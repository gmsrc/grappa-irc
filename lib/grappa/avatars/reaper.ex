defmodule Grappa.Avatars.Reaper do
  @moduledoc """
  Periodic sweep of expired `peer_avatars` rows + on-disk files (M3b).

  Same shape as `Grappa.Uploads.Reaper` — `:permanent` GenServer under
  the main application supervision tree, default 60s interval,
  configurable via `:interval_ms` for tests.

  Unlike `Uploads.Reaper`, this HARD-deletes: `Grappa.Avatars.PeerAvatar`
  has no soft-delete/public-URL contract to protect (a stale cached
  preview simply expiring and vanishing is the whole point of the
  cache — see `Grappa.Avatars` moduledoc). File unlink still happens
  FIRST, then the row, mirroring `Uploads.Reaper`'s ordering: a racing
  `GET /networks/:id/peer_avatar/:slug` between unlink + row-delete sees
  the row live + ENOENT on disk → 404, same as the public uploads path.

  Per-row failures log + continue — one bad row does not stop the sweep.
  """

  use Boundary, top_level?: true, deps: [Grappa.Avatars]

  use GenServer

  alias Grappa.Avatars
  alias Grappa.Avatars.PeerAvatar

  require Logger

  @default_interval_ms 60_000

  @type opts :: [interval_ms: pos_integer(), name: GenServer.name(), storage_root: Path.t()]

  defstruct [:interval_ms, :storage_root]
  @type t :: %__MODULE__{interval_ms: pos_integer(), storage_root: Path.t()}

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronous sweep — enumerates expired peer avatars + unlinks + hard-
  deletes each. `now` is injectable for time-sensitive tests.
  """
  @spec sweep(Path.t(), DateTime.t()) :: {:ok, non_neg_integer()}
  def sweep(storage_root, %DateTime{} = now) do
    expired = Avatars.list_expired(now)

    deleted =
      Enum.reduce(expired, 0, fn %PeerAvatar{} = row, acc ->
        path = Path.join(storage_root, row.slug)

        case unlink_then_delete(row, path) do
          :ok ->
            acc + 1

          {:error, reason} ->
            Logger.error("avatars reaper failure", peer_avatar_id: row.id, slug: row.slug, error: inspect(reason))
            acc
        end
      end)

    {:ok, deleted}
  end

  defp unlink_then_delete(%PeerAvatar{} = row, path) do
    case File.rm(path) do
      :ok -> :ok = Avatars.delete(row)
      {:error, :enoent} -> :ok = Avatars.delete(row)
      {:error, reason} -> {:error, {:fs, reason}}
    end
  end

  @impl GenServer
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    storage_root = Keyword.fetch!(opts, :storage_root)
    :ok = File.mkdir_p!(storage_root)

    schedule_tick(interval)
    {:ok, %__MODULE__{interval_ms: interval, storage_root: storage_root}}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    {:ok, n} = sweep(state.storage_root, DateTime.utc_now())
    if n > 0, do: Logger.info("avatars reaper swept", affected: n)

    schedule_tick(state.interval_ms)
    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
