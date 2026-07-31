defmodule Grappa.Themes.BuiltinBackgroundsTest do
  use ExUnit.Case, async: true

  alias Grappa.Themes.BuiltinBackgrounds

  test "all/0 is the curated set of 14 cover backgrounds" do
    all = BuiltinBackgrounds.all()
    assert length(all) == 14
  end

  test "every entry carries key + name + variant + path" do
    for bg <- BuiltinBackgrounds.all() do
      assert is_binary(bg.key) and bg.key != ""
      assert is_binary(bg.name) and bg.name != ""
      assert bg.variant in [:dark, :light]
      assert is_binary(bg.path)
    end
  end

  test "keys are unique" do
    keys = Enum.map(BuiltinBackgrounds.all(), & &1.key)
    assert keys == Enum.uniq(keys)
  end

  test "keys are safe slugs (no path-traversal surface)" do
    for %{key: key} <- BuiltinBackgrounds.all() do
      assert Regex.match?(~r/\A[a-z0-9-]+\z/, key), "unsafe key: #{key}"
    end
  end

  test "path is the static /backgrounds/<key>.webp convention customTheme mirrors" do
    for bg <- BuiltinBackgrounds.all() do
      assert bg.path == "/backgrounds/#{bg.key}.webp"
    end
  end

  test "the manifest is 7 dark + 7 light" do
    variants = Enum.frequencies_by(BuiltinBackgrounds.all(), & &1.variant)
    assert variants == %{dark: 7, light: 7}
  end

  # NOT tested here on purpose: that every key has a WebP on disk. That is the
  # real failure mode of adding a catalog entry (a picker tile that 404s), but
  # the oneshot test container mounts only `cicchetto/src` — `cicchetto/public`
  # is absent, so the assertion would either fail for the wrong reason or, if
  # written defensively, pass precisely when it matters. It belongs to a cic-side
  # check that can see the bundle, not to this suite. Verified by hand for #334.

  test "keys/0 is the flat key list, in all/0 order" do
    assert BuiltinBackgrounds.keys() == Enum.map(BuiltinBackgrounds.all(), & &1.key)
  end

  test "valid_key?/1 gates membership in the closed set" do
    known = hd(BuiltinBackgrounds.keys())
    assert BuiltinBackgrounds.valid_key?(known)
    refute BuiltinBackgrounds.valid_key?("99-not-a-real-bg")
    refute BuiltinBackgrounds.valid_key?("../../etc/passwd")
    refute BuiltinBackgrounds.valid_key?(nil)
  end
end
