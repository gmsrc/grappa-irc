defmodule Grappa.Push.BadgeCountLiveNickTest do
  @moduledoc """
  #498 — the notify/badge count must match the LIVE IRC nick, not the
  configured credential nick, after a `/nick` rename.

  `Grappa.Push.BadgeCount` (and the `/me` cold-load seed + read-cursor
  settle that share its own-nick resolver) historically read the
  CONFIGURED credential nick off-`Session`, accepting mention-match
  staleness after a rename "until the next reconnect rewrites the
  credential". Nothing rewrites the credential for a user, so the
  staleness was permanent: after `/nick newnick` the count kept matching
  the OLD nick and stopped matching the NEW one.

  C-prime converges every door onto the ONE live-nick source
  (`Session.current_nick/2`, now a cheap SessionRegistry-value lookup),
  so the badge follows the rename immediately, both halves.

  `async: false` — the session harness spawns a real `Session.Server`
  under the singleton `SessionRegistry`/`SessionSupervisor` (mirrors
  `Grappa.Session.ServerTest`); concurrent tests would collide on the
  `{:session, user_id, network_id}` key. `Grappa.DataCase` switches to
  shared sandbox mode so the out-of-PID GenServer sees the sandboxed Repo.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Networks, ReadCursor, ScrollbackHelpers, Session}
  alias Grappa.Push.BadgeCount

  # The configured (credential) nick and the post-rename LIVE nick. The
  # rename is a genuine identity change (old ≢ new), so the credential nick
  # stays `@configured_nick` while the live session nick becomes
  # `@live_nick` — exactly the divergence #498 is about.
  @configured_nick "grappa-test"
  @live_nick "renamed-vjt"

  # Starts a real session, reconciles at 001 to the configured nick, then
  # forces a self-NICK to `@live_nick`. Returns `{subject, network}` with
  # the credential nick left at `@configured_nick` (nothing persists the
  # rename — the #498 staleness). The PING/PONG round-trip flushes the
  # cross-process NICK pipeline (TCP buffer → Client → Session mailbox)
  # so the rename is fully applied before the assertions run.
  defp start_renamed_session do
    rfc_handler = fn state, line ->
      if String.starts_with?(line, "USER ") do
        {:reply, ":server 001 #{@configured_nick} :Welcome\r\n", state}
      else
        {:reply, nil, state}
      end
    end

    {:ok, server} = IRCServer.start_link(rfc_handler)
    port = IRCServer.port(server)

    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    {network, _} = network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network, %{nick: @configured_nick})

    _ = start_session_for(user, network)

    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    # Autojoin JOIN fires only after 001 is fully processed → a barrier
    # proving the nick reconciliation landed before the self-NICK below.
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

    IRCServer.feed(server, ":#{@configured_nick}!u@h NICK :#{@live_nick}\r\n")
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)

    {{:user, user.id}, network}
  end

  defp insert(subject, network, channel, opts) do
    {:ok, message} =
      ScrollbackHelpers.insert(%{
        user_id: elem(subject, 1),
        network_id: network.id,
        channel: channel,
        server_time: opts[:st],
        kind: :privmsg,
        sender: opts[:sender],
        body: opts[:body]
      })

    message
  end

  defp set_cursor(subject, network, channel, message_id) do
    {:ok, _} = ReadCursor.set(subject, network.id, channel, message_id)
    :ok
  end

  test "current_nick tracks the live rename (registry-backed reader)" do
    {subject, network} = start_renamed_session()

    # The reader returns the LIVE nick — the source every notify door must
    # converge on. (Green pre- and post-C-prime; guards the reader semantics
    # while its implementation moves from a GenServer.call to a Registry
    # lookup.)
    assert Session.current_nick(subject, network.id) == {:ok, @live_nick}
  end

  test "current_nick is :no_session with no live session (badge falls back to cred nick)" do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    network = network_fixture()
    _ = credential_fixture(user, network, %{nick: @configured_nick})

    assert Session.current_nick({:user, user.id}, network.id) == {:error, :no_session}
  end

  test "live_nick_index resolves the live nick when a session is up" do
    {subject, network} = start_renamed_session()
    slug = network.slug

    assert %{^slug => {network_id, nick}} = Networks.live_nick_index(subject)
    assert network_id == network.id
    assert nick == @live_nick
  end

  test "live_nick_index falls back to the credential nick with no live session" do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    network = network_fixture()
    _ = credential_fixture(user, network, %{nick: @configured_nick})

    assert Networks.live_nick_index({:user, user.id}) == %{
             network.slug => {network.id, @configured_nick}
           }
  end

  test "#498 — badge counts a mention of the LIVE nick after /nick (starts counting the new)" do
    {subject, network} = start_renamed_session()

    anchor = insert(subject, network, "#chan", st: 1, sender: "alice", body: "morning all")
    insert(subject, network, "#chan", st: 2, sender: "bob", body: "#{@live_nick}: ping")
    set_cursor(subject, network, "#chan", anchor.id)

    # RED before C-prime: the badge resolves own_nick from the CONFIGURED
    # nick (@configured_nick), so a mention of the LIVE nick is not matched
    # → 0. After: the badge follows the live nick → 1.
    assert BadgeCount.count(subject) == 1
  end

  test "#498 — badge stops counting a mention of the OLD (configured) nick after /nick" do
    {subject, network} = start_renamed_session()

    anchor = insert(subject, network, "#chan", st: 1, sender: "alice", body: "morning all")
    insert(subject, network, "#chan", st: 2, sender: "bob", body: "#{@configured_nick}: ping")
    set_cursor(subject, network, "#chan", anchor.id)

    # RED before C-prime: the badge still matches the stale CONFIGURED nick
    # → counts the old-nick mention → 1. After: the live nick is @live_nick,
    # so the old nick is no longer the operator's identity → 0.
    assert BadgeCount.count(subject) == 0
  end
end
