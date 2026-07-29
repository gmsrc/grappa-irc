defmodule Grappa.VersionSingleSourceTest do
  @moduledoc """
  #538 — the version is DECLARED ONCE and everything else DERIVES from it.

  `@version` in `mix.exs` is the single canonical declaration. Every other
  carrier is a DERIVATION, not a hand-edited copy:

    * the `.deb`/nfpm version — `infra/packaging/build.sh` exports
      `GRAPPA_VERSION` from `infra/packaging/version.sh` (which greps
      `@version`), and `nfpm.yaml` interpolates `${GRAPPA_VERSION}`;
    * the Arch `pkgver` — `infra/packaging/aur/regen.sh` derives it from the
      same `version.sh` at release time, filling the committed
      `@GRAPPA_VERSION@` sentinel (a value `makepkg` REFUSES, so an
      underived build fails loudly instead of shipping `grappa-@…@`);
    * the cicchetto `<meta cicchetto-version>` — `vite.config.ts` reads
      the `GRAPPA_VERSION` env (cic builds mount only `./cicchetto`, so
      they cannot read `mix.exs`; the build wrappers export it from
      `version.sh`), throwing if it is unset.

  This is the drift-catcher the issue asks for, **runnable on a bump commit,
  not only at tag time**: it fails the moment any carrier stops deriving —
  i.e. someone re-hardcodes a competing version literal. It does NOT assert
  the carriers all EQUAL the version (that would be the rejected "bump N
  files, CI yells" shape); it asserts they stay in their SENTINEL/DERIVED
  form, so there is exactly one number to bump: `mix.exs`.

  The tag ↔ `mix.exs` guard (the human declaration must match the tag being
  cut) lives in `.github/workflows/release.yml`; it needs a tag, so it is a
  release-time check. This test is its bump-commit-runnable complement.
  """
  use ExUnit.Case, async: true

  # The single canonical declaration, read the same way `version.sh` and the
  # release workflow read it — a build↔source cross-check, not a runtime read.
  @canonical_version "mix.exs"
                     |> File.read!()
                     |> then(&Regex.run(~r/@version\s+"([^"]+)"/, &1))
                     |> List.last()

  describe "the single canonical declaration (mix.exs @version)" do
    test "is a well-formed semver" do
      assert @canonical_version =~ ~r/^\d+\.\d+\.\d+/
    end

    test "is what OTP compiled into the .app resource (origin wired to runtime)" do
      # Application.spec/2 returns the vsn OTP baked into the .app from
      # @version at build. If they disagree the running node would report a
      # version the source never declared — the #533-adjacent honesty half.
      assert to_string(Application.spec(:grappa, :vsn)) == @canonical_version
    end

    test "version.sh (the shared derivation primitive) echoes it" do
      # build.sh + release.yml both derive the version through this script.
      # Invoke via `sh` (not `bash`): version.sh is POSIX #!/bin/sh, and the
      # dev/test container is the alpine/musl image, which ships busybox
      # /bin/sh but no bash — the same reason version.sh avoids bash-isms so
      # the FreeBSD jail can run it. Explicit interpreter so a stripped +x bit
      # can't mask a broken grep.
      #
      # env: only PATH (so the script's grep/sed/head resolve) — sensitive
      # vars (SECRET_KEY_BASE, CLOAK_KEY, …) are NOT inherited by the
      # subprocess, mirroring Grappa.Version's git call (Credo UnsafeExec).
      {out, 0} =
        System.cmd("sh", ["infra/packaging/version.sh"],
          env: [{"PATH", System.get_env("PATH") || "/usr/bin:/bin"}],
          stderr_to_stdout: true
        )

      assert String.trim(out) == @canonical_version
    end
  end

  describe "every other carrier stays a DERIVATION, never a hand-edited copy" do
    test "nfpm.yaml interpolates ${GRAPPA_VERSION} (fed by build.sh)" do
      version_line = carrier_value("infra/packaging/nfpm.yaml", ~r/^version:\s*(\S+)\s*$/m)
      assert version_line == "${GRAPPA_VERSION}"
    end

    test "PKGBUILD pkgver is the @GRAPPA_VERSION@ sentinel (makepkg refuses it → loud)" do
      pkgver = carrier_value("infra/packaging/aur/PKGBUILD", ~r/^pkgver=(.+)$/m)
      assert pkgver == "@GRAPPA_VERSION@"
    end

    test ".SRCINFO pkgver is the @GRAPPA_VERSION@ sentinel (regenerated with PKGBUILD)" do
      pkgver = carrier_value("infra/packaging/aur/.SRCINFO", ~r/pkgver\s*=\s*(\S+)/)
      assert pkgver == "@GRAPPA_VERSION@"
    end

    # The cicchetto carrier — package.json's version neutralised to 0.0.0 (vite
    # bakes GRAPPA_VERSION into <meta cicchetto-version> instead) — is guarded
    # on the CIC side, cicchetto/src/__tests__/versionSource.test.ts. It lives
    # there because the worktree overlay mounts cicchetto/src (not
    # cicchetto/package.json) into the Elixir test container, so reading it here
    # would assert against main's copy, not the change under test.
  end

  # Extract the first capture group of `re` from the file at `path`, failing
  # with a clear message when the carrier line is missing entirely.
  defp carrier_value(path, re) do
    contents = File.read!(path)

    case Regex.run(re, contents) do
      [_, value] -> value
      nil -> flunk("no line matching #{inspect(re)} in #{path}")
    end
  end
end
