defmodule Grappa.Config.CompileEnvRuntimeOverlapTest do
  @moduledoc """
  Pin for #1692: no key written by `config/runtime.exs` may also be read
  with `Application.compile_env/3`.

  `Application.compile_env/3` records the value it observed into the
  owning app's `.app` file, and `Config.Provider.validate_compile_env/1`
  refuses to proceed when that record disagrees with the live app env.
  `config/runtime.exs` is evaluated AFTER compilation in the Mix lane and
  at boot in the release lane, so a key written there and read with
  `compile_env` disagrees by construction — the only open question is
  which door reports it first, and how loudly.

  Measured on #1692: `[GrappaWeb.Endpoint, :code_reloader]` was both.
  Phoenix reads it with `Application.compile_env/3` in its `use` macro,
  and `config/runtime.exs`'s prod block wrote it. The release lane
  silenced the resulting boot check with `validate_compile_env: false` in
  `mix.exs`; the Mix lane had no silencer, so every `bin/grappa` boot verb
  and every `scripts/mix.sh --env=prod` died before its task ran with
  `** (Mix) the application :grappa has a different value set for path
  [:code_reloader] inside key GrappaWeb.Endpoint`. `mix compile` dies on
  the same gate, so a build that reaches that state cannot be recompiled
  out of it — only `mix deps.clean grappa --build` or a wiped `_build`
  clears it.

  DERIVED, not manifested (CLAUDE.md design rule 1): the compile-time
  reads come from the `.app` files the build just produced, and the
  runtime writes from the parsed AST of `config/runtime.exs`. A hand-kept
  list of either would be a parallel structure that drifts from the thing
  it describes — the exact failure this pin exists to catch.

  Matching is prefix-symmetric on purpose. `Config.config/3` deep-merges a
  keyword value, so a write to `[:admission, :captcha_secret]` leaves a
  read of `[:admission, :network_circuit_threshold]` alone. But a write of
  a non-keyword value REPLACES the whole key, and a read may itself name a
  whole key (`[Grappa.ChannelDirectory]`) that any subkey write disturbs.
  So a write collides with a read when either path is a prefix of the
  other, and only then.

  Scope is every app `config/runtime.exs` writes to, not just `:grappa`:
  the `.app` that records a compile-time read is the one belonging to the
  app being READ, so a dep that reads our config — or its own — is covered
  by the same sweep.
  """

  # async: true — pure file reads, no global state.
  use ExUnit.Case, async: true

  @runtime_exs "config/runtime.exs"

  test "no config/runtime.exs key is also read with Application.compile_env" do
    writes = runtime_writes()

    overlap =
      for {app, read_path, _} <- compile_env_reads(),
          write_path <- Map.get(writes, app, []),
          collides?(read_path, write_path),
          do: "  * #{inspect(app)} #{inspect(read_path)} (written as #{inspect(write_path)})"

    assert overlap == [],
           """
           #{@runtime_exs} writes keys that are read at COMPILE time:

           #{Enum.join(Enum.sort(overlap), "\n")}

           A compile_env key set from runtime.exs cannot agree with the value
           baked into the .app file, and validate_compile_env exists to refuse
           exactly that. It kills the Mix lane outright (every bin/grappa boot
           verb, every scripts/mix.sh --env=prod) and takes `mix compile` with
           it, so the build cannot be recompiled back to health.

           Fix the WRITE, not the check: move the key to a compile-time config
           (config/config.exs or config/<env>.exs), or stop setting it. Passing
           --no-validate-compile-env, or setting :validate_compile_env to false
           in the release config, silences the detector and leaves the mismatch.
           """
  end

  # Every {app, key_path, observed} triple the current build recorded, across
  # all loaded applications — the app that OWNS the key owns the record.
  defp compile_env_reads do
    for {app, _, _} <- Application.loaded_applications(),
        entry <- app_compile_env(app),
        do: entry
  end

  defp app_compile_env(app) do
    with dir when is_list(dir) <- :code.lib_dir(app),
         path = Path.join([List.to_string(dir), "ebin", "#{app}.app"]),
         {:ok, [{:application, ^app, properties}]} <- :file.consult(path) do
      Keyword.get(properties, :compile_env, [])
    else
      _ -> []
    end
  end

  # %{app => [key_path]} for every `config/2` and `config/3` call in
  # runtime.exs, read off the AST rather than by regex so a multi-line call
  # or a computed value reads the same as a one-liner.
  defp runtime_writes do
    @runtime_exs
    |> File.read!()
    |> Code.string_to_quoted!()
    |> Macro.prewalk([], fn
      {:config, _, args} = node, acc when is_list(args) -> {node, writes(args) ++ acc}
      node, acc -> {node, acc}
    end)
    |> elem(1)
    |> Enum.group_by(&elem(&1, 0), &elem(&1, 1))
  end

  defp writes([app, keyword]) when is_atom(app) do
    case keyword_keys(keyword) do
      {:ok, keys} -> Enum.map(keys, &{app, [&1]})
      :error -> []
    end
  end

  defp writes([app, key, value]) when is_atom(app) do
    case {config_key(key), keyword_keys(value)} do
      {:error, _} -> []
      {{:ok, key}, {:ok, keys}} -> Enum.map(keys, &{app, [key, &1]})
      # A non-keyword value replaces the whole key, so the write is the key.
      {{:ok, key}, :error} -> [{app, [key]}]
    end
  end

  defp writes(_), do: []

  defp config_key(key) when is_atom(key), do: {:ok, key}
  defp config_key({:__aliases__, _, parts}), do: {:ok, Module.concat(parts)}
  defp config_key(_), do: :error

  defp keyword_keys(list) when is_list(list) and list != [] do
    if Enum.all?(list, &match?({key, _} when is_atom(key), &1)) do
      {:ok, Enum.map(list, &elem(&1, 0))}
    else
      :error
    end
  end

  defp keyword_keys(_), do: :error

  defp collides?(read_path, write_path) do
    List.starts_with?(read_path, write_path) or List.starts_with?(write_path, read_path)
  end
end
