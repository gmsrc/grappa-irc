defmodule Grappa.Accounts.Revocations do
  @moduledoc """
  Domain event for "every bearer session of this subject is dead".

  ## The invariant

  **A subject's bearer sessions and its live WebSockets die together.**

  `GrappaWeb.UserSocket` authenticates once, at connect, and holds no
  further tie to the row — so the teardown has to be pushed. It used to
  be pushed BY HAND at each call-site, which is a rule and therefore
  something that drifts: it had, on most of the doors.

  Re-validating on the inbound frame path was considered and rejected.
  It would tie the teardown to the client SENDING something, which is
  the wrong half of a duplex connection to hang a guarantee on.

  ## The shape

  The kill sites announce; a web-layer listener
  (`GrappaWeb.SessionRevocationListener`) translates the announcement
  into the existing `GrappaWeb.UserSocket.disconnect_user_name/1`. The
  indirection is not decoration: calling the socket from here would be a
  context → web dependency that `Boundary` rejects (same reason
  `Grappa.Operator` carries no web deps).

  Announcing is NOT a new rule to remember at each door — that is the
  shape that drifted. Every write to `accounts_sessions` passes one of
  seven chokepoints: the four revoke functions in `Grappa.Accounts`
  (which own the table), plus the three places a parent row's deletion
  cascades onto it
  (`Accounts.delete_user/1`, `Accounts.delete_expired_sessions/0`, and
  the private `destroy_visitor/1` in `Grappa.Visitors`, already the
  single hard-delete mechanic for visitor rows). A new door inherits the
  teardown by construction.

  ## Two granularities: per-subject and per-session (#1499)

  `announce/1` names a SUBJECT and closes every socket that subject has;
  `announce_session/1` names ONE bearer session and closes only the
  sockets carrying it. A door picks by what it actually killed.

  Per-subject is right wherever the account itself changed hands or shape
  — `delete_user/1`, `revoke_sessions_for_user/1`, the visitor destroy —
  and on the "revoke all the OTHER sessions" paths (TOTP
  enrolment/disable, passkey mode change), where the acting device is
  disconnected too although its bearer survives. That one IS a blip:
  `phoenix.js` reconnects on its own, and the operation was something the
  account holder had just performed, so a reconnect is expected.

  Per-subject was WRONG for the idle-session reaper, which is what #1499
  reported. That door kills one stale row on a 60s timer with no request
  and no operator behind it, so the sockets it took down belonged to
  whoever happened to be connected — measured in production on
  2026-08-17, where reaping a week-old row of an active account dropped
  that account's IRC bridge and cost a full channel-rejoin storm on a
  bearer that had never expired. Nothing about that is a blip, and
  nothing about it was the account holder's doing.

  The finer address is ADDITIVE: `UserSocket.id/1` stays keyed by
  subject and every transport ALSO subscribes to
  `UserSocket.id_for_session/1` at connect. Re-keying `id/1` onto the
  session (the option #1499's body names, alongside teaching
  `Grappa.WSPresence` to carry `session_id`) was rejected — `id/1` yields
  ONE topic, so the account-wide doors would lose their address entirely
  and have to enumerate live sessions to rebuild it. Under-firing is
  still the failure that matters; a door in doubt announces the subject.

  ## Over-firing is the safe direction

  The in-transaction kill sites announce from INSIDE the transaction, so
  a rolled-back or `Repo.BusyRetry`-replayed transaction can announce a
  revocation that did not commit (or announce it twice). The consequence
  is a socket close whose bearer is still valid — a reconnect blip.
  Announcing only after commit would push the call back out to each
  call-site, which is the drift this module exists to end. Under-firing
  is the failure that matters; over-firing is not.
  """

  use Boundary, top_level?: true, deps: [Grappa.PubSub]

  alias Grappa.PubSub.Topic

  require Logger

  @typedoc """
  The subject whose sessions died — the topic-label PARTS, not a loaded
  struct and not an id.

  The user branch carries `user.name` and the visitor branch carries
  `visitor.id` because that is what the socket id-topic is keyed by
  (`Grappa.Subject.label/1`). It must be resolved BEFORE the row is
  deleted: on the cascade paths the user or visitor row is already gone
  by the time a listener could look it up.

  Structurally the `label_parts` type of `Grappa.Subject`, spelled out
  here rather than aliased: that module depends on `Grappa.Accounts`, so
  naming it from inside this boundary would close a dependency cycle.
  """
  @type subject :: {:user, String.t()} | {:visitor, String.t()}

  @typedoc """
  The messages a subscriber receives.

  Plural vs singular is the whole distinction and it is load-bearing:
  `:sessions_revoked` carries a SUBJECT and means every bearer it has is
  dead, `:session_revoked` carries ONE session id and means only that
  one is. A listener that handles the plural shape must not be assumed
  to handle the singular — they close different sets of sockets.
  """
  @type event :: {:sessions_revoked, subject()} | {:session_revoked, Ecto.UUID.t()}

  @doc """
  Subscribes the calling process to the revocation stream.

  One subscriber in production (the web listener); tests subscribe
  directly to assert the announcement without standing up a socket.

  Returns `:ok` or raises. The only failure `Phoenix.PubSub` reports here
  is `{:already_registered, pid}` — a process subscribing twice, which is
  a bug in that process, not a runtime condition anything could sensibly
  handle. Returning it would invent a failure mode every caller then has
  to pretend to consider.
  """
  @spec subscribe() :: :ok
  def subscribe do
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.session_revocations())
  end

  @doc """
  Announces that every bearer session of `subject` is dead.

  Fire-and-forget: a PubSub-unreachable `{:error, _}` is logged and
  swallowed. The caller has already killed the rows, and the announcement
  is an accelerator for a socket that is dead-in-law either way — it must
  never turn a completed revocation into a failed one, and never abort
  the transaction it is called from.
  """
  @spec announce(subject()) :: :ok
  def announce({tag, label} = subject) when tag in [:user, :visitor] and is_binary(label) do
    case broadcast({:sessions_revoked, subject}) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("session revocation announce failed",
          subject_kind: tag,
          reason: inspect(reason)
        )

        :ok
    end
  end

  @doc """
  Announces that ONE bearer session is dead (#1499).

  The narrow twin of `announce/1`, for a door that killed a single row
  rather than an account: `GrappaWeb.SessionRevocationListener` turns it
  into `GrappaWeb.UserSocket.disconnect_session/1`, which closes the
  sockets carrying that bearer and leaves the subject's other sockets
  serving.

  Use it only where the narrow claim is actually true. Announcing one
  session where the account died would under-fire, and under-firing is
  the failure this module exists to prevent — see the granularity
  section above.

  Fire-and-forget on the same terms as `announce/1`.
  """
  @spec announce_session(Ecto.UUID.t()) :: :ok
  def announce_session(session_id) when is_binary(session_id) do
    case broadcast({:session_revoked, session_id}) do
      :ok ->
        :ok

      {:error, reason} ->
        # No id on the line, and no `:subject_kind` either. The id is the
        # bearer token itself (S9 — `accounts_sessions.id` is what the
        # client presents), and `Grappa.Accounts.Session.handle/1`, which
        # exists to make one greppable without printing it, is on the far
        # side of this boundary's `deps`. `:subject_kind` is documented in
        # `config/config.exs` as `:user | :visitor`, where anything else
        # reads as an unknown-shape drop worth investigating — so a
        # `:session` value there would send an operator hunting a bug that
        # is not one. The distinct message carries the distinction instead.
        Logger.warning("single-session revocation announce failed", reason: inspect(reason))

        :ok
    end
  end

  # The one publish. Both granularities ride the same topic and the same
  # single subscriber; only the event shape and the failure line differ.
  @spec broadcast(event()) :: :ok | {:error, term()}
  defp broadcast(event),
    do: Phoenix.PubSub.broadcast(Grappa.PubSub, Topic.session_revocations(), event)
end
