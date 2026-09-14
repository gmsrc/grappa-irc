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
    accepted in silence, counts as MISSING and not as supplied;
  * the SECOND door, `refresh!/2` (issue 2137) — that the eleventh
    closure is refused when absent, when it is not 0-arity, and when its
    ANSWER is out of contract, which is a check no other member can get
    because no other member may be invoked at the door;
  * that `rationale/1` covers every governed member and says what each
    one's SILENCE costs — the table is held total at compile time, so
    this only has to pin that the entries are worth having.

  Out of scope, measured and deliberate:

  * `query_window_open?` is the ELEVENTH struct field and is due on NEITHER
    tag. Neither `SessionPlan` injects it, it carries a real production
    default (`&Grappa.QueryWindows.open?/3`), and the injection point
    exists so a test can keep `EventRouter` a sandbox-free classifier. So
    it is accepted on both tags and required on neither. It is also NOT one
    of the closures that hide an edge from `Boundary`: that default is a
    static reference, and `Grappa.Session` declares `Grappa.QueryWindows`
    in its `deps:` (issue 2137).
  🔴 `refresh_plan` USED to be listed here as out of scope, on the
  grounds that `Server.init/1` consumes it before `do_init/1` builds the
  struct. Issue 2137 kept the fact and dropped the conclusion: ordering
  decides WHERE the guard goes, not whether there is one. It is now due
  on both tags and guarded by `refresh!/2`, at the point of consumption —
  see the two describes for that door below. It is still NOT a struct
  field, and that is the deliberate part: nothing reads it after
  `init/1`.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials, SessionPlan}
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

    test "the two due sets are disjoint on all but the four shared closures" do
      user_keys = {:user, "u"} |> Deps.required_injections() |> Map.keys() |> MapSet.new()
      visitor_keys = {:visitor, "v"} |> Deps.required_injections() |> Map.keys() |> MapSet.new()

      # #1675 added the third: `link_state_reporter` is shared because the
      # `connection_state` write set it feeds has no subject branch. The
      # terminal `credential_failer` is shared as a KEY while the two
      # producers inject genuinely different closures behind it (visitor
      # terminal failure expires the identity row, not the credential
      # state) — this assertion is about the due SET, not the behaviour.
      # Issue 2137 added the fourth: `refresh_plan` is due on both tags
      # because both producers inject it, and the respawn staleness it
      # prevents has no subject branch either.
      assert MapSet.intersection(user_keys, visitor_keys) ==
               MapSet.new([
                 :credential_failer,
                 :last_joined_persister,
                 :link_state_reporter,
                 :refresh_plan
               ])
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
    test "a resolved user plan builds a struct with the user six set and the visitor four nil" do
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
  describe "refresh!/2 — the door for the closure the struct does not carry (issue 2137)" do
    test "returns the fresh plan when the closure answers with a plain map" do
      subject = {:user, "u"}
      opts = Map.put(complete_opts(subject), :refresh_plan, fn -> {:ok, %{nick: "fresh"}} end)

      assert Deps.refresh!(subject, opts) == {:ok, %{nick: "fresh"}}
    end

    test "passes {:error, :not_found} through — the subject-is-gone verdict" do
      subject = {:visitor, "v"}
      opts = Map.put(complete_opts(subject), :refresh_plan, fn -> {:error, :not_found} end)

      assert Deps.refresh!(subject, opts) == {:error, :not_found}
    end

    test "an OMITTED refresh_plan raises and names it, on BOTH tags" do
      for subject <- [{:user, "u"}, {:visitor, "v"}] do
        opts = Map.delete(complete_opts(subject), :refresh_plan)

        assert raise_message(subject, opts, &Deps.refresh!/2) =~ "missing: refresh_plan"
      end
    end

    test "an explicit nil counts as MISSING, not as supplied" do
      subject = {:user, "u"}
      opts = Map.put(complete_opts(subject), :refresh_plan, nil)

      assert raise_message(subject, opts, &Deps.refresh!/2) =~ "missing: refresh_plan"
    end

    test "a closure of the wrong arity is refused, naming both arities" do
      subject = {:user, "u"}
      opts = Map.put(complete_opts(subject), :refresh_plan, fn _ -> {:ok, %{}} end)

      assert raise_message(subject, opts, &Deps.refresh!/2) =~
               "wrong arity: refresh_plan (expected 0, got 1)"
    end

    # THE mutant. Right arity, wrong shape, and silent before this door
    # existed: `Map.merge/2` accepts a struct as its second argument, so
    # `{:ok, %Struct{}}` merged, injected `__struct__` into the opts and
    # refreshed nothing at all.
    test "a struct return is refused — the shape Map.merge/2 would have swallowed" do
      subject = {:user, "u"}
      opts = Map.put(complete_opts(subject), :refresh_plan, fn -> {:ok, %Credential{}} end)

      message = raise_message(subject, opts, &Deps.refresh!/2)

      assert message =~ "refresh_plan returned a shape its contract forbids"
      assert message =~ "Credential"
    end

    test "every other return shape is refused, nil and a bare atom included" do
      subject = {:user, "u"}

      for bad <- [nil, :ok, {:ok, [nick: "fresh"]}, {:error, :something_else}, "plan"] do
        opts = Map.put(complete_opts(subject), :refresh_plan, fn -> bad end)

        assert raise_message(subject, opts, &Deps.refresh!/2) =~
                 "refresh_plan returned a shape its contract forbids",
               "#{inspect(bad)} was accepted"
      end
    end

    # A raise that renders no fault at all would read as an empty
    # accusation, and `nil` is the shape that produces it if the field is
    # stored bare rather than wrapped.
    test "a nil return still names the fault instead of rendering an empty message" do
      subject = {:user, "u"}
      opts = Map.put(complete_opts(subject), :refresh_plan, fn -> nil end)

      assert raise_message(subject, opts, &Deps.refresh!/2) =~ "nil"
    end
  end

  describe "rationale/1 — one place, held total at compile time (issue 2137)" do
    test "every member this module governs carries a non-empty rationale" do
      for key <- [:query_window_open? | Deps.injectable_keys()] do
        rationale = Deps.rationale(key)

        assert is_binary(rationale) and byte_size(rationale) > 40,
               "#{key} has no usable rationale"
      end
    end

    test "each rationale names what the member's SILENCE costs, not just what it is" do
      # The table exists because a count grew without anyone able to state
      # the reason for the set. A rationale that describes the closure but
      # not its absence would restate the typedoc and buy nothing.
      for key <- Deps.injectable_keys() do
        assert Deps.rationale(key) =~ "Absent", "#{key}'s rationale does not say what is lost"
      end
    end

    test "a key outside the governed set has no rationale to give" do
      assert_raise FunctionClauseError, fn -> Deps.rationale(:porcodio_persister) end
    end

    test "the governed set is exactly the eleven injectable keys plus the one field" do
      assert length(Deps.injectable_keys()) == 11
      assert :refresh_plan in Deps.injectable_keys()
      refute :query_window_open? in Deps.injectable_keys()
    end
  end

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

  defp raise_message(subject, opts), do: raise_message(subject, opts, &Deps.from_opts/2)

  # Parameterised by the DOOR, because this module now has two and both
  # raise the same exception: `from_opts/2` over the set the struct keeps,
  # `refresh!/2` over the one member it does not.
  defp raise_message(subject, opts, door) do
    Exception.message(assert_raise(DepsInjectionError, fn -> door.(subject, opts) end))
  end
end
