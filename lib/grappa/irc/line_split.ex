defmodule Grappa.IRC.LineSplit do
  @moduledoc """
  Splits a PRIVMSG body into wire-frame-fitting fragments.

  The IRC server's max line length (`LINELEN`, advertised via
  `005 RPL_ISUPPORT LINELEN=<N>` or RFC 2812's 512-byte default)
  bounds the WHOLE wire frame including the `PRIVMSG <target> :`
  prefix and trailing `\\r\\n`. This module computes the per-frame
  body budget, splits the body on grapheme boundaries (UTF-8
  safe), and returns one body per fragment. Caller wraps each in
  the envelope.

  ## Why the budget reserves the RELAYED source prefix (#246)

  A client's OWN outbound line omits the source prefix — grappa
  sends `PRIVMSG <target> :<body>\\r\\n`. But the server, when it
  fans that line out to the OTHER channel members, prepends the
  originator's identity:

      :nick!user@host PRIVMSG <target> :<body>\\r\\n

  That relayed line — not grappa's client-side line — is what the
  server holds against `LINELEN`. If the body budget reserves only
  the client-side `PRIVMSG <target> :\\r\\n` framing, a fragment can
  be ≤ `LINELEN` on grappa's wire yet exceed it once relayed → the
  server truncates the tail → the next fragment resumes past the
  cut → a SILENT byte hole of ~(source-prefix length) at every
  boundary. Invisible on grappa's own echo; only recipients see it.

  So the budget reserves the WORST-CASE source prefix, not the live
  one: `host`/cloak length can grow between messages (a rebind, an
  oper cloak, an IPv6 vs reverse-DNS host), so budgeting against the
  current prefix would under-reserve the moment it grows. The
  worst-case ceilings are grappa's own documented identity maxima
  plus the common ircd `HOSTLEN`:

    * nick  ≤ 30 — `Grappa.IRC.Identifier` `@nick_regex` ceiling
      (Azzurra/bahamut `NICKLEN=30`); grappa's own nick can never
      register longer.
    * ident ≤ 10 — `Grappa.IRC.Identifier` `@ident_regex` ceiling
      (common ircd `USERLEN`); the server's `~` no-identd prefix is
      counted within `USERLEN`, so 10 bounds the on-wire ident.
    * host  ≤ 63 — the `HOSTLEN` of the ircds grappa targets (bahamut
      on Azzurra, solanum on Libera). Covers hostnames, hex/vhost
      cloaks, and bracketed IPv6 literals (max `[` + 45 + `]` = 47).
      Not advertised in 005, so a fixed worst case is the posture.
      This is a DEPLOYED-ircd ceiling, NOT a universal one: a network
      with `HOSTLEN` > 63 (e.g. InspIRCd's default `maxhost=64`)
      under-reserves the prefix and RE-OPENS this exact silent
      truncation data loss (smaller — ~`HOSTLEN − 63` bytes per
      boundary). Over-reserve is safe, under-reserve is the bug: so
      `@max_host_bytes` MUST be raised before pointing grappa at any
      ircd with a larger `HOSTLEN`. RFC 2812 does not bound the host;
      the RFC/DNS ceiling would be 253, chosen against here only to
      avoid tripling fragmentation on the networks grappa runs on.

  Over-reserving costs a few extra fragments on long messages only
  (short messages stay on the `[body]` fast path); under-reserving
  loses data. For a silent-data-loss bug, worst-case is the only
  safe budget. See `relay_frame_overhead/1`.

  ## Word boundaries and the whitespace policy (#1109)

  Within the byte budget the cut prefers the LAST word boundary at or
  before the budget; only when the chunk holds no boundary does it fall
  back to the byte cut. A single token longer than the budget — a URL, a
  base64 blob, a wall of CJK — therefore still splits mid-token rather
  than looping or being dropped.

  The boundary search may only ever SHRINK a fragment, never grow one, so
  the #246 relay-safety guarantee above is preserved by construction: no
  fragment can gain a byte from this.

  **The boundary whitespace is CONSUMED** — exactly one grapheme, the one
  the break lands on. That is what every word-wrap does, and it drops no
  non-whitespace byte, so the fragments no longer rejoin byte-identically:
  they TILE the body, separated by at most that one consumed grapheme.
  Callers that need the original bytes back must keep the original.

  A boundary is an ASCII space or tab, deliberately and not a broader
  Unicode whitespace class: NO-BREAK SPACE (U+00A0) and its relatives
  exist precisely to forbid a break, so treating them as boundaries would
  invert their meaning. A newline cannot appear in a body — it would have
  ended the wire frame.

  ## Why server-side

  Per CLAUDE.md "IRC is bytes; the web is UTF-8" + "one parser,
  on the server" — payload framing belongs to grappa, not cic.
  cic POSTs an arbitrary-length string; grappa fans out the
  fragments. Each fragment becomes its own scrollback row + its
  own upstream PRIVMSG, matching what every other IRC client
  renders + what the operator's own past view will reconstruct.

  ## cic PREVIEWS this, and that is a mirror you must maintain (#1108)

  The compose box warns before a send that the draft will split, and
  states how many messages it becomes. That number cannot be asked for —
  it has to be on screen before any POST — and it is not derivable from
  the budget by arithmetic once breaks land on words. So
  `cicchetto/src/lib/frameBudget.ts` reimplements the chunker below.

  The wire split is still ONLY this module's; a drift costs an advisory
  count off by a frame, never a byte. But the two are pinned to each
  other by one shared table of `(budget, body) → fragment count` cases,
  duplicated verbatim in `line_split_test.exs` ("#1108: the fragment
  counts cic's preview mirrors") and `frameBudget.test.ts`. **Changing
  `chunk_by_bytes/5` or `break_at_word/1` turns that table red here, and
  the fix is not complete until the cic side moves with it.**

  What cic does NOT own is the BUDGET: the worst-case ceilings above stay
  here, published as `frame_budget_base/1` on the `isupport_changed`
  payload. A second copy of THOSE is the #246 data loss again.

  ## CTCP awareness

  A body beginning with `\\x01ACTION ` is a CTCP ACTION (classified
  via the shared `Grappa.IRC.CTCP.action?/1`). Fragmenting NAIVELY
  would emit `\\x01ACTION text-chunk-1` (no trailing `\\x01`) and
  `text-chunk-2\\x01` (no leading envelope) — both garbage on the
  wire. This module preserves the envelope on every fragment so
  each one is a self-contained valid CTCP message (the optional
  trailing `\\x01` is stripped once and re-added per fragment).
  Budget accounts for the per-fragment overhead.

  Other CTCP verbs (`\\x01VERSION\\x01`, DCC, etc.) are single-
  line by convention; this module's CTCP detection only triggers
  for ACTION.
  """

  # Worst-case source prefix `:nick!user@host ` the RELAYING server
  # prepends before fanning our line out to other members (#246). See the
  # moduledoc for the per-field ceiling rationale. Sigils: `:` `!` `@` and
  # the trailing space = 4 fixed bytes.
  @max_nick_bytes 30
  @max_ident_bytes 10
  @max_host_bytes 63
  @source_prefix_reserve 1 + @max_nick_bytes + 1 + @max_ident_bytes + 1 + @max_host_bytes + 1

  @doc """
  Worst-case bytes the RELAYED wire frame adds around a fragment body for
  `target`: the source prefix the server prepends, plus the
  `PRIVMSG <target> :` command/target framing, plus the trailing `\\r\\n`.

  This is the amount `split_privmsg_body/3` subtracts from `linelen` to get
  the body budget, so a fragment sized to `linelen - relay_frame_overhead(target)`
  is guaranteed to fit `linelen` once the server relays it with the
  worst-case `:nick!user@host ` prefix. See the moduledoc.
  """
  @spec relay_frame_overhead(String.t()) :: pos_integer()
  def relay_frame_overhead(target) when is_binary(target) do
    @source_prefix_reserve + byte_size("PRIVMSG #{target} :") + byte_size("\r\n")
  end

  @doc """
  The per-frame body budget for `target` on a `linelen`-byte wire: the bytes a
  fragment may hold once the worst-case relayed framing is reserved. Can go
  non-positive on an absurdly small `linelen` — `split_privmsg_body/3` treats
  that as "no useful split".
  """
  @spec frame_budget(String.t(), pos_integer()) :: integer()
  def frame_budget(target, linelen) when is_binary(target) and is_integer(linelen) do
    linelen - relay_frame_overhead(target)
  end

  @doc """
  The TARGET-INDEPENDENT part of `frame_budget/2`, published to clients (#1108).

  `frame_budget(target, linelen) == frame_budget_base(linelen) - byte_size(target)`,
  because `relay_frame_overhead/1` is affine in the target's byte length. So one
  per-network scalar is enough for a client to size the budget of any target it
  can name, without owning a second copy of the #246 worst-case ceilings — the
  numbers whose whole reason for living here is that a client-side copy drifts
  silently in the direction that LOSES bytes.

  The client's half of the arithmetic is the length of a string it already
  holds; the ceilings stay here.
  """
  @spec frame_budget_base(pos_integer()) :: integer()
  def frame_budget_base(linelen) when is_integer(linelen), do: frame_budget("", linelen)

  @doc """
  Splits `body` into fragments that fit within `linelen` bytes
  per wire frame, given the target prefix.

  Each fragment is sized so that, once the server RELAYS it as
  `:nick!user@host PRIVMSG <target> :<fragment>\\r\\n` with the worst-case
  source prefix, the whole line is ≤ `linelen` (#246) — not merely
  grappa's prefix-less client-side line.

  Returns a non-empty list of UTF-8 strings, each one a valid
  PRIVMSG body for `target`. Single-fragment input returns
  `[body]` unchanged (fast path).

  Fragments break on word boundaries where the chunk has one, and the
  boundary whitespace is consumed — see the moduledoc's whitespace
  policy. Rejoining the fragments therefore reproduces the body only up
  to those consumed graphemes.
  """
  @spec split_privmsg_body(String.t(), String.t(), pos_integer()) :: [String.t(), ...]
  def split_privmsg_body(body, target, linelen)
      when is_binary(body) and is_binary(target) and is_integer(linelen) and linelen > 0 do
    budget = frame_budget(target, linelen)

    cond do
      budget <= 0 -> [body]
      byte_size(body) <= budget -> [body]
      Grappa.IRC.CTCP.action?(body) -> split_ctcp_action(body, budget)
      true -> split_plain(body, budget)
    end
  end

  defp split_plain(body, budget) do
    body
    |> String.graphemes()
    |> chunk_by_bytes(budget, [], [], 0)
  end

  defp split_ctcp_action(body, budget) do
    inner =
      body
      |> String.replace_prefix("\x01ACTION ", "")
      |> String.replace_suffix("\x01", "")

    envelope_overhead = byte_size("\x01ACTION ") + byte_size("\x01")
    inner_budget = budget - envelope_overhead

    if inner_budget <= 0 do
      [body]
    else
      inner
      |> String.graphemes()
      |> chunk_by_bytes(inner_budget, [], [], 0)
      |> Enum.map(fn chunk -> "\x01ACTION " <> chunk <> "\x01" end)
    end
  end

  defp chunk_by_bytes([], _, current_chunk, acc, _) do
    case flush_chunk(current_chunk, acc) do
      [] -> [""]
      list -> Enum.reverse(list)
    end
  end

  defp chunk_by_bytes([g | rest], budget, current_chunk, acc, current_size) do
    g_size = byte_size(g)

    cond do
      g_size > budget ->
        acc = flush_chunk(current_chunk, acc)
        chunk_by_bytes(rest, budget, [], [g | acc], 0)

      current_size + g_size > budget ->
        # Budget reached. Prefer the last word boundary inside the chunk
        # (#1109); `g` goes back on the input because the carry-over may
        # already leave no room for it.
        {chunk_str, carry, carry_size} = break_at_word(current_chunk)
        chunk_by_bytes([g | rest], budget, carry, [chunk_str | acc], carry_size)

      true ->
        chunk_by_bytes(rest, budget, [g | current_chunk], acc, current_size + g_size)
    end
  end

  # Cut `reversed_chunk` at its LAST word boundary, returning the fragment
  # to emit plus the graphemes that carry over into the next chunk (still
  # reversed, with their byte size). The boundary whitespace is CONSUMED.
  #
  # Falls back to the byte cut — emit the whole chunk, carry nothing — when
  # there is no boundary to use, which is both the single-oversized-token
  # case (URL, base64, CJK wall) and the case where the only whitespace is
  # the chunk's first grapheme, since breaking there would emit an empty
  # fragment. This can only ever SHRINK a fragment, never grow one, so the
  # #246 relay-safety budget is untouched by construction.
  defp break_at_word(reversed_chunk) do
    case split_at_last_break(reversed_chunk, []) do
      {[_ | _] = before_reversed, carry_in_order} ->
        fragment = IO.iodata_to_binary(Enum.reverse(before_reversed))
        {fragment, Enum.reverse(carry_in_order), IO.iodata_length(carry_in_order)}

      _ ->
        {IO.iodata_to_binary(Enum.reverse(reversed_chunk)), [], 0}
    end
  end

  # Walks the reversed chunk head-first, so the FIRST break grapheme it
  # meets is the LAST one in reading order. Returns the graphemes before
  # the boundary (still reversed) and those after it (in order); `:none`
  # when the chunk holds no boundary at all.
  defp split_at_last_break([], _), do: :none

  defp split_at_last_break([g | rest], carry) do
    if break_space?(g), do: {rest, carry}, else: split_at_last_break(rest, [g | carry])
  end

  # ASCII space and tab only, deliberately. A broader Unicode class would
  # drag in NO-BREAK SPACE (U+00A0) and friends, whose entire purpose is to
  # forbid the break we would then take — and IRC's own word separator is
  # the space. A newline cannot reach here: it would have ended the frame.
  defp break_space?(" "), do: true
  defp break_space?("\t"), do: true
  defp break_space?(_), do: false

  defp flush_chunk([], acc), do: acc

  defp flush_chunk(chunk, acc),
    do: [IO.iodata_to_binary(Enum.reverse(chunk)) | acc]
end
