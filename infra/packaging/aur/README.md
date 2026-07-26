# Grappa Arch/AUR packaging (self-hosting Part 2, #419 R2)

The **Arch renderer** for grappa, built on the format-agnostic packaging
substrate in [`..`](../README.md) (FHS layout, systemd unit, openssl secret
bootstrap, the `grappa` operator wrapper with the #419 packaged migrate).

Unlike the `.deb` (a **binary** package built once from a glibc ERTS via
[nfpm](../nfpm.yaml)), this is a **source** package: `makepkg` builds the
`mix release` + cicchetto SPA **on the target host**, so the bundled ERTS and
crypto NIFs link against the user's own Arch libraries. That is the AUR
convention (rebuild-on-upgrade) and it sidesteps the cross-distro ERTS
problem that deferred the `.rpm` — there is no "built on the wrong distro"
payload, because the user's own Arch toolchain does the build.

## Files

| File               | Role                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `PKGBUILD`         | the recipe (source build → FHS staging)                               |
| `.SRCINFO`         | machine-readable metadata; **regenerated** from `PKGBUILD` (see below) |
| `grappa.install`   | pacman scriptlet: user/dirs, secrets, migrate, systemd enable         |
| `grappa.sysusers`  | `sysusers.d` — the `grappa` system user (declarative)                 |
| `grappa.tmpfiles`  | `tmpfiles.d` — `/var/lib/grappa` state dirs (declarative)             |

The recipe reuses the **verbs, not the nouns**: the shared substrate provides
the FHS layout, the systemd unit, `gen-secrets.sh`, and the `grappa` wrapper
(installed straight from the source tarball's `infra/packaging/`); Arch's
**native** mechanisms replace the .deb's imperative maintainer scripts —
`sysusers.d`/`tmpfiles.d` for the user + state dirs, and `grappa.install`
for the genuinely-imperative first-install steps (env-file bootstrap, secret
generation, the packaged migrate, `systemctl enable`).

## `arch=(x86_64)` only

`bun` — the cicchetto build toolchain — is in the official `extra` repo for
**x86_64 only**, not for Arch Linux ARM (a separate project with its own
repos). Mainline Arch is x86_64 anyway, so x86_64 is both the canonical AUR
target and the only arch with an official `bun`. An ARM user can still build
by providing `bun` out-of-band (e.g. the upstream installer), but the recipe
does not claim `aarch64` it cannot satisfy from official repos.

## Building locally

`makepkg` needs `elixir` (pulls `erlang-core`) and `bun` on the host:

```sh
cd infra/packaging/aur
# builds the mix release + cicchetto, stages FHS, produces the package:
makepkg -f
# → grappa-<version>-<rel>-x86_64.pkg.tar.zst  (NOT installed, NOT published)
```

Install what you built (runs the scriptlet: user, secrets, migrate, enable):

```sh
sudo pacman -U grappa-*-x86_64.pkg.tar.zst
sudoedit /etc/grappa/grappa.env      # set PHX_HOST=your.host
sudo systemctl start grappa
curl http://127.0.0.1:4000/healthz
```

Everything after install — first user, `grappa migrate`, secret rotation,
backup of `GRAPPA_ENCRYPTION_KEY` — is documented in
[`../README.md`](../README.md); the `.deb` and the Arch package share the
same FHS paths, wrapper, and operator model.

## Publishing to the AUR — a **human** step

**This tree builds recipes; it never publishes them.** No AUR credentials
live here, and nothing here pushes to `aur.archlinux.org`. To publish a
release, a maintainer:

1. Cuts the `vX.Y.Z` git tag this `PKGBUILD` pulls (`pkgver` must match
   `@version` in `mix.exs`).
2. Regenerates the checksums + metadata against the now-existing tag tarball:

   ```sh
   cd infra/packaging/aur
   updpkgsums                       # replaces sha256sums=('SKIP') with the real hash
   makepkg --printsrcinfo > .SRCINFO
   ```

3. Copies **`PKGBUILD`, `.SRCINFO`, `grappa.install`** into the AUR git repo
   and pushes there. (`grappa.sysusers` / `grappa.tmpfiles` are **not**
   copied — they ship inside the source tarball and are installed from it by
   `package()`, keeping this repo their single source of truth.)

`sha256sums=('SKIP')` is committed here on purpose: the `vX.Y.Z` tarball does
not exist until the tag is cut, so the real hash cannot be known yet.
`updpkgsums` fills it at release. `.SRCINFO` is committed so the recipe is
reviewable in-tree; it is **derived** — regenerate it whenever `PKGBUILD`
changes, never hand-edit.

## Version reporting caveat (`-dev` suffix)

`Grappa.Version` derives its `CTCP VERSION` string from **build-time git
state** (#391): a clean checkout on the exact `vX.Y.Z` tag reports the bare
`X.Y.Z`; anything else reports `X.Y.Z-<sha>` or `X.Y.Z-dev`. A GitHub tag
**tarball has no `.git`**, so an AUR source build degrades to the documented
`X.Y.Z-dev` — the package is the released code, but it self-reports `-dev`.
This is `Grappa.Version`'s intended graceful degradation, not a packaging
bug; making an AUR build report the bare version would require a
`Grappa.Version` env-override seam, deliberately **not** bolted on here.

## What is proven, and what R3 CI must still exercise

Honest status (the recipe is real; not every layer was built locally):

**Proven locally — the load-bearing constraint.** The #419 risk is the
migrate model on the Arch **toolchain versions**: grappa dev-pins Elixir 1.19
/ OTP 28, but Arch ships **Elixir 1.20.2 / OTP 29.0.1**. That delta is
distro-independent (Elixir-compiler + OTP release-boot behavior on a glibc
bundled ERTS), and it was proven on the official `elixir:1.20.2-otp-29` image
(native, Debian/glibc, the exact Arch versions): `mix release` compiles clean,
`bin/grappa eval 'Grappa.Release.migrate()'` applies **72 migrations** on the
bundled OTP-29 ERTS, `gen-secrets.sh` (openssl) fills every secret, and the
release boots to a green `/healthz`. R1 proved the same model on the OTHER end
(Elixir 1.19 / OTP 28, the `.deb`), so the migrate path is now bracketed
across both toolchains. Note: `mix release` must run **without**
`--warnings-as-errors` on Arch — Elixir 1.20 emits `xref:`-deprecation
warnings from deps (mint/finch) that a strict build would false-fail; the
`PKGBUILD` deliberately omits it.

**Statically validated.** `PKGBUILD` passes `namcap` and `makepkg
--printsrcinfo` (the committed `.SRCINFO` is its output); `grappa.install`
passes `shellcheck`.

**NOT built locally — deferred to R3 CI (be honest about it).** A full
`makepkg` → `pacman -U` on real Arch was **not** run on this dev host: Arch is
x86_64-only and this arm64 host cannot emulate it (qemu-user cannot run the
OTP-29 ERTS — the `prim_tty` NIF is undefined, crashing even `mix`), while
native Arch Linux ARM's mirrors were too slow to pull the toolchain
(`erlang-core` stalled at <1 B/s). So the `makepkg` assembly and the
`pacman`-invoked `grappa.install` scriptlet are exercised end-to-end only by
**R3 CI on a real x86_64 Arch runner** — treat that as the gate, not this
local run. The scriptlet's core operations ARE covered, but by two proofs kept
distinct: the gate above ran `Grappa.Release.migrate()` via `bin/grappa eval`
+ `gen-secrets.sh` **directly** on the OTP-29 ERTS (the version delta), while
the `/usr/bin/grappa` wrapper's `runuser`-drop against a root-owned,
read-only release tree is the exact mechanism R1's `.deb` proved (on OTP 28).
Only the pacman transaction wrapper (sysusers/tmpfiles hooks, file extraction)
is genuinely CI-only.

## Deferred (tracked follow-ups)

- **Tag-driven release CI (R3)** — cuts the tag, runs `updpkgsums` +
  `makepkg --printsrcinfo`, and exercises the full `makepkg` → `pacman -U`
  path on real x86_64 Arch. Publishing (the AUR push, the GitHub Release)
  stays a human decision.
- **`.rpm` (R3)** — nfpm renders it from the same substrate, but the bundled
  ERTS is glibc/libssl-specific, so a valid `.rpm` needs a Fedora-built
  release: a per-distro build matrix, not a one-line nfpm flip.
- **`grappa create-user` subcommand** — see [`../README.md`](../README.md)
  "First user"; needs a release-callable entry point.
