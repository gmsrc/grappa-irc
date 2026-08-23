defmodule Grappa.Release.LiveNode do
  @moduledoc """
  The one hop `grappa add-network` makes out of its own VM and into the
  running bouncer (#1685).

  ## The problem this exists to solve

  `infra/release/grappa.sh` rewrites the account verbs into the release
  boot script's `eval`, and an `eval` starts a **transient node of its
  own**: it loads the app, writes to the database and exits. That is
  exactly right for the first-run door `Grappa.Release.cli/1` documents —
  but it means a session spawned there dies with the command, which is why
  `add-network` could report success against a running deployment while no
  `Session.Server` existed and every live-session operation answered
  `not_connected`.

  ## Why a distribution call and not an `rpc` verb

  The obvious fix — route the whole verb through the boot script's `rpc`
  instead of `eval` — is closed, and not by taste. **MEASURED (#1685):**
  `System.argv/0` evaluated under `--rpc-eval` is the *remote* node's argv
  and is always `[]`, so the argv channel the wrapper's safety property
  rests on does not exist there. Carrying the operator's words to the live
  node would mean interpolating them — `--password` included — into Elixir
  source evaluated on the production BEAM.

  So the parsing, the flag validation and the database write stay in the
  transient node, where they already are and where a mistyped flag can
  still `System.halt/1` harmlessly, and only the spawn crosses — as a
  **function call**. The arguments are Erlang terms on the distribution
  wire: there is no expression to escape and no `Code.eval_string` on the
  live node. The injection surface is not narrowed, it is absent by
  construction.

  ## What crosses, in each direction, and why it is that small

  Two identifiers go out and an atom comes back. Neither half carries a
  `%Grappa.Networks.Credential{}`, and the reason is not tidiness:
  Cloak hands back the **cleartext** on load, so a struct in either
  direction would put the operator's NickServ/SASL password on the
  distribution socket — which is unencrypted by default. `adopt_here/2`
  loads the row on the far side and answers `{:ok, :started}`.

  It deliberately does NOT answer with the row's `connection_state`.
  `Networks.connect/1` writes `:connected` as a statement of INTENT, and
  since #1675 that value means *registered upstream*; reporting it at the
  instant of return would be a lie the very next `001` either confirms or
  corrects.

  ## Measured, on three of the four substrates (2026-08-23, issue #1685)

  A release `eval` gets `--cookie "$RELEASE_COOKIE"` and no `-sname`, so it
  starts undistributed and must raise distribution itself — and it can, in
  **2–3 ms**, connecting in a further **1–3 ms**, on the published Docker
  release image (short hostname, FQDN hostname, and
  `RELEASE_DISTRIBUTION=name`) and on a `.deb` install on glibc. Two
  further measured facts shape the code below:

    * `Node.get_cookie/0` already returns the release cookie the moment
      `net_kernel` starts, so nothing here calls `Node.set_cookie/2`.
    * **There are two no-live-node shapes, not one.** With no epmd running
      (a fresh container, a host that never booted the service)
      `:net_kernel.start/2` itself fails with `:nodistribution` in ~8 ms;
      with epmd up and the node down, it succeeds and `Node.connect/1`
      returns `false` in ~1 ms. Both must fall through, and both do.

  The FreeBSD bastille jail is **not measured**. It does not need to be for
  this to be safe: the offline branch is mandatory anyway — first run is
  the case the CLI exists for — so a substrate that cannot raise
  distribution simply always takes it, and the credential lands `:parked`
  exactly as vjt ruled.
  """

  alias Grappa.Networks.Credentials
  alias Grappa.Operator

  @typedoc """
  Why the live node was not reached, or what it said when it was.

  `:unreachable` is deliberately coarse: **MEASURED**, a cookie mismatch
  and a node that is simply not there are indistinguishable at the caller
  (`Node.connect/1` returns `false` in 1–2 ms either way). The
  operator-facing message must not claim to know which.
  """
  @type error ::
          :no_release_node
          | :distribution_disabled
          | :no_distribution
          | :unreachable
          | :not_found
          | {:refused, refusal()}
          | {:call_failed, term()}

  @typedoc """
  Why the live node DECLINED, having been reached —
  `Grappa.Operator.connect_credential/1`'s error union minus `:not_found`,
  which is hoisted out because "the binding is not there" is a different
  answer from "the bouncer would not start it".

  Spelled out rather than aliased to `Grappa.Admission.capacity_error/0`,
  for the same reason `Grappa.Networks.Credentials.AdminWire.spawn_error/0`
  spells it out: this boundary must not depend on `Grappa.Admission`. The
  payloads are KEPT here, unlike AdminWire's wire-facing twin, because the
  operator message inspects the reason verbatim and a retry-after is worth
  reading.
  """
  @type refusal ::
          :resolve_failed
          | :ip_cap_exceeded
          | :visitor_cap_exceeded
          | :user_cap_exceeded
          | {:network_circuit_open, non_neg_integer()}
          | {:start_failed, term()}

  @doc """
  Starts a session for `(user_id, network_id)` in the live release node.

  The seam exists for exactly one reason: `adopt/2`'s own
  `:net_kernel.start/2` would make the CALLING VM distributed, which is
  intolerable inside a test suite. There is one production implementation
  and it is in this module; tests substitute a module through
  `put_test_impl/1`.
  """
  @callback adopt(Ecto.UUID.t(), pos_integer()) :: {:ok, :started} | {:error, error()}

  # An `:erpc.call/5` bound, not a hope. The far side does admission, a
  # backoff reset and a `DynamicSupervisor.start_child` — none of which
  # dials upstream synchronously — so this is generous by an order of
  # magnitude. It exists so that a wedged live node costs the operator a
  # bounded wait and an honest message instead of a stuck shell.
  @call_timeout :timer.seconds(15)

  @key {__MODULE__, :impl}

  @doc """
  Asks the live release node to start a session for `(user_id, network_id)`.

  Returns `{:ok, :started}`, or `{:error, reason}` naming why not — every
  reason is a fall-through the caller must survive, never a crash. See
  `t:error/0`.
  """
  @spec adopt(Ecto.UUID.t(), pos_integer()) :: {:ok, :started} | {:error, error()}
  def adopt(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    case impl() do
      nil -> reach(user_id, network_id)
      mod -> mod.adopt(user_id, network_id)
    end
  end

  @doc """
  The half that runs INSIDE the live node — the target of the `:erpc.call/5`
  above, and never called locally by the CLI.

  It needs the application RUNNING (`Grappa.SpawnOrchestrator`, the
  registry, the session supervisor), which the transient `eval` node has
  not started; calling it there would crash rather than misbehave.

  It loads the credential on this side so no decrypted secret crosses the
  wire, then hands it to `Grappa.Operator.connect_credential/1` — the same
  canonical admission → backoff-reset → spawn verb the #1163 console bind
  and every other runtime spawn surface reach. Bind-time and boot-time
  cannot drift because there is one implementation.
  """
  @spec adopt_here(Ecto.UUID.t(), pos_integer()) ::
          {:ok, :started} | {:error, :not_found | {:refused, refusal()}}
  def adopt_here(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    with {:ok, credential} <- Credentials.get_credential_by_ids(user_id, network_id),
         {:ok, _} <- Operator.connect_credential(credential) do
      {:ok, :started}
    else
      {:error, :not_found} -> {:error, :not_found}
      {:error, reason} -> {:error, {:refused, reason}}
    end
  end

  @doc """
  Spells the live node's name from `RELEASE_NODE` and our OWN node name.

  🔴 The host comes from `own_node`, never from `:inet.gethostname/0`.
  **MEASURED (#1685):** under `RELEASE_DISTRIBUTION=name` the two disagree
  — our node came up as `…@box2.example.com` while `gethostname` said
  `box2` — and the gethostname spelling is not merely wrong, it is
  rejected: `** Hostname box2 is illegal **`. Our own name is
  self-consistent with the live node's by construction, because both were
  derived by the same ERTS from the same `RELEASE_DISTRIBUTION`.

  An operator who qualified `RELEASE_NODE` themselves is taken at their
  word.
  """
  @spec target_node(String.t(), node()) :: node()
  def target_node(release_node, own_node) when is_binary(release_node) and is_atom(own_node) do
    if String.contains?(release_node, "@") do
      String.to_atom(release_node)
    else
      [_, host] = own_node |> Atom.to_string() |> String.split("@", parts: 2)
      String.to_atom(release_node <> "@" <> host)
    end
  end

  # ── the real transport ────────────────────────────────────────────────

  defp reach(user_id, network_id) do
    with {:ok, release_node} <- release_node(),
         {:ok, name_domain} <- name_domain(),
         {:ok, started?} <- start_distribution(name_domain) do
      try do
        call(target_node(release_node, node()), user_id, network_id)
      after
        # Only ours to stop. An operator evaluating this from a live remote
        # shell already had distribution up, and taking it down under them
        # would disconnect the node from its own cluster.
        if started?, do: :net_kernel.stop()
      end
    end
  end

  # No `RELEASE_NODE` means this is not running under a release boot script
  # — a source checkout's `mix` task, or a test — and there is no live
  # release node whose name we could even spell. Refuse before any I/O.
  defp release_node do
    case System.get_env("RELEASE_NODE") do
      nil -> {:error, :no_release_node}
      "" -> {:error, :no_release_node}
      node -> {:ok, node}
    end
  end

  # The generated boot script exports `RELEASE_DISTRIBUTION` (default
  # `sname`) and accepts exactly `sname | name | none`. `none` is an
  # operator saying the live node has no distribution at all: there is
  # nothing to reach, and trying would only cost a listener.
  defp name_domain do
    case System.get_env("RELEASE_DISTRIBUTION") do
      "none" -> {:error, :distribution_disabled}
      "name" -> {:ok, :longnames}
      # `sname`, or absent: the boot script default.
      _ -> {:ok, :shortnames}
    end
  end

  # `{:error, _}` here is the FIRST of the two no-live-node shapes: no epmd
  # is listening, which is what a box that has never started the service
  # looks like. It is the normal first-run path, not a fault.
  defp start_distribution(name_domain) do
    case :net_kernel.start(cli_node_name(), %{name_domain: name_domain}) do
      {:ok, _} -> {:ok, true}
      {:error, {:already_started, _}} -> {:ok, false}
      {:error, _} -> {:error, :no_distribution}
    end
  end

  # Unique per invocation: two operators typing verbs at once must not
  # collide on an epmd name, and neither may collide with the live node.
  defp cli_node_name do
    :"grappa_cli_#{:os.getpid()}_#{System.unique_integer([:positive])}"
  end

  defp call(target, user_id, network_id) do
    # The SECOND no-live-node shape: epmd is up (any long-lived host keeps
    # it after the service stops) but nothing answers to the name.
    if Node.connect(target) == true do
      erpc(target, user_id, network_id)
    else
      {:error, :unreachable}
    end
  end

  defp erpc(target, user_id, network_id) do
    :erpc.call(target, __MODULE__, :adopt_here, [user_id, network_id], @call_timeout)
  catch
    # `:erpc.call/5` RAISES on transport failure (timeout, a node that went
    # away between the connect and the call). The operator's shell must get
    # a message and an exit code, not a stack trace.
    kind, reason -> {:error, {:call_failed, {kind, reason}}}
  end

  @doc """
  The substituted implementation module, or `nil` for the real transport.

  Unlike the sibling `:persistent_term` seams (`Grappa.Push.BadgeSource`,
  `Grappa.Admission.Config`), this one has NO `boot/0`: the caller is a
  release `eval` node, which never runs `Grappa.Application.start/2`, so a
  boot-populated key would be permanently absent on the one path that
  matters. The default therefore IS production.
  """
  @spec impl() :: module() | nil
  def impl, do: :persistent_term.get(@key, nil)

  if Mix.env() == :test do
    @doc false
    @spec put_test_impl(module()) :: :ok
    def put_test_impl(mod) when is_atom(mod), do: :persistent_term.put(@key, mod)

    @doc false
    @spec reset_test_impl() :: :ok
    def reset_test_impl do
      _ = :persistent_term.erase(@key)
      :ok
    end
  end
end
