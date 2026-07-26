defmodule Grappa.Visitors.WireTest do
  @moduledoc """
  Tests for `Grappa.Visitors.Wire` — the public JSON shape for
  `Grappa.Visitors.Visitor` rows.

  #211 phase 7 — the visitor row is a pure identity/TTL row: the wire
  carries only `{id, expires_at?, registered}` (nick/ident/realname moved
  to the per-network credential rows). `registered` is DERIVED from the
  credentials and passed IN by the caller (the two renderers take
  `(visitor, registered)`), so these tests drive the boolean directly.
  """
  use ExUnit.Case, async: true

  alias Grappa.Visitors.{Visitor, Wire}

  defp build_visitor(opts \\ []) do
    default_expires = DateTime.add(DateTime.utc_now(), 86_400, :second)

    %Visitor{
      id: Keyword.get(opts, :id, "11111111-1111-1111-1111-111111111111"),
      expires_at: Keyword.get(opts, :expires_at, default_expires),
      ip: Keyword.get(opts, :ip, "192.0.2.1"),
      incognito: Keyword.get(opts, :incognito, false),
      inserted_at: DateTime.utc_now(),
      updated_at: DateTime.utc_now()
    }
  end

  describe "visitor_to_credential_json/2" do
    test "renders the credential-exchange shape (id, registered, incognito)" do
      v = build_visitor()
      assert Wire.visitor_to_credential_json(v, false) == %{id: v.id, registered: false, incognito: false}
      assert Wire.visitor_to_credential_json(v, true) == %{id: v.id, registered: true, incognito: false}
    end

    test "#363 surfaces the incognito flag so cic can mark the session ephemeral" do
      v = build_visitor(incognito: true)
      assert Wire.visitor_to_credential_json(v, false).incognito == true
    end

    test "EXCLUDES per-network identity + operator/audit fields" do
      json = Wire.visitor_to_credential_json(build_visitor(), false)

      for key <- [:nick, :ident, :realname, :network_slug, :password_encrypted, :password, :ip, :expires_at] do
        refute Map.has_key?(json, key)
      end
    end
  end

  describe "visitor_to_json/2" do
    test "renders the full profile shape (id, expires_at, registered, incognito)" do
      v = build_visitor()

      assert Wire.visitor_to_json(v, false) == %{
               id: v.id,
               expires_at: v.expires_at,
               registered: false,
               incognito: false
             }

      assert Wire.visitor_to_json(v, true).registered == true
    end

    test "#363 surfaces the incognito flag in the full profile shape" do
      assert Wire.visitor_to_json(build_visitor(incognito: true), false).incognito == true
    end

    test "EXCLUDES per-network identity + operator/audit fields" do
      json = Wire.visitor_to_json(build_visitor(), false)

      for key <- [
            :nick,
            :ident,
            :realname,
            :network_slug,
            :password_encrypted,
            :password,
            :ip,
            :inserted_at,
            :updated_at
          ] do
        refute Map.has_key?(json, key)
      end
    end
  end
end
