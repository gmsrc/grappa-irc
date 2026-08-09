defmodule Mix.Tasks.Grappa.OptionParsing do
  @moduledoc """
  Shared CLI helpers for the `grappa.*` mix tasks.

  Lives under `Mix.Tasks` so it stays out of the runtime boundary
  graph — no production code depends on it; only the operator-side
  CLI tasks pull it in.

  These helpers raise `Mix.Error` on malformed input rather than
  returning error tuples: an operator typing `--server no-port` at
  the shell wants a loud, immediate failure with a clear message,
  not a `{:error, _}` ladder up to System.halt.
  """
  use Boundary, top_level?: true

  # Explicit string->atom map, NOT `~w(...)a` + `String.to_existing_atom/1`.
  # Found live 2026-07-23 (native Linux, MIX_ENV=prod mix task
  # invocation): `~w(...)a` only exists as atoms during THIS module's
  # own compile-time attribute evaluation — since the runtime function
  # body below only ever touches the derived STRINGS, the atoms
  # themselves never get compiled into this module's bytecode, so
  # loading `OptionParsing` does not register them in the atom table.
  # `to_existing_atom("nickserv_identify")` then raises unless some
  # OTHER module that references that literal atom (e.g. the
  # NetworkCredential schema's changeset validation) happened to load
  # first — true under a full release boot (everything gets referenced
  # eventually) but not guaranteed for a bare `mix grappa.bind_network`
  # invocation. Writing the atoms as literal map values here makes them
  # part of THIS module's own compiled bytecode, so they exist the
  # moment `OptionParsing` itself loads — no dependency on load order
  # elsewhere.
  @auth_map %{
    "auto" => :auto,
    "sasl" => :sasl,
    "server_pass" => :server_pass,
    "nickserv_identify" => :nickserv_identify,
    "none" => :none
  }
  @auth_strings Map.keys(@auth_map)

  @doc """
  Parses `args` against `switches`, returning the option keyword list.

  Raises `Mix.Error` — one line, no traceback — when a switch is
  unrecognised, when its value will not parse, or when one of `required`
  is absent.

  `OptionParser.parse(args, strict: ...)` reports none of that on its
  own (GH #1086): an unrecognised switch lands in the `invalid` element
  every caller here was discarding, so `--nework azzurra` silently
  became no `--network` at all, and the first `Keyword.fetch!` for the
  option it failed to set dumped a raw `KeyError` traceback at the
  operator.

  An unrecognised switch is reported IN PREFERENCE to the required
  option it failed to set. `--nework azzurra` names the typo; saying
  `--network` is missing would send the operator hunting for a flag
  they believe they typed.
  """
  @spec parse!([String.t()], keyword(), [atom()]) :: keyword()
  def parse!(args, switches, required)
      when is_list(args) and is_list(switches) and is_list(required) do
    {opts, _rest, invalid} = OptionParser.parse(args, strict: switches)

    reject_invalid!(invalid, switches)
    reject_missing!(opts, required)

    opts
  end

  @doc """
  Parses a `host:port` server spec into `{host, port}`. Raises on
  malformed input.
  """
  @spec parse_server(String.t()) :: {String.t(), :inet.port_number()}
  def parse_server(spec) when is_binary(spec) do
    case String.split(spec, ":") do
      [host, port_str] ->
        case Integer.parse(port_str) do
          {port, ""} when port > 0 and port <= 65_535 ->
            {host, port}

          _ ->
            Mix.raise("--server port must be 1..65535 (got #{inspect(port_str)})")
        end

      _ ->
        Mix.raise("--server must be host:port (got #{inspect(spec)})")
    end
  end

  @doc """
  Parses an `--auth` flag value into an atom. Raises on unknown values.
  """
  @spec parse_auth(String.t()) ::
          :auto | :sasl | :server_pass | :nickserv_identify | :none
  def parse_auth(str) when is_binary(str) do
    case Map.fetch(@auth_map, str) do
      {:ok, atom} -> atom
      :error -> Mix.raise("--auth must be one of #{Enum.join(@auth_strings, "|")} (got #{inspect(str)})")
    end
  end

  @doc """
  Parses a comma-separated channel list into `[String.t()]`. `nil`
  and the empty string both yield `[]`.
  """
  @spec parse_autojoin(String.t() | nil) :: [String.t()]
  def parse_autojoin(nil), do: []
  def parse_autojoin(""), do: []

  def parse_autojoin(str) when is_binary(str) do
    str
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
  end

  defp reject_invalid!([], _switches), do: :ok

  defp reject_invalid!(invalid, switches) do
    known = Enum.map(switches, fn {name, _type} -> flag(name) end)

    Mix.raise(Enum.map_join(invalid, "; ", &invalid_message(&1, known)))
  end

  # `OptionParser` reports an unrecognised switch and a known switch
  # whose value will not parse through the SAME `invalid` element, so
  # the two are told apart by whether the reported spelling appears in
  # the caller's own switch table.
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

  defp reject_missing!(opts, required) do
    case Enum.reject(required, &Keyword.has_key?(opts, &1)) do
      [] -> :ok
      [one] -> Mix.raise("missing required option #{flag(one)}")
      many -> Mix.raise("missing required options #{Enum.map_join(many, ", ", &flag/1)}")
    end
  end

  # `services_flavor:` in the switch table is `--services-flavor` on the
  # command line. Derived from the atom's string form only — never the
  # reverse direction, for the reason the `@auth_map` note above gives.
  defp flag(name), do: "--" <> String.replace(Atom.to_string(name), "_", "-")
end
