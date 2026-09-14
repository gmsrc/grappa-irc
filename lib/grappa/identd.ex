defmodule Grappa.Identd do
  @moduledoc """
  An RFC 1413 ident server for grappa's OWN outbound IRC connections
  (issue 227).

  ## What it buys

  When grappa opens an upstream connection the ircd looks the source port
  back up on `113/tcp`. With nobody answering it falls back to a
  `~`-prefixed, unverified username, and some server configs gate
  features on a VERIFIED ident — notably oper O:lines that require
  `identd` active, which a grappa-connected user therefore cannot match.
  Answering the lookup removes the `~` and satisfies those blocks.

  Scope is grappa's own connections. This is not a general-purpose system
  identd, and it makes no difference on the networks that never ask,
  which is most of them today.

  ## The three parts

    * `Grappa.Identd.Bindings` — the `{source_ip, local_port, peer_ip,
      peer_port} → ident` table. Written by `Grappa.IRC.Client` the
      moment a socket comes up; torn down by the monitor on that Client.
    * `Grappa.Identd.Listener` — the TCP listener and its acceptor pool.
    * `Grappa.Identd.Protocol` — the wire format, with no socket in it.

  ## Off by default

  Nothing above is started unless an operator enables it, and the port
  they enable it on defaults to a high, unprivileged one. Reaching it
  from 113 is a deployment concern — see `docs/OPERATIONS.md` — because
  a release that granted itself `CAP_NET_BIND_SERVICE` would be a release
  that decided for the operator.

  ## The ident is the session's, and it is the one already on the wire

  `Grappa.IRC.Client` registers the very value it hands `AuthFSM` for
  `USER <ident>` (`Grappa.IRC.Identity.effective_ident/2`, which falls
  back to the nick). There is no identd-specific override and no second
  source: an identd that could answer something other than what the USER
  line said would be worse than none.

  ## Answering only the peer

  A lookup key is built from the QUERIER's address, so a query from
  anybody but the far end of the connection it asks about misses, and
  every miss is one uniform `ERROR : NO-USER`. Without that, anyone able
  to reach the port could enumerate grappa's idents by guessing port
  pairs. See `Grappa.Identd.Bindings` for why the check is the key's
  shape rather than a comparison.
  """

  use Boundary, top_level?: true, deps: [Grappa.Net.IpLiteral], exports: [Bindings, Listener]

  alias Grappa.Identd.Bindings

  @typedoc """
  `{source_ip, local_port, peer_ip, peer_port}` — the full 4-tuple of one
  outbound IRC socket, as `:inet.sockname/1` and `:inet.peername/1` report
  it. The source ADDRESS is part of the key because grappa's sources are
  plural and per-network: two sessions can hold the same ephemeral port
  on two different addresses.
  """
  @type binding_key ::
          {:inet.ip_address(), :inet.port_number(), :inet.ip_address(), :inet.port_number()}

  @doc """
  Binds `key` to `ident` for as long as the calling process lives.

  Always `:ok`, including when identd is disabled — see
  `Grappa.Identd.Bindings.register/2` for why the connect path is not
  allowed to care.
  """
  @spec register(binding_key(), String.t()) :: :ok
  defdelegate register(key, ident), to: Bindings

  @doc """
  Resolves `key`, waiting up to `wait_ms` for a registration still in
  flight. See `Grappa.Identd.Bindings.lookup/2`.
  """
  @spec lookup(binding_key(), non_neg_integer()) :: {:ok, String.t()} | :none
  defdelegate lookup(key, wait_ms), to: Bindings
end
