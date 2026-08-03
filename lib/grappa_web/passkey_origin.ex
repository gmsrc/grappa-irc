defmodule GrappaWeb.PasskeyOrigin do
  @moduledoc """
  The WebAuthn Relying Party origin this deployment asserts.

  ## Why it is not just the Endpoint URL

  A passkey is bound to an origin at registration and will refuse to
  answer for any other, so this value is a durable property of the
  deployment rather than of the request that happens to be in flight.
  Operators who front the bouncer with something whose public origin
  differs from what Phoenix would derive set `GRAPPA_PASSKEY_ORIGIN`
  (`config/runtime.exs`); everyone else gets `Endpoint.url()`, which is
  already rooted at the public origin for exactly the same reason
  upload links are.

  ## Boot-time read → `:persistent_term`

  Per CLAUDE.md "`Application.{put,get}_env`: boot-time only, runtime
  banned", `Grappa.Application.start/2` calls `boot/0` once before the
  supervision tree comes up and the value lands in `:persistent_term`;
  `origin/0` is then a lock-free read on the request path. Mirrors
  `Grappa.HttpHosts.boot/1` and `Grappa.Push.BadgeSource.boot/0`.

  The Endpoint fallback is resolved at CALL time, not at boot — the
  Endpoint is not started yet when `boot/0` runs. It also means the two
  passkey controllers no longer each carry their own copy of the
  fallback, which is how they could have drifted apart.

  Tests substitute via `put_test_origin/1`, not `Application.put_env`.

  Inherits the `GrappaWeb` boundary (no explicit `use Boundary`) — same
  pattern as `GrappaWeb.RemoteIP` and `GrappaWeb.Validation`. It reads
  `GrappaWeb.Endpoint`, which lives in that boundary, so standing itself
  up as a top-level one would only manufacture a cycle.
  """

  @key {__MODULE__, :origin}

  @doc """
  Stash the operator-configured passkey origin into `:persistent_term`.

  Stores `nil` when `GRAPPA_PASSKEY_ORIGIN` is unset, which is the
  signal for `origin/0` to fall back to the Endpoint.
  """
  @spec boot() :: :ok
  def boot do
    :persistent_term.put(@key, Application.get_env(:grappa, :passkey_origin))
    :ok
  end

  @doc """
  The origin every WebAuthn ceremony is bound to: the operator's
  override when one is configured, otherwise the Endpoint's public URL.
  """
  @spec origin() :: String.t()
  def origin do
    case :persistent_term.get(@key, nil) do
      configured when is_binary(configured) -> configured
      nil -> GrappaWeb.Endpoint.url()
    end
  end

  if Mix.env() == :test do
    @doc false
    @spec put_test_origin(String.t() | nil) :: :ok
    def put_test_origin(origin) do
      :persistent_term.put(@key, origin)
      :ok
    end
  end
end
