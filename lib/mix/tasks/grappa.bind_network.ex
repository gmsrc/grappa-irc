defmodule Mix.Tasks.Grappa.BindNetwork do
  @shortdoc "Binds a user to an IRC network: --user --network --server host:port [--tls|--no-tls] --nick [--password] [--auth] [--autojoin] [--source <ip>]"

  @moduledoc """
  Operator-side network binding. Idempotently creates the network +
  one server + per-user credential in a single shell call so the
  end-to-end deploy walkthrough (README + sub-task 2k) is one
  invocation per network.

  ## Usage

      scripts/mix.sh grappa.bind_network \\
        --user vjt --network azzurra \\
        --server irc.azzurra.chat:6697 \\
        --nick vjt-grappa \\
        --password '<NickServ password>' \\
        --auth auto \\
        --autojoin '#grappa,#italy' \\
        --source 203.0.113.9

  Required: `--user`, `--network`, `--server`, `--nick`, `--auth`.

  `--source <ip>` pins the outbound source address for this server.
  Must be a strict literal IPv4 or IPv6 address (no hostname, no CIDR).
  #266: this per-network source now takes ABSOLUTE precedence — when set
  it WINS over a subject's vhost selection and the rotation pool (the
  Libera go-live "one accountable egress per network" posture), reversing
  the #251 nuance where a self-selection overrode it. See `Grappa.Vhosts`.
  Unlike the REST admin surface, this trusted host-side path is NOT
  local-bindable-gated: a non-local literal is accepted here and fails at
  connect time.

  Valid `--auth` values: `auto | sasl | server_pass | nickserv_identify
  | none`. S29 H10: `--auth` lost its silent `auto` default — operator
  must pick the upstream auth shape explicitly because the legacy ircd
  PASS-handoff (`auto`/`server_pass`) and the modern SASL chain
  (`sasl`) target different on-the-wire surfaces. `--autojoin` is a
  comma-separated list of channel names.

  ## The two password flags (#1044)

  `--password` is the NickServ secret; `--server-pass` is the server `PASS`
  a password-gated network demands before it will register you. They are
  independent, and both may be given at once — which is the point: before
  #1044 one credential held one secret, so an operator who needed the gate
  had to keep the NickServ password in the on-connect perform list, in
  cleartext.

      --auth server_pass --server-pass '<gate secret>' \\
        --password '<NickServ password>'

  On `--auth server_pass` the `PASS` line carries `--server-pass` and
  `--password` drives the post-001 identify. On `--auth auto` the handoff
  spends `--password` on `PASS` itself, so `--server-pass` has no role
  there. `--server-pass` must be a single wire token: no spaces (the ircd
  would split it and keep the first), no CR/LF/NUL.

  ## TLS default — port-sniffed

  When neither `--tls` nor `--no-tls` is passed, the TLS posture is
  inferred from the server's port: `6697` (the de-facto IRC-over-TLS
  port) defaults to `tls: true`; any other port defaults to
  `tls: false`. Pass `--tls` or `--no-tls` explicitly to override.

  Adding the same `(network, host, port)` server twice is a no-op
  (the duplicate is silently skipped); rebinding an existing
  `(user, network)` credential reports a changeset error — use
  `grappa.update_network_credential` to mutate.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.Networks,
      Mix.Tasks.Grappa.Boot,
      Mix.Tasks.Grappa.OptionParsing,
      Mix.Tasks.Grappa.Output
    ]

  use Mix.Task

  alias Grappa.{Accounts, Networks}
  alias Mix.Tasks.Grappa.{Boot, OptionParsing, Output}

  @switches [
    user: :string,
    network: :string,
    services_flavor: :string,
    server: :string,
    tls: :boolean,
    nick: :string,
    password: :string,
    server_pass: :string,
    auth: :string,
    autojoin: :string,
    realname: :string,
    sasl_user: :string,
    source: :string
  ]

  @required [:user, :network, :server, :nick, :auth]

  # De-facto IRC-over-TLS port per RFC 7194 + ircv3 conventions.
  @tls_port 6697

  @impl Mix.Task
  def run(args) do
    opts = OptionParsing.parse!(args, @switches, @required)

    user_name = Keyword.fetch!(opts, :user)
    slug = Keyword.fetch!(opts, :network)
    server = Keyword.fetch!(opts, :server)
    nick = Keyword.fetch!(opts, :nick)
    auth = Keyword.fetch!(opts, :auth)

    Boot.start_app_silent()

    user = Accounts.get_user_by_name!(user_name)
    {host, port} = OptionParsing.parse_server(server)

    server_spec = %{
      host: host,
      port: port,
      tls: Keyword.get(opts, :tls, port == @tls_port),
      # A pre-existing `(network, host, port)` row keeps its prior
      # source_address; the --source given here is NOT persisted then.
      source_address: Keyword.get(opts, :source)
    }

    # `--services-flavor` (GH #349) applies only on the CREATE path;
    # `add_network/3` returns a pre-existing network unchanged, so
    # re-classifying an existing network is an admin PATCH, not a re-bind.
    # An invalid flavor string trips Ecto.Enum casting and comes back as
    # the changeset below.
    network_spec =
      case Keyword.get(opts, :services_flavor) do
        nil -> %{slug: slug, server: server_spec}
        flavor -> %{slug: slug, services_flavor: flavor, server: server_spec}
      end

    settings = %{
      nick: nick,
      password: Keyword.get(opts, :password),
      # #1044 — the server `PASS`, a DIFFERENT secret from `--password`. On a
      # password-gated network both are needed at once, so the two flags are
      # independent rather than one flag the auth method reinterprets.
      server_pass: Keyword.get(opts, :server_pass),
      auth_method: OptionParsing.parse_auth(auth),
      autojoin_channels: OptionParsing.parse_autojoin(Keyword.get(opts, :autojoin)),
      realname: Keyword.get(opts, :realname),
      sasl_user: Keyword.get(opts, :sasl_user)
    }

    # #1158: the network + server + credential composition lives in the
    # context now, so this task and the release-image door
    # (`grappa add-network`) provision an account the same way. The task is
    # the source-flavor surface over it, nothing more.
    case Networks.add_network(user, network_spec, settings) do
      {:ok, _} ->
        IO.puts("bound #{user.name} to #{slug} (server #{host}:#{port})")

      {:error, :no_enabled_server} ->
        Mix.raise("#{slug} has no ENABLED server — #{host}:#{port} exists but is disabled")

      {:error, cs} ->
        Output.halt_changeset("binding #{slug}", cs)
    end
  end
end
