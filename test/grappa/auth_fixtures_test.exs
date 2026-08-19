defmodule Grappa.AuthFixturesTest do
  @moduledoc """
  #1397 — the positive control for the precomputed Argon2 hash that
  `Grappa.AuthFixtures.user_fixture/1` stamps on every user it inserts.

  The hash is a constant, so nothing in the suite recomputes it and
  nothing in the suite would notice if it stopped being a hash of
  `fixture_password/0`: a corrupted constant makes every fixture user
  silently unverifiable, and the ~130 files that only need a row to hang
  a session on would keep passing. This test is the one place that reads
  the constant as a claim and checks it, through the production door
  rather than a raw `Argon2.verify_pass/2`.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts

  test "the fixture password verifies against the precomputed hash" do
    user = user_fixture()

    assert {:ok, verified} = Accounts.get_user_by_credentials(user.name, fixture_password())
    assert verified.id == user.id
  end
end
