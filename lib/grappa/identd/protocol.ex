defmodule Grappa.Identd.Protocol do
  @moduledoc """
  RFC 1413 request parsing and response rendering — the whole wire format
  of the identd, with no socket in sight (issue 227).

  ## The two directions

  A query is one line carrying a port pair:

      <port-on-server> , <port-on-client>

  where "server" is the host running the identd — us, the side that
  OPENED the IRC connection — so the first port is our ephemeral source
  port and the second is the ircd's. A reply is the same pair followed by
  either the answer or a refusal:

      <port-on-server> , <port-on-client> : USERID : UNIX : <user-id>
      <port-on-server> , <port-on-client> : ERROR : NO-USER

  ## Nothing from the query reaches the wire

  The reply echoes the port pair, which looks like an echo of the request
  and must not become one: the ports go out re-rendered from the PARSED
  INTEGERS, so a query carrying `6667 :ERROR: USERID : UNIX : root` in
  the port slot cannot smuggle a second field into our line. The reply is
  CRLF-framed and a single line, which is exactly what makes an
  unvalidated byte an injection rather than a cosmetic defect.

  `parse_query/1` therefore refuses anything that is not two plain
  integers in `1..65535`, including a line with a byte above 127 — an
  ident query has no business being non-ASCII, and refusing early keeps
  `String.trim/1` off arbitrary bytes.

  ## One error type, deliberately not the RFC's

  RFC 1413 distinguishes `INVALID-PORT`, `NO-USER`, `HIDDEN-USER` and
  `UNKNOWN-ERROR`. Every refusal here is `NO-USER` (issue 227 ruling): a
  reply that varies with WHY we said no is an enumeration oracle for
  anyone who can reach the port, and the distinction buys an operator
  nothing they cannot get from the logs. A query too malformed to yield
  ports is answered `0 , 0 : ERROR : NO-USER` — `0` is not a legal port,
  so it can never be read as an answer about a real connection.

  ## CR/LF are built numerically

  `@crlf` is `<<13, 10>>` and not a source escape. These are the bytes
  the whole format frames on; written as escapes they have a habit of
  landing in the file as real control bytes.
  """

  @crlf <<13, 10>>

  # RFC 1413 §3: "USERID" replies carry an opsys field and a user-id of at
  # most 512 octets. Nothing we emit comes near it — an IRC ident is 10
  # characters and a nick barely more — but the ceiling is the format's,
  # so it is checked rather than assumed.
  @max_userid_bytes 512

  @type port_pair :: {1..65_535, 1..65_535}

  @doc """
  Parses one RFC 1413 query line into its `{server_port, client_port}`
  pair, or `:error` for anything else.

  Accepts the whitespace the grammar allows around the comma and either
  line terminator. Refuses a port outside `1..65535` (including `0`,
  which no connection can carry), trailing junk, a missing comma, a
  non-ASCII byte, and the empty line.
  """
  @spec parse_query(binary()) :: {:ok, port_pair()} | :error
  def parse_query(line) when is_binary(line) do
    if ascii?(line), do: parse_ascii(line), else: :error
  end

  @doc """
  Renders the affirmative reply for `user_id`, CRLF-terminated.

  The caller MUST have checked `safe_userid?/1` — `Grappa.Identd.Bindings`
  does it at the moment a binding is written, so an unsafe value never
  reaches a table this function can read from.
  """
  @spec userid_reply(1..65_535, 1..65_535, String.t()) :: binary()
  def userid_reply(server_port, client_port, user_id)
      when is_integer(server_port) and is_integer(client_port) and is_binary(user_id) do
    "#{server_port} , #{client_port} : USERID : UNIX : #{user_id}" <> @crlf
  end

  @doc """
  Renders the one refusal this identd knows, CRLF-terminated.

  `0 , 0` is the pair to pass when the query could not be parsed at all.
  """
  @spec error_reply(0..65_535, 0..65_535) :: binary()
  def error_reply(server_port, client_port)
      when is_integer(server_port) and is_integer(client_port) do
    "#{server_port} , #{client_port} : ERROR : NO-USER" <> @crlf
  end

  @doc """
  True iff `user_id` can be shipped as the last field of a reply line
  without breaking its framing.

  Rejects CR, LF and NUL (they end or split the line), the colon (it
  delimits the reply's fields), the empty string, and anything past the
  512-octet ceiling.

  Deliberately NOT `Grappa.IRC.Identifier.valid_ident?/1`, which is a
  stricter and DIFFERENT rule: an ident that was never set falls back to
  the nick (`Grappa.IRC.Identity.effective_ident/2`), and a nick may
  carry RFC-2812 punctuation — `foo[1]`, `a|b` — that `valid_ident?/1`
  refuses. The identd's job is to name the value already sent as
  `USER <ident>`, whatever shape it has; the only thing it may refuse is
  a value that would corrupt its own wire.
  """
  @spec safe_userid?(term()) :: boolean()
  def safe_userid?(user_id)
      when is_binary(user_id) and user_id != "" and byte_size(user_id) <= @max_userid_bytes do
    not String.contains?(user_id, [<<13>>, <<10>>, <<0>>, ":"])
  end

  def safe_userid?(_), do: false

  defp parse_ascii(line) do
    case String.split(line, ",", parts: 2) do
      [server, client] -> pair(parse_port(server), parse_port(client))
      _ -> :error
    end
  end

  defp pair({:ok, server_port}, {:ok, client_port}), do: {:ok, {server_port, client_port}}
  defp pair(_, _), do: :error

  defp parse_port(raw) do
    case Integer.parse(String.trim(raw)) do
      {number, ""} when number in 1..65_535 -> {:ok, number}
      _ -> :error
    end
  end

  defp ascii?(<<>>), do: true
  defp ascii?(<<byte, rest::binary>>) when byte < 128, do: ascii?(rest)
  defp ascii?(_), do: false
end
