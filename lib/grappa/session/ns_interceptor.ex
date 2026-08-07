defmodule Grappa.Session.NSInterceptor do
  @moduledoc """
  Pure module: matches an outbound IRC wire line for any NickServ-account
  identify verb that carries a password, and lifts the password out for the
  host (`Grappa.Session.Server`) to stage or commit. The result carries a
  `kind` (`:identify | :register | :set_passwd`) so the host can pick the
  right action: IDENTIFY-family captures stage the TIMED `pending_auth`;
  REGISTER captures stage the UNTIMED `pending_registration_secret` (#129 —
  register grants +r minutes-to-hours later, outside the 10s window);
  SET PASSWD captures are committed OPTIMISTICALLY on-send (#131 — an
  already-identified session rotating its password emits no `+r`, so there
  is no rendezvous to stage against). Staged captures are committed to the
  visitor row ONLY on +r MODE observation (the timed slot is also discarded
  on the `@pending_auth_timeout_ms` timeout). Wrong passwords never touch
  the DB; a rejected SET PASSWD is recovered by #124's re-auth backstop.

  Covers the full azzurra identify-channel set (source-verified against
  `bahamut-azzurra` ircd + azzurra `services`):

    * `PRIVMSG NickServ[@host] :IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER <args>`
    * `NS|NICKSERV IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER <args>`   (services command alias)
    * `IDENTIFY|ID|SIDENTIFY <args>`                    (ircd `m_identify`)
    * `PASS <args>`                                     (ircd `m_pass` -> `m_identify`, post-connect)
    * `PRIVMSG NickServ[@host] :SET PASSWD <old> <new>` / `NS|NICKSERV SET PASSWD <old> <new>` /
      bare `SET PASSWD <old> <new>`                      (#131 — in-session password change)

  Every pattern is ANCHORED at line start (`^`) so a channel PRIVMSG body that
  merely CONTAINS "identify"/"pass"/"set passwd" is never captured — raw IRC
  frames start with the command verb, PRIVMSGs start with `PRIVMSG`.

  Password extraction: last whitespace token for IDENTIFY/ID/SIDENTIFY/GHOST/
  PASS (`IDENTIFY [account] <pass>`, `GHOST <nick> <pass>`, `PASS [nick] <pass>`);
  FIRST token for REGISTER (`REGISTER <pass> <email>`); the SECOND token for
  SET PASSWD (#977). The Azzurra verb is `SET PASSWD`, NOT `SET PASSWORD`
  (`do_set` only routes `PASSWD`; `PASSWORD` errors), so the regex matches
  `PASSWD` exactly and lets `SET PASSWORD …` fall through untouched.

  ## SET PASSWD takes the OLD password first, and its new one has no spaces

  Read off `azzurra/services@23473ed`, not inferred. `do_set`
  (`src/nickserv.c:2090`) hands the handler `param = strtok(NULL, "")` —
  everything after the verb — and `do_set_password` (`:2182`) then splits
  THAT at the first space: `newpass = strchr(param, ' '); *newpass++ = 0;`.
  The head is the OLD password (`:2204`: *"param holds the old password"*,
  checked against the stored one), the tail is the new. The form is
  `SET PASSWD <old> <new>` and the rotation is AUTHENTICATED.

  Before #977 this module read that `strtok(NULL, "")` as "the new password,
  which may therefore contain spaces" and captured rest-of-line — so every
  in-session rotation stored `"<old> <new>"` concatenated and corrupted the
  credential. Azzurra passwords cannot contain spaces AT ALL: right after the
  split, `strchr(newpass, ' ')` earns `CSNS_ERROR_PASSWORD_WITH_SPACES`.

  Since the capture is written to the credential OPTIMISTICALLY on-send, a
  value services would refuse must never be captured — it would store a
  secret that never took. So this module also carries `do_set_password`'s own
  guard chain, in its order (spaces / nick-or-under-5 / over-`PASSMAX` /
  control codes), and answers `{:reject, :set_passwd, reason}` with the
  services error constant as the reason. The line still goes out: services
  send the user their own error notice, and grappa's DB stays untouched.
  `PASSMAX` = 32 is a compile-time `#define` (`inc/config.h:96`), NOT a
  services.conf directive — there is nothing to learn at runtime and nothing
  for an operator to tune, so it lives here as a constant with its source
  reference.

  Two `do_set_password` guards are deliberately NOT mirrored: `str_equals`
  against the CURRENT password (rejecting a no-op rotation, which would store
  the value already stored — no divergence either way) and the old-password
  check itself (`str_equals(param, ni->pass)`; grappa cannot vet a wrong OLD
  password from the line alone, so a mistyped one still commits optimistically
  — the #124 re-auth backstop, unchanged by #977).

  Boundary: inherits the parent `Grappa.Session` boundary (no `use Boundary`).
  """

  alias Grappa.IRC.Identifier

  @typedoc """
  The captured verb's class. `:identify` covers IDENTIFY/ID/SIDENTIFY/
  GHOST/PASS — services grant +r synchronously (within the 10s window),
  so the host stages a TIMED `pending_auth`. `:register` is the
  register→auth-code flow (#129): services email an auth code and grant
  +r minutes-to-hours later, far outside that window, so the host stages
  an UNTIMED `pending_registration_secret`. `:set_passwd` is the
  in-session password change (#131): an already-identified session
  rotates its NickServ password, which emits NO `+r` transition — so the
  host commits it OPTIMISTICALLY on-send rather than staging it against a
  rendezvous. The host maps verb → action; the interceptor only reports
  which verb it saw.
  """
  @type kind :: :identify | :register | :set_passwd

  @typedoc """
  Why a syntactically-matched SET PASSWD was NOT captured: the name of the
  services error the line will earn (`do_set_password`, `src/nickserv.c`).
  `:syntax_error` is the one-token `SET PASSWD <new>` form, which Azzurra
  rejects outright — services change nothing, so neither may we.
  """
  @type reject_reason ::
          :syntax_error
          | :password_with_spaces
          | :insecure_password
          | :password_max_length
          | :password_with_ccodes

  @type result ::
          :passthrough
          | {:capture, kind(), String.t()}
          | {:reject, :set_passwd, reject_reason()}

  # `azzurra/services@23473ed inc/config.h:96` — `#define PASSMAX 32`, and
  # `do_set_password` rejects under 5. Compile-time defines, not conf knobs.
  @passmax 32
  @passmin 5

  # PRIVMSG-to-NickServ / NS-NICKSERV command form. `(?:...)` groups are
  # non-capturing; capture groups are (verb, rest).
  @verb_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)(IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER)\s+(\S.*?)\s*$/i

  # Bare ircd command form (m_identify).
  @bare_re ~r/^(IDENTIFY|ID|SIDENTIFY)\s+(\S.*?)\s*$/i

  # PASS post-connect identify (m_pass -> m_identify).
  @pass_re ~r/^PASS\s+(\S.*?)\s*$/i

  # #131 / #977 — in-session SET PASSWD. Same anchored PRIVMSG-NickServ /
  # NS-NICKSERV prefix family as `@verb_re`, plus the bare form (raw `/quote
  # SET PASSWD`), via an optional prefix group. The verb is the literal
  # two-token `SET PASSWD` (Azzurra `do_set` only routes `PASSWD`; `PASSWORD`
  # errors — the literal `PASSWD` followed by a space or EOL rejects
  # `PASSWORD …`).
  #
  # The capture group is services' `param` — old AND new, VERBATIM, split
  # here rather than by the regex. No trimming: services trim nothing, and a
  # trailing space is precisely what makes them refuse the line. Separators
  # from `SET` onward are LITERAL spaces, not `\s`, because services tokenise
  # with `strtok(…, " ")` / `strchr(…, ' ')` — a TAB is not a delimiter there
  # and must not be treated as one. The PRIVMSG prefix keeps `\s+`: that part
  # is parsed by the ircd, not by services. The group is optional so a bare
  # `SET PASSWD` reaches the same `:syntax_error` verdict as `SET PASSWD x`.
  @set_passwd_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)?SET +PASSWD(?: (.*))?$/i

  @doc """
  Inspects one outbound IRC wire line and returns `:passthrough` (no NickServ
  secret-bearing verb detected), `{:capture, kind, password}` with the
  cleartext password lifted out and the verb class (`:identify` / `:register`
  / `:set_passwd`) for the host to act on, or `{:reject, :set_passwd, reason}`
  for a SET PASSWD services will refuse (#977).

  `nick` is the sender's CURRENT nick — `callerUser->nick` on the services
  side. `do_set_password` refuses a new password equal to it
  (`str_equals_nocase`), and this module refuses the same, so the nick is an
  input to the verdict rather than something the host re-checks afterwards.

  Pure: no side effects. The host (`Grappa.Session.Server`) decides whether
  to stage against `+r` MODE (`:identify`/`:register`), commit optimistically
  on-send (`:set_passwd`, #131), discard on the pending-auth timeout, or
  overwrite on a subsequent capture.
  """
  @spec intercept(String.t(), String.t()) :: result()
  def intercept(line, nick) when is_binary(line) and is_binary(nick) do
    case Regex.run(@verb_re, line, capture: :all_but_first) do
      [verb, rest] -> dispatch(String.upcase(verb), rest)
      nil -> intercept_set_passwd(line, nick)
    end
  end

  # #131 / #977 — SET PASSWD. SET PASSWD shares no verb with the identify
  # family, so this check is order-independent w.r.t.
  # `@verb_re`/`@bare_re`/`@pass_re`.
  defp intercept_set_passwd(line, nick) do
    case Regex.run(@set_passwd_re, line, capture: :all_but_first) do
      # `:re` TRIMS an unset trailing group, so a bare `SET PASSWD` — verb and
      # nothing else — arrives as `[]` rather than `[""]`.
      [] -> {:reject, :set_passwd, :syntax_error}
      [param] -> split_set_passwd(param, nick)
      nil -> intercept_bare(line)
    end
  end

  # `param` is services' `strtok(NULL, "")`: OLD password, then new. The
  # split is at the FIRST space, exactly like `strchr(param, ' ')`; with no
  # space at all `do_set_password` bails to NS_SET_PASSWD_SYNTAX_ERROR, so a
  # one-token `SET PASSWD <new>` (the Atheme spelling) changes nothing
  # upstream and must change nothing here either.
  defp split_set_passwd(param, nick) do
    case String.split(param, " ", parts: 2) do
      # The head is the OLD password; grappa cannot vet it, services do.
      [_, new_password] -> vet_new_password(new_password, nick)
      [_] -> {:reject, :set_passwd, :syntax_error}
    end
  end

  # `do_set_password`'s guard chain, in ITS order — same order so the reason
  # we report is the notice the user actually receives.
  defp vet_new_password(new_password, nick) do
    cond do
      String.contains?(new_password, " ") -> {:reject, :set_passwd, :password_with_spaces}
      insecure?(new_password, nick) -> {:reject, :set_passwd, :insecure_password}
      byte_size(new_password) > @passmax -> {:reject, :set_passwd, :password_max_length}
      ccodes?(new_password) -> {:reject, :set_passwd, :password_with_ccodes}
      true -> {:capture, :set_passwd, new_password}
    end
  end

  # `str_equals_nocase(callerUser->nick, newpass) || (str_len(newpass) < 5)`.
  # `str_len` is a BYTE count, and the case-insensitive compare is the plain
  # ASCII one — `Identifier.canonical_target/1`, per the project-wide rule
  # that no nick comparison uses a bare `String.downcase/1`.
  defp insecure?(new_password, nick) do
    byte_size(new_password) < @passmin or
      Identifier.canonical_target(new_password) == Identifier.canonical_target(nick)
  end

  # `string_has_ccodes` (`src/misc.c:1321`): any BYTE below 32, or the byte
  # 160. Byte-level on purpose — 160 is a UTF-8 continuation byte (`à` is
  # `C3 A0`), so services refuse accented passwords too, and mirroring them
  # per-byte is the only way to predict that.
  defp ccodes?(password) do
    password |> :binary.bin_to_list() |> Enum.any?(&(&1 < 32 or &1 == 160))
  end

  defp intercept_bare(line) do
    case Regex.run(@bare_re, line, capture: :all_but_first) do
      [verb, rest] -> dispatch(String.upcase(verb), rest)
      nil -> intercept_pass(line)
    end
  end

  defp intercept_pass(line) do
    case Regex.run(@pass_re, line, capture: :all_but_first) do
      [rest] -> {:capture, :identify, last_token(rest)}
      nil -> :passthrough
    end
  end

  # Catch-all: IDENTIFY / ID / SIDENTIFY / GHOST all take the password as
  # the last token AND grant +r synchronously → `:identify`. Only REGISTER
  # (password first, +r granted later via the auth-code) needs its own
  # clause AND its own `:register` kind (#129).
  defp dispatch("REGISTER", rest), do: {:capture, :register, first_token(rest)}
  defp dispatch(_, rest), do: {:capture, :identify, last_token(rest)}

  defp last_token(rest), do: rest |> String.split() |> List.last()
  defp first_token(rest), do: rest |> String.split() |> List.first()
end
