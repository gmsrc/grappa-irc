defmodule Grappa.Session.PerformList do
  @moduledoc """
  Pure module: expands a stored on-connect perform list (#189) into the
  executable wire lines, with `$nickserv_pass` / `$oper_pass` substituted.

  The perform list is **raw IRC**, one command per line — NOT cicchetto
  slash-commands and NOT user aliases (#385). cic owns only the editor
  panel; the server sends each expanded line verbatim (through
  `Grappa.Session.Server`'s outbound-capture path, so `NSInterceptor` still
  lifts any literal password for the `+r` staging). #288's Lua/Luerl engine
  — control flow, a scripting API, resource budgets — is explicitly out of
  scope; this is the static-command-list MVP preset.

  ## Skipped lines

  Blank lines and `#`-comment lines (leading `#`, after trimming) are
  dropped. No valid IRC command verb begins with `#`, so the marker is
  unambiguous. Each remaining line is trimmed of surrounding whitespace
  (incl. a trailing `\\r` from CRLF authoring).

  ## Variables

  Exactly two, substituted in a SINGLE pass so a secret value that happens
  to contain a `$…` token is never re-expanded:

    * `$nickserv_pass` — the credential's stored upstream NickServ password.
    * `$oper_pass` — the sibling `oper_pass` secret field.

  A variable with no bound value expands to the empty string (never the
  literal token — leaking `$nickserv_pass` onto the wire as a password would
  be worse than an empty one). Only these two tokens are variables; other
  `$…` sequences (e.g. `$nick`) pass through verbatim.

  ## Suppression signal (`consumed_nickserv_pass?`)

  `true` iff an EXECUTED (non-comment, non-blank) line actually substituted
  a present NickServ password. This is the exact structural signal
  `Grappa.Session.Server` uses to skip its built-in identify — NOT a text
  scan for `identify`/`ns id` verbs, which the codebase deliberately rejects
  (`NSInterceptor` moduledoc). A `$nickserv_pass` sitting in a COMMENTED-OUT
  line does not count: it was never executed.

  Boundary: inherits the parent `Grappa.Session` boundary (no `use
  Boundary`), same as `Grappa.Session.NSInterceptor`.
  """

  @type secrets :: %{
          required(:nickserv_pass) => String.t() | nil,
          required(:oper_pass) => String.t() | nil
        }

  @typedoc """
  `lines` are the executable wire lines, in order, with secrets already
  substituted — so they are NEVER safe to log (a line may carry a literal
  password the user pasted instead of a variable). The caller logs a
  redaction: the line COUNT and total byte size, never the text.
  """
  @type result :: %{lines: [String.t()], consumed_nickserv_pass?: boolean()}

  # Both variable tokens in one alternation → single-pass Regex.replace, so a
  # substituted value containing `$…` is never re-scanned.
  @var_re ~r/\$(nickserv_pass|oper_pass)/
  @nickserv_var "$nickserv_pass"

  @doc """
  Expands `text` against `secrets`. Returns the executable lines (in order)
  and the `consumed_nickserv_pass?` suppression signal. `nil`/blank text
  yields no lines.
  """
  @spec expand(String.t() | nil, secrets()) :: result()
  def expand(nil, _), do: %{lines: [], consumed_nickserv_pass?: false}

  def expand(text, secrets) when is_binary(text) do
    parsed =
      text
      |> String.split(~r/\r\n|\r|\n/)
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&skip_line?/1)
      |> Enum.map(&expand_line(&1, secrets))

    %{
      lines: Enum.map(parsed, & &1.line),
      consumed_nickserv_pass?: Enum.any?(parsed, & &1.consumed?)
    }
  end

  @spec skip_line?(String.t()) :: boolean()
  defp skip_line?(""), do: true
  defp skip_line?("#" <> _), do: true
  defp skip_line?(_), do: false

  defp expand_line(line, secrets) do
    %{
      line: Regex.replace(@var_re, line, fn _, var -> value_for(var, secrets) end),
      consumed?: String.contains?(line, @nickserv_var) and is_binary(secrets[:nickserv_pass])
    }
  end

  defp value_for("nickserv_pass", secrets), do: secrets[:nickserv_pass] || ""
  defp value_for("oper_pass", secrets), do: secrets[:oper_pass] || ""
end
