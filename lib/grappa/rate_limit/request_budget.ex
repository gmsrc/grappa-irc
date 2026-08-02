defmodule Grappa.RateLimit.RequestBudget do
  @moduledoc """
  GH #630 — the coarse per-subject INBOUND request budget: the single
  decision function both inbound doors call before doing any work.

  ## One code path, every door

  A misbehaving (or hostile) client can flood us over EITHER surface —
  every `GrappaChannel.handle_in` WS verb AND every REST write. #340's
  send bucket guards only `POST /messages`, so the cheap doors
  (`visibility`, `watchlist`, unknown-event catch-all, …) were unmetered.
  `check/1` is the SHARED coarse gate so a flooder cannot dodge it by
  switching surface: `GrappaWeb.Plugs.RequestBudget` (REST writes) and the
  `GrappaChannel` `handle_in` guard both call THIS function. #340's
  per-(subject, network) send bucket stays ON TOP as the finer send limit;
  this is the outer gate, not a replacement.

  ## The ladder (reuse the verbs, not the nouns)

  Built entirely on the two existing rate-limit primitives — no parallel
  state machine, no state that can be derived:

    1. **Throttle** — `Grappa.RateLimit.TokenBucket` holds a per-subject
       burst of `capacity` tokens, refilling at `refill_per_sec`. Each
       `check/1` consumes one. A full bucket ⇒ `:ok`.
    2. **429** — an empty bucket ⇒ `{:error, :rate_limited}`. The caller
       refuses the request (HTTP 429 / WS error frame + `retry_after_ms/0`
       hint), nothing is queued.
    3. **Sever** — every over-budget event ALSO records one failure in
       `Grappa.RateLimit.FailureWindow` (a rolling window per subject).
       The escalation counter IS that window — derived, not duplicated.
       When the count reaches `sever_after` within `sever_window_ms`, the
       EXACT crossing (`count == sever_after`) returns `{:error, :severed}`
       so the caller severs the web session ONCE (close socket + revoke
       auth session); counts past the crossing fall back to
       `{:error, :rate_limited}` (no double-sever). 🔴 The IRC
       `Session.Server` is NEVER touched — a client-side flood costs the
       user their web session, not their IRC presence.

  A reformed client heals on its own: once it stops over-shooting, the
  bucket refills (no more `:rate_limited`), no new failures are recorded,
  and the window expires — no reset verb needed.

  ## Config via the boot seam (never `Application.get_env/2` at runtime)

  `boot/0` reads `:grappa, :request_budget` once at application start,
  validates, and stashes the struct in `:persistent_term`; `config/0` is a
  lock-free runtime read. Same boundary as `Grappa.Admission.Config`.
  Tests inject deterministic tiny values via `put_test_config/1`.
  """

  alias Grappa.RateLimit.{FailureWindow, TokenBucket}

  @budget_bucket :request_budget
  @flood_bucket :request_flood

  @typedoc """
  The subject a budget is keyed by — the bare-id `Grappa.Subject.t()`
  shape (`{:user, uuid} | {:visitor, uuid}`). Declared locally to keep
  the `Grappa.RateLimit` boundary free of a `Grappa.Session` dep — the
  budget is subject-scoped, not session-scoped.
  """
  @type subject :: {:user, String.t()} | {:visitor, String.t()}

  @typedoc "Outcome of the ladder for one request."
  @type decision :: :ok | {:error, :rate_limited} | {:error, :severed}

  @type t :: %__MODULE__{
          capacity: pos_integer(),
          refill_per_sec: number(),
          sever_after: pos_integer(),
          sever_window_ms: pos_integer()
        }

  @enforce_keys [:capacity, :refill_per_sec, :sever_after, :sever_window_ms]
  defstruct @enforce_keys

  @key {__MODULE__, :config}

  @doc """
  Reads `:grappa, :request_budget` from `Application.get_env/3`,
  validates, and stores the struct in `:persistent_term`. Called once
  from `Grappa.Application.start/2` (mirrors `Admission.Config.boot/0`).
  """
  @spec boot() :: :ok
  def boot do
    cfg = build!(Application.get_env(:grappa, :request_budget, []))
    :persistent_term.put(@key, cfg)
    :ok
  end

  @doc """
  Returns the current budget config. Lock-free `:persistent_term` read;
  callers must have run `boot/0` first (ensured by supervision order).
  """
  @spec config() :: t()
  def config, do: :persistent_term.get(@key)

  @doc """
  Ms until one more token refills — the client-facing retry hint for a
  429 / `rate_limited` frame (`round(1000 / refill_per_sec)`).
  """
  @spec retry_after_ms() :: pos_integer()
  def retry_after_ms, do: max(1, round(1000 / config().refill_per_sec))

  @doc """
  The ladder — the shared decision function both inbound doors call.

  `:ok` when a token was available (consumed); `{:error, :rate_limited}`
  when over budget (nothing consumed); `{:error, :severed}` on the EXACT
  over-budget event that crosses `sever_after` within the window — the
  signal for the caller to sever the web session ONCE.
  """
  @spec check(subject()) :: decision()
  def check({kind, _} = subject) when kind in [:user, :visitor] do
    cfg = config()

    case TokenBucket.take(@budget_bucket, subject, cfg.capacity, cfg.refill_per_sec) do
      :ok ->
        :ok

      {:error, :rate_limited} ->
        # Every over-budget event advances the rolling escalation window.
        # The count IS the window (derived, not a parallel state machine);
        # the EXACT crossing severs once, later events just stay refused.
        count = FailureWindow.record_failure(@flood_bucket, subject, cfg.sever_window_ms)

        if count == cfg.sever_after do
          {:error, :severed}
        else
          {:error, :rate_limited}
        end
    end
  end

  if Mix.env() == :test do
    @doc false
    @spec put_test_config(t()) :: :ok
    def put_test_config(%__MODULE__{} = cfg), do: :persistent_term.put(@key, cfg)
  end

  @spec build!(keyword()) :: t()
  defp build!(raw) do
    cfg = %__MODULE__{
      capacity: Keyword.fetch!(raw, :capacity),
      refill_per_sec: Keyword.fetch!(raw, :refill_per_sec),
      sever_after: Keyword.fetch!(raw, :sever_after),
      sever_window_ms: Keyword.fetch!(raw, :sever_window_ms)
    }

    validate!(cfg)
    cfg
  end

  @spec validate!(t()) :: :ok
  defp validate!(%__MODULE__{
         capacity: cap,
         refill_per_sec: refill,
         sever_after: sever_after,
         sever_window_ms: window
       })
       when is_integer(cap) and cap > 0 and
              is_number(refill) and refill > 0 and
              is_integer(sever_after) and sever_after > 0 and
              is_integer(window) and window > 0,
       do: :ok

  defp validate!(cfg) do
    raise ArgumentError,
          "invalid :request_budget config — capacity/sever_after/sever_window_ms must be " <>
            "positive integers and refill_per_sec a positive number, got: #{inspect(cfg)}"
  end
end
