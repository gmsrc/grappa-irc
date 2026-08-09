#!/usr/bin/env bash
# Register a grappa A record via Technitium DNS API.
#
# Operator helper — not part of the dev or deploy flow. Needs a Technitium
# server with API access and an env file holding TECHNITIUM_TOKEN.
#
# Idempotent: no API call when the record already resolves to the desired
# IP; on drift or absence, delete-then-add, then assert the authoritative
# answer as a post-condition.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
#
# Required env vars (no defaults — script refuses to run without):
#   GRAPPA_DOMAIN         FQDN to register, e.g. grappa.example.com
#   GRAPPA_ZONE           authoritative zone, e.g. example.com
#   GRAPPA_IP             A-record target IP
#
# Optional env vars (with defaults):
#   GRAPPA_TTL            default 300
#   TECHNITIUM_BASE_URL   default https://ns1.bad.ass/api
#   DNS_NS                default ns1.bad.ass     (post-condition dig)
#   TECHNITIUM_ENV_FILE   default /srv/dns/.env   (sourced for TECHNITIUM_TOKEN)

set -euo pipefail

ENV_FILE="${TECHNITIUM_ENV_FILE:-/srv/dns/.env}"
DOMAIN="${GRAPPA_DOMAIN:?GRAPPA_DOMAIN missing — e.g. export GRAPPA_DOMAIN=grappa.example.com}"
ZONE="${GRAPPA_ZONE:?GRAPPA_ZONE missing — e.g. export GRAPPA_ZONE=example.com}"
IP="${GRAPPA_IP:?GRAPPA_IP missing — e.g. export GRAPPA_IP=192.168.1.10}"
TTL="${GRAPPA_TTL:-300}"
TECHNITIUM_BASE_URL="${TECHNITIUM_BASE_URL:-https://ns1.bad.ass/api}"
DNS_NS="${DNS_NS:-ns1.bad.ass}"

if [ ! -r "$ENV_FILE" ]; then
    echo "register-dns.sh: env file '$ENV_FILE' not readable" >&2
    exit 1
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

if [ -z "${TECHNITIUM_TOKEN:-}" ]; then
    echo "register-dns.sh: TECHNITIUM_TOKEN missing from '$ENV_FILE'" >&2
    exit 1
fi

# POST to a Technitium endpoint (query-string params, self-signed cert) and
# print ONLY `status` + `errorMessage`, tab-separated — never the full body:
# the API token rides every request.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
api_call() {
    local endpoint="$1"
    shift
    local response status errmsg
    response="$(curl -sk -X POST \
        --data-urlencode "token=$TECHNITIUM_TOKEN" \
        "$@" \
        "$TECHNITIUM_BASE_URL/$endpoint")"
    status="$(printf '%s' "$response" | sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
    errmsg="$(printf '%s' "$response" | sed -nE 's/.*"errorMessage"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
    printf '%s\t%s\n' "$status" "$errmsg"
}

# Authoritative pre-check; +tries=1/+timeout=5 fails fast on a dead
# nameserver. `|| true` absorbs dig's non-zero exit on no-answer.
current="$(dig @"$DNS_NS" "$DOMAIN" A +short +timeout=5 +tries=1 2>/dev/null || true)"
if [ "$current" = "$IP" ]; then
    echo "✓ DNS record already correct: $DOMAIN A $IP (no API call needed)"
    exit 0
fi

# Drift OR absence — both end with "delete then add". Delete failure on a
# non-existent record is expected and not fatal.
echo "  current: '$DOMAIN' → '${current:-<none>}', desired: '$IP' — re-registering"

del_result="$(api_call zones/records/delete \
    --data-urlencode "domain=$DOMAIN" \
    --data-urlencode "zone=$ZONE" \
    --data-urlencode "type=A")"
del_status="$(printf '%s' "$del_result" | cut -f1)"
del_err="$(printf '%s' "$del_result" | cut -f2)"
case "$del_status" in
    ok)
        echo "  • deleted prior $DOMAIN A record"
        ;;
    error)
        # Idempotent: prior absence is fine, the add below will create.
        echo "  • no prior $DOMAIN A record to delete (api: ${del_err:-<no message>})"
        ;;
    *)
        echo "register-dns.sh: unexpected delete-status: '${del_status:-<empty>}' err='${del_err:-<none>}'" >&2
        exit 1
        ;;
esac

add_result="$(api_call zones/records/add \
    --data-urlencode "domain=$DOMAIN" \
    --data-urlencode "zone=$ZONE" \
    --data-urlencode "type=A" \
    --data-urlencode "ipAddress=$IP" \
    --data-urlencode "ttl=$TTL")"
add_status="$(printf '%s' "$add_result" | cut -f1)"
add_err="$(printf '%s' "$add_result" | cut -f2)"
if [ "$add_status" != "ok" ]; then
    echo "register-dns.sh: API add failed: status='${add_status:-<empty>}' err='${add_err:-<none>}'" >&2
    exit 1
fi
echo "✓ DNS record set: $DOMAIN A $IP (TTL $TTL)"

# Post-condition. The `sleep` settles Technitium's in-zone cache, which
# lags the add slightly.
sleep 1
final="$(dig @"$DNS_NS" "$DOMAIN" A +short +timeout=5 +tries=1 2>/dev/null || true)"
if [ "$final" != "$IP" ]; then
    echo "register-dns.sh: post-condition failed — '$DOMAIN A' resolves to '${final:-<none>}', expected '$IP'" >&2
    exit 1
fi
echo "✓ Verified: $DOMAIN → $IP via @$DNS_NS"
