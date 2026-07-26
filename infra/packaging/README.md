# Grappa distro packaging (self-hosting Part 2)

Builds a native Linux **`.deb`** for grappa from a `mix release` + the
built cicchetto SPA, via [nfpm](https://nfpm.goreleaser.com/). The
release bundles Erlang/OTP, so the target host needs **no Elixir/mix
toolchain** — install the package, set one hostname, start the service.

This is the packaging **substrate** (`build.sh`, the FHS layout, the
maintainer scripts, the openssl secret bootstrap, the migrate command) +
its first **renderer** (nfpm → `.deb`). The substrate is format-agnostic;
Arch/AUR and the tag-driven release CI (and the `.rpm`, which needs a
per-distro ERTS build) are tracked follow-ups — see **Deferred** below.

## FHS layout

| Path                                   | What                                                        |
| -------------------------------------- | ---------------------------------------------------------- |
| `/usr/lib/grappa/`                     | the mix release (self-contained ERTS + compiled app)       |
| `/usr/lib/grappa/bin/grappa`           | the release boot script                                    |
| `/usr/bin/grappa`                      | operator CLI wrapper (sources env, drops to `grappa` user) |
| `/usr/share/grappa/cicchetto-dist/`    | built SPA (`CIC_DIST_ROOT`), served by the BEAM            |
| `/usr/share/grappa/grappa.env.example` | env template                                               |
| `/usr/share/grappa/gen-secrets.sh`     | openssl secret generator                                   |
| `/usr/lib/systemd/system/grappa.service` | systemd vendor unit                                      |
| `/etc/grappa/grappa.env`               | secrets + `PHX_HOST` (created on first install, `0640`)     |
| `/var/lib/grappa/`                     | state: `grappa.db`, `uploads/` (owned by `grappa`)         |

The `grappa` system user (nologin, home `/var/lib/grappa`) is created by
the package.

## Building the `.deb`

The build needs Elixir 1.19 / OTP 28 **on glibc** (not the alpine dev
image — musl ERTS will not run on a Debian/Ubuntu target) plus `bun`.

### Locally, in an isolated container

Runs in a throwaway container with its own `_build`, so it never touches
the dev compose stack's shared `_build`:

```sh
docker run --rm -v "$PWD:/src" -w /src elixir:1.19-otp-28 bash -c '
  apt-get update -q && apt-get install -y -q --no-install-recommends curl unzip &&
  curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH" &&
  infra/packaging/build.sh'
```

The `.deb` lands in `./dist/`.

### In CI (R3)

The tag-driven release workflow
([`.github/workflows/release.yml`](../../.github/workflows/release.yml))
runs `build.sh` on a `setup-beam` runner (Elixir 1.19 / OTP 28) with `bun`
installed, **installs** the built `.deb` (so postinstall's openssl secrets +
packaged migrate run for real), asserts the migration count and that the
artifact reports the bare `X.Y.Z`, then uploads `dist/*.deb` to the GitHub
Release. `build.sh` downloads a pinned nfpm if it is not on PATH.

## Installing

```sh
sudo apt install ./grappa_<version>_<arch>.deb
sudoedit /etc/grappa/grappa.env          # set PHX_HOST=your.host
sudo systemctl start grappa
curl http://127.0.0.1:4000/healthz
```

`postinstall` creates the state dirs, copies the env template, generates
the secrets (openssl), runs migrations, and **enables but does not start**
the service (it cannot start until you set a real `PHX_HOST`).

## First user

Once the service is running, attach to the live node and create it there
(the Repo is up on the running node):

```sh
sudo grappa remote
# in the IEx prompt:
Grappa.Accounts.create_user(%{name: "you", password: "change-me"})
```

> A dedicated `grappa create-user` subcommand is a planned follow-up; it
> needs a release-callable entry point (the existing `grappa.create_user`
> is a mix task, unavailable on a packaged host). Until then, use the
> `remote` path above. It shares the release remote-shell code path with
> `grappa migrate`, so it is covered by the same proof (see Caveat).

## Managing

```sh
sudo grappa migrate        # apply pending migrations (no mix needed)
sudo grappa gen-secrets    # (re)generate missing secrets in the env file
sudo grappa version        # release version
sudo grappa remote         # IEx into the running node
sudo systemctl status grappa
journalctl -u grappa -f
```

Rotate a secret: reset it to `REPLACE_ME` in `/etc/grappa/grappa.env`,
run `sudo grappa gen-secrets`, then `sudo systemctl restart grappa`. Back
up `GRAPPA_ENCRYPTION_KEY` separately — it encrypts stored IRC
credentials at rest; losing it makes them unrecoverable.

## Secrets model

A packaged host has no mix, so `gen-secrets.sh` generates everything with
**openssl only**, matching the mix generators' shapes byte-for-byte:

| Var                     | How                                                            |
| ----------------------- | ------------------------------------------------------------- |
| `SECRET_KEY_BASE`       | `openssl rand -base64 48`                                      |
| `SECRET_SIGNING_SALT`   | `openssl rand -base64 32`                                      |
| `RELEASE_COOKIE`        | `openssl rand -hex 32`                                         |
| `GRAPPA_ENCRYPTION_KEY` | `openssl rand -base64 32` (≡ `Base.encode64(rand_bytes(32))`)  |
| `VAPID_*`               | `openssl ecparam prime256v1` → base64url(65-byte point / 32-byte scalar) |

This keeps first-boot secret generation **off** the release `eval` path.

## Caveat — the migrate/eval proof

`grappa migrate` reaches `Ecto.Migrator` via
`bin/grappa eval 'Grappa.Release.migrate()'` — the same migrator the
FreeBSD/Docker deploys call. On the FreeBSD jail this works; but
`infra/linux/install.sh` documents that on a **native-Linux, asdf-built**
ERTS the release `eval`/`remote`/`rpc` boot variant crashes at kernel
start (a `persistent_term`/`code_server` badarg — even `eval '1 + 1'`),
and sidesteps it with `mix ecto.migrate`. A packaged host has no mix, so
`grappa migrate` **must** work through `eval` on the **packaged** ERTS.

R1's job is to prove exactly that on a package built by `build.sh`
(bundled ERTS, not asdf): install the `.deb` in a clean container, run
`sudo grappa migrate` against a fresh DB, confirm the service boots and
`/healthz` is green. If `eval` proves broken on the packaged ERTS too, the
fallback is a boot-time migrate flag — a separate design, **not** silently
bolted on here.

## Deferred (tracked follow-ups, not rejected)

- **`.rpm`** — nfpm renders it from the same config, but the bundled ERTS
  is glibc/libssl-specific, so a valid `.rpm` needs a Fedora-built
  release. That is an R3 per-distro build matrix, not a one-line flip.
- **Arch `PKGBUILD` + AUR recipe** — **shipped (R2)**, see
  [`aur/`](aur/README.md). A source package (`makepkg` builds on the target),
  which reuses this substrate's FHS paths + maintainer logic and sidesteps
  the cross-distro ERTS problem the `.rpm` still has.
- **Tag-driven release CI** (R3) — **shipped**
  ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)):
  builds + proves + uploads per tag; regenerates the AUR recipe
  (`updpkgsums` + `makepkg --printsrcinfo`) and runs the full `makepkg` →
  `pacman -U` on a real x86_64 Arch runner. Publishing (AUR push) stays a
  human decision.
- **`grappa create-user`** subcommand — see First user.
- **`priv/static` single-tarball** — declined for packaging: the
  `CIC_DIST_ROOT`-relocatable model (Part 1) ships the dist as a separate
  payload, which is exactly what packaging needs.
