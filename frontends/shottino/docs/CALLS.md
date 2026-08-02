# Calls in shottino

Audio and video calls, from a terminal, in channels and queries.

This document covers two things: **the invite convention that ships
today** (stage 1), and **what a host has to provide** for the stage that
puts the media in the terminal (stage 2, WHIP/WHEP).

The server side is deliberately **not grappa**. Nothing here touches the
bouncer, its database or its wire protocol. A call is a line of text on
IRC plus, later, an HTTP conversation with a media host that knows
nothing about IRC. The two never meet.

---

## Stage 1 — the invite convention (shipping)

A call is a URL somebody posts and somebody else opens. That is the
whole protocol, and it is deliberately the whole protocol: IRC stays
text, every other client in the channel sees a line it can read, and
shottino is the only one that also treats it as an event.

    📞 https://meet.jit.si/shottino-4f2c8e01…      audio
    📹 https://meet.jit.si/shottino-4f2c8e01…      video

The marker emoji mirrors what `/upload` already ships (`📸`, `🎤`, `🎥`),
so a human reading it in irssi or cicchetto needs no explanation.

### Verbs

| verb | what it does |
|---|---|
| `/call` | mint a room, post `📞 <url>` to this window, open it |
| `/videocall` | the same with `📹`, so the other side knows to expect a camera |
| `/answer` | join the last call that came in — ringing or not |
| `/hangup` | stop a ring. **Local**: the caller is not told |

### Settings

| setting | default | meaning |
|---|---|---|
| `call.base_url` | `https://meet.jit.si` | where a room is made. Any room-per-URL service |
| `call.ring` | `queries` | `off` / `queries` / `all` — when an arriving call interrupts you |

### The rules the implementation actually enforces

**A marker, never a URL pattern.** Ringing at any recognised meeting link
would mean anyone who pastes one — or quotes one, or links a recording of
one — makes every shottino in the channel ring. The marker must *open*
the line and must be followed by whitespace: `📞x` is not an invite, and
neither is `look at 📞 https://…`.

**http and https only.** Answering hands the URL to the desktop opener.
A `file://`, a `javascript:` or anything else with a registered handler,
arriving from a stranger and opened by one keystroke, is a hole rather
than a call.

**A URL that does not fit is refused, never truncated.** Half a room name
is not a shorter link; it is a different room.

**The room name is 128 bits from the CSPRNG.** A room of this shape is
public to whoever knows its name — *the link is the credential*. That
makes the honest privacy statement true: **a call is exactly as private
as the window its link was posted in.** Which is why the ring names the
window it came from, and why `/call` refuses to guess one.

**Queries ring; channels only announce.** A channel doorbell that any
member can press is a doorbell that gets pressed. The invite still lands
in scrollback and `/answer` still reaches it, so the quiet policy loses
the interruption and nothing else.

**Decline says nothing to anyone.** Declining down the wire would post
"no" into whatever window the invite arrived in, a channel included. The
caller learns you did not join by your not being in the room, which is
how a call has always worked.

