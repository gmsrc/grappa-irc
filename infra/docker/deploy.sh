#!/usr/bin/env bash
# grappa — verb-dispatched standalone Docker deploy (#503 unit B).
#
# One entry point for the vanilla single-host Docker box, replacing the
# three quickstart scripts (now thin forwarders — see scripts/quickstart*.sh):
#
#   deploy.sh install   fresh clones-and-goes bring-up: generate secrets,
#                       write .env, build the toolchain image, migrate,
#                       optionally seed a user+network, start the prod
#                       profile, wait for /healthz, render a front-door
#                       config. Config via env vars (PHX_HOST, HTTP_BIND,
#                       SEED_*, FRONTEND_SSL_*) — see the block below.
#   deploy.sh update    pull, then let the SHARED deploy algorithm
#                       (infra/lib/deploy_common.sh, the same lib driving
#                       the jail + linux + operator-docker substrates)
#                       classify hot-vs-cold via Grappa.Deploy.Preflight:
#                       HOT → POST /admin/reload (sessions preserved), COLD
#                       → recreate. This is the #503 win — quickstart-update
#                       ALWAYS recreated, on a hand-maintained regex table.
#   deploy.sh stop      take the prod profile all the way down
#                       (--profile prod down --remove-orphans [--volumes]).
#   deploy.sh           (bare) idempotent "make it so": no .env on disk →
#                       install, otherwise update. The single command a
#                       curl|bash one-liner (unit D) can always run.
#
# This is the STANDALONE path — deliberately plain `docker compose -f
# compose.yaml`, NO scripts/_lib.sh, NO compose.override.yaml, NO per-host
# machinery. It is independent of the operator deploy tooling
# (scripts/deploy.sh, deploy-m42.sh) which targets a specific production
# host. Re-running any verb is safe.
#
# ---- Serving it under a real hostname (staging box) -------------------
#
# The grappa container listens on plain HTTP on HTTP_BIND — that IS the
# listener you put your own TLS front door in front of. `install` RENDERS
# a ready-to-include front-door config from the shipped example (it
# installs nothing on the host) and tells you where it wrote it.
#
#   PHX_HOST=grappa.example.org infra/docker/deploy.sh install
#
# PHX_HOST is load-bearing: it is the source of the host-alias set the app
# derives upload links and origin checks from (lib/grappa/http_hosts.ex).
# Leaving it at `localhost` while serving under a real name mints links
# pointing at the wrong host, silently (#468). Pass it explicitly and it
# overwrites a previously-written value in .env.
#
# ---- Seeding a network + user (optional) ------------------------------
#
# Set SEED_USER on `install` to get an instance already connected on first
# login instead of an empty one:
#
#   PHX_HOST=grappa.example.org SEED_USER=you SEED_AUTOJOIN='#grappa' \
#     infra/docker/deploy.sh install
#
# Knobs (all optional except SEED_USER):
#   SEED_USER      account name — setting it enables seeding
#   SEED_PASSWORD  account password (generated and printed when unset)
#   SEED_NETWORK   network slug            (default: azzurra)
#   SEED_SERVER    host:port               (default: irc.azzurra.chat:6697)
#   SEED_NICK      IRC nick                (default: $SEED_USER)
#   SEED_AUTH      auto|sasl|server_pass|nickserv_identify|none (default: none)
#   SEED_NICK_PASSWORD  upstream auth password, when SEED_AUTH needs one
#   SEED_AUTOJOIN  comma-separated channels (default: none)
#   SEED_ADMIN     1 (default) grants the seeded account the admin bit;
#                  0 for a box that deliberately starts with no admin.

set -euo pipefail

# ---- locate repo root (this script lives in infra/docker/) ------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Pin to the committed compose file only — no override auto-merge. Every
# compose invocation reuses this array.
COMPOSE=(docker compose -f compose.yaml)

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

usage() {
	cat >&2 <<EOF
usage: infra/docker/deploy.sh {install|update|stop} [options]
       infra/docker/deploy.sh                 (bare) install if no .env, else update

  install                fresh bring-up (config via env: PHX_HOST, HTTP_BIND, SEED_*)
  update [--no-pull] [--force-hot|--force-cold]
                         pull + preflight → hot-on-HOT / recreate-on-COLD
  stop [--volumes|-v]    take the prod profile down (--remove-orphans)
EOF
	exit 64
}

