defmodule Grappa.Release.CLIFlagParityTest do
  @moduledoc """
  #1158 — the release flavor's account verbs and the source flavor's mix
  tasks must accept the SAME flags.

  The issue's complaint was that the verb names mean different things on
  the two flavors. They now mean the same thing because they call the
  same context functions — but a flag table copied into a second module
  drifts, and the failure is silent: `--sasl-user` quietly working on a
  dev checkout and being rejected on the release box the operator is
  actually holding.

  Both tables are read from source, for the same reason
  `Mix.Tasks.Grappa.OperatorHelpDriftTest` reads the dispatcher's: module
  attributes are not retained at runtime, and the source IS what ships.

  What is gated: the flag SET, both directions. What is not: which flags
  are required, and the positional/flag split — `--user` and `--network`
  are positional arguments on the release side, deliberately, because
  `grappa add-network vjt azzurra` is the spelling vjt asked for.
  """
  use ExUnit.Case, async: true

  @cli "lib/grappa/release/cli.ex"
  @bind_task "lib/mix/tasks/grappa.bind_network.ex"
  @create_task "lib/mix/tasks/grappa.create_user.ex"

  @external_resource @cli
  @external_resource @bind_task
  @external_resource @create_task

  # `--user` / `--network` are the two entities; the release CLI takes
  # them as positionals, so they are not expected in its switch table.
  @positional [:user, :network]

  # `create-user NAME` is likewise positional, and the mix task has no
  # switch for the admin flag's release-side spelling to differ on.
  @create_positional [:name]

  defp attribute(file, name) do
    {_, switches} =
      file
      |> File.read!()
      |> Code.string_to_quoted!()
      |> Macro.prewalk([], fn
        {:@, _, [{^name, _, [list]}]} = node, _ when is_list(list) -> {node, list}
        node, acc -> {node, acc}
      end)

    refute switches == [], "no @#{name} list found in #{file} — this gate is measuring nothing"

    switches |> Keyword.keys() |> MapSet.new()
  end

  test "add-network accepts exactly the flags grappa.bind_network accepts" do
    release_side = attribute(@cli, :add_network_switches)
    source_side = MapSet.difference(attribute(@bind_task, :switches), MapSet.new(@positional))

    assert MapSet.equal?(release_side, source_side), """
    `grappa add-network` and grappa.bind_network disagree on flags.

      on the release but not the task: #{inspect(MapSet.to_list(MapSet.difference(release_side, source_side)))}
      on the task but not the release: #{inspect(MapSet.to_list(MapSet.difference(source_side, release_side)))}
    """
  end

  test "create-user accepts exactly the flags grappa.create_user accepts" do
    release_side = attribute(@cli, :create_user_switches)
    source_side = MapSet.difference(attribute(@create_task, :switches), MapSet.new(@create_positional))

    assert MapSet.equal?(release_side, source_side), """
    `grappa create-user` and grappa.create_user disagree on flags.

      on the release but not the task: #{inspect(MapSet.to_list(MapSet.difference(release_side, source_side)))}
      on the task but not the release: #{inspect(MapSet.to_list(MapSet.difference(source_side, release_side)))}
    """
  end

  test "every flag the release CLI accepts is named in the usage it prints" do
    # The usage text is the operator's only documentation on a box with no
    # checkout and no man page. A switch missing from it is invisible.
    {_, usage_block} =
      @cli
      |> File.read!()
      |> Code.string_to_quoted!()
      |> Macro.prewalk("", fn
        {:@, _, [{:usage, _, [text]}]} = node, _ when is_binary(text) -> {node, text}
        node, acc -> {node, acc}
      end)

    refute usage_block == "", "no @usage heredoc in #{@cli} — this gate is measuring nothing"

    switches =
      MapSet.union(
        attribute(@cli, :add_network_switches),
        attribute(@cli, :create_user_switches)
      )

    for switch <- switches do
      flag = "--" <> String.replace(Atom.to_string(switch), "_", "-")
      assert usage_block =~ flag, "#{flag} is accepted but never mentioned in the usage text"
    end
  end
end
