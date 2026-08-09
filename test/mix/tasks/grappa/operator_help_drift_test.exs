defmodule Mix.Tasks.Grappa.OperatorHelpDriftTest do
  @moduledoc """
  #1086 — the flag table of every boot verb exists TWICE, and this is the
  gate that keeps the two copies honest.

  `bin/grappa <verb> --help` answers inline, from a `verb_help_<snake>`
  heredoc in the dispatcher. The same flags are declared, authoritatively,
  as the mix task's `@switches`. A switch added, renamed or dropped in the
  task with no matching edit in the dispatcher gives the operator a help
  text that lies — this test fails on the first byte of that drift, in
  BOTH directions (a flag in the help that no switch backs, and a switch
  with no flag in the help).

  ## Why the help is hand-written and not generated

  The obvious alternative was to generate the help blocks from
  `@shortdoc`/`@moduledoc` at build time, mirroring `wireTypes.ts` (which
  `mix grappa.gen_wire_types` derives from `Wire` typespecs, drift-gated
  by `--check` in `scripts/check.sh` + CI). That precedent does not
  transfer, for three reasons:

    * **The generator derives TYPES, not prose.** `gen_wire_types` reads
      `@type` specs — a machine-readable declaration with exactly one
      correct rendering in TypeScript. `@moduledoc` is prose, and prose
      has no single correct rendering into a second audience's document.

    * **The two documents answer different questions.** The moduledoc
      documents the MIX TASK: it spells the command
      `scripts/mix.sh grappa.create_user`, not `bin/grappa create-user`,
      and carries developer material — Boundary-declaration paragraphs
      (`grappa.create_user`, `grappa.gen_encryption_key`), the #251/#266
      vhost-precedence history, the post-mortem of the 9-day cold-start
      mystery (`grappa.add_server`). Emitting it verbatim ships that to an
      operator who asked which flags a verb takes. Emitting a curated
      subset means marking which prose is operator-facing — i.e. writing
      the operator's text a second time, in the `.ex` file, and then
      adding a build step to move it.

    * **What actually drifts is the flag table**, and that IS
      machine-readable. So it is gated here, and only it. Divergent prose
      between the two surfaces is not a defect; a divergent flag list is.

  ## What is gated, and what deliberately is not

  Gated: the SET of flags, both directions, per verb. A boolean switch may
  be written `--x`, `--no-x`, or both — `--tls / --no-tls` and `--admin`
  are equally acceptable spellings.

  NOT gated: which flags are required. `@required` is not the whole truth
  today — `grappa.set_network_caps` declares `@required []` while
  `--network` is unconditionally required, raised later by `fetch_slug!/1`
  so that "you passed no cap at all" is reported before "you passed no
  network". Gating required-ness against `@required` would force the help
  to call `--network` optional, which is false. Required-ness stays prose.
  """
  use ExUnit.Case, async: true

  @dispatcher "bin/grappa"
  @source File.read!(@dispatcher)
  @external_resource @dispatcher

  # kebab verb -> mix task name, read off the dispatcher's VERBS table so a
  # newly added boot verb is gated without editing this file.
  @boot_verbs Enum.map(
                Regex.scan(~r/^\s*\[([a-z-]+)\]="boot\|([a-z_.]+)\|/m, @source),
                fn [_, verb, task] -> {verb, task} end
              )

  test "the boot-verb extractor is not silently empty" do
    # Without this, a regex that stops matching generates ZERO tests below
    # and the whole gate passes vacuously.
    occurrences = length(Regex.scan(~r/="boot\|/, @source))

    assert occurrences > 0, "no boot verbs in #{@dispatcher} — the VERBS table shape changed"
    assert length(@boot_verbs) == occurrences
  end

  for {verb, task} <- @boot_verbs do
    @verb verb
    @task task

    test "#{verb} help lists exactly the @switches of #{task}" do
      switches = declared_switches(@task)
      declared = MapSet.new(Keyword.keys(switches))
      mentioned = @verb |> help_body() |> mentioned_switches(switches)

      assert MapSet.equal?(mentioned, declared), """
      bin/grappa's `#{@verb}` help and #{@task}'s @switches disagree.

        in the help but not a switch: #{inspect(MapSet.to_list(MapSet.difference(mentioned, declared)))}
        a switch but not in the help: #{inspect(MapSet.to_list(MapSet.difference(declared, mentioned)))}
      """
    end
  end

  # The heredoc body of `verb_help_<snake>() { cat <<'EOF' ... EOF }`.
  defp help_body(verb) do
    snake = String.replace(verb, "-", "_")
    pattern = Regex.compile!("^verb_help_#{snake}\\(\\) \\{ cat <<'EOF'\n(.*?)\nEOF\n\\}", "ms")

    case Regex.run(pattern, @source) do
      [_, body] -> body
      nil -> flunk("no verb_help_#{snake}() heredoc in #{@dispatcher}")
    end
  end

  # A flag DECLARATION line is one indented into a `Required:` / `Optional:`
  # section (8 spaces or more) whose first token is a `--flag`; every
  # `--flag` token on such a line counts, so `--tls / --no-tls` declares
  # both spellings.
  #
  # The indent is load-bearing, not decoration. Prose in these blocks sits
  # at 4 columns and wraps: a sentence that happens to break onto
  # `--max-* and its --clear-* twin ...` would otherwise be read as
  # declaring two switches called `max_` and `clear_`. Requiring the
  # section indent makes wrapped prose safe by construction, and a flag
  # line written at the WRONG indent still fails loudly — as a switch the
  # help does not mention.
  @flag_line ~r/^ {8,}--[a-z0-9-]/

  defp mentioned_switches(body, switches) do
    body
    |> String.split("\n")
    |> Enum.filter(&Regex.match?(@flag_line, &1))
    |> Enum.flat_map(&Regex.scan(~r/--[a-z0-9-]+/, &1))
    |> Enum.map(fn [flag] -> to_switch(flag, switches) end)
    |> MapSet.new()
  end

  # `--no-tls` is OptionParser's negation of the boolean switch `:tls`, not
  # a switch of its own.
  defp to_switch(flag, switches) do
    atom = flag |> String.trim_leading("-") |> String.replace("-", "_") |> String.to_atom()

    negated_boolean(atom, switches) || atom
  end

  defp negated_boolean(atom, switches) do
    case Atom.to_string(atom) do
      "no_" <> rest ->
        stripped = String.to_atom(rest)
        if Keyword.get(switches, stripped) == :boolean, do: stripped

      _ ->
        nil
    end
  end

  # @switches straight off the task's AST. Module attributes are not
  # retained at runtime, so the source is the only place to read them —
  # and reading the source is the point: this gate must fail on an edit
  # that never gets recompiled into anything the dispatcher can see.
  defp declared_switches(task) do
    {_, switches} =
      "lib/mix/tasks/#{task}.ex"
      |> File.read!()
      |> Code.string_to_quoted!()
      |> Macro.prewalk([], fn
        {:@, _, [{:switches, _, [list]}]} = node, _ when is_list(list) -> {node, list}
        node, acc -> {node, acc}
      end)

    switches
  end
end
