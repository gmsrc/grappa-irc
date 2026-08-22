defmodule Grappa.Networks.SessionPlanTlsVerifyTest do
  @moduledoc """
  #1677 — `Grappa.Networks.SessionPlan.base_plan/6` carries the per-server
  certificate-verification posture from the DB row into the plan that
  `Grappa.Session.Server` hands to `Grappa.IRC.Client`.

  This is the middle link of the chain, and the one with nothing else
  watching it: the schema test proves the column round-trips, the client
  test proves the two ssl-opt shapes, and only this proves the value
  actually TRAVELS from the row that was configured to the socket that is
  opened. A plan that dropped it would leave every other test green while
  every session silently verified.

  It is threaded off the SAME `%Server{}` as `tls`, which is the point: a
  fail-over pick must not be able to take its transport from one leaf and
  its verification posture from another.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Server, SessionPlan}

  defp cred, do: %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}

  defp plan_for(server) do
    user = user_fixture()
    network = network_fixture()
    SessionPlan.base_plan({:user, user.id}, "label", cred(), network, server, "n")
  end

  test "the opt-out travels from the server row into the plan" do
    plan =
      plan_for(%Server{host: "efnet.deic.eu", port: 6697, tls: true, tls_verify: false})

    assert plan.tls == true
    assert plan.tls_verify == false
  end

  test "a strict row produces a strict plan" do
    plan =
      plan_for(%Server{host: "irc.azzurra.chat", port: 6697, tls: true, tls_verify: true})

    assert plan.tls_verify == true
  end

  # The half that breaks in silence. A `%Server{}` built without naming the
  # field carries the SCHEMA default, and #89 must survive that path —
  # which is every row that existed before this slice.
  test "a row that never named the flag plans as verifying" do
    plan = plan_for(%Server{host: "irc.azzurra.chat", port: 6697, tls: true})

    assert plan.tls_verify == true
  end
end