# ---- prerequisites ----------------------------------------------------
require_compose_file() {
	[ -f compose.yaml ] || die "compose.yaml not in $REPO_ROOT — run this from a grappa checkout."
}

require_docker() {
	command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Engine first."
	docker compose version >/dev/null 2>&1 || die "docker compose v2 not found — install the Compose plugin."
}

# ---- one-box-per-host ownership guard ---------------------------------
# compose.yaml pins `container_name`, so those names belong to the docker
# daemon and not to a compose project: a second checkout that operates its
# own box collides with the first — "The container name /grappa is already
# in use" — which names neither the owner nor the fix. Ask the running
# container who owns it (docker's own compose label) and refuse if the
# answer is not us, while nothing has happened yet. Sets BOX_RUNNING=1 if
# any pinned container exists (so `stop` can report a genuine no-op).
assert_box_ownership() {
	BOX_RUNNING=0
	# shellcheck disable=SC2013  # container_name values are single tokens; word-split is intended
	for cname in $(sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' compose.yaml); do
		if owner="$(docker inspect --format \
			'{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
			"$cname" 2>/dev/null)"; then
			BOX_RUNNING=1
			if [ -n "$owner" ] && [ "$owner" != "$REPO_ROOT" ]; then
				warn "container '$cname' is up, but it belongs to another checkout:"
				warn "  $owner"
				die "one box per host: operate that box from its own checkout, or stop it first ($owner/infra/docker/deploy.sh stop)."
			fi
		fi
	done
}

# ---- .env helpers -----------------------------------------------------
# set_env KEY VALUE — set KEY only if it is absent or blank in .env.
set_env() {
	local key="$1" val="$2"
	if grep -qE "^${key}=.+" .env 2>/dev/null; then
		return 0
	fi
	if grep -qE "^${key}=" .env 2>/dev/null; then
		grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
	fi
	printf '%s=%s\n' "$key" "$val" >> .env
}

# force_env KEY VALUE — set KEY unconditionally, replacing any existing
# value. Used only for what the caller passed on this run: a second run
# with a different PHX_HOST must actually move the box, not silently keep
# the first run's hostname (the #468 failure mode).
force_env() {
	local key="$1" val="$2"
	if grep -qE "^${key}=" .env 2>/dev/null; then
		grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
	fi
	printf '%s=%s\n' "$key" "$val" >> .env
}

# migrate_publish_env — a box created by a pre-#485 checkout carries
# NGINX_PUBLISH=<host>:80 (the LAN-facing nginx container) and
# GRAPPA_PUBLISH=127.0.0.1:4000 (grappa behind nginx). nginx is gone;
# grappa must take over that LAN binding. Rewrite .env in place, mapping
# the container side :80 → :4000 (compose re-appends :4000). Deprecated
# alias honoured once, with a one-line warning. Idempotent — a no-op once
# NGINX_PUBLISH is gone.
migrate_publish_env() {
	grep -qE '^NGINX_PUBLISH=' .env || return 0

	local old host_side cur
	old="$(sed -n 's/^NGINX_PUBLISH=//p' .env | tail -n1)"
	cur="$(sed -n 's/^GRAPPA_PUBLISH=//p' .env | tail -n1)"
	host_side="${old%:80}"
	[ -n "$host_side" ] || host_side="127.0.0.1:3000"

	grep -vE '^NGINX_PUBLISH=' .env > .env.tmp && mv .env.tmp .env

	if [ -z "$cur" ] || [ "$cur" = "127.0.0.1:4000" ]; then
		warn "NGINX_PUBLISH is deprecated (#485 dropped the nginx container). Rewriting .env: GRAPPA_PUBLISH=${host_side} (grappa serves directly now), removing NGINX_PUBLISH."
		grep -vE '^GRAPPA_PUBLISH=' .env > .env.tmp && mv .env.tmp .env
		printf 'GRAPPA_PUBLISH=%s\n' "$host_side" >> .env
	else
		warn "NGINX_PUBLISH is deprecated (#485) and was removed from .env. Your GRAPPA_PUBLISH=${cur} is kept — verify it publishes grappa where your TLS front door proxies."
	fi
}

