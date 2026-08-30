defmodule Grappa.AvatarsTest do
  use Grappa.DataCase, async: true

  import Mox
  import Grappa.AuthFixtures, only: [network_fixture: 0]
  import Grappa.UploadFixtures, only: [bytes: 1]

  alias Grappa.{Avatars, Repo}
  alias Grappa.Avatars.PeerAvatar

  setup :verify_on_exit!

  # A REAL PNG (with EXIF, so the happy-path test also proves MetadataStrip
  # ran) — a hand-rolled magic-byte-only stub fails exiftool's own PNG
  # validation ("Truncated PNG image") and MetadataStrip fails CLOSED, which
  # made every "happy path" test that used one report a phantom rejection.
  #
  # `network_id` is a REAL `Grappa.Networks.Network` row's id — the
  # migration's `references(:networks, ...)` FK rejects a made-up integer.
  setup do
    {:ok, png: bytes(:gps_png), network_id: network_fixture().id}
  end

  test "fetch_and_cache/3 stores sanitized bytes and broadcasts on success", ctx do
    Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.peer_avatar_cache(ctx.network_id))

    expect(Grappa.Net.ImageFetcherMock, :fetch, fn "http://peer.example/av.png" ->
      {:ok, ctx.png, "image/png"}
    end)

    assert :ok = Avatars.fetch_and_cache(ctx.network_id, "somepeer", "http://peer.example/av.png")

    assert %PeerAvatar{mime: "image/png", nick_key: "somepeer"} =
             row = Avatars.get(ctx.network_id, "somepeer")

    assert File.exists?(Avatars.storage_path(row.slug))

    network_id = ctx.network_id
    assert_receive {:peer_avatar_ready, ^network_id, "somepeer", slug}
    assert slug == row.slug
  end

  test "fetch_and_cache/3 rejects bytes whose magic number doesn't match the claimed content-type", ctx do
    expect(Grappa.Net.ImageFetcherMock, :fetch, fn _ -> {:ok, "not a png", "image/png"} end)

    assert :ok = Avatars.fetch_and_cache(ctx.network_id, "spoofer", "http://peer.example/av.png")
    assert Avatars.get(ctx.network_id, "spoofer") == nil
  end

  test "fetch_and_cache/3 rejects a fetch over the per-entry byte cap even though the shared fetcher allowed it", ctx do
    oversized = String.duplicate("a", 2 * 1024 * 1024 + 1)
    expect(Grappa.Net.ImageFetcherMock, :fetch, fn _ -> {:ok, oversized, "image/png"} end)

    assert :ok = Avatars.fetch_and_cache(ctx.network_id, "toobig", "http://peer.example/huge.png")
    assert Avatars.get(ctx.network_id, "toobig") == nil
  end

  test "fetch_and_cache/3 swallows a fetcher SSRF block without raising or storing anything", ctx do
    expect(Grappa.Net.ImageFetcherMock, :fetch, fn _ -> {:error, :ssrf_blocked} end)

    assert :ok = Avatars.fetch_and_cache(ctx.network_id, "blocked", "http://169.254.169.254/latest/meta")
    assert Avatars.get(ctx.network_id, "blocked") == nil
  end

  test "fetch_and_cache/3 replaces a prior cached row, unlinking the old file", ctx do
    expect(Grappa.Net.ImageFetcherMock, :fetch, fn _ -> {:ok, ctx.png, "image/png"} end)
    assert :ok = Avatars.fetch_and_cache(ctx.network_id, "repeater", "http://peer.example/first.png")
    first = Avatars.get(ctx.network_id, "repeater")
    assert File.exists?(Avatars.storage_path(first.slug))

    expect(Grappa.Net.ImageFetcherMock, :fetch, fn _ -> {:ok, ctx.png, "image/png"} end)
    assert :ok = Avatars.fetch_and_cache(ctx.network_id, "repeater", "http://peer.example/second.png")
    second = Avatars.get(ctx.network_id, "repeater")

    refute second.slug == first.slug
    refute File.exists?(Avatars.storage_path(first.slug))
    assert File.exists?(Avatars.storage_path(second.slug))
    # One row per (network, nick) — a replace, not an accumulation.
    assert Repo.aggregate(PeerAvatar, :count) == 1
  end

  describe "get_by_slug/1" do
    test "returns :not_found for a malformed slug" do
      assert {:error, :not_found} = Avatars.get_by_slug("not-a-real-slug")
    end

    test "returns :not_found for an unknown slug" do
      assert {:error, :not_found} = Avatars.get_by_slug("aaaaaaaaaaaaaaaaaaaaaaaaaa")
    end

    test "returns the row for a live cached slug", ctx do
      expect(Grappa.Net.ImageFetcherMock, :fetch, fn _ -> {:ok, ctx.png, "image/png"} end)
      assert :ok = Avatars.fetch_and_cache(ctx.network_id, "findable", "http://peer.example/av.png")
      row = Avatars.get(ctx.network_id, "findable")

      assert {:ok, ^row} = Avatars.get_by_slug(row.slug)
    end

    test "returns :not_found for an expired row", ctx do
      expect(Grappa.Net.ImageFetcherMock, :fetch, fn _ -> {:ok, ctx.png, "image/png"} end)
      assert :ok = Avatars.fetch_and_cache(ctx.network_id, "stale", "http://peer.example/av.png")
      row = Avatars.get(ctx.network_id, "stale")

      row
      |> Ecto.Changeset.change(expires_at: DateTime.add(DateTime.utc_now(), -1, :second))
      |> Repo.update!()

      assert {:error, :not_found} = Avatars.get_by_slug(row.slug)
      assert Avatars.get(ctx.network_id, "stale") == nil
    end
  end
end
