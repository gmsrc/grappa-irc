defmodule Grappa.Session.SendTelemetryTest do
  @moduledoc """
  #357 Deliverable 1 — the send-path half of the split-span pair.

  `Grappa.Session.send_privmsg/4` wraps the `GenServer.call` round-trip in a
  `[:grappa, :session, :send_privmsg, :start | :stop]` span. Because the span
  runs in the CALLER's process (the controller / channel), the measured
  duration includes the time the call message sat in the `Session.Server`
  mailbox behind synchronous inbound inserts — i.e. it captures the mailbox
  head-of-line blocking (mechanism 1) that the "pure insert" scrollback span
  cannot see. The gap (send_privmsg duration − persist duration) is the
  queue-wait.

  These are the fast wiring assertions (no live session). The happy-path
  (`outcome: :ok` over a real send) is asserted in
  `GrappaWeb.MessagesControllerOutboundTest`, which already owns the live
  `IRCServer` + session fixture — no duplicate fixture here.
  """
  use Grappa.DataCase, async: false

  alias Grappa.IRC.Identifier
  alias Grappa.Session

  defp attach(events) do
    handler_id = {__MODULE__, System.unique_integer([:positive])}
    test_pid = self()

    :telemetry.attach_many(
      handler_id,
      events,
      fn event, measurements, metadata, _ ->
        send(test_pid, {:telemetry, event, measurements, metadata})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)
    :ok
  end

  test "send_privmsg with no live session still emits :stop tagged target/network_id, outcome: :no_session" do
    attach([[:grappa, :session, :send_privmsg, :stop]])
    subject = {:user, Ecto.UUID.generate()}

    assert {:error, :no_session} = Session.send_privmsg(subject, 4242, "#Sniffo", "ciao")

    assert_receive {:telemetry, [:grappa, :session, :send_privmsg, :stop], measurements, metadata}
    # Target is canonicalised before dispatch (UX-4) — the tag matches the wire.
    assert metadata.target == Identifier.canonical_channel("#Sniffo")
    assert metadata.network_id == 4242
    assert metadata.subject == :user
    assert metadata.outcome == :no_session
    assert is_integer(measurements.duration) and measurements.duration >= 0
  end

  test "an invalid line (CRLF injection) is rejected BEFORE the span — no :start event" do
    attach([[:grappa, :session, :send_privmsg, :start]])
    subject = {:user, Ecto.UUID.generate()}

    assert {:error, :invalid_line} = Session.send_privmsg(subject, 1, "#x\r\nJOIN #evil", "hi")

    refute_receive {:telemetry, [:grappa, :session, :send_privmsg, :start], _m, _meta}, 100
  end
end
