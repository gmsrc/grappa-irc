defmodule Grappa.Net.IpLiteral do
  @moduledoc """
  Strict IPv4/IPv6 literal parsing + canonicalization — the single
  source of truth for "is this a bindable source address literal?"

  ## Why this exists

  `Grappa.Networks.Server` and `Grappa.Vhosts.Vhost` (#228) both persist
  a source-address column that MUST be a strict IP literal (no hostname,
  no CIDR, no zero-padded octet), stored in canonical form so the stored
  bytes are stable regardless of how the operator typed the address. The
  strict-parse + `:inet.ntoa/1` canonicalization rule was born in
  `Server.validate_source_address/1`; extracting it here means the vhost
  changeset validates through the SAME rule instead of a copy-paste
  (CLAUDE.md "implement once, reuse everywhere").

  Strictness matters: a strict parse makes the bind family unambiguous
  (`family/1`) and the pool set-difference a static comparison — a
  loose parse would accept `192.000.002.001` as a distinct string from
  its canonical `192.0.2.1`, forking pool membership + exclusion checks.
  """

  use Boundary, top_level?: true, deps: []

  import Bitwise

  @doc """
  Parses `value` as a strict IPv4 or IPv6 literal and returns it in
  canonical form (`:inet.ntoa/1` — lowercase compressed v6, unpadded v4).

  Returns `:error` for a hostname, CIDR block, empty string,
  zero-padded octet, or any non-literal — the strictness the source-bind
  path depends on.
  """
  @spec canonicalize(String.t()) :: {:ok, String.t()} | :error
  def canonicalize(value) when is_binary(value) do
    charlist = String.to_charlist(value)

    case {:inet.parse_ipv4strict_address(charlist), :inet.parse_ipv6strict_address(charlist)} do
      {{:ok, tuple}, _} -> {:ok, to_string(:inet.ntoa(tuple))}
      {_, {:ok, tuple}} -> {:ok, to_string(:inet.ntoa(tuple))}
      _ -> :error
    end
  end

  @doc """
  Parses `value` as a strict IPv4/IPv6 literal and returns the parsed
  `:inet` tuple, or `:error` for any non-literal.

  The tuple form is what `:inet` reverse-DNS APIs consume — the #252
  vhost PTR resolver parses the persisted canonical address string back
  to a tuple before building the `in-addr.arpa` / `ip6.arpa` query name.
  Routes through the SAME strict-parse rule as `canonicalize/1`, so an
  input `canonicalize/1` would reject is rejected here identically.
  """
  @spec to_tuple(String.t()) :: {:ok, :inet.ip_address()} | :error
  def to_tuple(value) when is_binary(value) do
    charlist = String.to_charlist(value)

    case {:inet.parse_ipv4strict_address(charlist), :inet.parse_ipv6strict_address(charlist)} do
      {{:ok, tuple}, _} -> {:ok, tuple}
      {_, {:ok, tuple}} -> {:ok, tuple}
      _ -> :error
    end
  end

  @doc """
  Returns the address family (`:inet` / `:inet6`) of a strict IP
  literal. Raises `ArgumentError` on a non-literal — callers hold an
  already-validated literal (persisted through `canonicalize/1`), so a
  failure here is a broken invariant, not a runtime condition.
  """
  @spec family(String.t()) :: :inet | :inet6
  def family(value) when is_binary(value) do
    charlist = String.to_charlist(value)

    case :inet.parse_ipv4strict_address(charlist) do
      {:ok, _} ->
        :inet

      {:error, _} ->
        case :inet.parse_ipv6strict_address(charlist) do
          {:ok, _} -> :inet6
          {:error, _} -> raise ArgumentError, "not a strict IP literal: #{inspect(value)}"
        end
    end
  end

  @doc """
  Parses `value` as a strict IPv6 CIDR (`<v6-literal>/<0..128>`) and returns
  `{tuple, prefix_len}`. The address part goes through the SAME strict parse
  as `to_tuple/1`; the tuple is returned VERBATIM — host bits are NOT masked
  here (use `canonicalize_cidr6/1` for the masked network form).

  Returns `:error` for an IPv4 CIDR, a bare literal with no `/len`, a length
  outside `0..128`, a non-strict address, or any malformed input. The #543
  static-mapping derivation + prefix-impact scan consume `{tuple, len}`.
  """
  @spec parse_cidr6(String.t()) :: {:ok, {:inet.ip6_address(), 0..128}} | :error
  def parse_cidr6(value) when is_binary(value) do
    with [addr, len_str] <- String.split(value, "/", parts: 2),
         {len, ""} <- Integer.parse(len_str),
         true <- len in 0..128,
         {:ok, tuple} <- :inet.parse_ipv6strict_address(String.to_charlist(addr)) do
      {:ok, {tuple, len}}
    else
      _ -> :error
    end
  end

  @doc """
  Parses `value` as a strict IPv6 CIDR, masks the host bits below the prefix
  length to zero, and renders the network in canonical form (`<net>/<len>`,
  lowercase compressed). A prefix stored this way is stable regardless of how
  the operator typed it (case, compression, or an address carrying host bits).

  Returns `:error` for the same inputs `parse_cidr6/1` rejects.
  """
  @spec canonicalize_cidr6(String.t()) :: {:ok, String.t()} | :error
  def canonicalize_cidr6(value) when is_binary(value) do
    case parse_cidr6(value) do
      {:ok, {tuple, len}} ->
        network = tuple |> ip6_to_integer() |> mask_prefix(len) |> integer_to_ip6()
        {:ok, to_string(:inet.ntoa(network)) <> "/" <> Integer.to_string(len)}

      :error ->
        :error
    end
  end

  # ---- v6 bit helpers (128-bit int ↔ 8×16 tuple) -------------------

  defp ip6_to_integer({a, b, c, d, e, f, g, h}) do
    <<n::128>> = <<a::16, b::16, c::16, d::16, e::16, f::16, g::16, h::16>>
    n
  end

  defp integer_to_ip6(n) do
    <<a::16, b::16, c::16, d::16, e::16, f::16, g::16, h::16>> = <<n::128>>
    {a, b, c, d, e, f, g, h}
  end

  # Zero the low (128 - len) host bits. len=128 → no-op; len=0 → all zero.
  defp mask_prefix(n, len) do
    host_bits = 128 - len
    (n >>> host_bits) <<< host_bits
  end
end
