defmodule Grappa.Net.SourceAlias.Config do
  @moduledoc """
  Boot-time source-alias configuration: which platform adapter this substrate
  uses and which command runner it shells through.

  Read once via `boot/0` from `Application.get_env(:grappa, :source_alias, ...)`
  in `lib/grappa/application.ex` `start/2`, validated, stored in
  `:persistent_term`. Readers (`adapter/0`, `cmd/0`, `substrate/0`) are
  lock-free. CLAUDE.md "Application.{put,get}_env: boot-time only" — this is
  the designated boundary for the `:source_alias` keyspace (non-process
  DI-seam precedent: `Grappa.Admission.Config`, `Grappa.Themes.BackgroundImage`).

  ## Substrate is explicit, never autodetected

  The substrate (`:jail | :linux | :docker`) comes from the `GRAPPA_SUBSTRATE`
  env var — the SAME explicit `:jail|:linux|:docker` axis
  `Grappa.Deploy.Preflight` classifies against — NEVER a runtime `:os.type`
  probe. A Docker container reports `{:unix, :linux}` yet is NOT the native
  Linux AnyIP host; autodetect would silently arm the wrong adapter. Default
  `:docker` (the dev/CI stack) → the `Disabled` adapter → mode 2 refuses to
  arm, which is the safe default.

  ## What lives here vs. on the manager

  This module holds only the boot-env facts: the adapter module + the command
  runner. The ARM state (`armed?` / `disarm_reason`) lives on
  `Grappa.Net.SourceAliasManager` because it depends on the DB prefix
  (`ServerSettings.static_mapping_prefix/0`, resolved once the Repo is up) and
  is recomputed when the admin edits the prefix — neither is a boot-env fact.
  """

  alias Grappa.Net.SourceAlias

  @type substrate :: :jail | :linux | :docker

  @type t :: %__MODULE__{
          substrate: substrate(),
          adapter: module(),
          cmd: module()
        }

  @enforce_keys [:substrate, :adapter, :cmd]
  defstruct @enforce_keys

  @key {__MODULE__, :config}

  @doc """
  Reads `:source_alias` config from `Application.get_env/3`, derives the
  adapter from the substrate, and stores the resolved struct in
  `:persistent_term`. Called once from the application start callback.
  """
  @spec boot() :: :ok
  def boot do
    raw = Application.get_env(:grappa, :source_alias, [])
    :persistent_term.put(@key, build!(raw))
    :ok
  end

  @doc "The resolved config struct. Reads `:persistent_term` (lock-free)."
  @spec config() :: t()
  def config, do: :persistent_term.get(@key, default())

  @doc "The platform adapter module for this substrate."
  @spec adapter() :: module()
  def adapter, do: config().adapter

  @doc "The `Grappa.Sys.HardenedCmd`-shaped command runner (Mox'd in tests)."
  @spec cmd() :: module()
  def cmd, do: config().cmd

  @doc "The configured substrate atom."
  @spec substrate() :: substrate()
  def substrate, do: config().substrate

  # Safe fallback when boot/0 has not run (e.g. a one-shot mix task that
  # starts a partial tree): the Disabled adapter, so mode 2 refuses to arm
  # rather than shelling out on an unprovisioned host. Preserves the
  # graceful-degradation contract CLAUDE.md's persistent_term DI-seam rule
  # calls for.
  defp default do
    %__MODULE__{substrate: :docker, adapter: SourceAlias.Disabled, cmd: Grappa.Sys.HardenedCmd}
  end

  defp build!(raw) do
    substrate = Keyword.get(raw, :substrate, :docker)
    cmd = Keyword.get(raw, :cmd, Grappa.Sys.HardenedCmd)

    %__MODULE__{
      substrate: substrate,
      adapter: adapter_for(substrate),
      cmd: cmd
    }
  end

  # Substrate → adapter. FunctionClauseError on an unknown substrate is a
  # loud usage error (a miswired GRAPPA_SUBSTRATE), never a silent guess —
  # the same posture as Grappa.Deploy.Preflight's substrate guard.
  defp adapter_for(:jail), do: SourceAlias.FreeBSD
  defp adapter_for(:linux), do: SourceAlias.Linux
  defp adapter_for(:docker), do: SourceAlias.Disabled

  if Mix.env() == :test do
    @doc false
    @spec put_test_config(t()) :: :ok
    def put_test_config(%__MODULE__{} = cfg), do: :persistent_term.put(@key, cfg)
  end
end
