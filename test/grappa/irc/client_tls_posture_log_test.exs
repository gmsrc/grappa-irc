defmodule Grappa.IRC.ClientTlsPostureLogTest do
  @moduledoc """
  #1677 — `Grappa.IRC.Client.init/1` states WHICH TLS posture the session
  got, and the two arms sit at DIFFERENT levels on purpose.

  `async: false` because it lowers the global Logger level to observe an
  `info`. Same rationale, and the same requirement, as
  `client_outbound_cost_test.exs` and `user_socket_test.exs`: the level is
  process-global, so a concurrent test would see it move under itself.
  `client_test.exs` is `async: true` and must stay that way, which is why
  this arm lives in its own file rather than there — the repo's existing
  answer to exactly this problem.

  The asymmetry being pinned:

    * unverified → `Logger.warning`, ABOVE the default bar. An operator who
      is not looking for it still sees it. That is the whole operational
      half of the opt-out; a quiet downgrade would be worse than the
      cleartext it replaces, since `tls: false` at least announces itself
      in the config. (Pinned at the DEFAULT level in `client_test.exs`.)
    * verified → `Logger.info`, BELOW it. The ordinary posture must not
      spam a line per session per reconnect — the review record already
      carries that complaint about this very call site (B5-LOW-6).

  Both arms are asserted here so that "demote the warning to an info" and
  "delete the info line" are each a red test rather than a silent edit.

  Port 1 never accepts: `init/1` logs BEFORE the connect continue, so the
  posture line is emitted regardless of the handshake, which is itself the
  property (#89 made it deliberately not contingent on handshake validity).
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Grappa.IRC.Client

  setup do
    original = Application.get_env(:logger, :level, :warning)
    Logger.configure(level: :info)
    on_exit(fn -> Logger.configure(level: original) end)
    :ok
  end

  defp connect_opts(overrides) do
    Map.merge(
      %{
        host: "127.0.0.1",
        port: 1,
        tls: true,
        dispatch_to: self(),
        logger_metadata: [],
        nick: "grappa-test",
        ident: "grappa-test",
        realname: "grappa-test",
        sasl_user: "grappa-test",
        auth_method: :none
      },
      overrides
    )
  end

  defp capture_posture(overrides) do
    Process.flag(:trap_exit, true)

    capture_log(fn ->
      {:ok, client} = Client.start_link(connect_opts(overrides))
      assert_receive {:EXIT, ^client, _}, 15_000
    end)
  end

  test "a verified session logs the verify_peer posture as an info" do
    log = capture_posture(%{})

    assert log =~ "TLS posture: verify_peer"
    assert log =~ "[info]"
    refute log =~ "TLS posture: verify_none"
  end

  test "an unverified session logs verify_none as a WARNING, naming the flag" do
    log = capture_posture(%{tls_verify: false})

    assert log =~ "TLS posture: verify_none"
    assert log =~ "tls_verify=false"
    assert log =~ "[warning]"
    refute log =~ "TLS posture: verify_peer"
  end

  test "the unverified line says what is actually lost, not just that it is off" do
    log = capture_posture(%{tls_verify: false})

    # An operator reading the log must learn the CONSEQUENCE. "verify_none"
    # alone is a setting name; this is the sentence that makes it a warning.
    assert log =~ "NOT validated"
    assert log =~ "active on-path attacker"
  end

  test "a plaintext session logs no TLS posture line at all" do
    log = capture_posture(%{tls: false, port: 1})

    # Unchanged from #89: cleartext is already legible as `transport: :tcp`
    # everywhere else, and inventing a third posture line here would dilute
    # the one that matters.
    refute log =~ "TLS posture"
  end
end