# ======================================================================
# verb: install
# ======================================================================
cmd_install() {
	[ $# -eq 0 ] || usage

	# Host port the PWA is served on (grappa, directly — #485 dropped
	# nginx). A value passed on this run must win over what a previous run
	# (or .env.example) left behind, else the box quietly serves elsewhere.
	local HTTP_BIND_EXPLICIT=0
	[ -n "${HTTP_BIND+x}" ] && HTTP_BIND_EXPLICIT=1
	local HTTP_BIND="${HTTP_BIND:-127.0.0.1:3000}"

	local PHX_HOST_EXPLICIT=0
	[ -n "${PHX_HOST+x}" ] && PHX_HOST_EXPLICIT=1
	local PHX_HOST="${PHX_HOST:-localhost}"

	local FRONTEND_SSL_CERT="${FRONTEND_SSL_CERT:-/etc/ssl/grappa/fullchain.pem}"
	local FRONTEND_SSL_KEY="${FRONTEND_SSL_KEY:-/etc/ssl/grappa/privkey.pem}"

	local SEED_USER="${SEED_USER:-}"
	local SEED_NETWORK="${SEED_NETWORK:-azzurra}"
	local SEED_SERVER="${SEED_SERVER:-irc.azzurra.chat:6697}"
	local SEED_NICK="${SEED_NICK:-$SEED_USER}"
	local SEED_AUTH="${SEED_AUTH:-none}"
	local SEED_NICK_PASSWORD="${SEED_NICK_PASSWORD:-}"
	local SEED_AUTOJOIN="${SEED_AUTOJOIN:-}"
	# #475 — the seeded account is an admin by DEFAULT: the admin console
	# is the only place some install-level switches live (visitor access),
	# so a box seeded without it cannot be finished from the UI it hands
	# you. SEED_ADMIN=0 for a box that should start with no administrator.
	local SEED_ADMIN="${SEED_ADMIN:-1}"

	# ---- 0. preflight -------------------------------------------------
	say "Checking prerequisites"
	require_docker
	docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon — is it running / do you have permission?"
	require_compose_file
	assert_box_ownership

	# ---- 1. host-owned runtime dirs (avoid root-owned bind-mount mkdir)
	mkdir -p runtime/cicchetto-dist runtime/bun-cache runtime/uploads

	# ---- 2. .env scaffolding ------------------------------------------
	local ENV_CREATED_NOW=0
	if [ ! -f .env ]; then
		say "Creating .env from .env.example"
		cp .env.example .env
		ENV_CREATED_NOW=1
	fi

	say "Configuring .env for a full-stack run under ${PHX_HOST}"
	set_env MIX_ENV prod
	set_env CONTAINER_UID "$(id -u)"
	set_env CONTAINER_GID "$(id -g)"
	if [ "$PHX_HOST_EXPLICIT" -eq 1 ] || [ "$ENV_CREATED_NOW" -eq 1 ]; then
		# A .env just copied from the example carries the example's
		# hostname, which is someone else's host — inheriting it is the
		# copy-trap that mints upload links pointing away from this box
		# (#468). Whatever this run resolved to wins over it.
		force_env PHX_HOST "$PHX_HOST"
	else
		set_env PHX_HOST "$PHX_HOST"
		PHX_HOST="$(sed -n 's/^PHX_HOST=//p' .env | tail -n1)"
		PHX_HOST="${PHX_HOST:-localhost}"
	fi
	# #485 — grappa is the LAN-facing service now (no nginx in front), so
	# it publishes on HTTP_BIND. compose.yaml appends :4000, so
	# GRAPPA_PUBLISH carries only the host side (addr:port, or a bare port).
	if [ "$HTTP_BIND_EXPLICIT" -eq 1 ] || [ "$ENV_CREATED_NOW" -eq 1 ]; then
		force_env GRAPPA_PUBLISH "${HTTP_BIND}"
	else
		set_env GRAPPA_PUBLISH "${HTTP_BIND}"
		local published
		published="$(sed -n 's/^GRAPPA_PUBLISH=//p' .env | tail -n1)"
		case "$published" in
			'')      ;;
			*:*)     HTTP_BIND="$published" ;;
			*)       HTTP_BIND="127.0.0.1:${published}" ;;
		esac
	fi

	# #485 — a pre-change box carries NGINX_PUBLISH. `install` does NOT
	# migrate it (only `update` does): re-installing here would leave
	# grappa on the loopback default and silently orphan the old LAN URL.
	# Warn and point at the upgrade path rather than half-migrate.
	if grep -qE '^NGINX_PUBLISH=' .env; then
		warn "This box predates #485 (NGINX_PUBLISH is set — the nginx container was dropped)."
		warn "install does NOT migrate the port binding; run 'infra/docker/deploy.sh update'"
		warn "instead — it rewrites NGINX_PUBLISH → GRAPPA_PUBLISH and sweeps the stale grappa-nginx."
	fi

	# ---- 3. build the image -------------------------------------------
	say "Building the grappa toolchain image (first run downloads the base — be patient)"
	"${COMPOSE[@]}" build grappa

	# ---- 4. bootstrap toolchain + deps against the bind-mount ---------
	say "Installing hex/rebar + fetching deps into the checkout"
	# shellcheck disable=SC1010  # `mix do` is a mix subcommand, not shell `do`
	"${COMPOSE[@]}" run --rm --no-deps -T -e MIX_ENV=dev grappa \
		mix do local.hex --force, local.rebar --force, deps.get, compile

	# ---- 5. generate secrets (only the blank ones) --------------------
	gen() { "${COMPOSE[@]}" run --rm --no-deps -T -e MIX_ENV=dev grappa "$@" 2>/dev/null | tr -d '\r'; }
	needs_secret() { ! grep -qE "^$1=.+" .env; }

	if needs_secret SECRET_KEY_BASE; then
		say "Generating SECRET_KEY_BASE"
		set_env SECRET_KEY_BASE "$(gen mix phx.gen.secret | tail -n1)"
	fi
	if needs_secret SECRET_SIGNING_SALT; then
		say "Generating SECRET_SIGNING_SALT"
		set_env SECRET_SIGNING_SALT "$(gen mix phx.gen.secret 64 | tail -n1)"
	fi
	if needs_secret GRAPPA_ENCRYPTION_KEY; then
		say "Generating GRAPPA_ENCRYPTION_KEY (back this up — losing it loses stored creds)"
		set_env GRAPPA_ENCRYPTION_KEY "$(gen mix grappa.gen_encryption_key | tail -n1)"
	fi
	if needs_secret VAPID_PUBLIC_KEY || needs_secret VAPID_PRIVATE_KEY; then
		say "Generating VAPID keypair (Web Push)"
		local vapid
		vapid="$(gen mix grappa.gen_vapid)"
		set_env VAPID_PUBLIC_KEY  "$(printf '%s\n' "$vapid" | sed -n 's/^VAPID_PUBLIC_KEY=//p')"
		set_env VAPID_PRIVATE_KEY "$(printf '%s\n' "$vapid" | sed -n 's/^VAPID_PRIVATE_KEY=//p')"
	fi
	if needs_secret RELEASE_COOKIE; then
		say "Generating RELEASE_COOKIE (Erlang distribution cookie)"
		set_env RELEASE_COOKIE "$(gen elixir -e 'IO.puts(Base.encode16(:crypto.strong_rand_bytes(32), case: :lower))' | tail -n1)"
	fi

	# ---- 6. migrate the database --------------------------------------
	say "Running database migrations"
	"${COMPOSE[@]}" run --rm --no-deps grappa mix ecto.migrate

	# ---- 6b. seed an account + network (optional) ---------------------
	# Runs BEFORE the stack comes up: Bootstrap reads the binding at boot,
	# so the very first `up` already dials out. Neither task is destructive
	# on a second run (duplicate name / existing credential both fail), so
	# both failures downgrade to a note instead of aborting a healthy box.
	local SEED_ACCOUNT_EXISTED=0
	if [ -n "$SEED_USER" ]; then
		local SEED_PASSWORD="${SEED_PASSWORD:-}"
		if [ -z "$SEED_PASSWORD" ]; then
			SEED_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-20)"
		fi

		# #475 — `--admin` is part of the same command: create_user grants
		# the bit right after creation, only on CREATION (an existing
		# account keeps its flags).
		local create_args=(mix grappa.create_user --name "$SEED_USER" --password "$SEED_PASSWORD")
		[ "$SEED_ADMIN" != "0" ] && create_args+=(--admin)

		if [ "$SEED_ADMIN" != "0" ]; then
			say "Seeding account '${SEED_USER}' (admin)"
		else
			say "Seeding account '${SEED_USER}'"
		fi

		if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa "${create_args[@]}"; then
			SEED_ACCOUNT_EXISTED=1
			warn "account '${SEED_USER}' was not created (it most likely already exists) — keeping the existing one."
			warn "the password printed below is then NOT the account's password, and its admin flag is unchanged."
		fi

		say "Binding ${SEED_USER} → ${SEED_NETWORK} (${SEED_SERVER}) as ${SEED_NICK}"
		local bind_args=(mix grappa.bind_network
			--user "$SEED_USER" --network "$SEED_NETWORK"
			--server "$SEED_SERVER" --nick "$SEED_NICK" --auth "$SEED_AUTH")
		[ -n "$SEED_NICK_PASSWORD" ] && bind_args+=(--password "$SEED_NICK_PASSWORD")
		[ -n "$SEED_AUTOJOIN" ] && bind_args+=(--autojoin "$SEED_AUTOJOIN")
		if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa "${bind_args[@]}"; then
			warn "binding not created — ${SEED_USER} is probably already bound to ${SEED_NETWORK}."
			warn "change an existing binding with: ${COMPOSE[*]} run --rm grappa mix grappa.update_network_credential --help"
		fi
	fi

	# ---- 6c. seed the built-in theme gallery --------------------------
	# #475 — OUTSIDE the SEED_USER block: the curated gallery is a property
	# of the install, so a box with no seeded user still ships its themes.
	# Idempotent (upsert on (system owner, name)); not fatal (an empty
	# gallery is cosmetic, not worth failing a healthy install over).
	say "Seeding the built-in theme gallery"
	if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa mix grappa.seed_themes; then
		warn "theme seeding failed — the box works, but the gallery starts empty."
		warn "retry with: ${COMPOSE[*]} run --rm grappa mix grappa.seed_themes"
	fi

	# ---- 7. bring up the stack ----------------------------------------
	say "Starting the stack (grappa + cicchetto build)"
	"${COMPOSE[@]}" --profile prod up -d --remove-orphans

	# ---- 8. wait for health -------------------------------------------
	say "Waiting for /healthz (first boot compiles prod — up to ~10 min)"
	local deadline=$((SECONDS + 600))
	until "${COMPOSE[@]}" exec -T grappa curl -fsS http://localhost:4000/healthz >/dev/null 2>&1; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			warn "stack did not become healthy in time. Inspect with:"
			warn "  ${COMPOSE[*]} --profile prod logs --tail=200 grappa"
			die "health check timed out"
		fi
		printf '.'; sleep 3
	done
	printf '\n'

	# ---- 8b. render the front-door config -----------------------------
	local FRONTEND_CONF="runtime/nginx-frontend.conf"
	local UPSTREAM="$HTTP_BIND"
	case "$UPSTREAM" in
		0.0.0.0:*) UPSTREAM="127.0.0.1:${UPSTREAM##*:}" ;;
		'[::]:'*)  UPSTREAM="127.0.0.1:${UPSTREAM##*:}" ;;
	esac

	sed -e "s|<your-domain>|${PHX_HOST}|g" \
	    -e "s|^  server 127\.0\.0\.1:3000;|  server ${UPSTREAM};|" \
	    -e "s|^  ssl_certificate     .*|  ssl_certificate     ${FRONTEND_SSL_CERT};|" \
	    -e "s|^  ssl_certificate_key .*|  ssl_certificate_key ${FRONTEND_SSL_KEY};|" \
	    infra/nginx-tls-frontend.example.conf > "$FRONTEND_CONF"

	# ---- 9. done ------------------------------------------------------
	say "grappa is up and healthy 🎉"
	cat <<EOF

  Web UI:   http://${HTTP_BIND}/
  Health:   curl http://${HTTP_BIND}/healthz
  PHX_HOST: ${PHX_HOST}

  Front-door config rendered for ${PHX_HOST} → ${UPSTREAM}:
    ${REPO_ROOT}/${FRONTEND_CONF}
  Include it from your own nginx (this script installs nothing on the
  host) and point the certificate lines at a certificate your browser
  trusts.
