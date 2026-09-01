defmodule Grappa.Release.CLI do
  @moduledoc """
  The account verbs an operator gets on a PACKAGED release (#1158).

  ## Why this exists

  A release ships no Mix, so none of the `grappa.*` operator tasks that
  seed a source install exist on the published image, the bastille jail
  or the `.deb`/AUR host. Until this door landed, a box that had never
  been seeded had no supported way to a first account: the release boot
  script answered `ERROR: Unknown command create-user`, and the only
  thing that did work was typing `Grappa.Accounts` module calls into an
  IEx remote shell — which is not a product.

  The rule vjt set is that the operator types a subcommand and nothing
  else:

      grappa create-user vjt --admin
      grappa add-network vjt azzurra --server irc.azzurra.chat:6697 \\
        --nick vjt-grappa --auth sasl --autojoin '#grappa'
      grappa remove-network vjt azzurra

  That `bin/grappa` is `infra/release/grappa.sh`, installed over the
  generated boot script when the release is assembled; it recognises the
  verbs above, hands everything else to the release unchanged, and
  reaches this module through `Grappa.Release.cli/1`. The `eval` under
  the hood is an implementation detail the operator never sees or types.

  ## Shape

  `run/1` takes argv and returns `{:ok, message}` or `{:error, message}`
  — it never halts and never prints, so the whole verb table is testable
  in-process. `Grappa.Release.cli/1` owns the boot (load the app, start
  the vault, start the repo) and turns the result into stdout/stderr and
  an exit status.

  Positional arguments name the ENTITIES (the account, the network);
  flags carry the settings, spelled exactly as the source-flavor mix
  tasks spell them, so an operator moving between a dev checkout and a
  release box does not learn two grammars. That correspondence is gated,
  not hoped for: `Grappa.Release.CLITest` compares this module's switch
  tables against the mix tasks' `@switches`.

  One code path, three doors: these verbs call the same context
  functions (`Grappa.Accounts.create_user/1`,
  `Grappa.Networks.add_network/3`, `Grappa.Networks.remove_network/2`)
  the mix tasks and the admin REST surface call. This module parses and
  reports; it decides nothing about the domain.
  """

  alias Grappa.{Accounts, Networks}
  alias Grappa.Accounts.User
  alias Grappa.Networks.Network
  alias Grappa.Release.LiveNode

  @create_user_switches [password: :string, admin: :boolean]

  # Mirrors `Mix.Tasks.Grappa.BindNetwork`'s @switches minus `--user` /
  # `--network`, which are positional here. Gated in CLITest.
  @add_network_switches [
    server: :string,
    nick: :string,
    auth: :string,
    tls: :boolean,
    password: :string,
    server_pass: :string,
    autojoin: :string,
    realname: :string,
    sasl_user: :string,
    source: :string,
    services_flavor: :string
  ]

  @add_network_required [:server, :nick, :auth]

  # De-facto IRC-over-TLS port per RFC 7194 + ircv3 conventions; the
  # source-flavor task infers the same default from the same number.
  @tls_port 6697

  # Explicit string->atom map, NOT `~w(...)a` + `String.to_existing_atom/1`:
  # the atoms must be compiled into THIS module's bytecode or a bare
  # `eval` (which loads almost nothing) can fail to resolve them. Same
  # reasoning, and the same table, as the mix-task side that now delegates
  # here.
  @auth_map %{
    "auto" => :auto,
    "sasl" => :sasl,
    "server_pass" => :server_pass,
    "nickserv_identify" => :nickserv_identify,
    "none" => :none
  }
  @auth_strings Map.keys(@auth_map)

  @usage """
  Usage: grappa COMMAND [ARGS]

  Account commands:

      create-user NAME [--admin] [--password PW]
          Creates an account. Without --password the password is read
          from the terminal, so it stays out of shell history.

      add-network USER NETWORK --server HOST:PORT --nick NICK --auth METHOD
                  [--tls | --no-tls] [--password PW] [--server-pass PW]
                  [--autojoin '#a,#b']
                  [--realname NAME] [--sasl-user USER] [--source IP]
                  [--services-flavor FLAVOR]
          Gives USER access to NETWORK, creating the network and the
          server when they do not exist yet. --auth is one of
          auto|sasl|server_pass|nickserv_identify|none. TLS defaults to
          on for port 6697, off otherwise.
          --password is the NickServ secret; --server-pass is the server
          PASS a gated network demands before registration. They are
          different secrets and may both be given (#1044).

      remove-network USER NETWORK
          Revokes that access and stops any live session for it.

  Every other command is the release's own (start, daemon, eval, rpc,
  remote, stop, pid, version).
  """

  @doc """
  Runs one operator verb. Returns the operator-facing message either way;
  never prints, never halts.
  """
  @spec run([String.t()]) :: {:ok, String.t()} | {:error, String.t()}
  def run(["create-user" | rest]), do: create_user_verb(rest)
  def run(["add-network" | rest]), do: add_network_verb(rest)
  def run(["remove-network" | rest]), do: remove_network_verb(rest)
  def run(["help" | _]), do: {:ok, @usage}
  def run(["--help" | _]), do: {:ok, @usage}

  def run([verb | _]) when is_binary(verb) do
    {:error, misuse("#{inspect(verb)} is not one of the account commands")}
  end

  def run([]), do: {:error, misuse("no command given")}

  # ── create-user ─────────────────────────────────────────────────────────

  # A flag in the name slot is the natural typo (`create-user --admin vjt`);
  # taking it as the name would create an account nobody asked for.
  defp create_user_verb([name | rest]) when is_binary(name) do
    if flag?(name),
      do: {:error, misuse("create-user needs an account name, got the flag #{name}")},
      else: create_user(name, rest)
  end

  defp create_user_verb([]), do: {:error, misuse("create-user needs an account name")}

  defp add_network_verb([user_name, slug | rest])
       when is_binary(user_name) and is_binary(slug) do
    if flag?(user_name) or flag?(slug),
      do: {:error, misuse("add-network needs an account name and a network")},
      else: add_network(user_name, slug, rest)
  end

  defp add_network_verb(_), do: {:error, misuse("add-network needs an account name and a network")}

  defp remove_network_verb([user_name, slug])
       when is_binary(user_name) and is_binary(slug) do
    with {:ok, user} <- fetch_user(user_name),
         {:ok, network} <- fetch_network(slug) do
      :ok = Networks.remove_network(user, network)
      {:ok, "#{user.name} no longer has access to #{slug}"}
    end
  end

  defp remove_network_verb(_) do
    {:error, misuse("remove-network takes exactly an account name and a network")}
  end

  defp create_user(name, argv) do
    with {:ok, opts} <- parse(argv, @create_user_switches, []),
         {:ok, password} <- read_password(opts, name),
         {:ok, user} <- insert_user(name, password),
         {:ok, user} <- grant_admin(user, Keyword.get(opts, :admin, false)) do
      {:ok, "created user #{user.name} (#{user.id})#{admin_marker(user)}"}
    end
  end

  defp insert_user(name, password) do
    case Accounts.create_user(%{name: name, password: password}) do
      {:ok, %User{} = user} -> {:ok, user}
      {:error, changeset} -> {:error, "creating user: " <> changeset_message(changeset)}
    end
  end

  # `--admin` promotes through the guarded context path, exactly as the
  # source-flavor task does; promotion never trips the last-admin guard,
  # which only blocks demotion.
  defp grant_admin(%User{} = user, false), do: {:ok, user}

  defp grant_admin(%User{} = user, true) do
    case Accounts.update_admin_flags(user, %{is_admin: true}) do
      {:ok, %User{} = user} -> {:ok, user}
      {:error, :last_admin} -> {:error, "granting admin: refused by the last-admin guard"}
      {:error, changeset} -> {:error, "granting admin: " <> changeset_message(changeset)}
    end
  end

  defp admin_marker(%User{is_admin: true}), do: " [admin]"
  defp admin_marker(%User{is_admin: false}), do: ""

  # An operator who passes no --password is prompted, so the secret never
  # reaches shell history or the process table. Echo suppression is
  # best-effort: the return of `:io.setopts/1` is deliberately ignored
  # because a non-tty (a pipe, a test's captured IO) rejects the option,
  # and reading the password still has to work there.
  defp read_password(opts, name) do
    case Keyword.fetch(opts, :password) do
      {:ok, password} -> {:ok, password}
      :error -> prompt_password(name)
    end
  end

  defp prompt_password(name) do
    _ = :io.setopts(echo: false)

    # `after`, not two straight-line calls: anything that escapes from the
    # read would otherwise leave the OPERATOR'S terminal with echo off, and
    # they would be typing invisibly into their own shell afterwards. This
    # is state restoration, not an error being swallowed — nothing is
    # rescued here.
    input =
      try do
        IO.gets("password for #{name}: ")
      after
        _ = :io.setopts(echo: true)
      end

    IO.puts("")

    case input do
      :eof ->
        {:error, "no password given — pass --password or type one at the prompt"}

      {:error, reason} ->
        {:error, "could not read the password: #{inspect(reason)}"}

      line when is_binary(line) ->
        {:ok, line |> String.trim_trailing("\n") |> String.trim_trailing("\r")}
    end
  end

  # ── add-network ─────────────────────────────────────────────────────────

  defp add_network(user_name, slug, argv) do
    with {:ok, opts} <- parse(argv, @add_network_switches, @add_network_required),
         {:ok, user} <- fetch_user(user_name),
         {:ok, {host, port}} <- parse_endpoint(Keyword.fetch!(opts, :server)),
         {:ok, auth_method} <- parse_auth(Keyword.fetch!(opts, :auth)),
         {:ok, credential} <- grant_access(user, slug, opts, {host, port}, auth_method) do
      outcome = LiveNode.adopt(credential.user_id, credential.network_id)

      {:ok,
       "#{user.name} can now use #{slug} (server #{host}:#{port})\n" <>
         outcome_line(user, outcome)}
    end
  end

  # #1685 — the operator is told which of two things happened, because they
  # are not the same thing and only one of them needs anything further from
  # anybody.
  #
  # The row is bound either way: a refused spawn is not a failed bind (the
  # operator asked to PROVISION access, and discarding their input because
  # the bouncer was busy would be the wrong trade — the same call
  # `Admin.CredentialsController.create/2` makes for the console door). So
  # the exit status stays 0 in every branch below, which also keeps the
  # normal first-run script — `create-user && add-network && start the
  # service` — from breaking on the case that has no live node BY
  # DEFINITION.
  #
  # Silence is what is not allowed. `Grappa.Release.cli/1` prints this
  # whole string, so "parked and why" reaches the terminal even though the
  # command succeeded.
  @spec outcome_line(User.t(), {:ok, :started} | {:error, LiveNode.error()}) :: String.t()
  defp outcome_line(%User{}, {:ok, :started}) do
    "  started a session on the live node — nothing else to do"
  end

  defp outcome_line(%User{name: name}, {:error, reason}) do
    # The restart caveat is load-bearing, not a courtesy. vjt's #1685
    # ruling keeps `:parked` OUT of the boot adoption query
    # (`connection_state in [:connected, :failing]`) on purpose: `:parked`
    # means explicit user intent, and widening the query would resurrect
    # every network a user had deliberately disconnected. The price is that
    # an operator who seeds a box and restarts it gets nothing, so the
    # message has to say so rather than let them find out.
    "  the binding is PARKED: #{park_reason(reason)}.\n" <>
      "  A restart will NOT dial it — #{name} connects it with Connect after logging in."
  end

  @spec park_reason(LiveNode.error()) :: String.t()
  defp park_reason(:no_release_node), do: "there is no live node to reach from here"

  defp park_reason(:distribution_disabled),
    do: "RELEASE_DISTRIBUTION=none, so the running node has no distribution to call"

  defp park_reason(:no_distribution),
    do: "nothing is listening on epmd, so no bouncer is running here"

  # The live node was reached and could not find the row this command just
  # wrote. The usual cause is worth naming: the two VMs are looking at
  # DIFFERENT databases (a `DATABASE_PATH` that differs between the service
  # environment and this shell's).
  defp park_reason(:not_found),
    do:
      "the live node cannot see this binding — check that it reads the same " <>
        "DATABASE_PATH as this command"

  # MEASURED (#1685): a cookie mismatch and a node that is simply not there
  # are indistinguishable at this end — `Node.connect/1` answers `false` in
  # 1–2 ms either way. Naming both beats guessing one.
  defp park_reason(:unreachable),
    do: "the live node did not answer (not running, or a different RELEASE_COOKIE)"

  defp park_reason({:refused, reason}),
    do: "the live node refused to start the session (#{inspect(reason)})"

  defp park_reason({:call_failed, reason}),
    do: "the call to the live node failed (#{inspect(reason)})"

  defp grant_access(%User{} = user, slug, opts, {host, port}, auth_method) do
    server = %{
      host: host,
      port: port,
      tls: Keyword.get(opts, :tls, port == @tls_port),
      source_address: Keyword.get(opts, :source)
    }

    # `--services-flavor` (GH #349) applies only when the network is
    # created; an existing row comes back unchanged.
    network_spec =
      case Keyword.get(opts, :services_flavor) do
        nil -> %{slug: slug, server: server}
        flavor -> %{slug: slug, services_flavor: flavor, server: server}
      end

    settings = %{
      nick: Keyword.fetch!(opts, :nick),
      password: Keyword.get(opts, :password),
      # #1044 — the server `PASS`, independent of `--password` (the NickServ
      # secret). A password-gated network needs both at once; the mix-task
      # twin `grappa.bind_network` carries the same pair.
      server_pass: Keyword.get(opts, :server_pass),
      auth_method: auth_method,
      autojoin_channels: parse_autojoin(Keyword.get(opts, :autojoin)),
      realname: Keyword.get(opts, :realname),
      sasl_user: Keyword.get(opts, :sasl_user),
      # #1685 — bind `:parked`, NEVER the schema default `:connected`. This
      # door was the last of the three that still inherited the default:
      # `session_controller.ex` (#642) and
      # `admin/credentials_controller.ex` (#1163) both write `:parked` and
      # let the spawn promote the row. Here the write happens in a
      # transient `eval` VM, so the row CLAIMED a session that VM could not
      # possibly have started — cic rendered CONNECTED with nothing to
      # press while every live-session operation answered `not_connected`.
      #
      # `Grappa.Operator.connect_credential/1` promotes it, over
      # `LiveNode`, only once a `Session.Server` is actually running.
      connection_state: :parked
    }

    case Networks.add_network(user, network_spec, settings) do
      {:ok, credential} ->
        {:ok, credential}

      {:error, :no_enabled_server} ->
        {:error, "#{slug} has no ENABLED server — #{host}:#{port} exists but is disabled"}

      {:error, changeset} ->
        {:error, "adding #{slug}: " <> changeset_message(changeset)}
    end
  end

  # ── lookups ─────────────────────────────────────────────────────────────

  defp fetch_user(name) do
    case Accounts.get_user_by_name(name) do
      %User{} = user ->
        {:ok, user}

      nil ->
        {:error, "no account named #{inspect(name)} — create it with: grappa create-user #{name}"}
    end
  end

  defp fetch_network(slug) do
    case Networks.get_network_by_slug(slug) do
      {:ok, %Network{} = network} -> {:ok, network}
      {:error, :not_found} -> {:error, "no network named #{inspect(slug)}"}
    end
  end

  # ── option grammar (shared with the source-flavor mix tasks) ────────────

  @doc """
  Parses `argv` against `switches`, rejecting an unrecognised switch, a
  value that will not parse, and any absent `required` option.

  `OptionParser.parse/2` reports none of that on its own (GH #1086): an
  unrecognised switch lands in the `invalid` element, so `--nework
  azzurra` silently became no `--network` at all. An unrecognised switch
  is reported IN PREFERENCE to the required option it failed to set —
  saying `--network` is missing sends the operator hunting for a flag
  they believe they typed.

  Leftover positional arguments are ignored, matching the source-flavor
  behaviour this replaced.
  """
  @spec parse([String.t()], keyword(), [atom()]) :: {:ok, keyword()} | {:error, String.t()}
  def parse(argv, switches, required)
      when is_list(argv) and is_list(switches) and is_list(required) do
    {opts, _, invalid} = OptionParser.parse(argv, strict: switches)

    with :ok <- reject_invalid(invalid, switches),
         :ok <- reject_missing(opts, required) do
      {:ok, opts}
    end
  end

  @doc """
  Parses a `host:port` server spec.
  """
  @spec parse_endpoint(String.t()) ::
          {:ok, {String.t(), :inet.port_number()}} | {:error, String.t()}
  def parse_endpoint(spec) when is_binary(spec) do
    case String.split(spec, ":") do
      [host, port_string] -> parse_port(host, port_string)
      _ -> {:error, "--server must be host:port (got #{inspect(spec)})"}
    end
  end

  defp parse_port(host, port_string) do
    case Integer.parse(port_string) do
      {port, ""} when port > 0 and port <= 65_535 ->
        {:ok, {host, port}}

      _ ->
        {:error, "--server port must be 1..65535 (got #{inspect(port_string)})"}
    end
  end

  @doc """
  Parses an `--auth` flag value into the credential's `auth_method` atom.
  """
  @spec parse_auth(String.t()) ::
          {:ok, :auto | :sasl | :server_pass | :nickserv_identify | :none}
          | {:error, String.t()}
  def parse_auth(string) when is_binary(string) do
    case Map.fetch(@auth_map, string) do
      {:ok, atom} ->
        {:ok, atom}

      :error ->
        {:error, "--auth must be one of #{Enum.join(@auth_strings, "|")} (got #{inspect(string)})"}
    end
  end

  @doc """
  Parses a comma-separated channel list. `nil` and the empty string both
  yield `[]`.
  """
  @spec parse_autojoin(String.t() | nil) :: [String.t()]
  def parse_autojoin(nil), do: []
  def parse_autojoin(""), do: []

  def parse_autojoin(string) when is_binary(string) do
    string
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
  end

  @doc """
  Renders `name` as the command-line flag that sets it: `:sasl_user` is
  `--sasl-user`. Derived from the atom's string form only, never the
  reverse direction (see the `@auth_map` note).
  """
  @spec flag(atom()) :: String.t()
  def flag(name) when is_atom(name), do: "--" <> String.replace(Atom.to_string(name), "_", "-")

  defp reject_invalid([], _), do: :ok

  defp reject_invalid(invalid, switches) do
    known = Enum.map(switches, fn {name, _} -> flag(name) end)

    {:error, Enum.map_join(invalid, "; ", &invalid_message(&1, known))}
  end

  # `OptionParser` reports an unrecognised switch and a known switch whose
  # value will not parse through the SAME `invalid` element, so the two are
  # told apart by whether the reported spelling is in the switch table.
  defp invalid_message({switch, nil}, known) do
    if switch in known,
      do: "missing value for #{switch}",
      else: "unknown option #{switch}"
  end

  defp invalid_message({switch, value}, known) do
    if switch in known,
      do: "invalid value #{inspect(value)} for #{switch}",
      else: "unknown option #{switch}"
  end

  defp reject_missing(opts, required) do
    case Enum.reject(required, &Keyword.has_key?(opts, &1)) do
      [] -> :ok
      [one] -> {:error, "missing required option #{flag(one)}"}
      many -> {:error, "missing required options #{Enum.map_join(many, ", ", &flag/1)}"}
    end
  end

  # ── shared rendering ────────────────────────────────────────────────────

  defp flag?("-" <> _), do: true
  defp flag?(_), do: false

  defp misuse(reason), do: reason <> "\n\n" <> @usage

  # Operator-readable, not developer-readable: `inspect(changeset.errors)`
  # renders interpolation placeholders and tuples at someone whose whole
  # question is which field they got wrong.
  defp changeset_message(%Ecto.Changeset{} = changeset) do
    changeset
    |> Ecto.Changeset.traverse_errors(fn {message, opts} ->
      Enum.reduce(opts, message, fn {key, value}, acc ->
        String.replace(acc, "%{#{key}}", to_string(value))
      end)
    end)
    |> Enum.map_join("; ", fn {field, messages} -> "#{field} #{Enum.join(messages, ", ")}" end)
  end
end
