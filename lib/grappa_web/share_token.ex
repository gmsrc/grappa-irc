defmodule GrappaWeb.ShareToken do
  @moduledoc """
  The session share-link token itself: salt, TTL, signing, verification.

  ## Why this is a module and not two copies

  TWO doors mint this token — `POST /me/share-token`
  (`GrappaWeb.ShareTokenController`, the subject's own device-to-device
  share) and `POST /admin/visitors/:id/share-token`
  (`GrappaWeb.Admin.VisitorsController`, #982's recovery door for a
  visitor who lost access and, having no password, cannot mint their
  own). ONE door redeems it: `POST /auth/share/consume`.

  A second `Phoenix.Token.sign/3` call site carrying its own copy of the
  salt and the TTL would be two secrets that agree only by inspection —
  and the failure is silent in the worst direction: the mint keeps
  returning 200 with a token the consume endpoint rejects, so the
  operator hands out a dead link and the locked-out visitor stays
  locked out. Signing and verification live together here so a change
  to either constant moves both doors at once.

  ## Why the payload is a TAGGED subject (#1306)

  Until #1306 the payload was the bare visitor UUID, because only a
  visitor could share. A user can now (`/me/share-token` no longer 403s
  a password subject), and a user id and a visitor id are the same
  shape: two UUIDs, indistinguishable inside one signed namespace. A
  consume reading a bare id would have to GUESS which table to read,
  and guess wrong the moment the two id spaces ever collided.

  So the payload is the `t:Grappa.Subject.t/0` tuple — the same
  `{:user, id} | {:visitor, id}` discriminator every context-side
  subject-scoped write already speaks, and the exact shape
  `Grappa.Accounts.create_session/4` takes, so the consume hands the
  verified payload straight through instead of re-deriving it.

  **The salt bump to `share-v2` is what makes that safe.** The signing
  key is derived from the salt, so a `visitor-share-v1` token does not
  verify here at all: there is no window in which an in-flight token
  from the untagged era is re-read as EITHER kind. That is the whole
  point of moving the salt rather than merely widening the payload —
  the change is not cosmetic, it is the guarantee. `verify/1` also
  refuses a correctly-salted token whose payload is not one of the two
  known tags, so reaching the v2 namespace is necessary but not
  sufficient.

  ## Why `Phoenix.Token` and not the DB

  Unchanged from the original design: the threat model is benign, the
  TTL is short (10 min), and the one-shot ledger (`Grappa.ShareTokens`)
  is ETS, so losing it on a BEAM restart opens at most a TTL-bounded
  reuse window for tokens already signed. Zero migrations, HOT-deploy
  friendly.

  Neither #982 nor #1306 widens either constant. Ten minutes and single
  use are what keep a leaked link from being a standing key — and #1306
  raises the stakes rather than lowering them, since the identity behind
  the link may now be a password-holding (possibly admin) user, so ONE
  constant governs both kinds and it is the short one.
  """

  @salt "share-v2"
  @max_age_seconds 600

  @typedoc """
  What the token carries: the tagged subject the link grants a session
  for. Same shape as `t:Grappa.Subject.t/0` and as the argument of
  `Grappa.Accounts.create_session/4`, deliberately — the consume passes
  the verified value straight on.
  """
  @type subject :: Grappa.Subject.t()

  @doc """
  The `Phoenix.Token` salt. Public so tests assert against the real
  value rather than re-declaring it.
  """
  @spec salt() :: String.t()
  def salt, do: @salt

  @doc """
  Token lifetime in seconds — the same number the mint reports as
  `expires_at` and the consume enforces as `max_age`. ONE constant for
  both subject kinds (#1306 ruling): a user link is not longer-lived
  than a visitor one.
  """
  @spec max_age_seconds() :: unquote(@max_age_seconds)
  def max_age_seconds, do: @max_age_seconds

  @doc """
  Sign a token for `subject`, on behalf of a session of kind
  `minting_kind`. Returns `{:ok, {token, expires_at}}`, where
  `expires_at` is the absolute UTC instant at which `verify/1` starts
  refusing it — cic renders the countdown from it.

  `minting_kind` is the `t:Grappa.Accounts.Session.kind/0` of the
  session presenting itself at the door, and it decides whether there
  is a token at all: only a full (`:web`) session mints one, and a
  scoped per-client session is answered `{:error, :client_token_scope}`
  — the same atom `GrappaWeb.Plugs.RequireFullSession` raises, so both
  layers render one 403 through `GrappaWeb.FallbackController`.

  ## Why the rule lives HERE and not only on the route (#1353)

  What the link yields on the receiving device is a full session for
  the identity, so the scope of the redeemed session is decided at the
  MINT, not at the redeem. A route-shaped rule states that once, for
  the doors that exist today; this states it for the signing act
  itself, so a door added later inherits the rule by being unable to
  call `mint/2` without naming the kind it is minting under.

  The argument is required rather than defaulted for the same reason:
  a default is a caller that never had to think about it.

  A `:web` mint is unchanged from #1306 — same salt, same payload, same
  TTL — so links already in flight are unaffected by this gate.
  """
  @spec mint(subject(), Grappa.Accounts.Session.kind()) ::
          {:ok, {String.t(), DateTime.t()}} | {:error, :client_token_scope}
  def mint({kind, id} = subject, :web) when kind in [:user, :visitor] and is_binary(id) do
    token = Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, subject)
    {:ok, {token, DateTime.add(DateTime.utc_now(), @max_age_seconds, :second)}}
  end

  def mint({kind, id}, :client) when kind in [:user, :visitor] and is_binary(id),
    do: {:error, :client_token_scope}

  @doc """
  Verify a token and recover the tagged subject it was signed for.

  The two failure atoms are already wire-shaped for
  `GrappaWeb.FallbackController`: `:share_token_expired` → 410 Gone (the
  link was real and ran out), `:unauthorized` → 401 (the signature does
  not hold). Keeping them distinct is what lets cic tell "ask for a new
  link" apart from "this link is not ours".

  A payload that is not one of the two known tags is `:unauthorized`,
  not a crash: `Phoenix.Token` deserialises whatever was signed under
  this salt, so the shape check is a boundary rejection and belongs
  here rather than in the branch downstream.
  """
  @spec verify(String.t()) ::
          {:ok, subject()} | {:error, :unauthorized | :share_token_expired}
  def verify(token) when is_binary(token) do
    case Phoenix.Token.verify(GrappaWeb.Endpoint, @salt, token, max_age: @max_age_seconds) do
      {:ok, {kind, id}} when kind in [:user, :visitor] and is_binary(id) -> {:ok, {kind, id}}
      # A payload that is not one of the two known tags: correctly
      # signed, but not something this branch can route.
      {:ok, _} -> {:error, :unauthorized}
      {:error, :expired} -> {:error, :share_token_expired}
      {:error, _} -> {:error, :unauthorized}
    end
  end
end