EOF

	if [ "$PHX_HOST" != "localhost" ]; then
		cat <<EOF
  Serving it over plain HTTP under that name will look like it works and
  will not: service workers refuse to register off-localhost without TLS,
  and an untrusted certificate is refused too — so push, offline and
  install silently disappear. Use a trusted cert (mkcert on a LAN, ACME
  in public).
EOF
	fi

	if [ -n "$SEED_USER" ]; then
		if [ "$SEED_ACCOUNT_EXISTED" -eq 1 ]; then
			cat <<EOF

  Account:         ${SEED_USER} — already exists, left untouched.
                   The password shown above does not apply to it, and its
                   admin flag was not changed. Rotate the password with:
                     ${COMPOSE[*]} run --rm grappa mix run -e \\
                       'Grappa.Accounts.get_user_by_name("${SEED_USER}") |> Grappa.Accounts.update_password(%{password: "new-one"})'
  Seeded network:  ${SEED_NETWORK} → ${SEED_SERVER} as ${SEED_NICK}${SEED_AUTOJOIN:+ (autojoin ${SEED_AUTOJOIN})}
EOF
		else
			cat <<EOF

  Seeded account:  ${SEED_USER} / ${SEED_PASSWORD}
  Account role:    $([ "$SEED_ADMIN" != "0" ] && printf 'admin — the console is at the cog, "admin console"' || printf 'plain user (SEED_ADMIN=0)')
  Seeded network:  ${SEED_NETWORK} → ${SEED_SERVER} as ${SEED_NICK}${SEED_AUTOJOIN:+ (autojoin ${SEED_AUTOJOIN})}
  Test-grade credentials — the account is a login for this box, nothing else.
