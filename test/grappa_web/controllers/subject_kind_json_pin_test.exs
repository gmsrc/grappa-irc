defmodule GrappaWeb.SubjectKindJSONPinTest do
  @moduledoc """
  #1406 X-S10 — byte pin on the two subject-discriminated render doors.

  `MeJSON.show/1` and `AuthJSON.login/1` used to put the STRINGS `"user"` /
  `"visitor"` into `:kind`; the closed-set rule types them as atoms instead.
  Jason renders an atom value as the same JSON string, so the change is
  supposed to be invisible on the wire — but "Jason emits the same bytes" is
  a prediction until something asserts it. These tests are that assertion:
  they were written and run GREEN against the string implementation, so a
  post-change green means the wire did not move.

  Structural equality over the DECODED body, plus a byte-exact encode of the
  discriminator alone. Object member order is deliberately NOT pinned: it is
  insignificant per RFC 8259, and Erlang's small-map key order follows atom
  term order, which shifts as the atom table changes between builds — a
  full-body byte pin would be a flake, not a gate.
  """
  use Grappa.DataCase, async: true

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.{AuthJSON, MeJSON}

  @user %User{
    id: "11111111-1111-4111-8111-111111111111",
    name: "vjt",
    is_admin: true,
    inserted_at: ~U[2026-08-17 09:00:00Z]
  }

  @visitor %Visitor{
    id: "22222222-2222-4222-8222-222222222222",
    expires_at: ~U[2026-08-17 10:00:00Z],
    incognito: false
  }

  @home_data %{networks: [], available_networks: []}

  describe "GET /me body" do
    test "the user body is byte-identical, discriminator included" do
      body =
        MeJSON.show(%{
          user: @user,
          read_cursors: %{},
          unread_counts: %{},
          badge_count: 0,
          home_data: @home_data
        })

      assert decode(body) == %{
               "kind" => "user",
               "id" => "11111111-1111-4111-8111-111111111111",
               "name" => "vjt",
               "is_admin" => true,
               "inserted_at" => "2026-08-17T09:00:00Z",
               "read_cursors" => %{},
               "unread_counts" => %{},
               "badge_count" => 0,
               "home_data" => %{"networks" => [], "available_networks" => []}
             }

      assert encoded_kind(body) == ~s({"kind":"user"})
    end

    test "the visitor body is byte-identical, discriminator included" do
      body =
        MeJSON.show(%{
          visitor: @visitor,
          registered: true,
          read_cursors: %{},
          unread_counts: %{},
          badge_count: 0,
          home_data: @home_data
        })

      assert decode(body) == %{
               "kind" => "visitor",
               "id" => "22222222-2222-4222-8222-222222222222",
               "expires_at" => "2026-08-17T10:00:00Z",
               "registered" => true,
               "incognito" => false,
               "read_cursors" => %{},
               "unread_counts" => %{},
               "badge_count" => 0,
               "home_data" => %{"networks" => [], "available_networks" => []}
             }

      assert encoded_kind(body) == ~s({"kind":"visitor"})
    end
  end

  describe "POST /auth/login body" do
    test "the user subject is byte-identical, discriminator included" do
      body = AuthJSON.login(%{token: "tok", subject: {:user, @user}})

      assert decode(body) == %{
               "token" => "tok",
               "subject" => %{
                 "kind" => "user",
                 "id" => "11111111-1111-4111-8111-111111111111",
                 "name" => "vjt"
               }
             }

      assert encoded_kind(body.subject) == ~s({"kind":"user"})
    end

    # `registered` is DERIVED from the credentials at render time, so this
    # clause reaches the Repo — a visitor with no credential row is not
    # registered. That is why the case runs under DataCase.
    test "the visitor subject is byte-identical, discriminator included" do
      body = AuthJSON.login(%{token: "tok", subject: {:visitor, @visitor}})

      assert decode(body) == %{
               "token" => "tok",
               "subject" => %{
                 "kind" => "visitor",
                 "id" => "22222222-2222-4222-8222-222222222222",
                 "registered" => false,
                 "incognito" => false
               }
             }

      assert encoded_kind(body.subject) == ~s({"kind":"visitor"})
    end
  end

  defp decode(body), do: body |> Jason.encode!() |> Jason.decode!()

  defp encoded_kind(%{kind: kind}), do: Jason.encode!(%{kind: kind})
end
