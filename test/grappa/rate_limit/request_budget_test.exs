defmodule Grappa.RateLimit.RequestBudgetTest do
  # async: false — exercises the shared TokenBucket + FailureWindow ETS
  # singletons + the :persistent_term config. Per-test subjects are unique
  # (make_ref-derived) so no two tests collide on a bucket/window key, but
  # the singletons are process-global, so keep this serial (max_cases: 1
  # already enforces it repo-wide).
  use ExUnit.Case, async: false

  alias Grappa.RateLimit.RequestBudget

  # A fresh, never-before-seen subject per test — a full bucket + empty
  # window, so the ladder starts from a clean slate every time.
  defp fresh_subject do
    {:user, "req-budget-#{System.unique_integer([:positive])}"}
  end

  # Inject tiny deterministic thresholds for THIS test only (the global
  # test config leaves the budget effectively off so unrelated tests aren't
  # metered) and restore the original in on_exit so nothing leaks. capacity
  # 5, sever_after 3, refill 0.5/s (no token refills between the sequential
  # calls of one test), window 60_000ms.
  setup do
    original = RequestBudget.config()

    cfg = %RequestBudget{
      capacity: 5,
      refill_per_sec: 0.5,
      sever_after: 3,
      sever_window_ms: 60_000
    }

    RequestBudget.put_test_config(cfg)
    on_exit(fn -> RequestBudget.put_test_config(original) end)
    {:ok, cfg: cfg}
  end

  describe "check/1 — throttle rung" do
    test "admits a full burst up to capacity, then 429s", %{cfg: cfg} do
      subject = fresh_subject()

      for _ <- 1..cfg.capacity do
        assert RequestBudget.check(subject) == :ok
      end

      assert RequestBudget.check(subject) == {:error, :rate_limited}
    end

    test "keys per subject — one subject's flood never touches another" do
      flooder = fresh_subject()
      bystander = fresh_subject()

      # Drain the flooder past capacity into rate-limited territory.
      for _ <- 1..10, do: RequestBudget.check(flooder)

      # A fresh bystander still gets its full burst.
      assert RequestBudget.check(bystander) == :ok
    end
  end

  describe "check/1 — sever rung" do
    test "severs on the EXACT over-budget event that crosses sever_after", %{cfg: cfg} do
      subject = fresh_subject()

      # Burn the burst.
      for _ <- 1..cfg.capacity, do: assert(RequestBudget.check(subject) == :ok)

      # Over-budget events 1..(sever_after-1) → rate_limited.
      for _ <- 1..(cfg.sever_after - 1) do
        assert RequestBudget.check(subject) == {:error, :rate_limited}
      end

      # The sever_after-th over-budget event → severed (fire ONCE).
      assert RequestBudget.check(subject) == {:error, :severed}
    end

    test "does not double-sever — over-budget events past the crossing are rate_limited", %{
      cfg: cfg
    } do
      subject = fresh_subject()
      for _ <- 1..cfg.capacity, do: RequestBudget.check(subject)
      for _ <- 1..(cfg.sever_after - 1), do: RequestBudget.check(subject)
      assert RequestBudget.check(subject) == {:error, :severed}

      # Any straggler after the crossing is refused, NOT re-severed.
      assert RequestBudget.check(subject) == {:error, :rate_limited}
      assert RequestBudget.check(subject) == {:error, :rate_limited}
    end
  end

  describe "retry_after_ms/0" do
    test "derives the hint from the refill rate" do
      # refill 0.5/s → one token every 2000ms.
      assert RequestBudget.retry_after_ms() == 2000
    end
  end

  describe "config/0" do
    test "returns the validated struct from the boot seam" do
      assert %RequestBudget{} = RequestBudget.config()
    end
  end
end
