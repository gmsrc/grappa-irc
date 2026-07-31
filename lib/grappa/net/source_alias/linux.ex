defmodule Grappa.Net.SourceAlias.Linux do
  @moduledoc """
  Native-Linux source-alias adapter (#543). Per-address binding is a NO-OP:
  an AnyIP local route makes the WHOLE configured `/80` bindable at once
  (`ip -6 route add local <prefix> dev lo`), and `net.ipv6.ip_nonlocal_bind=1`
  lets a socket source from an address the host does not literally own. So
  `ensure_source` / `release_source` do nothing — there is no per-address
  alias to add or remove, and therefore nothing for boot reconcile to sweep
  (`list_aliases` is always `{:ok, []}`).

  `arm_check` is the real work: it verifies BOTH prerequisites via the
  hardened command seam, refusing to arm (Global Constraint: never fall
  through to a shared kernel-default source) with a concrete reason when
  either is missing.
  """

  @behaviour Grappa.Net.SourceAlias

  alias Grappa.Net.IpLiteral
  alias Grappa.Net.SourceAlias.Config

  @timeout_s 10

  @impl Grappa.Net.SourceAlias
  def arm_check(prefix) do
    with {:ok, network} <- canonical_network(prefix),
         :ok <- check_nonlocal_bind(),
         :ok <- check_anyip_route(network) do
      :ok
    end
  end

  # No per-address alias on Linux (AnyIP covers the /80) — the guard still
  # rejects an out-of-prefix address to keep the contract uniform with the
  # FreeBSD adapter (a derived source is always in-prefix; a caller passing
  # something else is a bug worth surfacing).
  @impl Grappa.Net.SourceAlias
  def ensure_source(addr, prefix), do: noop_in_prefix(addr, prefix)

  @impl Grappa.Net.SourceAlias
  def release_source(addr, prefix), do: noop_in_prefix(addr, prefix)

  @impl Grappa.Net.SourceAlias
  def list_aliases(_), do: {:ok, []}

  defp noop_in_prefix(addr, prefix) do
    if IpLiteral.in_cidr6?(addr, prefix), do: :ok, else: {:error, :outside_prefix}
  end

  defp canonical_network(prefix) do
    case IpLiteral.canonicalize_cidr6(prefix) do
      {:ok, _} = ok -> ok
      :error -> {:error, :invalid_prefix}
    end
  end

  # net.ipv6.ip_nonlocal_bind must be 1, else a bind() to a non-owned
  # AnyIP address is EADDRNOTAVAIL.
  defp check_nonlocal_bind do
    case Config.cmd().run("sysctl", ["-n", "net.ipv6.ip_nonlocal_bind"], @timeout_s) do
      {:ok, output} ->
        if String.trim(output) == "1", do: :ok, else: {:error, :ip_nonlocal_bind_disabled}

      {:error, _} ->
        {:error, :ip_nonlocal_bind_unreadable}
    end
  end

  # The local routing table must carry an AnyIP `local <prefix>` route so the
  # kernel accepts every address in the block as locally bindable. `network`
  # is the canonical `<net>/<len>` (via IpLiteral) so operator/kernel spelling
  # differences don't false-negative.
  defp check_anyip_route(network) do
    case Config.cmd().run("ip", ["-6", "route", "show", "table", "local"], @timeout_s) do
      {:ok, output} ->
        if anyip_route_present?(output, network),
          do: :ok,
          else: {:error, :anyip_route_missing}

      {:error, _} ->
        {:error, :anyip_route_unreadable}
    end
  end

  # `ip route` prints `local <net>/<len> dev lo ...`.
  defp anyip_route_present?(output, network) do
    output
    |> String.split("\n", trim: true)
    |> Enum.any?(fn line ->
      trimmed = String.trim(line)

      String.starts_with?(trimmed, "local " <> network <> " ") or
        String.starts_with?(trimmed, "local " <> network <> "\t")
    end)
  end
end