**Three guards at the ingest, shared with `/bot`:** not from history (a
scrollback fetch must not ring you with yesterday's calls), not from a
blocked person, and not from a presence row — a join is not an
invitation. Your own invite, echoed back by the server, does not ring
you either.

### Known limitation of the default target

`meet.jit.si` now requires the **moderator** to authenticate (Google,
Facebook or GitHub) before a room will start. Joining a room that is
already running is still anonymous, so an invite you *receive* always
works; one you *place* may ask the browser for a login the first time.
Point `call.base_url` at a service without that gate and the behaviour is
identical — nothing in the call code knows what jitsi is.

---

## Stage 2 — WHIP/WHEP, and what the host must provide

Stage 1 hands the URL to a browser. Stage 2 joins the call *in the
terminal*: audio through the system devices, video decoded by ffmpeg and
drawn as colour art by the renderer that already draws animated clips.

The protocol choice is **WHIP** (WebRTC-HTTP Ingestion Protocol, RFC
9725) for sending and **WHEP** for receiving, because it is the only
option whose signalling costs *no new dependency and almost no code*:

```
POST <base>/<room>/whip          Content-Type: application/sdp
  body: SDP offer
→ 201 Created
  Location: <resource-url>
  body: SDP answer

DELETE <resource-url>            hang up
```

That is an HTTP request `shottino/http.c` can already make over the
OpenSSL it already links. The SDP is generated and consumed by
libdatachannel — the one new dependency, and the same one whether the
signalling is WHIP, Jitsi's XMPP/Jingle, or CTCP over IRC. **The
signalling choice costs code, not dependencies**, and WHIP is the
cheapest code.

### What the host has to run

**1. An SFU that speaks WHIP and WHEP.**

| option | notes |
|---|---|
| **MediaMTX** | single Go binary, no dependencies, WHIP+WHEP native, **and it serves a browser page per path** — which preserves the "post a link a browser user can click" property for free. The recommended starting point. |
| **LiveKit** | a real room/participant model, WHIP ingest, single binary for one node. More capable, more moving parts. |
| **Janus** | mature, plugin-based; needs the WHIP server plugin. |
| **Galène** | small, self-hostable, has a browser UI; its own protocol plus a WHIP endpoint. |
| hosted | Cloudflare Realtime, Millicast and others speak WHIP if you would rather not run a host at all. |

**2. TLS.** Not optional in practice: browsers refuse `getUserMedia` on
plain HTTP, so any host that also serves the browser page needs a real
certificate. Let's Encrypt via the SFU's own ACME support or a reverse
proxy in front.

**3. Ports.**

- **TCP 443** — WHIP/WHEP signalling and the browser page.
- **UDP** for the media itself. Prefer an SFU configured for a **single
  UDP port mux** (MediaMTX defaults to `8189/udp`) over a wide range;
  one hole in the firewall is one hole to get wrong.
- Optionally **TCP 443 for ICE-TCP**, as the fallback for clients on
  networks that block UDP entirely.

**4. The public IP, declared.** This is the classic misconfiguration and
it fails *silently*: the SFU advertises ICE candidates, and if it
advertises a private address (because it is behind NAT and nobody told
it otherwise) the handshake simply never completes. MediaMTX calls this
`webrtcAdditionalHosts`; LiveKit calls it `rtc.node_ip`. Set it.

**5. STUN, and TURN only if needed.** A publicly reachable SFU is
typically ICE-lite, so a client needs STUN only to discover its own
reflexive candidate — any public STUN server does. **TURN** (coturn,
listening on 443/TCP) is needed only for participants behind symmetric
NAT or a UDP-blocking firewall. It relays media, so it costs real
bandwidth; treat it as the fallback it is, not the default path.

**6. Auth.** WHIP carries `Authorization: Bearer <token>`. Two shapes fit
this design:

- **No auth, unguessable room path.** Consistent with stage 1, where the
  link already *is* the credential. Anyone who knows the path can
  publish — which is exactly the bargain the invite convention already
  makes, and the 128-bit room name is what makes it acceptable.
- **A shared or per-room bearer**, if the host is shared with people who
  are not in the channel.

**7. Codecs — forward, do not transcode.** Opus for audio. **VP8** for
video is the safest common denominator: universally supported and free
of the licensing baggage that keeps H.264 out of some distributions.
Because the terminal renders ASCII art, the useful resolution is tiny
(320×240 at 10 fps is generous), so the SFU should be configured to
forward streams untouched — transcoding would burn CPU to produce
detail the renderer immediately throws away.

### The one thing WHIP/WHEP does not give you, and why it does not matter here

WHIP and WHEP are deliberately just publish and subscribe. They carry no
roster: nothing in the protocol tells you *who else is in the room*.
Normally you fill that gap with an SFU-specific room API, which is
exactly the vendor lock-in the standard was meant to avoid.

**IRC already provides the roster.** The channel membership *is* the
participant list, and the invite convention is the room announcement. A
participant publishes to `<room>/<nick>` and subscribes to the paths of
the other members shottino already tracks in its nicklist. The thing
WHIP leaves out is the thing an IRC client has had all along.

### Bandwidth, for sizing the host

Because the display is coloured half-blocks in a terminal, the numbers
are small enough to be worth stating:

- audio, Opus: **~24 kbps** per participant
- video at 320×240 / 10 fps, VP8: **~150 kbps** per participant

An SFU forwards rather than mixes, so a room of N costs the host roughly
`N × (N−1) × stream`. A five-way video call is under 3 Mbps of forwarding
in total — which is also why a full peer-to-peer **mesh** remains viable
here well past the point it stops being viable for a normal video app,
and is the reason a query call needs no host at all.

---

## Roadmap

- **Stage 1 — shipping.** Invite convention, ring, answer/decline, hand
  off to the browser. Remains the permanent fallback when no media
  helper is installed.
- **Stage 2.** `shottino-call`, a separate helper *process* (not a
  plugin `.so`): no ABI to keep stable, no GStreamer or C++ in
  shottino's address space, the ASan gate stays pure C, and a crash in
  WebRTC drops the call rather than the IRC session. Receive-only audio
  first — it proves the signalling, which is the risky half.
- **Stage 3.** Send audio (real mute/unmute), then receive video into
  the existing renderer, then the camera.

The packaging consequence of the helper being a separate process is that
the `grappa` package is untouched: still four dependencies, still zero
new ones, with the helper as an `optdepends`-shaped runtime download —
exactly the shape ffmpeg already has.
