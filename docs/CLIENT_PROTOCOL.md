# grappa — client protocol

A guide for authors of **third-party clients**. grappa is a REST + Phoenix
Channels bouncer designed to be spoken by clients we don't write
(`cicchetto` and `shottino` are ours; a third one is the point). This
document describes the wire contract; **the source is authoritative** —
every section points at `file:line` and, where they disagree, the code
wins (line numbers drift; the module + function names are the stable
anchors). Filed for GH #447.

> **Credit.** The contract *shape* here is lifted, with attribution, from
> [amiantos/lurker](https://github.com/amiantos/lurker) (MPL-2.0) —
> an independently-built bouncer with the same "the client never speaks
> IRC" premise. We copied the shape, not the code (different stacks
> entirely); the casing and naming are grappa's own (see "Wire format").

---

## 1. First contact — `GET /api/config`

Hit this **before** you authenticate or open a socket. It is
unauthenticated, carries no secrets, and is cacheable.

```
GET /api/config
→ 200 application/json
{
  "server": "grappa",
  "version": "1.4.2-abc1234",
  "protocol_version": 1,
  "min_protocol_version": 1
}
```

| field | meaning |
|-------|---------|
| `server` | server identity / edition. Always `"grappa"` for this implementation. |
| `version` | human-facing **software release** string (the CTCP VERSION value). Diagnostic only — **never** key compatibility off this. |
| `protocol_version` | the wire protocol the server currently speaks. |
| `min_protocol_version` | the oldest client protocol the server still accepts. If your protocol is below this, the server will refuse your WebSocket (see §3). |

> **Operator note — this endpoint is public by design.** It requires no
> auth and carries no secrets, so `version` (the software release string —
> `X.Y.Z` on a released build, `X.Y.Z-<shortsha>` on an unreleased one) is
> disclosed to anyone who can reach the URL. That is the same value grappa
> already hands any IRC user via `CTCP VERSION`, and a discovery endpoint
> that hid what it is would be self-defeating — so the exposure is
> deliberate, not a leak. Self-hosted operators who consider even that a
> concern can front `/api/config` however they like; grappa treats it as
> public.

Source: `lib/grappa_web/controllers/config_controller.ex:35`
(`show/2`), routed at `lib/grappa_web/router.ex:233`. The two numbers come
from `Grappa.Protocol` (`lib/grappa/protocol.ex:64` `version/0`, `:71`
`min_version/0`) — the single source of truth.

---

## 2. Versioning + the additive-only rule

There are **two** numbers, and they mean different things:

- **`protocol_version`** — what the server speaks *now*.
- **`min_protocol_version`** — the floor. A client below it is refused.

**The contract is additive-only.** Both sides MUST follow it:

- New **frame kinds**, new **event types**, and new **fields** may appear
  at ANY time, WITHOUT a `protocol_version` bump.
- An **unknown verb or field is never fatal, in BOTH directions.** A
  client MUST ignore fields and events it does not recognise. The server,
  symmetrically, replies to an unknown client verb with a non-fatal error
  frame and keeps the socket open.
- **Existing fields are never repurposed or removed.** A field means the
  same thing forever.

Because of this, `protocol_version` bumps **only** for a change the
additive rule cannot express (a field's meaning changes, or a frame is
withdrawn). Such a change also raises `min_protocol_version` when clients
below it can no longer be served. **Practical consequence for you:** pin
the LOWEST `protocol_version` whose features you use, ignore everything
you don't recognise, and you will keep working across additive upgrades
without a code change.

---

## 3. The WebSocket handshake

The realtime surface is Phoenix Channels at `/socket/websocket`. Two
signals ride the handshake:

### 3a. Authentication — the bearer, via subprotocol

Your session bearer (obtained from `POST /auth/login`) rides the
`Sec-WebSocket-Protocol` header as `base64url.bearer.phx.<token>`, NOT the
URL. This keeps the credential out of access logs. The phoenix.js client
does this for you via `new Socket(url, {authToken: token})`; a raw client
sends the bearer subprotocol alongside `"phoenix"`. A missing/invalid
bearer is rejected with **403**. Source:
`lib/grappa_web/channels/user_socket.ex` (`connect/3:101`, `extract_token`)
+ `lib/grappa_web/endpoint.ex:87` (`auth_token: true`).

### 3b. Protocol version — the `client_proto` query param

Declare the protocol version your client speaks as the **`client_proto`
query parameter** on the upgrade URL:

```
wss://host/socket/websocket?client_proto=1&vsn=2.0.0
```

- `client_proto` — YOUR protocol version. This is public, not a secret,
  so it rides the URL (unlike the bearer). Do NOT confuse it with `vsn`,
  which is phoenix's own transport-serializer version — a different thing.
- If you declare **below** `min_protocol_version`, the server refuses the
  upgrade with a clean **`426 Upgrade Required`** whose JSON body names
  the floor:
  ```
  426 { "error": "upgrade_required", "protocol_version": 2, "min_protocol_version": 2 }
  ```
  This is DISTINCT from the 403 you get for a bad bearer — a 426 means
  "upgrade your client," a 403 means "fix your credential."
- If you **omit** `client_proto` entirely, you are treated as **current**
  (the server sends you nothing new). This is the zero-friction path and
  is exactly what our own clients do until they need to negotiate.
- There is **no upper bound**: declaring a version higher than the server
  speaks is fine (additive-only — a newer client tolerates an older
  server).

Source: `lib/grappa_web/channels/user_socket.ex:135`
(`check_protocol_version/1`) → returns `{:error, :upgrade_required}`,
which the endpoint's `error_handler`
(`user_socket.ex:166` `handle_ws_error/2`, wired at
`endpoint.ex:90`) turns into the 426. The version check runs **before**
auth, so a too-old client is refused regardless of its credential.

### 3c. The initial payload

The first topic to join is the user topic `grappa:user:{user}`. Its join
reply is your **initial payload** and carries `protocol_version`, so a
client that skipped `/api/config` still learns it on connect:

```
join "grappa:user:vjt" → {:ok, {"protocol_version": 1}}
```

Source: `lib/grappa_web/channels/grappa_channel.ex:332`
(`join_reply({:user, _})`).

---

## 4. Topics

Topics are user-rooted (single source of truth
`lib/grappa/pubsub/topic.ex`):

| topic | shape | source |
|-------|-------|--------|
| user | `grappa:user:{user}` | `topic.ex:64` |
| network | `grappa:user:{user}/network:{slug}` | `topic.ex:70` |
| channel | `grappa:user:{user}/network:{slug}/channel:{chan}` | `topic.ex:92` |

Channel segments are case-folded under rfc1459 server-side, so join with
any casing and you land on the canonical window. Events push on the
matching topic as `"event"` frames; treat unknown `kind` values as
ignorable per §2.

---

## 5. Wire format

- **JSON, UTF-8.** IRC bytes are decoded to UTF-8 at the server boundary;
  you never parse IRC.
- **snake_case, without exception.** Every key on every surface is
  snake_case (`protocol_version`, `server_time`, `read_cursor`, …).
  grappa's TypeScript wire types are the mirror
  (`cicchetto/src/lib/wireTypes.ts`); there is not a single camelCase key
  in the contract, and new fields MUST be snake_case. (This is a
  deliberate divergence from #447's issue text, which used camelCase; see
  `docs/DESIGN_NOTES.md` 2026-07-27 for why.)
- **REST for resources, Channels for events.** State changes are pushed
  over Channels, not polled over REST.

---

*This document tracks a live contract. When it disagrees with the code,
the code is right — start from the `file:line` anchors above.*
