defmodule Grappa.SubjectTest do
  @moduledoc """
  Tests for the subject-label codec (#413).

  `label/1` + `from_label/1` are the single source of truth for the
  user-rooted topic-label encoding — `user.name` for users,
  `"visitor:" <> id` for visitors — previously restated at ~6 call
  sites plus one inverse parser. The failure mode this pins is a
  silent dead-drop on drift: a subject that no longer round-trips
  does not raise, it just stops matching, far from the cause. The
  property test is exactly the shape an encode/decode pair calls for.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Subject

  describe "label/1" do
    test "user → bare name" do
      assert Subject.label({:user, "alice"}) == "alice"
    end

    test "visitor → \"visitor:\" <> id" do
      assert Subject.label({:visitor, "9a3f-uuid"}) == "visitor:9a3f-uuid"
    end
  end

  describe "from_label/1" do
    test "\"visitor:\" <> id → {:visitor, id}" do
      assert Subject.from_label("visitor:9a3f-uuid") == {:visitor, "9a3f-uuid"}
    end

    test "bare name → {:user, name}" do
      assert Subject.from_label("alice") == {:user, "alice"}
    end
  end

  describe "round-trip (property)" do
    property "user names survive label |> from_label" do
      check all(name <- user_name()) do
        assert Subject.from_label(Subject.label({:user, name})) == {:user, name}
      end
    end

    property "visitor ids survive label |> from_label" do
      check all(id <- visitor_id()) do
        assert Subject.from_label(Subject.label({:visitor, id})) == {:visitor, id}
      end
    end
  end

  # Grappa user names match `^[a-zA-Z][a-zA-Z0-9_\-]*$`
  # (`Grappa.Accounts.User` @name_format) — a leading letter then
  # alphanumeric/_/-, never a colon. That charset is what makes the
  # bare-name encoding unambiguous: a valid name can never collide
  # with the `"visitor:"` prefix, so the round-trip holds by domain.
  defp user_name do
    gen all(
          first <- string([?a..?z, ?A..?Z], length: 1),
          rest <- string([?a..?z, ?A..?Z, ?0..?9, ?_, ?-], max_length: 30)
        ) do
      first <> rest
    end
  end

  # Visitor ids are `Ecto.UUID` strings in production; the prefix
  # strip is exact, so ANY binary round-trips — UUIDs are the honest
  # domain.
  defp visitor_id, do: StreamData.repeatedly(&Ecto.UUID.generate/0)
end
