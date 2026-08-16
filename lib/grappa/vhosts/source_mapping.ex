defmodule Grappa.Vhosts.SourceMapping do
  @moduledoc """
  Pure derivation of a deterministic outbound source address from a
  client's network prefix — the core of the #543
  `static_mapping_with_reservations` addressing mode.

  Each untrusted subject egresses from ONE stable address inside the
  configured derivation `/80`, derived from the subject's OWN client `/64`
  (v6) or `/32` (v4). This replaces the random pool for mode 2: an
  address is `derive(client_key(client_ip), prefix)` — same client, same
  address, forever (until the operator renumbers the prefix).

  ## The mapping key (`client_key/1`)

  The key is the client's routable prefix, NOT its full address:

    * IPv6 → the first 64 bits (the `/64`). The interface id is IGNORED
      because RFC 8981 rotates it (privacy extensions) — keying on it
      would hand a single roaming laptop a new outbound address every
      few hours, defeating accountability. Keying on the `/64` gives a
      home/mobile subscriber ONE address for the life of their prefix.
    * IPv4 → all 32 bits (the `/32`).

  A NAT/CGNAT that collapses many clients behind one prefix to a single
  derived address is INTENDED ("come se si collegassero direttamente"):
  they share an upstream vantage point, so they share an egress.

  ## The derivation is KEYED (#1404, correcting #543)

  `derive/2` fills the host bits of the prefix from
  `hmac_sha256(deployment_key, client_key)`.

  #543 shipped this as a bare `sha256(@domain_tag <> client_key)` on the
  premise, stated in this moduledoc, that reversibility was irrelevant
  because the mapping runs client-prefix → our-own-block rather than
  holding a secret. **That premise does not survive contact with what the
  output IS**: the derived address is the host the ircd publishes for the
  session, the input space is a single client prefix, and the domain tag
  was a public constant in this file. Anyone who can see the published
  host can confirm a guessed input. Hiding the subscriber behind the
  bouncer is the property the bouncer exists to provide, so this is the
  one derivation in the codebase where reversibility is the whole point.

  The MAC keeps every property #543 actually relied on. HMAC-SHA256 is
  the same near-uniform spread over the host bits, so the collision math
  below is unchanged; determinism is unchanged (same client, same
  address); only guessability moves.

  ## The key, and why there is no default

  The key is derived ONCE at boot from the deployment's
  `secret_key_base`, domain-separated by `@domain_tag`, and stashed in
  `:persistent_term` (`boot/1`) — the CLAUDE.md non-process DI seam, as
  `Grappa.HttpHosts` and `Grappa.Net.SourceAlias.Config` do. No new
  operator secret: `secret_key_base` is already mandatory, already
  secret, and already the root of every other derived key here.

  `mac_key/0` deliberately has **no default**. Every other
  `:persistent_term` seam in the codebase defaults to a value that
  preserves graceful degradation; a key cannot, because the only
  available default is a constant every reader of this file knows, which
  is exactly the defect being fixed. An unbooted node raises rather than
  silently deriving a guessable address.

  ## Operator consequence — this renumbers a mode-2 deployment ONCE

  Derived addresses are computed on demand and never stored (only the
  client KEY is persisted), so changing the derivation is operationally
  the same event as the operator renumbering the prefix, which this
  design already supports: every subject moves to one new stable address
  at its next connect, and `Grappa.Net.SourceAliasManager` reconciles the
  alias set at boot. Deployments on the DEFAULT `pool_with_reservations`
  mode derive nothing and are unaffected. Rotating `secret_key_base`
  renumbers a mode-2 deployment for the same reason — see
  `docs/OPERATIONS.md`.

  `@domain_tag` still provides domain separation, now as the key
  derivation's label rather than as a message prefix. It remains a
  namespace label and is still NOT the secret.

  ## Collision math

  For a `/80` prefix the host part is 48 bits. By the birthday bound the
  expected first collision arrives around `2^(48/2) = 2^24 ≈ 16.7M`
  distinct client prefixes mapped into the block. Real deployments map
  thousands, not millions, of distinct `/64`s, so in practice the map is
  injective; reservations (which win over derivation) live OUTSIDE the
  `::cb` block, so a derived address can never shadow a reserved one.

  ## Boundary

  Sub-module of the `Grappa.Vhosts` boundary (which already deps
  `Grappa.Net.IpLiteral`); it declares no boundary of its own and is not
  exported — every caller (`Vhosts.effective_source/*`,
  `Vhosts.record_client_source/*`, `Vhosts.prefix_impact/*`) sits inside
  the same boundary.
  """

  alias Grappa.Net.IpLiteral

  # Domain separation for the key derivation — a namespace label, NOT a
  # secret. Bumping the version suffix renumbers a mode-2 deployment, so
  # it is a deliberate operator-visible act, not a refactor.
  @domain_tag "grappa/source-mapping/v1"

  @mac_key {__MODULE__, :mac_key}

  @doc """
  Derive the deployment's source-mapping MAC key from `secret_key_base`
  and stash it in `:persistent_term`. Called once from
  `Grappa.Application.start/2`.

  PBKDF2 via `Plug.Crypto.KeyGenerator` rather than using
  `secret_key_base` directly, so this purpose gets its own subkey and
  never shares key material with `Phoenix.Token` or any other consumer
  of the same root. Run once at boot, never per derivation.
  """
  @spec boot(String.t()) :: :ok
  def boot(secret_key_base) when is_binary(secret_key_base) do
    :persistent_term.put(@mac_key, Plug.Crypto.KeyGenerator.generate(secret_key_base, @domain_tag))
    :ok
  end

  # No default, deliberately — see the moduledoc. An unbooted node must
  # raise here rather than fall back to a constant that is public by
  # construction.
  @spec mac_key() :: binary()
  defp mac_key, do: :persistent_term.get(@mac_key)

  @doc """
  Reduces a client IP tuple to its routable-prefix key: the v6 `/64`
  (first 8 bytes, interface id dropped) or the v4 `/32` (4 bytes). This
  binary is the mapping key fed to `derive/2` and persisted per subject.
  """
  @spec client_key(:inet.ip_address()) :: binary()
  def client_key({a, b, c, d, _, _, _, _}), do: <<a::16, b::16, c::16, d::16>>
  def client_key({a, b, c, d}), do: <<a, b, c, d>>

  @doc """
  Derives the deterministic source address for `key` inside `prefix_cidr`.

  Keeps the prefix's network bits verbatim and fills the host bits from
  `hmac_sha256(mac_key(), key)`, returning a canonical v6 literal
  strictly inside `prefix_cidr`. Deterministic and idempotent for a given
  `(key, prefix_cidr)` on a given deployment; two deployments with
  different `secret_key_base` derive different addresses from the same
  client, which is the #1404 property.

  Returns `{:error, :invalid_prefix}` when `prefix_cidr` is not a strict
  IPv6 CIDR (`parse_cidr6/1` rejects it). Raises if `boot/1` has not run
  — a missing key is a boot defect, never a reason to degrade to a
  guessable address.
  """
  @spec derive(binary(), String.t()) :: {:ok, String.t()} | {:error, :invalid_prefix}
  def derive(key, prefix_cidr) when is_binary(key) do
    case IpLiteral.parse_cidr6(prefix_cidr) do
      {:ok, {net_tuple, len}} ->
        host_bits = 128 - len
        <<net::size(len), _::bitstring>> = ip6_bits(net_tuple)
        # HMAC-SHA256 is 256 bits ≥ host_bits (≤128) for any len, so this
        # match holds for EVERY prefix length — no /8-alignment needed.
        <<host::size(host_bits), _::bitstring>> = :crypto.mac(:hmac, :sha256, mac_key(), key)
        # net ‖ host is exactly 128 bits regardless of where `len` falls,
        # so re-slice it straight into the 8×16 tuple (no integer round-trip).
        <<a::16, b::16, c::16, d::16, e::16, f::16, g::16, h::16>> =
          <<net::size(len), host::size(host_bits)>>

        {:ok, {a, b, c, d, e, f, g, h} |> :inet.ntoa() |> to_string()}

      :error ->
        {:error, :invalid_prefix}
    end
  end

  @doc """
  True when `addr` (a v6 literal) sits inside `prefix_cidr`. Any non-v6
  address, malformed literal, or malformed prefix returns `false`. Used
  by the INC-7 prefix-impact scan and the adapter's in-prefix guard.

  Thin alias for `Grappa.Net.IpLiteral.in_cidr6?/2` — the CIDR-membership
  math is a pure `Net.IpLiteral` primitive (the #543 source-alias adapter
  in-prefix guard reuses the SAME function), kept there once rather than
  duplicated per caller (CLAUDE.md "implement once, reuse everywhere").
  """
  @spec in_prefix?(String.t(), String.t()) :: boolean()
  def in_prefix?(addr, prefix_cidr), do: IpLiteral.in_cidr6?(addr, prefix_cidr)

  # ---- v6 bit helper (8×16 tuple → 128-bit binary) --------------------------
  #
  # Bitstring-space, distinct from IpLiteral's integer-space helpers: the
  # network/host split in `derive/2` lands on arbitrary (non-byte) bit
  # boundaries, which the shift-based `IpLiteral.mask_prefix/2` can't express.

  defp ip6_bits({a, b, c, d, e, f, g, h}),
    do: <<a::16, b::16, c::16, d::16, e::16, f::16, g::16, h::16>>
end
