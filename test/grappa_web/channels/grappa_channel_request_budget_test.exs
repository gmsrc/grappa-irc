defmodule GrappaWeb.GrappaChannelRequestBudgetTest do
  @moduledoc """
  GH #630 — the WS door of the coarse inbound request budget. Every
  `GrappaChannel.handle_in` frame passes through the single `handle_in/3`
  guard, so a metered verb (`visibility`) exercises the whole ladder:
  within budget it replies normally, over budget it earns a `rate_limited`
  error reply + retry hint, and the sever crossing closes the socket +
  revokes the bearer + broadcasts the `web_session_severed` user-topic
  event that drives cic's flood banner. Deterministic against
  config/test.exs (capacity 5, sever_after 3, refill 0.5/s → no mid-burst
  refill).
  """
  use GrappaWeb.ChannelCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Accounts
  alias Grappa.PubSub.Topic
  alias Grappa.RateLimit.RequestBudget
  alias GrappaWeb.{GrappaChannel, UserSocket}

  # Inject tiny deterministic thresholds for THIS test only (global test
  # config leaves the budget effectively off) and restore on exit so the
  # metering doesn't leak into unrelated channel tests. capacity 5,
  # sever_after 3, refill 0.5/s.
  setup do
    original = RequestBudget.config()

    RequestBudget.put_test_config(%RequestBudget{
      capacity: 5,
      refill_per_sec: 0.5,
      sever_after: 3,
      sever_window_ms: 60_000
    })

    on_exit(fn -> RequestBudget.put_test_config(original) end)
    :ok
  end

  # A joined user-topic socket with the full production assigns surface
  # (user_name + bare-id subject + real session id) so the guard can read
  # the bearer to revoke and the label to disconnect on sever.
  defp join_user_socket do
    user = user_fixture()
    {:ok, session} = Accounts.create_session({:user, user.id}, nil, nil, [])
    user_name = user.name

    {:ok, _, socket} =
      UserSocket
      |> socket("user_socket:#{user_name}", %{
        user_name: user_name,
        current_subject: {:user, user.id},
        current_session_id: session.id
      })
      |> subscribe_and_join(GrappaChannel, Topic.user(user_name))

    %{socket: socket, user_name: user_name, session: session}
  end

  defp push_visibility(socket), do: push(socket, "visibility", %{"visible" => true})

  describe "throttle rung" do
    test "admits a full burst, then replies rate_limited with a retry hint" do
      %{socket: socket} = join_user_socket()

      # capacity 5 → first 5 metered frames pass to the real handler.
      for _ <- 1..5 do
        ref = push_visibility(socket)
        assert_reply ref, :ok, %{}
      end

      # 6th is over budget → the WS twin of a 429.
      ref = push_visibility(socket)
      assert_reply ref, :error, %{error: "rate_limited", retry_after_ms: hint}
      assert is_integer(hint) and hint > 0
    end
  end

  describe "sever rung" do
    test "sustained flooding severs: user event + bearer revoked + socket disconnect" do
      %{socket: socket, user_name: user_name, session: session} = join_user_socket()

      # Watch the socket's id-topic so we can assert the disconnect fired.
      GrappaWeb.Endpoint.subscribe("user_socket:#{user_name}")

      # Burn capacity (5) + the first (sever_after-1 = 2) over-budget events:
      # 7 frames, no sever yet.
      for _ <- 1..7, do: push_visibility(socket)
      assert {:ok, _} = Accounts.authenticate(session.id)

      # 8th frame = 3rd over-budget = the sever crossing.
      ref = push_visibility(socket)
      assert_reply ref, :error, %{error: "rate_limited"}

      # 1. The subject is told (drives cic's flood banner) on its user topic.
      assert_push "event", %{kind: :web_session_severed, code: :rate_limit_flood}

      # 2. The bearer is revoked — a reconnect with the old creds is refused.
      assert {:error, :revoked} = Accounts.authenticate(session.id)

      # 3. The live socket(s) are closed via the id-topic disconnect.
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    test "a second well-behaved subject keeps working while another is severed" do
      %{socket: flooder} = join_user_socket()
      %{socket: bystander, session: bystander_session} = join_user_socket()

      # Flood subject A past the sever crossing (8 frames).
      for _ <- 1..8, do: push_visibility(flooder)

      # Subject B — a different subject — is untouched: full burst still served.
      for _ <- 1..5 do
        ref = push_visibility(bystander)
        assert_reply ref, :ok, %{}
      end

      assert {:ok, _} = Accounts.authenticate(bystander_session.id)
    end
  end
end
