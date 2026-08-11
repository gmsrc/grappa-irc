defmodule Grappa.Release.CLITest do
  @moduledoc """
  #1158 — the account door of a PACKAGED release.

  An operator on the published image has no Mix, no checkout and, on a
  first run, no account to log in with. The `grappa.*` mix tasks that
  seed a source install do not exist there, so until this door landed the
  only way in was an IEx remote shell and module names typed out of the
  source tree.

  vjt's acceptance criterion is quoted literally: *on the published
  image, create a first admin and log in*. So the headline test does not
  assert that a row appeared — it drives the very expression the shipped
  `bin/grappa` dispatcher evaluates, with the argv that dispatcher passes,
  and then LOGS IN over the real HTTP surface with the credentials the
  operator just typed. Nothing but a working account can make it pass.

  Reading the expression out of the shell script is deliberate: the two
  halves of this door live in different languages and nothing links them
  at compile time. `Grappa.ReleaseTest` pins that the FUNCTION named there
  is exported; this pins that CALLING it, exactly as written, provisions
  an account. A quoting or arity change in the script fails here.
  """
  use GrappaWeb.ConnCase, async: false

  import ExUnit.CaptureIO

  alias Grappa.Accounts
  alias Grappa.Networks
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.Release.CLI

  @dispatcher "infra/release/grappa.sh"
  @external_resource @dispatcher

  # The `eval '<expr>'` the dispatcher hands the release boot script. Read,
  # never restated: a restated copy would keep passing after the shipped
  # one broke.
  @eval_expression (case Regex.run(~r/eval\s+'([^']+)'/, File.read!(@dispatcher)) do
                      [_, expression] -> expression
                      nil -> nil
                    end)

  @password "correct horse battery staple"

  setup do
    # System.argv/1 is global; restore it so a failure here cannot leak
    # into another test file's view of the world.
    argv = System.argv()
    on_exit(fn -> System.argv(argv) end)
    :ok
  end

  defp unique_name, do: "vjt-#{System.unique_integer([:positive])}"

  # Runs the door the way the shipped dispatcher runs it: argv in the
  # process's own argv, the expression evaluated verbatim.
  defp eval_door(argv) do
    System.argv(argv)
    capture_io(fn -> Code.eval_string(@eval_expression) end)
  end

  describe "the shipped dispatcher's eval expression" do
    test "is a call this test could actually read" do
      # Guards the guard: a dispatcher rewritten to build the expression
      # some other way would otherwise leave every test below evaluating
      # `nil` — or worse, silently skipping the door.
      assert @eval_expression =~ "Grappa.Release.",
             "no `eval '<expr>'` found in #{@dispatcher} — this suite is measuring nothing"

      assert @eval_expression =~ "System.argv()",
             "the dispatcher must pass argv through, or the verbs carry no arguments"
    end

    test "creates a first admin who can then LOG IN over HTTP", %{conn: conn} do
      name = unique_name()

      output = eval_door(["create-user", name, "--admin", "--password", @password])
      assert output =~ name

      user = Accounts.get_user_by_name(name)
      assert user.is_admin

      # vjt's criterion, end to end: the account the operator just created
      # is the account the login door accepts.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/auth/login", %{"identifier" => name, "password" => @password})

      body = json_response(conn, 200)
      assert body["subject"]["kind"] == "user"
      assert body["subject"]["id"] == user.id
      assert is_binary(body["token"])
    end
  end

  describe "create-user" do
    test "without --admin the account is an ordinary user" do
      name = unique_name()
      assert {:ok, message} = CLI.run(["create-user", name, "--password", @password])
      assert message =~ name

      refute Accounts.get_user_by_name(name).is_admin
    end

    test "reads the password from stdin when --password is absent" do
      name = unique_name()

      output =
        capture_io([input: @password <> "\n"], fn ->
          assert {:ok, _} = CLI.run(["create-user", name])
        end)

      # The prompt names the account, so an operator who ran two of these
      # knows which one is asking.
      assert output =~ name

      assert %Accounts.User{} = user = Accounts.get_user_by_name(name)
      assert {:ok, ^user} = Accounts.get_user_by_credentials(user.name, @password)
    end

    test "refuses a duplicate name with the field that clashed" do
      name = unique_name()
      assert {:ok, _} = CLI.run(["create-user", name, "--password", @password])

      assert {:error, message} = CLI.run(["create-user", name, "--password", @password])
      assert message =~ "name"
      refute message =~ "Ecto.Changeset<"
    end

    test "refuses an empty argument list instead of creating something" do
      assert {:error, message} = CLI.run(["create-user"])
      assert message =~ "create-user"
    end

    test "does not mistake a flag for the account name" do
      # `grappa create-user --admin vjt` is the natural typo; taking
      # "--admin" as the name would create an account nobody asked for.
      assert {:error, message} = CLI.run(["create-user", "--admin", "vjt"])
      assert message =~ "create-user"
      assert is_nil(Accounts.get_user_by_name("--admin"))
    end

    test "rejects an unknown switch by name" do
      assert {:error, message} = CLI.run(["create-user", "vjt", "--adminn"])
      assert message =~ "--adminn"
    end
  end

  describe "add-network / remove-network" do
    setup do
      name = unique_name()
      {:ok, _} = CLI.run(["create-user", name, "--password", @password])
      %{name: name, user: Accounts.get_user_by_name(name)}
    end

    test "provisions access that can actually be dialled", %{name: name, user: user} do
      assert {:ok, message} =
               CLI.run([
                 "add-network",
                 name,
                 "azzurra",
                 "--server",
                 "irc.azzurra.chat:6697",
                 "--nick",
                 "vjt-grappa",
                 "--auth",
                 "sasl",
                 "--password",
                 "loadbearing",
                 "--autojoin",
                 "#grappa,#italy"
               ])

      assert message =~ "azzurra"

      network = Networks.get_network_by_slug!("azzurra")
      cred = Credentials.get_credential!(user, network)

      # The parity claim of the slice: create-user + add-network is the
      # whole seed path, so the plan must resolve with nothing else run.
      assert {:ok, plan} = SessionPlan.resolve(cred)
      assert plan.host == "irc.azzurra.chat"
      assert plan.port == 6697
      assert plan.auth_method == :sasl
      # The secret survived the door, the encrypted column and the read
      # back — the one field that would silently arrive empty if the CLI
      # dropped it.
      assert plan.password == "loadbearing"
      assert plan.autojoin_channels == ["#grappa", "#italy"]
      # 6697 is the de-facto TLS port: the door must infer that, as the
      # mix task does, or the first connection goes out in the clear.
      assert plan.tls
    end

    test "names the user when there is no such account" do
      assert {:error, message} =
               CLI.run([
                 "add-network",
                 "nobody-here",
                 "azzurra",
                 "--server",
                 "irc.azzurra.chat:6697",
                 "--nick",
                 "x",
                 "--auth",
                 "none"
               ])

      assert message =~ "nobody-here"
    end

    test "reports a missing required flag rather than half-provisioning", %{name: name} do
      assert {:error, message} = CLI.run(["add-network", name, "azzurra", "--nick", "vjt"])
      assert message =~ "--server"
      assert Networks.get_network_by_slug("azzurra") == {:error, :not_found}
    end

    test "speaks the same --auth grammar as the source-flavor task", %{name: name} do
      assert {:error, message} =
               CLI.run([
                 "add-network",
                 name,
                 "azzurra",
                 "--server",
                 "irc.azzurra.chat:6697",
                 "--nick",
                 "vjt",
                 "--auth",
                 "telepathy"
               ])

      assert message =~ "--auth must be one of"
      assert message =~ "nickserv_identify"
    end

    test "rejects a malformed --server the same way", %{name: name} do
      assert {:error, message} =
               CLI.run([
                 "add-network",
                 name,
                 "azzurra",
                 "--server",
                 "irc.azzurra.chat",
                 "--nick",
                 "vjt",
                 "--auth",
                 "none"
               ])

      assert message =~ "--server must be host:port"
    end

    test "remove-network revokes the access it granted", %{name: name, user: user} do
      assert {:ok, _} =
               CLI.run([
                 "add-network",
                 name,
                 "azzurra",
                 "--server",
                 "irc.azzurra.chat:6697",
                 "--nick",
                 "vjt-grappa",
                 "--auth",
                 "none"
               ])

      assert {:ok, message} = CLI.run(["remove-network", name, "azzurra"])
      assert message =~ "azzurra"
      assert Credentials.list_credentials_for_user(user) == []
    end

    test "remove-network on an unknown network says so, and stays quiet otherwise",
         %{name: name} do
      assert {:error, message} = CLI.run(["remove-network", name, "no-such-net"])
      assert message =~ "no-such-net"
    end
  end

  describe "usage" do
    test "an unknown verb lists the verbs that exist" do
      assert {:error, message} = CLI.run(["frobnicate"])

      for verb <- ~w(create-user add-network remove-network) do
        assert message =~ verb
      end
    end

    test "help asks for nothing and fails at nothing" do
      assert {:ok, message} = CLI.run(["help"])
      assert message =~ "create-user"
    end
  end
end
