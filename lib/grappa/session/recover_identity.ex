defmodule Grappa.Session.RecoverIdentity do
  @moduledoc """
  Pure FSM: a visitor-triggered "recover my identity" sequence —
  re-take a registered nick after services parked the session on an
  unidentified (non-`+r`) nick. Split from #561 point 4 (GH #581).

  A **sibling** to `Grappa.Session.GhostRecovery`, not a generalisation
  of it (GH #581 architecture ruling A2). GhostRecovery is
  reconnect-triggered, underscore-first, and NickServ-**NOTICE**-driven;
  this FSM is user-triggered, targets the credential nick directly, and
  trusts the `+r` umode ONLY — it never parses a NickServ notice. Shared
  is the *shape* (pure `step/2` returning `{:cont | :stop, state,
  [iodata]}`, host owns I/O + timers), not the state machine.

  ## Ordering is SOURCE-VERIFIED, not assumed (GH #581, 2026-07-31)

  `+r` (`UMODE_r`) is a PER-NICK flag — "the nick you are wearing RIGHT
  NOW is your identified registered nick". bahamut CLEARS it on any
  genuine nick change (`bahamut/src/m_nick.c:594-602`:
  `if (mycmp(old, new)) sptr->umode &= ~UMODE_r;`; the ircd's own comment
  at `include/struct.h:226` says `+r` IS reset on `/nick`, unlike the
  session `FLAGS_REGISTERED`). Azzurra services `do_identify` emits the
  `+r` SVSMODE **only when `sameNick`** — identifying for a protected nick
  while force-renamed to `Guest…` fires a NOTICE but NO `+r`
  (`docs/DESIGN_NOTES.md` 2026-05-xx). `RECOVER`/`RELEASE` reclaim the nick
  (password-authenticated) but do NOT set `+r`; the follow-up `IDENTIFY`
  ON the reclaimed nick is what commits.

  So `+r` cannot arrive while on a Guest nick. You must be ON the
  credential nick AND `IDENTIFY` (sameNick) to get `+r`. The sequence
  therefore sends `NICK` and `IDENTIFY` TOGETHER (mirroring
  `GhostRecovery`'s `:succeeded` `["NICK …", "IDENTIFY …"]` emit) and
  waits for `+r` as the SUCCESS signal:

  1. `:start` → `NICK <cred_nick>` + `IDENTIFY <cred_nick> <secret>`,
     transition `:awaiting_r`.
  2. `:r_observed` (the `+r` umode landed — fed by the host from
     `EventRouter`'s identity signal, NOT parsed here) → `:succeeded`.
  3. `{:nick_error, 433}` (nick in use) → `RECOVER`; `{:nick_error, 437}`
     (services hold) → `RELEASE`; transition `:awaiting_verb_settle`. (The
     `IDENTIFY` sent in step 1 was a foreign-nick identify — no `+r`, per
     the sameNick rule; it is harmless and re-sent below.)
  4. `:settle` (host's short post-verb settle tick) → `NICK <cred_nick>` +
     `IDENTIFY <cred_nick> <secret>`, transition `:awaiting_final_r`.
  5. `:r_observed` → `:succeeded`. A refused final `NICK` (`{:nick_error,
     _}`) is **terminal `:failed`** — F2 (vjt 2026-07-31): an empty retry
     never wins the nick, which is exactly why the verb is `RECOVER`. No
     retry loop.
  6. `:timeout` (host's overall deadline) in any non-terminal phase →
     `:failed`, phase-appropriate reason (`:wrong_password` if `+r` never
     came after a clean NICK; `:services_declined` if the verb went
     unanswered; `:nick_unavailable` if the reclaimed NICK still failed).

  Wire lines carry the credential nick **RAW** — its case is
  presentation (the key/display/wire split, GH #121/#537). The FSM emits
  no broadcasts and arms no timers: the host (`Grappa.Session.Server`)
  owns I/O, the overall deadline, the settle tick, and the progress
  broadcasts.

  Boundary: inherits the parent `Grappa.Session` boundary — same pattern
  as sibling submodules `Server`, `EventRouter`, `GhostRecovery`. No `use
  Boundary` here.
  """

  defstruct phase: :idle, cred_nick: nil, secret: nil, verb: nil, reason: nil

  @type phase ::
          :idle
          | :awaiting_r
          | :awaiting_verb_settle
          | :awaiting_final_r
          | :succeeded
          | :failed

  @type verb :: :recover | :release | nil

  @type reason :: :wrong_password | :nick_unavailable | :services_declined | nil

  @type input ::
          :start
          | :r_observed
          | {:nick_error, 433 | 437}
          | :settle
          | :timeout

  @type t :: %__MODULE__{
          phase: phase(),
          cred_nick: String.t() | nil,
          secret: String.t() | nil,
          verb: verb(),
          reason: reason()
        }

  @doc """
  Builds an initial FSM pinned to the credential nick to reclaim and the
  NickServ secret to identify with. Both are required — the host gates on
  a recoverable credential (a stored NickServ secret) BEFORE building the
  FSM (#561 pt3: never blind-`IDENTIFY` a nick with no credential).
  """
  @spec init(String.t(), String.t()) :: t()
  def init(cred_nick, secret) when is_binary(cred_nick) and is_binary(secret) do
    %__MODULE__{phase: :idle, cred_nick: cred_nick, secret: secret}
  end

  @doc """
  Drives one semantic input through the FSM. Returns `{:cont, state,
  [lines]}` to continue or `{:stop, state, [lines]}` at a terminal phase;
  `lines` are CRLF-framed IRC strings the host must push via
  `Grappa.IRC.Client.send_line/2` (through `Server.flush_lines/2`, so the
  outbound `IDENTIFY` still stages the `+r` rendezvous).

  Inputs that don't match the current phase's expected transition are
  no-ops (`{:cont, state, []}`), including terminal-phase passthrough.
  """
  @spec step(t(), input()) :: {:cont, t(), [String.t()]} | {:stop, t(), [String.t()]}

  def step(%__MODULE__{phase: :idle} = s, :start) do
    {:cont, %{s | phase: :awaiting_r}, take_and_identify(s)}
  end

  def step(%__MODULE__{phase: :awaiting_r} = s, :r_observed) do
    {:stop, %{s | phase: :succeeded}, []}
  end

  def step(%__MODULE__{phase: :awaiting_r, cred_nick: nick, secret: secret} = s, {:nick_error, 433}) do
    {:cont, %{s | phase: :awaiting_verb_settle, verb: :recover}, ["PRIVMSG NickServ :RECOVER #{nick} #{secret}\r\n"]}
  end

  def step(%__MODULE__{phase: :awaiting_r, cred_nick: nick, secret: secret} = s, {:nick_error, 437}) do
    {:cont, %{s | phase: :awaiting_verb_settle, verb: :release}, ["PRIVMSG NickServ :RELEASE #{nick} #{secret}\r\n"]}
  end

  def step(%__MODULE__{phase: :awaiting_r} = s, :timeout) do
    # NICK succeeded (else we'd have seen 433/437) but `+r` never came →
    # the IDENTIFY was rejected → wrong password.
    {:stop, %{s | phase: :failed, reason: :wrong_password}, []}
  end

  def step(%__MODULE__{phase: :awaiting_verb_settle} = s, :settle) do
    {:cont, %{s | phase: :awaiting_final_r}, take_and_identify(s)}
  end

  def step(%__MODULE__{phase: :awaiting_verb_settle} = s, :timeout) do
    {:stop, %{s | phase: :failed, reason: :services_declined}, []}
  end

  def step(%__MODULE__{phase: :awaiting_final_r} = s, :r_observed) do
    {:stop, %{s | phase: :succeeded}, []}
  end

  # F2 (vjt 2026-07-31): the post-verb NICK gets ONE shot. A refusal is
  # TERMINAL — no retry line, no loop. An empty retry never wins the nick.
  def step(%__MODULE__{phase: :awaiting_final_r} = s, {:nick_error, _}) do
    {:stop, %{s | phase: :failed, reason: :nick_unavailable}, []}
  end

  def step(%__MODULE__{phase: :awaiting_final_r} = s, :timeout) do
    {:stop, %{s | phase: :failed, reason: :nick_unavailable}, []}
  end

  def step(state, _), do: {:cont, state, []}

  # NICK to the credential nick + IDENTIFY for it, in ONE flush. Order
  # matters: NICK first so the IDENTIFY that follows is `sameNick` and
  # thus commits `+r` (mirrors `GhostRecovery`'s `:succeeded` emit). If
  # the NICK fails, the IDENTIFY is a harmless foreign-nick identify (no
  # `+r`) and the sequence reclaims off the 433/437.
  @spec take_and_identify(t()) :: [String.t()]
  defp take_and_identify(%__MODULE__{cred_nick: nick, secret: secret}) do
    ["NICK #{nick}\r\n", "PRIVMSG NickServ :IDENTIFY #{nick} #{secret}\r\n"]
  end
end
