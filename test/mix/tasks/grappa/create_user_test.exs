defmodule Mix.Tasks.Grappa.CreateUserTest do
  @moduledoc """
  Smoke-tests the `mix grappa.create_user` CLI entry point.

  The error-path (invalid changeset → `System.halt/1`) cannot be
  exercised in-process — `System.halt/1` kills the BEAM unconditionally.
  That branch is covered indirectly: the Accounts.create_user/1
  invariants live in `Grappa.AccountsTest`, and the operator
  bind-network smoke pass (sub-task 2k) re-checks the CLI end-to-end.
  """
  use Grappa.DataCase, async: true

  import ExUnit.CaptureIO

  alias Grappa.Accounts
  alias Mix.Tasks.Grappa.CreateUser

  test "creates a user and prints its name + id" do
    output =
      capture_io(fn ->
        CreateUser.run([
          "--name",
          "vjt",
          "--password",
          "correct horse battery staple"
        ])
      end)

    assert output =~ "created user vjt"
    assert {:ok, _} = Accounts.get_user_by_credentials("vjt", "correct horse battery staple")
  end

  test "creates an admin user when --admin is passed" do
    output =
      capture_io(fn ->
        CreateUser.run([
          "--name",
          "boss",
          "--password",
          "correct horse battery staple",
          "--admin"
        ])
      end)

    assert output =~ "created user boss"
    assert output =~ "admin"
    assert Accounts.get_user_by_name!("boss").is_admin == true
  end

  test "creates a non-admin user by default" do
    capture_io(fn ->
      CreateUser.run(["--name", "pleb", "--password", "correct horse battery staple"])
    end)

    assert Accounts.get_user_by_name!("pleb").is_admin == false
  end

  # #1086 — both of these asserted `KeyError`, pinning the defect the
  # issue reports rather than the behaviour an operator needs. A test
  # that encodes the bug is why the bug survived.
  test "a missing --name names it, without a traceback" do
    error =
      assert_raise Mix.Error, fn ->
        CreateUser.run(["--password", "correct horse battery staple"])
      end

    assert error.message =~ "--name"
  end

  test "a missing --password names it, without a traceback" do
    error =
      assert_raise Mix.Error, fn ->
        CreateUser.run(["--name", "vjt"])
      end

    assert error.message =~ "--password"
  end
end
