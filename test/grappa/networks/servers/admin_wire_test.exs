defmodule Grappa.Networks.Servers.AdminWireTest do
  @moduledoc """
  Admin-panel bucket 1 — wire-shape projection for `Grappa.Networks.Server`
  rows. The projection is pure: every field on the schema (sans the
  preloaded `:network` association) lands in the JSON. No password or
  internal state to leak — Servers carry no secrets — but the test pins
  the shape so a future field addition is a deliberate edit per
  CLAUDE.md "Adding a field = one explicit edit per Wire module."
  """
  use ExUnit.Case, async: true

  alias Grappa.Networks.Server
  alias Grappa.Networks.Servers.AdminWire

  describe "server_to_admin_json/1" do
    test "projects every Server row field" do
      now = DateTime.utc_now()

      server = %Server{
        id: 17,
        network_id: 3,
        host: "irc.example.test",
        port: 6697,
        tls: true,
        priority: 0,
        enabled: true,
        inserted_at: now,
        updated_at: now
      }

      assert %{
               id: 17,
               network_id: 3,
               host: "irc.example.test",
               port: 6697,
               tls: true,
               priority: 0,
               enabled: true,
               inserted_at: ^now,
               updated_at: ^now
             } = AdminWire.server_to_admin_json(server)
    end

    test "tls false + disabled + custom priority round-trip as is" do
      now = DateTime.utc_now()

      server = %Server{
        id: 99,
        network_id: 1,
        host: "plain.example.test",
        port: 6667,
        tls: false,
        priority: 10,
        enabled: false,
        inserted_at: now,
        updated_at: now
      }

      json = AdminWire.server_to_admin_json(server)
      assert json.tls == false
      assert json.enabled == false
      assert json.priority == 10
    end

    test "preloaded :network association is NOT exposed (no field leakage)" do
      now = DateTime.utc_now()

      server = %Server{
        id: 1,
        network_id: 1,
        network: %Grappa.Networks.Network{slug: "should-not-leak"},
        host: "h",
        port: 1,
        tls: true,
        priority: 0,
        enabled: true,
        inserted_at: now,
        updated_at: now
      }

      json = AdminWire.server_to_admin_json(server)
      refute Map.has_key?(json, :network)
    end

    # #1677 — the posture is projected so an operator can SEE which servers
    # run unverified. Read-only: it is deliberately NOT in the controller's
    # write whitelist, because whether the API should be able to SET it is
    # the question the issue explicitly left open.
    test "tls_verify is projected, and a schema default row projects true" do
      now = DateTime.utc_now()

      # `%Server{}` with no tls_verify given — the SCHEMA default is what a
      # pre-#1677 row and a caller who never named the field both get.
      strict = %Server{
        id: 1,
        network_id: 1,
        host: "irc.azzurra.chat",
        port: 6697,
        tls: true,
        priority: 0,
        enabled: true,
        inserted_at: now,
        updated_at: now
      }

      assert AdminWire.server_to_admin_json(strict).tls_verify == true

      loose = %Server{strict | id: 2, host: "efnet.deic.eu", tls_verify: false}
      assert AdminWire.server_to_admin_json(loose).tls_verify == false
    end
  end
end
