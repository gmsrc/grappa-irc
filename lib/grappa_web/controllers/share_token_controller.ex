defmodule GrappaWeb.ShareTokenController do
  @moduledoc """
  Session-sharing endpoints.

    * `POST /me/share-token` — mints a Phoenix-signed, short-TTL token
      bound to the caller's own tagged subject. cic wraps the token in
      a shareable URL (`https://<host>/#/share/<token>`) so the caller
      can forward it to another device of their own.
    * `POST /auth/share/consume` — unauthenticated. Body `{token}`.
      Verifies signature + TTL, checks the one-shot ETS ledger
      (`Grappa.ShareTokens`), confirms the subject row still exists,
      and mints a fresh `accounts_sessions` row for the SAME subject.
      Returns `{token, subject}` mirroring the login wire.

  ## Who may mint (#1306)

  Every authenticated subject except an incognito visitor. It was
  visitor-only until #1306, on the argument that a user has a password
  and can just log in on the second device — true, and beside the
  point: retyping a password (and a TOTP code, and possibly a passkey
  ceremony) on a phone is exactly the friction the QR exists to remove.
  The bearer presenting itself at the mint has ALREADY cleared whatever
  second factor the identity carries, so no re-auth gates the mint (an
  explicit #1306 ruling, independent of #442).

  The one refusal left is #363's incognito visitor: an ephemeral
  session must not be made portable, whatever else changes around it.

  Since #982 `/me` is not the only mint either: an admin can mint the
  same token for a locked-out visitor via `POST
  /admin/visitors/:id/share-token`. The consume below stays the single
  redeem surface for both origins, and both mints go through
  `GrappaWeb.ShareToken` — see that module for why the salt and TTL
  cannot live in a controller any more, and why the payload carries the
  subject KIND rather than a bare id.

  ## Why Phoenix.Token + ETS (no DB)

  Threat model is benign (someone clicks their own link twice). Short
  TTL (10 min). Losing the consumed-set on BEAM restart opens at most a
  TTL-bounded reuse window for tokens already signed. The benefit is
  zero migrations → HOT-deploy-friendly. A future DB-backed hardening
  path (a `share_tokens` table with `consumed_at`) is a mechanical
  migration if the threat model shifts.

  #1306 moves that model, without yet moving this decision: the
  identity behind a link can now be a password-holding — possibly
  admin — user, so the reuse window a BEAM restart opens is worth more
  than it was. What keeps it acceptable is that the window is bounded
  by the SAME 10 minutes and applies only to tokens already signed and
  not yet redeemed. The DB-backed path is the answer if that stops
  being enough; widening the TTL never is.

  ## Error envelope

  All error responses flow through `GrappaWeb.FallbackController`
  (wired via `use GrappaWeb, :controller`). The new error atoms this
  surface contributes are:

    * `:share_token_expired` → 410 Gone
    * `:share_token_consumed` → 410 Gone

  Reused: `:forbidden` (an incognito visitor trying to mint — #363),
  `:bad_request` (missing token param), `:unauthorized` (invalid
  signature), `:not_found` (the subject row gone between mint and
  consume).
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, AdminEvents, ShareTokens, Visitors}
  alias Grappa.Accounts.User
  alias Grappa.AdminEvents.Wire, as: EventsWire
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.{AuthJSON, RemoteIP, ShareToken, Subject}

  @doc """
  `POST /me/share-token` — self-mint for the calling subject.

  Returns `{token, expires_at}`. `expires_at` is the absolute UTC
  ISO8601 timestamp at which the token will be rejected by the
  consume endpoint (TTL elapsed) — cic uses this for the countdown
  in the share modal.

  #1306 — a user mints exactly as a visitor does; the only 403 left is
  the incognito visitor (#363).
  """
  @spec mint(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :forbidden | :unauthorized}
  def mint(conn, _) do
    case conn.assigns[:current_subject] do
      {:visitor, %Visitor{incognito: true}} ->
        # #363 — an incognito session is deliberately non-portable: its
        # whole point is "gone when this browser closes." Minting a share
        # link would carry the session to another device (and the shared
        # socket would keep the reconcile linger alive), defeating the
        # ephemerality. cic already hides the share control for incognito;
        # this is the server-side twin of that gate so the REST door can't
        # be driven directly ("one feature, every door"). This clause sits
        # FIRST on purpose: it is a carve-out of the visitor clause below,
        # and reordering the two would silently reopen the door.
        {:error, :forbidden}

      {:visitor, %Visitor{}} = subject ->
        mint_for(conn, subject)

      {:user, %User{}} = subject ->
        mint_for(conn, subject)

      _ ->
        # Defensive fall-through — `:authn` should have rejected
        # already, but a regressed pipeline would land here. 401 via
        # FallbackController matches the broader unauth surface.
        {:error, :unauthorized}
    end
  end

  # The mint proper, shared by both admitted subject kinds (#1306). The
  # token payload is `Subject.to_session/1`'s bare-id tuple — the same
  # discriminator `Accounts.create_session/4` takes, so the consume can
  # hand the verified payload straight through without re-deriving it.
  @spec mint_for(Plug.Conn.t(), Subject.t()) :: Plug.Conn.t()
  defp mint_for(conn, subject) do
    {kind, id} = Subject.to_session(subject)
    {token, expires_at} = ShareToken.mint({kind, id})

    :telemetry.execute(
      [:grappa, :share_token, :minted],
      %{count: 1},
      %{subject_kind: kind, subject_id: id}
    )

    record_admin_event(subject)

    conn
    |> put_status(:ok)
    |> json(%{token: token, expires_at: DateTime.to_iso8601(expires_at)})
  end

  # #1306 — a USER self-mint reaches the admin register; a visitor
  # self-mint does not, and the asymmetry is the argument rather than an
  # omission. A visitor share hands out a visitor session — the routine
  # case, unattributed since #392. A user share hands out a session for
  # a PASSWORD identity, obtained without presenting the password, over
  # whatever channel carried the link; the ruling admits admins with no
  # exclusion, so that identity may hold the console. Logging both would
  # spend a bounded ring buffer on the routine half.
  #
  # Distinct from `:visitor_share_token_minted`, which stays exactly as
  # #982 left it: that event means "an ADMIN minted for someone else",
  # and the client-facing wire is additive-only — an existing kind is
  # never renamed or repurposed, so widening it was not available even
  # if it had been desirable.
  @spec record_admin_event(Subject.t()) :: :ok
  defp record_admin_event({:user, %User{id: id, name: name}}) do
    AdminEvents.record(EventsWire.user_share_token_minted(id, name))
  end

  defp record_admin_event({:visitor, %Visitor{}}), do: :ok

  @doc """
  `POST /auth/share/consume` — unauthenticated, body `{token}`.

  Flow (claim-then-release, #593):
    1. Validate body shape (token present + binary) → 400 otherwise.
    2. `ShareToken.verify/1` → 401 on bad signature or on a payload
       that is not a known subject tag, 410 on TTL elapsed. The
       recovered value is the TAGGED subject (#1306), so step 4 reads
       the right table instead of guessing from a bare UUID.
    3. `ShareTokens.mark_consumed/1` (atomic ETS insert-if-absent) —
       the one-shot CLAIM → 410 on second redemption. From here the
       token is held by THIS request. The ledger is keyed on the token
       string, so it serves both kinds unchanged.
    4. `Visitors.get/1` or `Accounts.get_user/1` per the tag → 404 if
       the row went away between mint and consume.
    5. `Accounts.create_session/4` for the SAME subject → returns the
       new bearer + that subject's login envelope.

  #593 — the claim (step 3) is taken BEFORE the mint (steps 4-5), so a
  failed mint would strand the token consumed with no session minted: a
  dead link the retryable-503 (#518) invites the client to retry in vain.
  `mint_session/3` closes that: ANY failure after the claim calls
  `ShareTokens.release/1` to roll the claim back, so a failed mint leaves
  the link usable and a successful mint leaves it dead. The release is
  scoped to THIS request's own post-claim failures — a second
  redemption's 410 (step 3) never releases the winner's claim.

  IP + user-agent are captured for audit just like login.
  """
  @spec consume(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error,
             :bad_request
             | :unauthorized
             | :share_token_expired
             | :share_token_consumed
             | :not_found
             | :db_unavailable
             | Ecto.Changeset.t()}
  def consume(conn, %{"token" => token}) when is_binary(token) and token != "" do
    with {:ok, subject} <- ShareToken.verify(token),
         :ok <- mark_consumed(token) do
      # The one-shot claim is now HELD by this request (mark_consumed
      # returned :ok — we won any race). #593 — every failure past this
      # point MUST roll the claim back (claim-then-release), so a
      # retryable mint failure (a 503 under transient SQLite saturation,
      # #518) leaves the link usable instead of silently dead.
      mint_session(conn, token, subject)
    else
      # Pre-consume rejects (bad signature / expired / lost the one-shot
      # race → :share_token_consumed). NOTHING to release here: either no
      # claim was taken, or the claim belongs to the WINNING request —
      # releasing it would resurrect a token that already minted a
      # session (dead-link → double-redemption, a worse bug).
      {:error, reason} -> reject(reason)
    end
  end

  def consume(_, _), do: {:error, :bad_request}

  # Mint the session for an already-CLAIMED token. On ANY failure the
  # claim is released (#593 claim-then-release) — safe because
  # `mark_consumed/1` returned `:ok` for THIS request just above, so the
  # token is ours to roll back, never a concurrent winner's. A failed
  # mint therefore leaves the link usable; a successful mint leaves the
  # claim in place (link dead), honouring the one-shot guarantee.
  @spec mint_session(Plug.Conn.t(), String.t(), ShareToken.subject()) ::
          Plug.Conn.t()
          | {:error, :not_found | :db_unavailable | Ecto.Changeset.t()}
  defp mint_session(conn, token, {kind, id} = subject) do
    with {:ok, loaded} <- fetch_subject(subject),
         {:ok, session} <-
           Accounts.create_session(
             subject,
             format_ip(conn),
             user_agent(conn),
             client_id: conn.assigns[:current_client_id]
           ) do
      :telemetry.execute(
        [:grappa, :share_token, :consumed],
        %{count: 1},
        %{subject_kind: kind, subject_id: id}
      )

      # The login envelope, not a second hand-rolled copy of it: a share
      # consume IS a login as far as the client is concerned (cic feeds
      # the response to the same `installSharedSession` → localStorage
      # path), and the user variant only exists at all because AuthJSON
      # already had it.
      conn
      |> put_status(:ok)
      |> json(AuthJSON.login(%{token: session.id, subject: loaded}))
    else
      {:error, reason} ->
        ShareTokens.release(token)
        reject(reason)
    end
  end

  # The closed set of rejection reasons — pre-consume (bad sig / expired /
  # lost the one-shot race) and post-consume (visitor reaped / saturated
  # mint / mint changeset). Typed over a bare `atom()` per CLAUDE.md's
  # closed-set rule.
  @typep reject_reason ::
           :unauthorized
           | :share_token_expired
           | :share_token_consumed
           | :not_found
           | :db_unavailable
           | Ecto.Changeset.t()

  # Emit the rejection telemetry and return the wire error tuple, so
  # both the pre-consume and post-consume reject paths stay single-sourced.
  @spec reject(reject_reason()) :: {:error, reject_reason()}
  defp reject(reason) do
    :telemetry.execute(
      [:grappa, :share_token, :rejected],
      %{count: 1},
      %{reason: reason}
    )

    {:error, reason}
  end

  # Translates `ShareTokens.mark_consumed/1`'s `{:error,
  # :already_consumed}` into the controller's wire-shaped error atom
  # `:share_token_consumed` so `FallbackController` can map it to 410.
  # Keeps the ETS module's contract clean (it doesn't know about HTTP
  # wire strings) and puts the wire-shape lift right at the boundary.
  @spec mark_consumed(String.t()) :: :ok | {:error, :share_token_consumed}
  defp mark_consumed(token) do
    case ShareTokens.mark_consumed(token) do
      :ok -> :ok
      {:error, :already_consumed} -> {:error, :share_token_consumed}
    end
  end

  # Load the row the tag names. The 404 is the same for both kinds — a
  # link outliving its identity is one condition, not two — but WHICH
  # table is read is decided by the signed tag, never inferred from the
  # id (the #1306 reason the payload carries the kind at all).
  @spec fetch_subject(ShareToken.subject()) :: {:ok, Subject.t()} | {:error, :not_found}
  defp fetch_subject({:visitor, visitor_id}) do
    case Visitors.get(visitor_id) do
      %Visitor{} = v -> {:ok, {:visitor, v}}
      nil -> {:error, :not_found}
    end
  end

  defp fetch_subject({:user, user_id}) do
    case Accounts.get_user(user_id) do
      %User{} = u -> {:ok, {:user, u}}
      nil -> {:error, :not_found}
    end
  end

  @spec format_ip(Plug.Conn.t()) :: String.t() | nil
  defp format_ip(conn), do: RemoteIP.format(conn)

  @spec user_agent(Plug.Conn.t()) :: String.t() | nil
  defp user_agent(conn) do
    case get_req_header(conn, "user-agent") do
      [ua | _] -> ua
      [] -> nil
    end
  end
end
