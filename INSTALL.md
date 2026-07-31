# Installing grappa with Docker

A self-hosted install on a single host: one Docker container running the
IRC bouncer, which also serves the `cicchetto` PWA and owns its own
security headers — reachable at `http://localhost:3000`. (A one-shot
build container compiles the PWA bundle and then exits; the long-lived
container is just grappa.)

This is the plain, no-frills path. It does not touch the operator deploy
machinery (`scripts/deploy.sh`, `deploy-m42.sh`, per-host compose
overrides) — those target a specific production host and are not needed
to run grappa yourself.

> **Upgrading an existing two-container box?** Older installs ran a
> separate nginx front door alongside grappa. #485 removed it — the BEAM
> now serves the SPA and emits the CSP itself. Jump to
> [Upgrading from the two-container topology](#upgrading-from-the-two-container-topology).

## Prerequisites

- **Docker Engine** with the **Compose v2** plugin (`docker compose
  version` works).
- **git**, and a clone of this repository.
- ~2 GB free disk and RAM for the build.
- A free TCP port **3000** on localhost (change it with `HTTP_BIND`, see
  below).

No Elixir, Node, or Bun on the host — the container is the only runtime.

## Quick start

```sh
git clone https://github.com/vjt/grappa-irc
cd grappa-irc
infra/docker/deploy.sh install
```

> The old `scripts/quickstart.sh` / `-update.sh` / `-stop.sh` still work —
> they are thin shims that forward to `infra/docker/deploy.sh
> install`/`update`/`stop` for one release. New commands are shown below.

That one command does everything and exits only once the stack answers
`/healthz`. First run takes a while (it downloads the base image and
compiles); later runs are fast. When it finishes:

```
Web UI:  http://127.0.0.1:3000/
```

To serve on a different address/port, set `HTTP_BIND` before running:

```sh
HTTP_BIND=0.0.0.0:8080 infra/docker/deploy.sh install   # all interfaces, port 8080
```

### Prefer a pre-built image over compiling?

The clone-and-build above is the **from-source** path (the dev/CI toolchain
image compiles the tree). If you would rather **pull** than build, every
`vX.Y.Z` release publishes a self-contained, multi-arch image
(`linux/amd64` + `linux/arm64`) to:

```
ghcr.io/vjt/grappa:<tag>     # e.g. :v0.8.0, or :latest
```

It bundles the Erlang release + the cicchetto SPA and boots on its own — no
source, no build toolchain. It is a **release** image, so it has **no
`Phoenix.CodeReloader`**: it is a runtime, not the hot-edit dev environment.
The Docker Compose stack (this document's clone-and-build path) remains the
development runtime. See `docs/OPERATIONS.md` for how the image is built and
published; the `docker run` bring-up + `curl | bash` one-liners for it land with
the release-image install path (#503 unit D).

### What the script does

1. Checks Docker is installed and running.
2. Creates host-owned `runtime/` directories (sqlite DB, uploads, build
   output).
3. Writes a `.env`: sets `MIX_ENV=prod`, your host UID/GID,
   `PHX_HOST` (`localhost` unless you pass one), and the host port.
4. Builds the image and fetches Elixir deps into the checkout.
5. **Generates every secret** and writes them to `.env` —
   `SECRET_KEY_BASE`, `SECRET_SIGNING_SALT`, `GRAPPA_ENCRYPTION_KEY`, a
   VAPID keypair (Web Push), and `RELEASE_COOKIE`. Already-set values are
   never overwritten, so re-running is safe.
6. Runs database migrations.
7. Brings up the stack (`docker compose --profile prod up -d`): the
   one-shot `cicchetto-build` compiles the PWA bundle, then the single
   long-lived grappa container comes up and self-serves it.
8. Polls `/healthz` until the stack is green.

> **Back up `GRAPPA_ENCRYPTION_KEY`** (in `.env`) somewhere safe. It
> encrypts your stored IRC/NickServ passwords at rest — lose it and those
> credentials are unrecoverable.

## Validate it's up

```sh
curl http://127.0.0.1:3000/healthz      # -> 200 OK
docker compose -f compose.yaml --profile prod ps
```

Open `http://127.0.0.1:3000/` in a browser — you should get the cicchetto
login screen.

## Create your first user

A fresh install has no accounts and connects to no networks until you say
so.

```sh
docker compose -f compose.yaml run --rm grappa \
  mix grappa.create_user --name you --password 'change-me'
```

Then log in via the web UI. To connect the bouncer to an IRC network, see
**"Bind a network"** in [README.md](README.md).

## A throwaway box for testing (staging)

To look at a change under a real hostname before it ships, hand the script
the hostname and an account to seed. It comes up already connected, so the
first login lands on a live session instead of an empty box:

```sh
PHX_HOST=grappa.example.org \
SEED_USER=you SEED_AUTOJOIN='#grappa' \
  infra/docker/deploy.sh install
```

`SEED_USER` is the switch — without it nothing is seeded. The rest is
optional: `SEED_PASSWORD` (generated and printed when unset),
`SEED_NETWORK` (default `azzurra`), `SEED_SERVER`
(default `irc.azzurra.chat:6697`), `SEED_NICK` (default `$SEED_USER`),
`SEED_AUTH` (`auto|sasl|server_pass|nickserv_identify|none`, default
`none`), `SEED_NICK_PASSWORD` and `SEED_AUTOJOIN`. Re-running never
clobbers a live box: an existing account or binding is reported and left
alone.

`PHX_HOST` is load-bearing — it is where upload links and origin checks
come from. If you serve the box as `grappa.example.org` while `.env` still
says something else, links point at the wrong host and nothing errors out.
Pass it explicitly and it replaces whatever a previous run wrote.

The stack still listens on plain HTTP on `HTTP_BIND`; that is the listener
your own TLS front door proxies to. The script installs nothing on the
host — it renders `runtime/nginx-frontend.conf` from the shipped example
with your hostname, upstream and certificate paths filled in
(`FRONTEND_SSL_CERT` / `FRONTEND_SSL_KEY` override the defaults under
`/etc/ssl/grappa/`), and prints the path. Include it from your nginx.

> Serving a staging box over plain HTTP under a real name looks like it
> works and does not: off `localhost`, browsers refuse to register the
> service worker without TLS — and refuse it behind an untrusted
> certificate too. Push, offline and install then silently vanish, which
> is usually the part you meant to test. Use mkcert on a LAN, ACME in
> public.

## Managing the stack

All commands run from the repo root. The `-f compose.yaml` flag keeps it
to the committed config (no local overrides).

```sh
# Tail logs
docker compose -f compose.yaml --profile prod logs -f grappa

# Stop / start
infra/docker/deploy.sh stop                 # takes the prod profile down too
infra/docker/deploy.sh update               # brings it back up (idempotent)
```

Use the verb rather than a bare `docker compose down`: the
`cicchetto-build` one-shot lives behind the `prod` profile, so a down
without `--profile prod` can walk past profile-gated services and leave
the box half-stopped. `stop` also passes `--remove-orphans`, which
sweeps a stale `grappa-nginx` container left behind by a pre-#485
two-container box (removing the nginx service from `compose.yaml` does
not stop the container it once created). `stop` refuses to stop a box that
belongs to a different checkout, and takes `--volumes` when you want the
build caches gone as well. `runtime/` is a bind mount in the checkout, so
no flag can touch the database.

### Updating an installed box

```sh
infra/docker/deploy.sh update               # pull, then update
infra/docker/deploy.sh update --no-pull     # update from the working tree as-is
infra/docker/deploy.sh                       # bare: install if new, else update
```

`install` never touches git — re-running it can only re-install what is
already on disk. The operator `scripts/deploy.sh` is the production path
and its `require_main_checkout` guard refuses any checkout that is not the
main one on `main`, which rules out a staging box parked on a branch.
`update` covers the gap in between.

It refuses before it touches anything: a missing `.env` (the box was never
installed), no docker, not a git checkout, a foreign-checkout box, or —
when pulling — a dirty tree, all abort with the reason. The pull is
`--ff-only`, so a diverged branch stops the run rather than being merged by
a script. Nothing in the stack has moved at that point.

**`update` classifies hot-vs-cold** the same way the production substrates
do — via `Grappa.Deploy.Preflight`, which diffs the pull for changes that
cannot be hot-swapped (`mix.lock`/`mix.exs`, the supervision tree, migrations,
long-lived GenServer state shape):

- **HOT** → `POST /admin/reload` swaps the changed modules into the live
  BEAM. Sessions are preserved; nothing restarts. This is the common case
  — the tree is bind-mounted and the image is toolchain-only, so ordinary
  code changes compile at boot with no rebuild.
- **COLD** → the stack is rebuilt and recreated (image build, cic bundle,
  deps, migrations, `up --force-recreate`) when the diff is not hot-safe.

Two cases always go cold: **`--no-pull`** (the working-tree diff has an
empty commit range preflight cannot classify, and a recreate is never
wrong) and a **stopped stack** (you cannot hot-reload a box that is down —
this is the start-again-after-`stop` path). `--force-hot` / `--force-cold`
override the classifier. `/healthz` is polled until it answers, then the
URL is printed from `.env`.

## Upgrading from the two-container topology

Installs from before #485 ran **two** containers: grappa on loopback,
and a `grappa-nginx` front door that served the PWA, added the security
headers, and held the LAN-facing port. #485 collapsed that into one:

- **The BEAM now serves the SPA and owns every security header**
  (`GrappaWeb.Plugs.SecurityHeaders` — the CSP that guards the bearer
  token is emitted in-app, not by nginx). The nginx **container** is
  gone entirely.
- **grappa takes over the LAN binding** nginx used to hold. The old
  `.env` split the ports as `NGINX_PUBLISH=<host>:80` (LAN) +
  `GRAPPA_PUBLISH=127.0.0.1:4000` (grappa behind nginx); the new box
  has grappa alone on the published port.

`infra/docker/deploy.sh update` does the `.env` migration for you — but the
**very first** upgrade off a two-container box needs `git pull`
**before** you run it, for two reasons: the pre-change checkout has no
`infra/docker/deploy.sh` yet, and its old `compose.yaml` still references
the removed nginx service. So run the pull yourself once, then update the
just-pulled tree cold:

```sh
git pull --ff-only                          # get the #485/#503 scripts + compose first
infra/docker/deploy.sh update --no-pull     # force-cold: migrate .env, deps, migrate, cic, recreate
```

> **Why `--no-pull` here.** You already pulled by hand, so re-pulling would
> be a no-op with an empty commit range — which the hot-vs-cold classifier
> cannot read. `--no-pull` forces the **cold** path, and the cold path runs
> the full sequence unconditionally: image build, `deps.get`, the cic
> bundle, `ecto.migrate`, and `up --force-recreate`. A box that predates
> #485 has almost certainly crossed migration, dep, and bundle commits, and
> the cold path applies all of them — no hand-run steps, unlike the old
> update's diff-driven table. The critical one is `ecto.migrate`: crossing a
> schema-adding commit without it boots new code against the old schema, and
> the health poll times out. From then on run `infra/docker/deploy.sh update`
> normally (it pulls and classifies hot-vs-cold).

On that run the script:

1. **Rewrites your `.env` in place** — drops the deprecated
   `NGINX_PUBLISH`, and (unless you'd set a non-default `GRAPPA_PUBLISH`)
   moves nginx's old host binding onto `GRAPPA_PUBLISH` by stripping the
   `:80` container side, so the box comes back on the **same URL and
   port** with no hand edits. It prints a one-line warning telling you
   what it changed.
2. **Sweeps the stale `grappa-nginx` container** with
   `--remove-orphans` — removing the service from `compose.yaml` does
   **not** stop the container it created, and a leftover `grappa-nginx`
   would keep the host port bound and block the new single-container box
   from binding it.

**The one thing to check yourself:** if you front grappa with your own
TLS reverse proxy (Caddy, nginx, a cloud LB), point it at grappa's
published port now — **not** at the deleted nginx's port — and make sure
it forwards grappa's headers untouched. It must **not** add a
`Content-Security-Policy` of its own: duplicate CSP headers are enforced
by the browser as their *intersection*, which silently tightens the
policy and breaks the app. Verify exactly one of each header:

```sh
curl -sI https://your.host/ | grep -iE 'content-security-policy|x-frame-options'
```

## Exposing it beyond localhost (TLS)

The default install binds to `127.0.0.1`, which is the safe, fully-working
mode: `http://localhost` is a secure context, so the PWA (service worker,
push, install-to-homescreen) works without TLS.

To reach grappa from other devices you need **HTTPS** — browsers refuse to
register a service worker over plain HTTP off-localhost (and over an
untrusted cert), so the PWA breaks without it. Put a TLS reverse proxy in
front; the Docker stack stays HTTP-only behind it. In `.env`, set
`PHX_HOST` so Phoenix accepts the `wss://` origin and mints correct links,
then restart:

```sh
# .env
PHX_HOST=grappa.example.org
# docker compose -f compose.yaml --profile prod up -d
```

### Option A — Caddy (simplest; public domain)

[Caddy](https://caddyserver.com) provisions and auto-renews a Let's Encrypt
certificate for you. With a domain pointed at the host and ports 80+443
reachable from the internet, the whole config is:

```caddyfile
grappa.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

`reverse_proxy` forwards the WebSocket upgrade and sets
`X-Forwarded-Proto`/`-For` automatically. Run `caddy run` (or the service)
— no cert files, no renewal cron, nothing else.

### Option B — nginx (reference config)

If you already run nginx, use
[`infra/nginx-tls-frontend.example.conf`](infra/nginx-tls-frontend.example.conf):
a self-contained TLS vhost (modern ciphers, HSTS, the `/socket` WebSocket
block, `/sw.js` no-cache) adapted from the production front. Replace the
`<placeholders>`, point `ssl_certificate*` at your cert, reload.

### LAN only (no public domain)

ACME can't issue a public cert for a private address, so use a
locally-trusted CA — then the service worker still registers:
[`mkcert`](https://github.com/FiloSottile/mkcert) (`mkcert -install` once,
then `mkcert grappa.lan`) feeding the nginx reference, or Caddy's `tls
internal`. A plain self-signed cert will **not** do — the browser rejects
the service worker.

## Manual install (without the script)

The script just automates these steps. To do it by hand:

```sh
cp .env.example .env
# Edit .env: set MIX_ENV=prod, CONTAINER_UID/GID to your host id -u/-g,
# PHX_HOST=localhost, and fill the secret block. Generate values with:
docker compose -f compose.yaml run --rm -e MIX_ENV=dev grappa mix phx.gen.secret        # SECRET_KEY_BASE
docker compose -f compose.yaml run --rm -e MIX_ENV=dev grappa mix phx.gen.secret 64     # SECRET_SIGNING_SALT
docker compose -f compose.yaml run --rm -e MIX_ENV=dev grappa mix grappa.gen_encryption_key
docker compose -f compose.yaml run --rm -e MIX_ENV=dev grappa mix grappa.gen_vapid       # VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
openssl rand -hex 32                                                                      # RELEASE_COOKIE

mkdir -p runtime/cicchetto-dist runtime/bun-cache runtime/uploads
docker compose -f compose.yaml build grappa
docker compose -f compose.yaml run --rm grappa mix ecto.migrate
docker compose -f compose.yaml --profile prod up -d
```

Secrets are generated with `-e MIX_ENV=dev` on purpose: a prod-env task
would read `config/runtime.exs`, which refuses to start until those very
secrets exist.

## Troubleshooting

- **First boot is slow / health check waits minutes.** Expected: the
  container compiles the app on first prod boot. Watch progress with
  `docker compose -f compose.yaml --profile prod logs -f grappa`.
- **Port 3000 already in use.** Re-run with a free port:
  `HTTP_BIND=127.0.0.1:3100 infra/docker/deploy.sh install`.
- **`cannot talk to the Docker daemon`.** Start Docker, or add yourself to
  the `docker` group (then re-login).
- **Health check timed out.** Inspect the last logs:
  `docker compose -f compose.yaml --profile prod logs --tail=200 grappa`.

## How it's wired

One long-lived `grappa` container runs the Elixir/OTP bouncer
(`mix phx.server`) against a sqlite database under `runtime/`. It serves
everything itself: the REST API, the WebSocket, the cicchetto PWA + its
static assets (via `Plug.Static`, `CIC_DIST_ROOT`), and the
Content-Security-Policy + sibling security headers
(`GrappaWeb.Plugs.SecurityHeaders`). The `prod` profile adds one
throwaway `cicchetto-build` container that compiles the PWA bundle into
`runtime/cicchetto-dist` and exits — there is no nginx in the box (#485
dropped it). State that must survive a rebuild — the database, uploads —
lives in `runtime/` on the host. See
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the operator runbook and
[CLAUDE.md](CLAUDE.md) for the architecture.
