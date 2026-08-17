defmodule Grappa.LoggerMetadataAllowlistTest do
  @moduledoc """
  Both drift directions for the Logger `:metadata` allowlist in
  `config/config.exs` (#1403, architecture review A7, formerly A18).

  The forward direction moved here from `Grappa.Scrollback.MetaTest`: 85 of
  the 108 allowlisted atoms have nothing to do with scrollback meta, so the
  invariant does not belong to one Ecto type's test file. Its assertion is
  unchanged.

  ## Why the reverse direction exists

  The forward gate (`known_keys -- allowlist == []`) forces every scrollback
  meta key into the allowlist. Nothing gated the other way, and the gap had
  already filled: `:cap_kind`, `:cap_value` and `:cap_observed` were in the
  allowlist while the string does not occur in a single file under `lib/`.
  Four other entries carry a hand-written comment apologising for being
  present-but-unlogged; those four are the ones somebody happened to notice.

  ## What the reverse gate actually proves

  A LOWER BOUND, deliberately. An allowlisted atom must occur as a substring
  on a non-comment line of some `lib/**/*.ex` file. That is much weaker than
  "something logs it":

    * a mention inside a `@moduledoc` / `@doc` heredoc counts (only whole
      `#` comment lines are dropped);
    * a substring of a longer identifier counts.

  So the gate catches "cannot possibly be logged", not "is not logged". The
  weakness is the point: the derivation is a plain substring scan, which
  cannot go red on a key that is alive but built dynamically. Two such keys
  exist today and would defeat anything stricter — `Grappa.Log.session_context/2`
  hands `[user: u, network: n]` to `Logger.metadata/1` through a function call,
  and `Grappa.IRC.Client` receives the same pair as a `start_link` opt. An
  AST walk of Logger call sites would report both as orphans.

  `Meta.known_keys/0` is subtracted before the check so the two directions
  cannot fight: a key the forward gate REQUIRES in the allowlist must never be
  reported as an orphan by the reverse one.
  """

  # async: true — file reads plus an Application env read, no global state
  # mutated. Mirrors `GrappaWeb.ErrorTokensDriftTest`, the sibling
  # derive-from-source drift pin.
  use ExUnit.Case, async: true

  alias Grappa.Scrollback.Meta

  @lib_glob "lib/**/*.ex"

  # Injected by the plug stack, never by our own code: `Plug.RequestId` is
  # mounted in `GrappaWeb.Endpoint` and puts `:request_id` into the process
  # metadata itself. Today the atom would also survive the substring scan on
  # two `@moduledoc` mentions (`log.ex`, `endpoint.ex`) — this entry is what
  # keeps a reworded moduledoc from turning a live framework key into an
  # apparent orphan somebody then prunes.
  @framework_injected [:request_id]

  describe "known_keys/0 ↔ Logger metadata allowlist (architecture review A18)" do
    test "every Meta @known_keys atom is present in the Logger :metadata allowlist" do
      missing = Meta.known_keys() -- logger_metadata_keys()

      assert missing == [],
             "Meta.@known_keys not in Logger metadata allowlist: " <>
               "#{inspect(missing)} — extend config/config.exs :metadata list"
    end
  end

  describe "Logger metadata allowlist -> lib/ (reverse direction, #1403)" do
    test "every allowlisted atom is reachable from lib/, a known_key, or framework-injected" do
      source = lib_source()
      known = Meta.known_keys()

      orphans =
        Enum.reject(logger_metadata_keys(), fn key ->
          key in known or key in @framework_injected or
            String.contains?(source, Atom.to_string(key))
        end)

      assert orphans == [],
             "Logger :metadata atoms that occur nowhere under lib/: " <>
               "#{inspect(orphans)} — drop them from config/config.exs, or add " <>
               "them to @framework_injected with the reason they are set from " <>
               "outside this codebase"
    end
  end

  # Elixir 1.15+ uses :default_formatter; fall back to legacy :console.
  defp logger_metadata_keys do
    modern = Application.get_env(:logger, :default_formatter, [])[:metadata] || []

    if modern == [],
      do: Application.get_env(:logger, :console, [])[:metadata] || [],
      else: modern
  end

  # Every `lib/` source line that is not a whole-line `#` comment, joined.
  # Whole-line comments are dropped so an atom surviving only in a "removed
  # in #NNN" note does not keep its allowlist entry alive; heredocs are kept
  # on purpose (see the moduledoc — this is a lower bound, not a census).
  defp lib_source do
    @lib_glob
    |> Path.wildcard()
    |> Enum.map_join("\n", fn path ->
      path
      |> File.read!()
      |> String.split("\n")
      |> Enum.reject(&String.starts_with?(String.trim_leading(&1), "#"))
      |> Enum.join("\n")
    end)
  end
end
