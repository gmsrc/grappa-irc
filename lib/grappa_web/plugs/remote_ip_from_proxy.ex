defmodule GrappaWeb.Plugs.RemoteIpFromProxy do
  @moduledoc """
  Conditionally rewrite `conn.remote_ip` from the X-Forwarded-For /
  X-Real-IP chain, treating loopback peers as legitimate proxies
  when they carry forwarded headers.

  Wraps the `RemoteIp` hex package. Same option shape: `headers:` +
  `proxies:` + `clients:` etc. are forwarded verbatim.

  ## Trust model

  Three cases, decided by `(peer_loopback?, has_xff?)`:

      | peer        | XFF present | action                                    |
      |-------------|-------------|-------------------------------------------|
      | loopback    | no          | trust peer (direct curl from inside box)  |
      | loopback    | yes         | trust XFF (local nginx is reverse-proxying) |
      | non-loopback| any         | delegate to `RemoteIp`: the forwarded-chain client if XFF is present (walked right-to-left, reserved ranges skipped), else the peer |

  The `non-loopback` row is NOT "ignore headers and trust the peer":
  a non-loopback peer WITH an XFF still has its chain walked (the
  docker-bridge / operator-fronted-proxy shape) — see the plug tests.
  The single source of truth for all three rows is
  `trusted_client_ip/3`; the socket and HTTP doors both delegate to it.

  The middle row is the load-bearing one for the bastille jail
  (cp52 S2 incident): nginx runs in the same jail as grappa and
  proxies via `127.0.0.1:4000`. Every legitimate user request
  surfaces with `peer = 127.0.0.1` AND nginx-set X-F-F. Without
  the rewrite, every user session would persist `ip = "127.0.0.1"`
  instead of the real client IP — silent data loss on the audit
  trail. The Docker substrate (`scripts/deploy.sh`) has the same
  shape: nginx publishes on `0.0.0.0:80`, grappa publishes on
  `127.0.0.1:4000`, nginx proxies via the docker bridge but local
  curls from the container also hit loopback — same rule applies.

  The first row covers the operator's healthcheck/admin-poke shape:
  `sudo bastille cmd grappa curl http://127.0.0.1:4000/admin/reload`
  (or `docker exec grappa curl ...`) — loopback peer, no proxy
  headers, trust the peer. `Plugs.LoopbackOnly` gates on the result.

  ## Shell-spoof: explicitly accepted residual risk

  An attacker with shell access on the host CAN spoof
  `X-Forwarded-For: 127.0.0.1` from a loopback peer; the wrapper
  trusts XFF in that case and `Plugs.LoopbackOnly` would accept
  the result. The earlier (cp51-era) version of this plug blocked
  that spoof at the cost of breaking nginx-as-local-proxy. The
  trade-off is intentional: anyone who can run `sudo bastille cmd
  grappa <anything>` or `docker exec grappa <anything>` already
  has root-equivalent access (kill the BEAM, drop the sqlite DB,
  write the codebase). `POST /admin/reload` is the least
  interesting thing they could do. The defense at this layer is
  network reachability (nginx doesn't proxy `/admin/reload`,
  grappa binds 127.0.0.1 only), NOT input validation against an
  attacker who already has the keys.

  ## Loopback shapes

  `{127, _, _, _}` and `{0, 0, 0, 0, 0, 0, 0, 1}` are the only two
  loopback shapes that reach Phoenix. The IPv4-mapped IPv6 form
  `{0, 0, 0, 0, 0, 0xffff, hi, lo}` is NOT loopback per RFC 4291 —
  it's an IPv4 address in IPv6 transport. Real clients that hit
  Phoenix via the v4-mapped form get treated as non-loopback
  peers, which is correct.

  ## Shared trust SSOT (#543 Part C)

  The trust DECISION lives in exactly one place — `trusted_client_ip/3`
  — so callers OUTSIDE the plug pipeline reuse it verbatim instead of
  reimplementing this (subtle, security-load-bearing) matrix. The HTTP
  `call/2` delegates to it; `GrappaWeb.UserSocket.connect/3` calls the
  zero-config `trusted_client_ip/2` with the `peer_data`/`x_headers` it
  reads from `connect_info` (a WS `connect/3` gets `connect_info`, NOT a
  `Plug.Conn`, so `RemoteIp` can't run as a plug there). Both paths land
  the SAME trusted client IP — one door, one matrix.
  """
  @behaviour Plug

  # The header allowlist SSOT — `init/1`'s default AND the set the
  # zero-config `trusted_client_ip/2` uses. The endpoint plug is wired with
  # this exact literal (`headers: ~w[x-forwarded-for x-real-ip]`), pinned by
  # `RemoteIpFromProxyTest`'s "config wiring" drift test, so the HTTP and WS
  # doors can't drift onto different header sets.
  @default_headers ~w[x-forwarded-for x-real-ip]

  @typedoc "Packed plug options: the header allowlist + the `RemoteIp` keyword opts."
  @type opts :: {[binary()], keyword()}

  @impl Plug
  @spec init(keyword()) :: opts()
  def init(opts) do
    headers = Keyword.get(opts, :headers, @default_headers)
    # Keep the RAW keyword opts (not `RemoteIp.init/1`'s packed form): the
    # SSOT resolves via `RemoteIp.from/2`, which re-packs internally and is
    # the blessed non-`Plug.Conn` entry (RemoteIp moduledoc). `:headers` is
    # forced so `from/2` honours the same allowlist the plug advertises.
    {headers, Keyword.put(opts, :headers, headers)}
  end

  @impl Plug
  @spec call(Plug.Conn.t(), opts()) :: Plug.Conn.t()
  def call(%Plug.Conn{remote_ip: peer, req_headers: req_headers} = conn, opts) do
    ip = trusted_client_ip(peer, req_headers, opts)
    # Preserve `RemoteIp.call/2`'s side-effect: it stamped the `:remote_ip`
    # Logger metadata (config allowlists it — the HTTP log line carries the
    # post-rewrite client IP). `RemoteIp.from/2` does NOT, so re-stamp it
    # here. This is an HTTP-request logging concern local to the plug, not
    # part of the shared trust decision.
    put_remote_ip_metadata(ip)
    %{conn | remote_ip: ip}
  end

  @doc """
  Resolves the trusted client IP for a caller OUTSIDE the plug pipeline
  (the WS `connect/3`), using the SAME default header allowlist the
  endpoint plug is wired with. `req_headers` is the forwarded-header list
  (`connect_info.x_headers`); `peer_ip` is `connect_info.peer_data.address`.
  """
  @spec trusted_client_ip(:inet.ip_address(), [{binary(), binary()}]) :: :inet.ip_address()
  def trusted_client_ip(peer_ip, req_headers) when is_tuple(peer_ip) and is_list(req_headers) do
    trusted_client_ip(peer_ip, req_headers, init([]))
  end

  @doc """
  The trust-matrix SSOT: given the transport peer IP + the request's
  forwarded headers, return the IP to trust as the client.

      | peer         | XFF present | trusted                                   |
      |--------------|-------------|-------------------------------------------|
      | loopback     | no          | the peer (operator shell / direct curl)   |
      | loopback     | yes         | the header-chain client (local nginx)     |
      | non-loopback | any         | the header-chain client, else the peer    |

  The non-loopback rows delegate to `RemoteIp.from/2`, which walks the
  forwarded chain right-to-left and stops at the first non-reserved IP —
  so a trusted proxy's appended real client wins over any forged leftmost
  entry, and a header yielding no client falls back to the peer.
  """
  @spec trusted_client_ip(:inet.ip_address(), [{binary(), binary()}], opts()) ::
          :inet.ip_address()
  def trusted_client_ip(peer_ip, req_headers, {headers, remote_ip_opts}) do
    if loopback?(peer_ip) and not has_forwarded_header?(req_headers, headers) do
      peer_ip
    else
      RemoteIp.from(req_headers, remote_ip_opts) || peer_ip
    end
  end

  defp loopback?({127, _, _, _}), do: true
  defp loopback?({0, 0, 0, 0, 0, 0, 0, 1}), do: true
  defp loopback?(_), do: false

  defp has_forwarded_header?(req_headers, headers) do
    Enum.any?(req_headers, fn {name, _} -> name in headers end)
  end

  # Replicates `RemoteIp.call/2`'s `add_metadata/1` (a private dep helper):
  # stamp the client IP as `:remote_ip` Logger metadata via `:inet.ntoa/1`,
  # skipping a malformed tuple rather than crashing the request.
  defp put_remote_ip_metadata(ip) do
    case :inet.ntoa(ip) do
      {:error, _} -> :ok
      str -> Logger.metadata(remote_ip: to_string(str))
    end
  end
end
