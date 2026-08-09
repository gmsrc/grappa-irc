defmodule Grappa.Vhosts.AdminWireTest do
  @moduledoc """
  #228 / #1140 — the operator-facing grant + vhost JSON shapes.

  The grant shape carries the subject as the `(subject_type, subject_id)`
  XOR pair PLUS `subject_label`, the resolved human name (#1140: the table
  used to print the bare UUID). `subject_id` stays on the wire — it is the
  stable key; the label is display. `subject_label: nil` is the honesty
  signal, the same one `Grappa.LiveIntrospection.AdminWire` uses.

  ## Test isolation

  Pure projection — struct fixtures, no DB.
  """
  use ExUnit.Case, async: true

  alias Grappa.Vhosts.{AdminWire, Grant, Vhost}

  defp grant(attrs) do
    struct!(%Grant{id: 1, vhost_id: 7}, attrs)
  end

  describe "grant_to_admin_json/2" do
    test "keeps the XOR pair and adds the resolved user label" do
      g = grant(user_id: "u-1")

      assert AdminWire.grant_to_admin_json(g, %{{:user, "u-1"} => "vjt"}) == %{
               id: 1,
               vhost_id: 7,
               subject_type: :user,
               subject_id: "u-1",
               subject_label: "vjt"
             }
    end

    test "renders a visitor's resolved nick as the label" do
      g = grant(visitor_id: "v-2")

      assert %{subject_type: :visitor, subject_id: "v-2", subject_label: "guest"} =
               AdminWire.grant_to_admin_json(g, %{{:visitor, "v-2"} => "guest"})
    end

    test "an unresolved subject renders nil — no fabricated placeholder" do
      g = grant(visitor_id: "v-orphan")

      assert %{subject_id: "v-orphan", subject_label: nil} =
               AdminWire.grant_to_admin_json(g, %{})
    end

    test "looks the label up by the subject PAIR, not the bare id" do
      # Keying on the id alone would let a visitor label bleed onto a user
      # grant that happens to carry the same uuid string.
      g = grant(user_id: "shared-id")

      assert %{subject_type: :user, subject_label: nil} =
               AdminWire.grant_to_admin_json(g, %{{:visitor, "shared-id"} => "notme"})
    end

    test "#251 — no `pinned` field survives on the grant wire" do
      json = AdminWire.grant_to_admin_json(grant(user_id: "u-4"), %{})
      refute Map.has_key?(json, :pinned)
    end
  end

  describe "vhost_to_admin_json/1" do
    test "projects the inventory row fields" do
      now = ~U[2026-08-09 10:00:00.000000Z]

      v = %Vhost{
        id: 3,
        address: "2001:db8::1",
        in_pool: true,
        generally_available: false,
        inserted_at: now,
        updated_at: now
      }

      assert AdminWire.vhost_to_admin_json(v) == %{
               id: 3,
               address: "2001:db8::1",
               in_pool: true,
               generally_available: false,
               inserted_at: now,
               updated_at: now
             }
    end
  end
end
