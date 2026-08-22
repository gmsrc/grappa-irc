defmodule Mix.Tasks.Grappa.AddServer do
  @shortdoc "Adds a server endpoint to a network: --network --server host:port [--tls|--no-tls] [--no-tls-verify] [--priority] [--source <ip>]"

  @moduledoc """
  Appends an additional server to an existing network's fail-over
  list. Use this when a network gets a new round-robin endpoint or
  when staging a planned host migration.

  ## Usage

      scripts/mix.sh grappa.add_server \\
        --network azzurra \\
        --server irc2.azzurra.chat:6697 \\
        --priority 1 \\
        --source 203.0.113.9

  The network must already exist (created via `grappa.bind_network`);
  this task NEVER creates the network. `--priority` defaults to 0.
  Re-adding the same `(network, host, port)` triple is a no-op.

  `--source <ip>` pins the outbound source address for this server.
  Must be a strict literal IPv4 or IPv6 address (no hostname, no CIDR).
  #266: this per-network source now takes ABSOLUTE precedence — when set
  it WINS over a subject's vhost selection and the rotation pool (the
  Libera go-live "one accountable egress per network" posture), reversing
  the #251 nuance where a self-selection overrode it. See `Grappa.Vhosts`.
  Unlike the REST admin surface, this trusted host-side path is NOT
  local-bindable-gated: a non-local literal is accepted here and fails at
  connect time.

  ## TLS default — port-sniffed

  When neither `--tls` nor `--no-tls` is passed, the TLS posture is
  inferred from the port: `6697` (the de-facto IRC-over-TLS port)
  defaults to `tls: true`; any other port defaults to `tls: false`.
  Pass `--tls` or `--no-tls` explicitly to override.

  Rationale: the prior "always default to tls: true" default was a
  footgun — adding a plain leaf on `:6667` without `--no-tls` produces
  a session whose TLS handshake never completes against a non-TLS
  socket, and the failure mode is `:connect_timeout` ~8s into every
  spawn (root cause of the 9-day visitor-mint cold-start mystery).
  Port-sniff matches operator expectation: 6697 means TLS everywhere
  in the IRC world, anything else is plain unless flagged.

  ## `--no-tls-verify` — the per-server opt-out (#1677)

  Drops THIS server to `verify: :verify_none`. Defaults to verifying, is
  never port-sniffed (no port number means "this leaf's certificate will
  not validate"), and applies only when the server is TLS at all.

  Use it for a network whose leaves can never present a validating chain —
  measured: every EFNet leaf with an AAAA record is self-signed or expired,
  and `irc.ircnet.com` serves the certificate of `ircnet.tngnet.nl`. For
  those the alternative is `--no-tls`, i.e. CLEARTEXT, which leaks the whole
  stream (SASL and NickServ traffic included) to anything on path; an
  unverified TLS session at least defeats passive capture.

  It is NOT the answer for a private network with its own CA — add that CA
  to the host's system trust store instead. Every session on a server
  carrying this flag logs a `Logger.warning` naming the posture at connect.

      scripts/mix.sh grappa.add_server \\
        --network efnet \\
        --server efnet.deic.eu:6697 \\
        --no-tls-verify
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Networks,
      Mix.Tasks.Grappa.Boot,
      Mix.Tasks.Grappa.OptionParsing,
      Mix.Tasks.Grappa.Output
    ]

  use Mix.Task

  alias Grappa.Networks
  alias Grappa.Networks.Servers
  alias Mix.Tasks.Grappa.{Boot, OptionParsing, Output}

  @switches [
    network: :string,
    server: :string,
    tls: :boolean,
    tls_verify: :boolean,
    priority: :integer,
    source: :string
  ]

  @required [:network, :server]

  # De-facto IRC-over-TLS port per RFC 7194 + ircv3 conventions.
  @tls_port 6697

  @impl Mix.Task
  def run(args) do
    opts = OptionParsing.parse!(args, @switches, @required)
    slug = Keyword.fetch!(opts, :network)
    server = Keyword.fetch!(opts, :server)

    Boot.start_app_silent()

    network = Networks.get_network_by_slug!(slug)
    {host, port} = OptionParsing.parse_server(server)

    attrs = %{
      host: host,
      port: port,
      tls: Keyword.get(opts, :tls, port == @tls_port),
      # #1677 — NOT port-sniffed, unlike `--tls` above. There is no port that
      # means "this leaf's certificate will not validate", so there is nothing
      # honest to infer: the strict #89 posture is the default and the opt-out
      # must be typed.
      tls_verify: Keyword.get(opts, :tls_verify, true),
      priority: Keyword.get(opts, :priority, 0),
      source_address: Keyword.get(opts, :source)
    }

    case Servers.add_server(network, attrs) do
      {:ok, _} ->
        IO.puts("added server #{host}:#{port} to #{slug}")

      {:error, :already_exists} ->
        IO.puts("server #{host}:#{port} already on #{slug}; no-op")

      {:error, cs} ->
        Output.halt_changeset("adding server", cs)
    end
  end
end
