defmodule Grappa.IRC.CTCP do
  @moduledoc """
  CTCP framing classification.

  CTCP messages ride inside a normal PRIVMSG body wrapped in `\\x01`
  delimiters: `\\x01<VERB> <args>\\x01`. The only verb that earns its own
  scrollback kind today is `ACTION` (what `/me` emits); every other verb
  (VERSION, PING, DCC, …) persists as a plain `:privmsg` until Phase 5+.

  This module is the single source of truth for "is this body a CTCP
  ACTION frame?". Both the inbound path (`Grappa.Session.EventRouter`,
  classifying a received PRIVMSG) and the outbound path
  (`Grappa.Session.Server`, classifying the operator's own self-echoed
  send) MUST agree — issue #14 was exactly the two paths drifting: the
  inbound classifier said `:action`, the outbound persist hardcoded
  `:privmsg`, so the operator's own `/me` rendered as raw `<nick> ACTION
  text` in cic. `Grappa.IRC.LineSplit` also calls this to decide whether
  to preserve the ACTION envelope across wire-frame fragments.

  Per CLAUDE.md "IRC is bytes" — the classifier matches on raw bytes
  (`\\x01` == `0x01`), never on a decoded string.
  """

  @doc """
  True iff `body` opens with the CTCP ACTION frame `\\x01ACTION ` (note
  the mandatory space separating the verb from its argument).

  Lenient on the closing `\\x01`: CTCP's trailing delimiter is optional
  and some clients omit it, so the classification keys only on the
  opening frame. `\\x01ACTION\\x01` (no space) is NOT an ACTION frame —
  it carries no argument and matches the stricter verb-only shape.
  """
  @spec action?(binary()) :: boolean()
  def action?(<<0x01, "ACTION ", _::binary>>), do: true
  def action?(_), do: false

  @doc """
  True iff `body` is CTCP-framed at all — it opens with `\x01`, whatever
  the verb.

  Where `action?/1` asks "is this the one verb that IS conversation",
  this asks the complement: "is this protocol rather than something
  somebody said". A CTCP reply (`\x01PING 1234\x01`, `\x01VERSION …\x01`)
  arrives as a NOTICE from a peer's nick and would otherwise be routed
  like any peer NOTICE — persisted under that peer and minting a query
  window for them, with a row of control characters in it. Pinging
  somebody would leave a tab open with them.

  Lenient on the closing `\x01` for the same reason `action?/1` is: the
  trailing delimiter is optional and clients omit it.
  """
  @spec framed?(binary()) :: boolean()
  def framed?(<<0x01, _::binary>>), do: true
  def framed?(_), do: false
end