EOF
		fi
	else
		cat <<EOF

  Create your first user (then log in via the web UI):
    ${COMPOSE[*]} run --rm grappa mix grappa.create_user --name you --password 'change-me'

  Bind an IRC network: see README.md "Bind a network".
EOF
	fi

	cat <<EOF

  Update the box:      infra/docker/deploy.sh update
  Stop the stack:      infra/docker/deploy.sh stop
EOF
}

# ======================================================================
# verb: stop
# ======================================================================
cmd_stop() {
	local DROP_VOLUMES=0
	case "${1:-}" in
		--volumes|-v) DROP_VOLUMES=1 ;;
		'')           ;;
		*) die "usage: infra/docker/deploy.sh stop [--volumes]" ;;
	esac

	# Deliberately NOT requiring .env: a box you cannot stop because its
	# config went missing is a trap, and the containers exist either way.
	require_compose_file
	require_docker
	assert_box_ownership

	if [ "$BOX_RUNNING" -eq 0 ]; then
		say "No grappa containers are up — collecting whatever is left"
	else
		say "Stopping the stack (prod profile: grappa + cicchetto-build)"
	fi

	# --remove-orphans: drop a stale grappa-nginx from a pre-#485 box
	# (removed from compose.yaml but not stopped by a plain down) so the
	# project network frees.
	local down=("${COMPOSE[@]}" --profile prod down --remove-orphans)
	[ "$DROP_VOLUMES" -eq 1 ] && down+=(--volumes)
	"${down[@]}"

	if [ "$BOX_RUNNING" -eq 0 ]; then
		say "nothing was running 🫥"
	else
		say "box is down 🛑"
	fi

	if [ "$DROP_VOLUMES" -eq 1 ]; then
		warn "named volumes dropped — the next start recompiles from scratch."
	fi

	cat <<EOF

  Start again:  infra/docker/deploy.sh update
  Data:         runtime/ is a bind mount in this checkout — untouched.
EOF
}

# ======================================================================
# dispatch
# ======================================================================
verb="${1:-}"
if [ $# -gt 0 ]; then shift; fi
case "$verb" in
	install) cmd_install "$@" ;;
	stop)    cmd_stop "$@" ;;
	*)       usage ;;
esac
