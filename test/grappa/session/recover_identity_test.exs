defmodule Grappa.Session.RecoverIdentityTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.RecoverIdentity

  # Source-verified ordering (GH #581): `+r` is per-nick and only lands
  # when you IDENTIFY while ON the registered nick (sameNick). So the
  # sequence sends NICK + IDENTIFY together and waits for `+r` as success;
  # a 433/437 drives a RECOVER/RELEASE detour, then one retry.

  describe "init/2" do
    test "starts in :idle with cred_nick + secret populated, no verb/reason" do
      assert %RecoverIdentity{
               phase: :idle,
               cred_nick: "vjt",
               secret: "s3cret",
               verb: nil,
               reason: nil
             } = RecoverIdentity.init("vjt", "s3cret")
    end
  end

  describe "step/2 — happy path (nick free)" do
    test ":idle + :start → :awaiting_r + NICK then IDENTIFY (sameNick), in order" do
      state = RecoverIdentity.init("vjt", "s3cret")

      assert {:cont, next, lines} = RecoverIdentity.step(state, :start)

      assert next.phase == :awaiting_r
      # NICK MUST precede IDENTIFY so the identify is sameNick and commits +r.
      assert lines == ["NICK vjt\r\n", "PRIVMSG NickServ :IDENTIFY vjt s3cret\r\n"]
    end

    test ":awaiting_r + :r_observed → :succeeded, no lines" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}

      assert {:stop, next, []} = RecoverIdentity.step(state, :r_observed)
      assert next.phase == :succeeded
      assert next.reason == nil
    end
  end

  describe "step/2 — wrong password (clean NICK, no +r)" do
    test ":awaiting_r + :timeout → :failed :wrong_password, no lines" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}

      assert {:stop, next, []} = RecoverIdentity.step(state, :timeout)
      assert next.phase == :failed
      assert next.reason == :wrong_password
    end
  end

  describe "step/2 — nick held → verb → settle → one retry" do
    test ":awaiting_r + {:nick_error, 433} → :awaiting_verb_settle verb :recover + RECOVER" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}

      assert {:cont, next, lines} = RecoverIdentity.step(state, {:nick_error, 433})

      assert next.phase == :awaiting_verb_settle
      assert next.verb == :recover
      assert lines == ["PRIVMSG NickServ :RECOVER vjt s3cret\r\n"]
    end

    test ":awaiting_r + {:nick_error, 437} → :awaiting_verb_settle verb :release + RELEASE" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}

      assert {:cont, next, lines} = RecoverIdentity.step(state, {:nick_error, 437})

      assert next.phase == :awaiting_verb_settle
      assert next.verb == :release
      assert lines == ["PRIVMSG NickServ :RELEASE vjt s3cret\r\n"]
    end

    test ":awaiting_verb_settle + :settle → :awaiting_final_r + NICK then IDENTIFY" do
      state = %RecoverIdentity{
        phase: :awaiting_verb_settle,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :recover
      }

      assert {:cont, next, lines} = RecoverIdentity.step(state, :settle)

      assert next.phase == :awaiting_final_r
      assert lines == ["NICK vjt\r\n", "PRIVMSG NickServ :IDENTIFY vjt s3cret\r\n"]
    end

    test ":awaiting_final_r + :r_observed → :succeeded" do
      state = %RecoverIdentity{
        phase: :awaiting_final_r,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :recover
      }

      assert {:stop, next, []} = RecoverIdentity.step(state, :r_observed)
      assert next.phase == :succeeded
    end

    test ":awaiting_verb_settle + :timeout → :failed :services_declined" do
      state = %RecoverIdentity{phase: :awaiting_verb_settle, cred_nick: "vjt", verb: :recover}

      assert {:stop, next, []} = RecoverIdentity.step(state, :timeout)
      assert next.phase == :failed
      assert next.reason == :services_declined
    end
  end

  describe "step/2 — F2: a refused NICK after the verb is TERMINAL, never retried" do
    # F2 (vjt 2026-07-31): a refused NICK after the verb has done its job is
    # a FAILURE, not a retry. RECOVER was chosen precisely because an empty
    # retry never wins the nick. The retry gets ONE shot; refusal = failed,
    # and CRUCIALLY the FSM emits NO further NICK line — no loop.
    test ":awaiting_final_r + {:nick_error, 433} → :failed :nick_unavailable, NO retry line" do
      state = %RecoverIdentity{
        phase: :awaiting_final_r,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :recover
      }

      assert {:stop, next, lines} = RecoverIdentity.step(state, {:nick_error, 433})
      assert next.phase == :failed
      assert next.reason == :nick_unavailable
      assert lines == []
    end

    test ":awaiting_final_r + {:nick_error, 437} → :failed :nick_unavailable, NO retry line" do
      state = %RecoverIdentity{
        phase: :awaiting_final_r,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :release
      }

      assert {:stop, next, lines} = RecoverIdentity.step(state, {:nick_error, 437})
      assert next.phase == :failed
      assert next.reason == :nick_unavailable
      assert lines == []
    end

    test ":awaiting_final_r + :timeout → :failed :nick_unavailable" do
      state = %RecoverIdentity{phase: :awaiting_final_r, cred_nick: "vjt", verb: :recover}

      assert {:stop, next, []} = RecoverIdentity.step(state, :timeout)
      assert next.phase == :failed
      assert next.reason == :nick_unavailable
    end
  end

  describe "step/2 — wire lines keep the credential nick RAW (key/display/wire split)" do
    # cred_nick is a DISPLAY/WIRE token: its case is presentation and must
    # NOT be folded on the wire. The FSM never lower-cases it.
    test "mixed-case cred_nick round-trips verbatim through NICK/IDENTIFY/RECOVER" do
      state = RecoverIdentity.init("Vjt", "s3cret")
      assert {:cont, r1, l1} = RecoverIdentity.step(state, :start)
      assert l1 == ["NICK Vjt\r\n", "PRIVMSG NickServ :IDENTIFY Vjt s3cret\r\n"]

      assert {:cont, _, l2} = RecoverIdentity.step(r1, {:nick_error, 433})
      assert l2 == ["PRIVMSG NickServ :RECOVER Vjt s3cret\r\n"]
    end
  end

  describe "step/2 — no-ops (off-phase inputs and terminal passthrough)" do
    test "off-phase input is a no-op {:cont, state, []}" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}
      # :settle is only valid in :awaiting_verb_settle
      assert {:cont, ^state, []} = RecoverIdentity.step(state, :settle)
    end

    test "a :start on an already-started FSM is a no-op" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}
      assert {:cont, ^state, []} = RecoverIdentity.step(state, :start)
    end

    test "terminal phases pass any input through unchanged with no lines" do
      for phase <- [:succeeded, :failed] do
        state = %RecoverIdentity{phase: phase, cred_nick: "vjt", secret: "s3cret"}
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :start)
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :r_observed)
        assert {:cont, ^state, []} = RecoverIdentity.step(state, {:nick_error, 433})
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :settle)
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :timeout)
      end
    end
  end
end
