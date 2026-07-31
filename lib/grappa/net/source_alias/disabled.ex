defmodule Grappa.Net.SourceAlias.Disabled do
  @moduledoc """
  No-source-binding adapter (#543) — the default for the `:docker` substrate
  and any host without the FreeBSD wrapper or the Linux AnyIP prerequisites.

  `arm_check` always refuses to arm with a concrete reason, so mode 2 is HELD
  (`{:hold, :mode2_disarmed}`) rather than egressing from a shared
  kernel-default source (Global Constraint). Because a disarmed mode 2 never
  resolves a derived source, the manager never calls `ensure_source` /
  `release_source` — so they RAISE: reaching them means the arm gate was
  bypassed, a bug that must surface loudly, not silently no-op into a wrong
  egress. `list_aliases` is `{:ok, []}` so boot reconcile is a clean no-op.
  """

  @behaviour Grappa.Net.SourceAlias

  @impl Grappa.Net.SourceAlias
  def arm_check(_), do: {:error, :substrate_disabled}

  # Truthfully no_return (always raises) — a narrower success typing than the
  # behaviour's `:ok | {:error, term}`, which Dialyzer flags unless declared.
  # Reaching either is a bug (the arm gate was bypassed), so raising is the
  # contract, not a fallback.
  @spec ensure_source(String.t(), String.t()) :: no_return()
  @impl Grappa.Net.SourceAlias
  def ensure_source(_, _) do
    raise "Grappa.Net.SourceAlias.Disabled.ensure_source/2 must never be called " <>
            "— mode 2 is disarmed on this substrate; the arm gate was bypassed"
  end

  @spec release_source(String.t(), String.t()) :: no_return()
  @impl Grappa.Net.SourceAlias
  def release_source(_, _) do
    raise "Grappa.Net.SourceAlias.Disabled.release_source/2 must never be called " <>
            "— mode 2 is disarmed on this substrate; the arm gate was bypassed"
  end

  @impl Grappa.Net.SourceAlias
  def list_aliases(_), do: {:ok, []}
end
