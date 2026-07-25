defmodule Grappa.ApplicationSupervisionTreeTest do
  # Drift pin (GH #369 theme 8 / X2 — docs-as-authority drifting).
  #
  # The CLAUDE.md "## Architecture — Top-level supervision tree" fenced
  # block is documentation-as-authority: it's the map new contributors
  # (human and Claude) read to understand what runs at boot. It rotted —
  # ten children were added to `lib/grappa/application.ex` over time
  # (AdminEvents, SessionLog, Visitors.ShareTokens, the three RateLimit
  # singletons, Net.PtrCache, Task.Supervisor, Uploads.Reaper,
  # Accounts.Reaper) without ever being added to the doc tree, and nothing
  # caught it.
  #
  # This pins the doc against the RUNNING supervisor — the real source of
  # truth, not a brittle re-parse of application.ex source (cf. the #112
  # nit that criticises source-grep tests). Every child currently
  # supervised under `Grappa.Supervisor` MUST be named in the CLAUDE.md
  # tree block. Modeled on `router_sw_denylist_test.exs`: read the mirror
  # file, extract the pinned region, assert the superset relation.
  #
  # Direction — doc ⊇ running children. A documented-but-not-running child
  # (`Grappa.Bootstrap`: `:start_bootstrap = false` in test env) is NOT
  # flagged; only an UNDOCUMENTED running child fails. That's exactly the
  # "added a child, forgot the doc" drift class this pin exists to catch.
  #
  # Requires the worktree oneshot to bind-mount CLAUDE.md (scripts/_lib.sh
  # WORKTREE_VOLUMES) so the pin reads the worktree's edited copy, not
  # main's via the base `./:/app` bind.
  use ExUnit.Case, async: true

  @claude_md "CLAUDE.md"

  describe "CLAUDE.md supervision tree ⊇ running top-level children" do
    test "every child under Grappa.Supervisor is named in the CLAUDE.md tree block" do
      tree = supervision_tree_block()
      running = running_children()

      undocumented =
        running
        |> Enum.reject(fn {_, labels} ->
          Enum.any?(labels, &documented?(tree, &1))
        end)
        |> Enum.map(fn {primary, _} -> primary end)

      assert undocumented == [],
             """
             CLAUDE.md "Top-level supervision tree" is missing supervised child(ren): #{inspect(undocumented)}.

             Every child started by lib/grappa/application.ex MUST appear in the
             fenced tree block under "## Architecture" in CLAUDE.md, with its
             one-line why-note. (Separately — not enforced here — add its
             ordering why-comment in application.ex per CLAUDE.md "Don't touch
             supervision tree ordering casually".)

             Fix: add the missing child(ren) to the CLAUDE.md tree block.

             Running children: #{inspect(Enum.map(running, &elem(&1, 0)))}
             """
    end
  end

  # For each running child, the labels the doc may legitimately use to name
  # it. `Supervisor.which_children/1` returns `{id, pid, type, modules}`;
  # match on the child-spec `id` only. The `id` is the friendly name the
  # tree uses — the plain module (`Grappa.AdminEvents`, `GrappaWeb.Endpoint`)
  # or the REGISTERED name for library children (`Grappa.SessionRegistry`
  # for `{Registry, name: ...}`, `Grappa.SessionSupervisor`,
  # `Grappa.TaskSupervisor`). Deliberately NOT the `modules` field: it
  # carries generic library module names (`Registry`, `Task.Supervisor`,
  # `DynamicSupervisor`) that are already substrings of the tree, so a
  # SECOND undocumented instance (e.g. another `{Registry, name: ...}`)
  # would falsely pass. id-only errs toward false-FAIL (an unrecognised id
  # is flagged), the safe direction — it forces documentation.
  #
  # One id is a `Foo.Supervisor` wrapper rather than the friendly name:
  # Phoenix.PubSub's child id is `Phoenix.PubSub.Supervisor` while the tree
  # names `Phoenix.PubSub`. The `.Supervisor`-suffix-stripped candidate
  # covers that (and any other lib that wraps the same way). `inspect/1`
  # renders atoms without the `Elixir.` prefix — the spelling the tree uses.
  defp running_children do
    Grappa.Supervisor
    |> Supervisor.which_children()
    |> Enum.map(fn {id, _, _, _} ->
      label = inspect(id)
      {label, Enum.uniq([label, String.replace_suffix(label, ".Supervisor", "")])}
    end)
  end

  # Whole-token containment: `label` must appear in the tree as a standalone
  # dotted module token — not immediately preceded or followed by an
  # identifier char (`[\w.]`). Prevents a child id from being spuriously
  # "documented" by being a dotted PREFIX (or suffix) of a longer tree
  # entry, e.g. a bare `Grappa.RateLimit` child must NOT match the
  # `Grappa.RateLimit.DailyQuota` line.
  defp documented?(tree, label) do
    Regex.match?(~r/(?<![\w.])#{Regex.escape(label)}(?![\w.])/, tree)
  end

  # Extract the first fenced ``` block that follows the "supervision tree"
  # heading — the region this pin is responsible for.
  defp supervision_tree_block do
    source = File.read!(@claude_md)

    case Regex.run(~r/Top-level supervision tree:\s*```(.+?)```/s, source) do
      [_, block] -> block
      _ -> flunk("Could not locate the fenced supervision-tree block in #{@claude_md}")
    end
  end
end
