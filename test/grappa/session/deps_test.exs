defmodule Grappa.Session.DepsTest do
  @moduledoc """
  #1398 — the injected-closure half of bucket I, the half no compile-time
  checker can see.

  A closure carries no module reference, so `Boundary` cannot follow the
  edge: an omitted injection is not a compile error, not a crash and not a
  log line. It is a persist that silently does not happen. The two
  producers are `Grappa.Networks.SessionPlan` (registered users) and
  `Grappa.Visitors.SessionPlan` (visitors), and they inject DISJOINT sets —
  so `nil` is not a legitimate default, it is a function of the SUBJECT
  TAG. An absent `away_persister` on a user session is a bug; the same
  absence on a visitor session is correct by construction. Before
  `from_opts/2` the two were indistinguishable.

  What this file pins:

  * the per-tag due set AND its arities, against the LIVE output of both
    producers — a closure added to a plan without a table entry, or a
    table entry no plan injects, or an arity change on either side, is red;
  * that a missing due key raises and NAMES the key (and does not name the
    keys that were supplied);
  * that an alien key — a visitor closure on a user session — raises;
  * that an explicit `nil`, the exact shape the old `Map.get/2` door
    accepted in silence, counts as MISSING and not as supplied.

  Out of scope, measured and deliberate:

  * `query_window_open?` is the tenth struct field and is due on NEITHER
    tag. Neither `SessionPlan` injects it, it carries a real production
    default (`&Grappa.QueryWindows.open?/3`), and the injection point
    exists so a test can keep `EventRouter` a sandbox-free classifier. So
    it is accepted on both tags and required on neither.
  * `refresh_plan` is NOT a `Deps` field, though both plans inject it and
    it belongs to the same silent class. `Server.init/1` reads it from the
    raw opts BEFORE `do_init/1` builds this struct, because its return
    value REPLACES the opts the struct would be built from. It is outside
    this struct's authority and stays unguarded — the documented
    limitation of this guard, not an oversight.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.QueryWindows
  alias Grappa.Session.{Deps, DepsInjectionError}
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan

  describe "the due set, measured against the live producers" do
    test "the user plan injects exactly the user-due set, at the declared arities" do
      {user, network, _} = user_with_credential(6667, %{})
      {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))

      assert injected_arities(plan) == Deps.required_injections({:user, user.id})
    end

    test "the visitor plan injects exactly the visitor-due set, at the declared arities" do
      {visitor, network} = visitor_with_network(6667)
      {:ok, plan} = VisitorSessionPlan.resolve(visitor, network)

      assert injected_arities(plan) == Deps.required_injections({:visitor, visitor.id})
    end

    test "the two due sets are disjoint on all but the three shared closures" do
      user_keys = {:user, "u"} |> Deps.required_injections() |> Map.keys() |> MapSet.new()
      visitor_keys = {:visitor, "v"} |> Deps.required_injections() |> Map.keys() |> MapSet.new()

      # #1675 added the third: `link_state_reporter` is shared because the
      # `connection_state` write set it feeds has no subject branch. The
      # terminal `credential_failer` is shared as a KEY while the two
      # producers inject genuinely different closures behind it (visitor
      # terminal failure expires the identity row, not the credential
      # state) — this assertion is about the due SET, not the behaviour.
      assert MapSet.intersection(user_keys, visitor_keys) ==
               MapSet.new([:credential_failer, :last_joined_persister, :link_state_reporter])
    end

    test "injectable_keys/0 is exactly the union of the two due sets" do
      union =
        [{:user, "u"}, {:visitor, "v"}]
        |> Enum.flat_map(&Map.keys(Deps.required_injections(&1)))
        |> Enum.uniq()
        |> Enum.sort()

      assert Deps.injectable_keys() == union
    end
  end

  describe "from_opts/2 on a complete plan" do
    test "a resolved user plan builds a struct with the user five set and the visitor four nil" do
      {user, network, _} = user_with_credential(6667, %{})
      subject = {:user, user.id}
      {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))

      deps = Deps.from_opts(subject, plan)

      assert is_function(deps.away_persister, 2)
      assert is_function(deps.credential_committer, 1)
      assert is_function(deps.credential_failer, 1)
      assert is_function(deps.last_joined_persister, 2)
      assert is_function(deps.registration_committer, 1)

      assert deps.recover_source == nil
      assert deps.visitor_committer == nil
      assert deps.visitor_nick_persister == nil
      assert deps.visitor_password_rotator == nil
    end

    test "a resolved visitor plan builds a struct with the visitor six set and the user three nil" do
      {visitor, network} = visitor_with_network(6667)
      subject = {:visitor, visitor.id}
      {:ok, plan} = VisitorSessionPlan.resolve(visitor, network)

      deps = Deps.from_opts(subject, plan)

      assert is_function(deps.credential_failer, 1)
      assert is_function(deps.last_joined_persister, 2)
      assert is_function(deps.recover_source, 0)
      assert is_function(deps.visitor_committer, 3)
      assert is_function(deps.visitor_nick_persister, 2)
      assert is_function(deps.visitor_password_rotator, 2)

      assert deps.away_persister == nil
      assert deps.credential_committer == nil
      assert deps.registration_committer == nil
    end

    test "query_window_open? falls back to the production default and an override wins" do
      subject = {:user, "u"}
      opts = complete_opts(subject)
      fake = fn _, _, _ -> true end

      assert Deps.from_opts(subject, opts).query_window_open? == (&QueryWindows.open?/3)

      assert Deps.from_opts(subject, Map.put(opts, :query_window_open?, fake)).query_window_open? ==
               fake
    end

    test "query_window_open? is accepted on the visitor tag too, and is due on neither" do
      subject = {:visitor, "v"}
      fake = fn _, _, _ -> true end

      refute Map.has_key?(Deps.required_injections(subject), :query_window_open?)

      assert %Deps{} =
               Deps.from_opts(subject, Map.put(complete_opts(subject), :query_window_open?, fake))
    end
  end

  describe "from_opts/2 refuses a set that does not match the tag" do
    test "a user plan missing away_persister raises and names ONLY the missing key" do
      subject = {:user, "u"}
      opts = Map.delete(complete_opts(subject), :away_persister)

      message = raise_message(subject, opts)

      assert message =~ "away_persister"
      refute message =~ "credential_failer"
      refute message =~ "last_joined_persister"
    end

    test "a plan missing several due keys names all of them" do
      subject = {:visitor, "v"}
      opts = Map.drop(complete_opts(subject), [:recover_source, :visitor_nick_persister])

      message = raise_message(subject, opts)

      assert message =~ "recover_source"
      assert message =~ "visitor_nick_persister"
      refute message =~ "visitor_committer"
    end

    test "an explicit nil is MISSING, not supplied — the silent shape the old door accepted" do
      subject = {:user, "u"}
      opts = Map.put(complete_opts(subject), :credential_failer, nil)

      assert raise_message(subject, opts) =~ "credential_failer"
    end

    test "a visitor closure on a user session raises as ALIEN, not as missing" do
      subject = {:user, "u"}
      opts = Map.put(complete_opts(subject), :visitor_committer, fn _, _, _ -> :ok end)

      message = raise_message(subject, opts)

      assert message =~ "visitor_committer"
      assert message =~ "not due"
      refute message =~ "away_persister"
    end

    test "a user closure on a visitor session raises as ALIEN too" do
      subject = {:visitor, "v"}
      opts = Map.put(complete_opts(subject), :away_persister, fn _, _ -> :ok end)

      message = raise_message(subject, opts)

      assert message =~ "away_persister"
      assert message =~ "not due"
    end

    test "a due key supplied at the wrong arity raises and reports both arities" do
      subject = {:user, "u"}
      opts = Map.put(complete_opts(subject), :last_joined_persister, fn _ -> :ok end)

      message = raise_message(subject, opts)

      assert message =~ "last_joined_persister"
      assert message =~ "expected 2"
      assert message =~ "got 1"
    end

    test "the subject tag is named, so the message says which set was expected" do
      subject = {:visitor, "v"}
      opts = Map.delete(complete_opts(subject), :recover_source)

      assert raise_message(subject, opts) =~ ":visitor"
    end
  end

  # The arity-correct injection set for `subject`, built FROM the SSOT so a
  # new due key cannot be silently forgotten here — the helper grows with
  # the table, and the drift tests above keep the table honest against the
  # two real producers.
  defp complete_opts(subject) do
    subject
    |> Deps.required_injections()
    |> Map.new(fn {key, arity} -> {key, inert(arity)} end)
  end

  defp inert(0), do: fn -> {:error, :nothing_to_recover} end
  defp inert(1), do: fn _ -> :ok end
  defp inert(2), do: fn _, _ -> :ok end
  defp inert(3), do: fn _, _, _ -> {:error, :not_found} end

  # Every injectable key the plan actually carries, mapped to the arity it
  # carries it at. Scoped to `injectable_keys/0` rather than to the tag's
  # own due set on purpose: an EXTRA closure (a visitor callback leaking
  # into the user plan) must show up as a surplus key, not be filtered out.
  defp injected_arities(plan) do
    plan
    |> Map.take(Deps.injectable_keys())
    |> Map.new(fn {key, fun} -> {key, elem(Function.info(fun, :arity), 1)} end)
  end

  defp raise_message(subject, opts) do
    Exception.message(assert_raise(DepsInjectionError, fn -> Deps.from_opts(subject, opts) end))
  end
end
