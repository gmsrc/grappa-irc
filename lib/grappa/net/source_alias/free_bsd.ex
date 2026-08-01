defmodule Grappa.Net.SourceAlias.FreeBSD do
  @moduledoc """
  FreeBSD-jail source-alias adapter (#543). Binds a derived `::cb::/80`
  address as a `/128` alias on `lo0` through the sudoers-scoped wrapper
  `infra/freebsd/bin/grappa-source-alias`, invoked via the hardened command
  seam (`Grappa.Net.SourceAlias.Config.cmd/0`).

  The wrapper — not a bare `sudo ifconfig` — is the privilege boundary: it
  hard-codes `lo0` + `/128` and refuses any address outside the compiled/env
  prefix (an unconstrained `sudo ifconfig` is a privilege hole, Global
  Constraint). This adapter mirrors that guard in-process (`in_cidr6?/2`
  BEFORE shelling) so an out-of-prefix address never even reaches `sudo`.

  `ensure_source` / `release_source` add / delete the alias; `arm_check`
  proves the sudoers grant works via the wrapper's no-op `check` subcommand;
  `list_aliases` reads `ifconfig lo0` (unprivileged, no sudo) and returns the
  inet6 addresses inside the prefix — the ground truth for boot reconcile.
  """

  @behaviour Grappa.Net.SourceAlias

  alias Grappa.Net.IpLiteral
  alias Grappa.Net.SourceAlias.Config

  # sudoers-scoped wrapper; resolved on the operator's secure_path (see
  # docs/OPERATIONS.md). subcommands: add | del | check.
  @wrapper "grappa-source-alias"
  # Wall-clock ceiling for the ifconfig shell-out — an alias add/del is
  # sub-second; 10s is generous slack, not a tuning knob.
  @timeout_s 10

  @impl Grappa.Net.SourceAlias
  def arm_check(prefix) do
    case IpLiteral.parse_cidr6(prefix) do
      {:ok, _} ->
        # Prove the NOPASSWD sudoers grant + wrapper are actually present.
        # `-n` (non-interactive) turns a missing grant into an immediate
        # non-zero instead of a password prompt that would hang boot.
        case Config.cmd().run("sudo", ["-n", @wrapper, "check"], @timeout_s) do
          {:ok, _} -> :ok
          {:error, _} -> {:error, :wrapper_unavailable}
        end

      :error ->
        {:error, :invalid_prefix}
    end
  end

  @impl Grappa.Net.SourceAlias
  def ensure_source(addr, prefix), do: alias_op("add", addr, prefix)

  @impl Grappa.Net.SourceAlias
  def release_source(addr, prefix), do: alias_op("del", addr, prefix)

  @impl Grappa.Net.SourceAlias
  # #627 — no prefix means mode 2 is unconfigured: no block to list aliases
  # inside, so the answer is empty WITHOUT shelling `ifconfig`. Belt-and-braces
  # with the manager's reconcile early-return — keeps the adapter contract
  # total (never raises) for the nil prefix of a mode-1 / fresh install, rather
  # than parsing `lo0` and filtering `::1` through `in_cidr6?(_, nil)`.
  def list_aliases(nil), do: {:ok, []}

  def list_aliases(prefix) when is_binary(prefix) do
    case Config.cmd().run("ifconfig", ["lo0"], @timeout_s) do
      {:ok, output} -> {:ok, parse_lo0_inet6(output, prefix)}
      {:error, _} = err -> err
    end
  end

  # Guard in-prefix BEFORE shelling — the process must never attempt an
  # out-of-scope ifconfig even though the wrapper would also refuse it.
  defp alias_op(subcommand, addr, prefix) do
    if IpLiteral.in_cidr6?(addr, prefix) do
      case Config.cmd().run("sudo", [@wrapper, subcommand, addr], @timeout_s) do
        {:ok, _} -> :ok
        {:error, _} = err -> err
      end
    else
      {:error, :outside_prefix}
    end
  end

  # Extract the inet6 addresses from `ifconfig lo0` output that fall inside
  # `prefix`. Lines look like `\tinet6 2a03:4000:20:2d3:cb::1 prefixlen 128`;
  # a link-local carries a `%lo0` zone we strip before the membership test.
  #
  # Each address is CANONICALIZED (`IpLiteral.canonicalize/1`, i.e. the same
  # `:inet.ntoa` form the manager's held keys carry) before it is returned, so
  # the reconcile set-diff (OS-bound vs held) compares like-for-like. Without
  # this, `ifconfig`'s spelling of an address vs `SourceMapping.derive/2`'s
  # (`:inet.ntoa`) could differ for the same address and reconcile would
  # classify a live, held alias as an orphan and release it — an outage-class
  # trap once INC-6 wires real holders. An unparseable token is dropped.
  defp parse_lo0_inet6(output, prefix) do
    output
    |> String.split("\n", trim: true)
    |> Enum.flat_map(&inet6_addr/1)
    |> Enum.filter(&IpLiteral.in_cidr6?(&1, prefix))
  end

  # One canonical inet6 address from an `ifconfig` line (zone stripped), or []
  # for a non-inet6 line / unparseable token.
  defp inet6_addr(line) do
    case line |> String.trim() |> String.split() do
      ["inet6", addr | _] -> canonical_or_drop(addr)
      _ -> []
    end
  end

  defp canonical_or_drop(addr) do
    case addr |> String.split("%") |> hd() |> IpLiteral.canonicalize() do
      {:ok, canon} -> [canon]
      :error -> []
    end
  end
end
