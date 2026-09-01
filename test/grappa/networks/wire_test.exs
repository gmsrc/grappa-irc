defmodule Grappa.Networks.WireTest do
  @moduledoc """
  Tests for `Grappa.Networks.Wire` — the public JSON shape for
  `Networks.Credential` and `Networks.Network` rows.

  The CRITICAL invariant: the credential JSON output MUST NOT include
  `:password_encrypted` (which post-Cloak-load carries the upstream
  IRC password as plaintext-in-memory) NOR the virtual `:password`
  field (input-only, but defensively excluded too). `redact: true`
  on the schema only protects `inspect/1` and Logger; `Jason.encode!/1`
  walks the struct fields directly. Without an explicit allowlist
  serializer, the first naive Phase 3 `GET /networks` controller
  emitting `Jason.encode!(credential)` would leak the NickServ
  password to JSON.
  """
  use Grappa.DataCase, async: true

  alias Grappa.{Accounts, Networks, Repo}
  alias Grappa.Networks.{Credential, Credentials, Wire}

  setup do
    {:ok, user} =
      Accounts.create_user(%{
        name: "vjt-#{System.unique_integer([:positive])}",
        password: "correct horse battery"
      })

    {:ok, network} =
      Networks.find_or_create_network(%{slug: "azzurra-#{System.unique_integer([:positive])}"})

    %{user: user, network: network}
  end

  describe "credential_to_json/1" do
    test "renders the public credential shape (slug under :network)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          ident: "grp",
          realname: "Marcello",
          sasl_user: "vjt",
          auth_method: :sasl,
          password: "shibboleth",
          autojoin_channels: ["#grappa"]
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      json = Wire.credential_to_json(cred)

      assert json.network == network.slug
      assert json.nick == "vjt"
      assert json.ident == "grp"
      assert json.realname == "Marcello"
      assert json.sasl_user == "vjt"
      assert json.auth_method == :sasl
      assert json.autojoin_channels == ["#grappa"]
      # Timestamps land as ISO-8601 strings on the wire (bnd-A11);
      # the dedicated test below pins the round-trip shape.
      assert is_binary(json.inserted_at)
      assert is_binary(json.updated_at)
    end

    # CRITICAL — the whole point of this module. If this assertion ever
    # regresses, the next deployed `GET /networks` endpoint leaks the
    # upstream NickServ password to the world.
    test "NEVER includes :password_encrypted nor :password",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: "leak-canary-please-never-appear"
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      # Sanity-check the precondition: post-load Cloak has decrypted
      # the AES-GCM ciphertext into plaintext-in-memory.
      assert cred.password_encrypted == "leak-canary-please-never-appear"

      json = Wire.credential_to_json(cred)

      refute Map.has_key?(json, :password_encrypted)
      refute Map.has_key?(json, :password)

      # And the canary string must not appear ANYWHERE in the JSON
      # (defends against a future field that accidentally carries it).
      json_string = Jason.encode!(json)
      refute json_string =~ "leak-canary-please-never-appear"
    end

    test "crashes loudly on unloaded :network assoc",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = Credentials.get_credential!(user, network)
      # `get_credential!/2` returns the row WITHOUT preloading :network.
      assert match?(%Ecto.Association.NotLoaded{}, cred.network)

      assert_raise FunctionClauseError, fn -> Wire.credential_to_json(cred) end
    end

    test "is Jason-encodable without raising",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      assert is_binary(Jason.encode!(Wire.credential_to_json(cred)))
    end

    # Architecture audit bnd-A11: timestamps on the wire must be
    # ISO-8601 strings, not raw `%DateTime{}` structs. The cic-side TS
    # contract (`api.ts` `CredentialJson`) declares `inserted_at:
    # string` etc. — the typespec was lying about the wire shape.
    test "renders timestamps as ISO-8601 strings (cic contract)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      json = Wire.credential_to_json(cred)

      # Convert-at-the-Wire-boundary: the field is a binary on output,
      # not a `%DateTime{}` (which would still encode correctly through
      # Jason but lie about the typespec).
      assert is_binary(json.inserted_at)
      assert is_binary(json.updated_at)
      # ISO-8601 sanity round-trip.
      assert {:ok, _, 0} = DateTime.from_iso8601(json.inserted_at)
      assert {:ok, _, 0} = DateTime.from_iso8601(json.updated_at)
    end

    test "connection_state_changed_at: nil → nil; %DateTime{} → ISO-8601 string",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      # bind_credential defaults to `DateTime.utc_now/0`; assert
      # iso-8601 round-trip.
      with_default = Wire.credential_to_json(cred)
      assert is_binary(with_default.connection_state_changed_at)
      assert {:ok, _, 0} = DateTime.from_iso8601(with_default.connection_state_changed_at)

      # Force-clear to nil and re-render — `iso8601_or_nil/1` must
      # preserve the nullability through the wire boundary.
      cleared = Wire.credential_to_json(%{cred | connection_state_changed_at: nil})
      assert cleared.connection_state_changed_at == nil
    end
  end

  describe "services_flavor exposure (GH #349) on both GET /networks twins" do
    test "network_with_nick_to_json/4 (user twin) carries services_flavor",
         %{network: network} do
      net = %{network | services_flavor: :atheme}

      cred = %Credential{
        network: net,
        nick: "vjt",
        connection_state: :connected,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      json = Wire.network_with_nick_to_json(net, "vjt", cred, nil)

      assert json.kind == :user
      assert json.services_flavor == :atheme
    end

    test "visitor_network_to_json/4 (visitor twin) carries services_flavor",
         %{network: network} do
      net = %{network | services_flavor: :azzurra}

      cred = %Credential{
        network: net,
        nick: "vjt",
        connection_state: :connected,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      json = Wire.visitor_network_to_json(net, "vjt", cred, nil)

      assert json.kind == :visitor
      assert json.services_flavor == :azzurra
    end

    test "an unclassified network surfaces services_flavor: nil (wizard hidden)",
         %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :connected,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      # setup builds the network via find_or_create_network → nil flavor.
      assert Wire.network_with_nick_to_json(network, "vjt", cred, nil).services_flavor == nil
      assert Wire.visitor_network_to_json(network, "vjt", cred, nil).services_flavor == nil
    end
  end

  describe "connection field (#474 scope B) on both GET /networks twins" do
    test "network_with_nick_to_json/4 embeds the live connection facts",
         %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :connected,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      at = ~U[2026-08-06T10:00:00Z]
      conn = %{server: "89.31.72.10", port: 6697, tls: true, registered: true, connected_at: at}
      json = Wire.network_with_nick_to_json(network, "vjt", cred, conn)

      assert json.connection == %{
               server: "89.31.72.10",
               port: 6697,
               tls: true,
               registered: true,
               connected_at: "2026-08-06T10:00:00Z"
             }
    end

    test "visitor_network_to_json/4 embeds the live connection facts",
         %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :connected,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      conn = %{
        server: "127.0.0.1",
        port: 6667,
        tls: false,
        registered: false,
        connected_at: ~U[2026-08-06T10:00:00Z]
      }

      assert Wire.visitor_network_to_json(network, "vjt", cred, conn).connection == %{
               server: "127.0.0.1",
               port: 6667,
               tls: false,
               registered: false,
               connected_at: "2026-08-06T10:00:00Z"
             }
    end

    test "connected_at renders as an ISO-8601 string, and nil stays nil (#897)",
         %{network: network} do
      # #897 — the link's connect instant travels inside `:connection`, the
      # live-only sub-object, so it is absent exactly when there is no live
      # pid. `nil` is reachable on a session whose state predates the field
      # (the #216 hot-reload contract): the wire says "unknown", never a
      # fabricated instant, and cic omits the row.
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :connected,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      base = %{server: "127.0.0.1", port: 6667, tls: false, registered: false, connected_at: nil}

      live = %{base | connected_at: ~U[2026-08-06T09:30:45Z]}

      assert Wire.network_with_nick_to_json(network, "vjt", cred, live).connection.connected_at ==
               "2026-08-06T09:30:45Z"

      assert Wire.network_with_nick_to_json(network, "vjt", cred, base).connection.connected_at ==
               nil
    end

    test "connection: nil when the session is not live (honest, no fabricated facts)",
         %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :parked,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      assert Wire.network_with_nick_to_json(network, "vjt", cred, nil).connection == nil
      assert Wire.visitor_network_to_json(network, "vjt", cred, nil).connection == nil
    end
  end

  describe "visitor_network_to_json/4 (#211 phase 6 — visitor GET /networks row)" do
    test "renders the visitor twin shape (kind: :visitor, nick, connection_state)",
         %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :connected,
        connection_state_reason: nil,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      json = Wire.visitor_network_to_json(network, "vjt-live", cred, nil)

      assert json.kind == :visitor
      assert json.id == network.id
      assert json.slug == network.slug
      # nick is the caller-passed live-nick, NOT necessarily cred.nick.
      assert json.nick == "vjt-live"
      assert json.connection_state == :connected
      assert json.connection_state_reason == nil
      assert is_binary(json.connection_state_changed_at)
      # Timestamps land as ISO-8601 strings on the wire (bnd-A11).
      assert is_binary(json.inserted_at)
      assert is_binary(json.updated_at)
    end

    test "carries a parked credential's reason + state (persistent park, ruling D)",
         %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :parked,
        connection_state_reason: "user-disconnect",
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      json = Wire.visitor_network_to_json(network, "vjt", cred, nil)

      assert json.connection_state == :parked
      assert json.connection_state_reason == "user-disconnect"
    end

    test "is Jason-encodable", %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :connected,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      assert is_binary(Jason.encode!(Wire.visitor_network_to_json(network, "vjt", cred, nil)))
    end
  end

  describe "Credential.upstream_password/1" do
    test "returns the post-Cloak-load plaintext upstream secret",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :server_pass,
          # #1044 — the row carries both secrets, which makes the accessor
          # claim sharper: it reads ITS column and not the neighbouring one.
          server_pass: "gate-secret",
          password: "shibboleth"
        })

      cred = Credentials.get_credential!(user, network)

      assert Credential.upstream_password(cred) == "shibboleth"
    end

    test "returns nil for :none credentials with no stored password",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = Credentials.get_credential!(user, network)

      assert Credential.upstream_password(cred) == nil
    end
  end

  # Defense-in-depth: prove that handing the raw schema struct to
  # Jason — i.e., what a naive controller might do before A1 was
  # written — would have leaked. This isn't a regression test for the
  # Wire module itself; it's a contract on the schema's behaviour
  # under JSON encoding so future readers understand WHY Wire exists.
  describe "raw-struct Jason regression canary" do
    test "raw Credential leaks password_encrypted (this is what Wire prevents)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :sasl,
          password: "DO-NOT-LEAK"
        })

      cred = Credentials.get_credential!(user, network)

      # Jason can't encode an Ecto schema struct without `@derive` —
      # the raw struct path either raises Protocol.UndefinedError OR,
      # if a future @derive opens it up, leaks. Assert the current
      # state is the safe one (raise) so a future @derive Jason.Encoder
      # on Credential trips this canary and forces the author to use
      # Wire.credential_to_json/1 instead.
      assert_raise Protocol.UndefinedError, fn -> Jason.encode!(cred) end
    end

    test "raw Network leaks fields too (this is what Wire prevents)",
         %{network: network} do
      assert_raise Protocol.UndefinedError, fn -> Jason.encode!(network) end
    end
  end

  describe "channel_to_json/3 (P4-1 A5 wire)" do
    test "renders {name, joined, source} for an autojoin-joined channel" do
      assert %{name: "#italia", joined: true, source: :autojoin} =
               Wire.channel_to_json("#italia", true, :autojoin)
    end

    test "renders {name, joined, source} for an autojoin-but-parted channel" do
      assert %{name: "#italia", joined: false, source: :autojoin} =
               Wire.channel_to_json("#italia", false, :autojoin)
    end

    test "renders {name, joined, source} for a session-joined channel (not in autojoin)" do
      assert %{name: "#bnc", joined: true, source: :joined} =
               Wire.channel_to_json("#bnc", true, :joined)
    end
  end

  describe "connection_state_changed_event/5 (CP16 B3, REV-J M15 fold)" do
    test "renders the wire payload from a credential + transition tuple + nick",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          realname: "Marcello",
          sasl_user: "vjt",
          auth_method: :sasl,
          password: "shibboleth",
          autojoin_channels: ["#grappa"]
        })

      %Credential{} =
        cred = user |> Credentials.get_credential!(network) |> Repo.preload([:user, :network])

      now = DateTime.utc_now()

      # REV-J M15: the folded `:network` field carries `home_network_row/2`
      # of the credential POST-transition. Caller (Networks.broadcast_state_change/4)
      # passes the row with the new state already written; the test mirrors
      # that by setting connection_state on the fixture struct.
      cred = %Credential{cred | connection_state: :parked, connection_state_changed_at: now}

      payload =
        Wire.connection_state_changed_event(cred, :connected, :parked, "operator paused", "vjt-live")

      assert payload == %{
               kind: :connection_state_changed,
               user_id: cred.user_id,
               network_id: cred.network_id,
               network_slug: network.slug,
               from: :connected,
               to: :parked,
               reason: "operator paused",
               at: DateTime.to_iso8601(now),
               network: %{
                 slug: network.slug,
                 nick: "vjt-live",
                 connection_state: :parked,
                 connection_state_reason: nil,
                 connection_state_changed_at: DateTime.to_iso8601(now),
                 # #581 (D2) — :sasl credential, no NickServ secret.
                 recoverable: false
               }
             }
    end

    test "tolerates nil reason (state-change without operator note)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          realname: "Marcello",
          sasl_user: "vjt",
          auth_method: :sasl,
          password: "shibboleth",
          autojoin_channels: ["#grappa"]
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload([:user, :network])

      payload = Wire.connection_state_changed_event(cred, :parked, :connected, nil, "vjt")

      assert payload.reason == nil
      assert payload.from == :parked
      assert payload.to == :connected
      assert payload.kind == :connection_state_changed
      assert payload.network.nick == "vjt"
    end
  end

  # UX-4 bucket B (2026-05-18); REV-J M15 (2026-05-22). The home pane's
  # per-row payload is the narrow projection consumed by HomePane on
  # cold-load (via /me's `home_data` envelope) AND by HomePane on live
  # updates (via the `:network` field of `connection_state_changed`).
  # Both reads go through the shared `home_network_row/2` builder so
  # the wire shape is one edit, not two — the wire-parity test below
  # pins that invariant.
  describe "home_network_row/2 (UX-4 B)" do
    test "renders {slug, nick, connection_state, ...} from a preloaded credential",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      row = Wire.home_network_row(cred, "vjt-live")

      assert row.slug == network.slug
      assert row.nick == "vjt-live"
      assert row.connection_state == :connected
      assert row.connection_state_reason == nil
      # bind_credential defaults `connection_state_changed_at` to now; the
      # wire boundary converts to ISO-8601.
      assert is_binary(row.connection_state_changed_at)
      assert {:ok, _, 0} = DateTime.from_iso8601(row.connection_state_changed_at)
      # #581 (D2) — an :none credential carries no NickServ secret.
      assert row.recoverable == false
    end

    test "recoverable is true when the credential carries a NickServ secret (#581 D2)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: "hunter2"
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      assert Wire.home_network_row(cred, "vjt").recoverable == true
    end

    test "surfaces nil connection_state_changed_at as nil on the wire",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      row =
        Wire.home_network_row(
          %{cred | connection_state_changed_at: nil},
          "vjt"
        )

      assert row.connection_state_changed_at == nil
    end

    test "crashes loudly on unloaded :network assoc (mirror of credential_to_json/1)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = Credentials.get_credential!(user, network)
      assert match?(%Ecto.Association.NotLoaded{}, cred.network)

      assert_raise FunctionClauseError, fn -> Wire.home_network_row(cred, "vjt") end
    end

    test "rejects empty/non-string nick (defensive — caller bug)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{nick: "vjt", auth_method: :none})

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      assert_raise FunctionClauseError, fn -> Wire.home_network_row(cred, "") end
      assert_raise FunctionClauseError, fn -> Wire.home_network_row(cred, nil) end
    end
  end

  describe "home_data/2 (UX-4 B / #211 phase 6)" do
    test "renders networks + available_networks from (cred, nick) pairs + slugs",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      envelope = Wire.home_data([{cred, "vjt-live"}], ["libera"])

      assert %{networks: [row], available_networks: [avail]} = envelope
      assert row.slug == network.slug
      assert row.nick == "vjt-live"
      assert avail == %{slug: "libera"}
    end

    test "renders empty networks + empty available for empty inputs" do
      assert Wire.home_data([], []) == %{networks: [], available_networks: []}
    end
  end
end
