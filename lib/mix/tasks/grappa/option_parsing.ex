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

  ## Why the grammar itself moved out (#1158)

  Every rule below — which switches exist, how `host:port` splits, which
  `--auth` values are legal — is ALSO the grammar of the packaged
  release's own operator verbs (`grappa add-network ...`). Those cannot
  call anything under `Mix`, because a release ships no Mix at all. So
  the rules live once, in `Grappa.Release.CLI`, as error-tuple functions,
  and this module is the thin Mix-flavored face over them: same
  messages, same acceptance, `Mix.raise` instead of a tuple. Two copies
  of the auth table would mean one flag quietly accepting different
  values depending on which flavor the operator was standing on.
  """
  use Boundary, top_level?: true, deps: [Grappa.Release]

  alias Grappa.Release.CLI

  @doc """
  Parses `args` against `switches`, returning the option keyword list.

  Raises `Mix.Error` — one line, no traceback — when a switch is
  unrecognised, when its value will not parse, or when one of `required`
  is absent. See `Grappa.Release.CLI.parse/3` for why `OptionParser`
  reports none of that on its own (GH #1086), and why an unrecognised
  switch is reported in preference to the option it failed to set.
  """
  @spec parse!([String.t()], keyword(), [atom()]) :: keyword()
  def parse!(args, switches, required)
      when is_list(args) and is_list(switches) and is_list(required) do
    args
    |> CLI.parse(switches, required)
    |> or_raise()
  end

  @doc """
  Parses a `host:port` server spec into `{host, port}`. Raises on
  malformed input.
  """
  @spec parse_server(String.t()) :: {String.t(), :inet.port_number()}
  def parse_server(spec) when is_binary(spec) do
    spec
    |> CLI.parse_endpoint()
    |> or_raise()
  end

  @doc """
  Parses an `--auth` flag value into an atom. Raises on unknown values.
  """
  @spec parse_auth(String.t()) ::
          :auto | :sasl | :server_pass | :nickserv_identify | :none
  def parse_auth(string) when is_binary(string) do
    string
    |> CLI.parse_auth()
    |> or_raise()
  end

  @doc """
  Parses a comma-separated channel list into `[String.t()]`. `nil`
  and the empty string both yield `[]`.
  """
  @spec parse_autojoin(String.t() | nil) :: [String.t()]
  defdelegate parse_autojoin(string), to: CLI

  defp or_raise({:ok, value}), do: value
  defp or_raise({:error, message}), do: Mix.raise(message)
end
