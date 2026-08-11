defmodule Grappa.Session.IdentityState do
  @moduledoc """
  The single source of truth for one question (GH #388): **is this session
  identified to the network's services?**

  Before #388 that question was answered by three separate readers, each
  spelling `"r" in umodes` by hand — `EventRouter.session_identity_effects/2`,
  `EventRouter`'s `set_r_mode?/1` mode-string walker, and `Session.Server`'s
  `registered:` wire field — plus a fourth in cicchetto. `+r` is emitted
  only by bahamut, so every one of them was an Azzurra-shaped answer and the
  #349 registration wizard could not ship anywhere else. This module replaces
  all of them: callers ask `identified?/1`, never a mode letter.

  ## The two axes

  A session counts as identified when EITHER holds:

    * **account** — the services account name, from IRCv3 `account-notify`
      (`ACCOUNT <name>` / `ACCOUNT *`) or numeric 330 RPL_WHOISLOGGEDIN for
      self. Flavour-agnostic, and the ONLY axis solanum/atheme networks
      offer (see below). **Counts as proof only where `account-notify` is
      ACKed** — see the next section.
    * **registered umode** — the per-flavour umode letter the ircd sets when
      services confirm an identify.

  They are OR'd: a bahamut network supplies only the umode, a solanum one
  only the account, and an ircd offering both may deliver either first.

  ## Why the account axis is gated on the cap (vjt's ruling, 2026-08-11)

  An account name is only a *live* identity where the ircd promises to
  retract it, and `account-notify` IS that promise: it is the cap that
  delivers `ACCOUNT *` on logout. Without it we can learn an account (a
  330 naming us) but we will never be told it ended, so treating it as
  proof means a verdict that can go up and never come down.

  That is not hypothetical. bahamut (Azzurra, all of prod) offers no such
  cap and strips `+r` on a genuine rename (#581). Ungated, a 330 would
  pin the session "identified" forever: the `+r` strip would stop moving
  the verdict, and #581's re-identify affordance — the button that tells
  the operator they need to identify again — would never come back. So on
  bahamut a 330 is **display only**: still folded onto the state for the
  WHOIS card, no longer part of the verdict, and `+r` alone decides.
  Behaviour on prod is therefore exactly the pre-#388 behaviour.

  On solanum/OFTC the cap IS ACKed, so the account axis is live: it
  survives a rename, as it should, and `ACCOUNT *` retracts it. A 330 with
  neither cap nor umode degrades to "not identified" — the safe direction,
  and the tolerance `identity.ts` already declares.

  This reads box 2 of the #388 checklist ("parse WHOIS-330 for account")
  more narrowly than written. The checklist predates the measurement;
  where the two disagree, the measured design wins.

  ## Why the umode letter is per-flavour and EXCLUSIVE

  The letter is not a portable constant, and accepting a union of `r` and
  `R` would be actively wrong in both directions. Verified at source:

    * **bahamut** (Azzurra, all of prod) — lowercase `+r` is the registered
      state; this is the pre-#388 behaviour and the invariant #561/#581
      already lean on (`m_nick.c` strips it on a genuine rename).
    * **OFTC** (`oftc/oftc-hybrid@36f0431`, `src/s_user.c`, blob
      `e325095`) — uppercase `R` is `UMODE_NICKSERVREG`, "user is registered
      with nickserv and identified" (`s_user.c:114`, `include/client.h:401`).
      Lowercase `r` on the SAME ircd is `UMODE_REJ`, an oper bot-rejection
      server-notice mode (`s_user.c:142`). Treating `r` as identity there
      would mark an oper identified and let the wizard commit a registration
      that never happened.
    * **solanum** (Libera, `ircd/s_user.c` `user_modes[256]`) — neither
      letter is assigned in core (`/* R */ 0`; the table is
      `D/Q/S/Z/a/i/o/s/w/z`). Identity arrives purely via account, which is
      why `:atheme` gets no usable umode and needs none. Uppercase `R` being
      free in core is also why it must NOT be honoured off OFTC: an
      extension is at liberty to assign it something unrelated.

  So `registered_umode/1` returns ONE letter per flavour and callers test
  membership of exactly that letter. An unclassified network (`nil`, the
  operator never set `services_flavor`) and any flavour added later default
  to lowercase `r` — the pre-#388 answer, so classifying nothing changes
  nothing.

  ## Shape

  Pure functions over the session-state map; this module stores nothing.
  The three facts already live on `Grappa.Session.Server`'s state
  (`:umodes`, `:account`, `:services_flavor`) and are read here with
  `Map.get` defaults, so a hot-reloaded process whose state predates any of
  them answers "not identified" instead of `KeyError`-crashing (the #216
  contract). Reading all three in ONE place is the point: a caller cannot
  forget an axis, which is precisely how the `+r`-only readers drifted.
  """

  @typedoc """
  The operator-set services flavour, mirroring
  `Grappa.Networks.Network.services_flavor/0`. Declared as a plain `atom()`
  rather than aliased: `Networks` already depends on `Session`, so naming
  that type here would close a Boundary cycle (the same indirection
  `Session.Server`'s committer typedocs use). Unrecognised atoms are not an
  error — they take the lowercase default.
  """
  @type flavor :: atom() | nil

  @typedoc """
  The subset of the session state this module reads. Every key is optional
  for the #216 hot-reload contract, and the open tail lets the full
  `Session.Server` state be passed straight in.
  """
  @type facts :: %{
          optional(:umodes) => [String.t()],
          optional(:account) => String.t() | nil,
          optional(:services_flavor) => flavor(),
          optional(:caps_active) => MapSet.t(String.t()),
          optional(any()) => any()
        }

  # Flavours whose registered umode is NOT the lowercase default. One entry
  # per divergence, so adding an ircd is a one-line edit here rather than a
  # new detector somewhere downstream.
  @registered_umode_by_flavor %{oftc: "R"}
  @default_registered_umode "r"

  # IRCv3 account-notify spells "logged out" as a literal asterisk.
  @logged_out_account "*"

  # The cap that makes the account axis retractable, and therefore usable
  # as proof. Same string the CAP ACK seam records into `caps_active`.
  @account_notify_cap "account-notify"

  @doc """
  Whether the session is identified to services — the normalized signal
  every consumer keys off, replacing all direct umode reads.
  """
  @spec identified?(facts()) :: boolean()
  def identified?(facts) when is_map(facts) do
    account_identified?(facts) or umode_identified?(facts)
  end

  @doc """
  The umode letter meaning "registered and identified" on the given
  services flavour. Exactly one letter, never a set — see the moduledoc for
  why a union of `r` and `R` is wrong on both OFTC and solanum.
  """
  @spec registered_umode(flavor()) :: String.t()
  def registered_umode(flavor) do
    Map.get(@registered_umode_by_flavor, flavor, @default_registered_umode)
  end

  @doc """
  Folds an account name off the wire into the stored value: the
  `account-notify` logout sentinel `"*"` and an empty string both mean "no
  account", so they normalize to `nil` rather than being stored as a blank
  identity that would read as identified.
  """
  @spec normalize_account(String.t() | nil) :: String.t() | nil
  def normalize_account(@logged_out_account), do: nil
  def normalize_account(""), do: nil
  def normalize_account(account) when is_binary(account), do: account
  def normalize_account(nil), do: nil

  # An account counts only where the ircd promised to retract it. The
  # `Map.get` default is an empty set, so a hot-reloaded state predating
  # the key falls back to the umode axis — the pre-#388 answer, and the
  # safe direction (#216).
  @spec account_identified?(facts()) :: boolean()
  defp account_identified?(facts) do
    is_binary(Map.get(facts, :account)) and
      MapSet.member?(Map.get(facts, :caps_active, MapSet.new()), @account_notify_cap)
  end

  @spec umode_identified?(facts()) :: boolean()
  defp umode_identified?(facts) do
    letter = registered_umode(Map.get(facts, :services_flavor))
    letter in Map.get(facts, :umodes, [])
  end
end
