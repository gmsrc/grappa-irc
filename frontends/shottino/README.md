# shottino

Standalone Linux terminal client for grappa's REST + Phoenix Channels surface.

Shottino is intentionally a terminal facade over grappa's JSON API. It does not
parse IRC and does not connect to upstream IRC servers.

## Install from a package

Shottino ships in grappa's distro packages as `/usr/bin/shottino` — on a host
with the `.deb` or the Arch package installed there is nothing to build. To
build it from source instead, read on.

## Build

```sh
./configure
make
```

Dependencies checked by `./configure`:

- C compiler with C11 support
- `pkg-config`
- `ncursesw`
- OpenSSL (`libssl`, `libcrypto`)
- pthread support

Optional runtime dependencies (only for media link previews — see below):

- `ffmpeg` — fetches and decodes the linked image, or a video/GIF into the
  frames it plays back.
  Required for in-terminal previews; without it a media link opens via
  `xdg-open` instead.
- `chafa` — optional. When present it renders the frame; when absent shottino
  renders it itself as coloured half-block character art.

## Moving pictures

Video and animated GIFs play inline as colour character art, and `/preview`
plays them full-screen too. Up to 64 frames at 10fps, and only frames that are
ON SCREEN are advanced — a scrollback full of GIFs you scrolled past is not a
scrollback full of running animations.

Whether something animates is decided by the DECODER, not by the link: on a
character-art terminal every picture is asked for its frames, so an animated
GIF plays whatever its URL looks like, and a still comes back as the single
frame it has. On a terminal with a graphics protocol the extension is still
consulted, because forcing art there would trade real sharpness for a guess.

Motion is deliberately a character-art capability. A terminal graphics
protocol (kitty/iTerm2/sixel) places a whole picture at the cursor, so
animating one means re-emitting an escape per frame: flicker, bandwidth, and
a separate code path per protocol. Character art goes through ncurses like
text, so it repaints, clips and scrolls with everything else — a clip renders
as art even where a protocol is available. Still images keep using the
protocol when there is one.

`/media still` shows one representative frame instead; `/media anim` turns
playback back on. Both obey the same first-party rule as still images — see
`/media all`.

## The topic bar

The band at the top is at most **two lines**, whatever the topic says. The
channel label takes only the width it needs (capped at a third of the pane), so
the topic gets the rest rather than starting a third of the way across.

What does not fit on the two lines **scrolls** along the second one, pausing at
each end so it can be read, and pausing entirely while the mouse pointer rests
on the band (the marquee is the way to read a long topic; the pointer is a
courtesy, and needs mouse tracking, which is on by default). A `…` on the left of the second line
says there is more; it reads `(paused)` while you hold it.

## Bridging a normal IRC client (`--ircd`)

`shottino --ircd https://grappa.example.net you password` runs headless and
listens as an IRC **server**, so irssi, hexchat, weechat or anything else can
connect to it and reach grappa through it. No terminal is opened, which is why
it works over ssh, in a service unit, or in a container with no tty.

```
shottino --ircd              https://grappa.example.net you password   # 127.0.0.1:6667
shottino --ircd=6668         https://grappa.example.net you password
shottino --ircd=10.0.0.2     https://grappa.example.net you password
shottino --ircd=[::1]:6668   https://grappa.example.net you password
```

The argument is a port, an address, or address:port, v4 or v6; a bare IPv6
address needs no brackets (`--ircd=::1`) but one **with** a port does
(`--ircd=[::1]:6668`), since otherwise the colons are ambiguous. Only the
`--ircd=SPEC` form is accepted — `--ircd 6668` would be indistinguishable from
a positional argument, and the positional it would eat is your password.

It **detaches into the background** once it is up, printing the pid, the log
path (`~/.local/share/shottino/ircd.log`) and how to stop it. Backgrounding is
the last thing it does: the login, the scrollback, the websocket and the bind
all happen in the foreground first, so a wrong password or a port already in use
is still an error you see and a non-zero exit — not a line in a log file you did
not know to look at. Pass `--foreground` under a service manager, which
supervises the process it started and reads a fork as a crash.

**One connection is one network.** An IRC client has one nick, one MOTD and one
channel namespace per connection, while grappa has several networks at once and
`#ops` on two of them is two different rooms. So the client names the network it
wants in `PASS`, and a user with three networks opens three connections — the
way people already use bouncers:

```
/connect localhost 6667
/quote PASS azzurra:<password>     # or set the server password to azzurra:<password>
```

With one network bound, `PASS azzurra` (or nothing at all, on loopback) is
enough. Naming a network that does not exist is answered with the list.

**Off loopback, a password is required.** The bridge hands over the whole IRC
session — every channel, every DM, and the ability to speak as you. On
`127.0.0.1` that is bounded by who can run processes as you; on any other
address it is bounded by nothing, so a non-loopback bind without
`SHOTTINO_IRCD_PASS` refuses to start rather than listening quietly. Set it and
the clients must send it: `PASS <network>:<password>`.

What the client gets on connect: the nick grappa uses on that network (a
different one is corrected with a `NICK`, as a real server would), `001`–`005`
with the network's real `PREFIX`, a `JOIN` for every channel grappa already
holds open with its topic and names, and a replay of the recent conversation.
With `server-time` the replay is stamped when things were **said** rather than
when you reconnected. See the capability list under Chat history.

Your own messages are not echoed back unless the client negotiates
`echo-message` — a client prints what it sends, and echoing doubles every line.
The cost is that messages you send from cicchetto or from shottino's own UI do
not appear; `echo-message` is how a client asks to see those.

### Chat history

The bridge speaks `CHATHISTORY`, so a client can ask for what it missed instead
of being told once at connect time:

```
/quote CHATHISTORY LATEST #chan * 50
/quote CHATHISTORY BEFORE #chan msgid=1234 50
/quote CHATHISTORY AFTER  #chan timestamp=2026-07-29T08:00:00.000Z 50
/quote CHATHISTORY BETWEEN #chan msgid=1200 msgid=1250 50
/quote CHATHISTORY AROUND #chan msgid=1234 50
/quote CHATHISTORY TARGETS * * 50
```

Clients that support it (senpai, goguma, Halloy, recent weechat) do this on their
own when you scroll up. Replies come as a `chathistory` **batch**, each message
tagged with `@time` (when it was said) and `@msgid` (what to point at next).

Capabilities offered: `server-time`, `message-tags`, `batch`, `multi-prefix`,
`echo-message`, `draft/chathistory`.

**Where history comes from.** By default the bridge answers from what it has
seen this session — the scrollback fetched from grappa at startup and on each
join, plus everything live since (a thousand messages). That covers the question
a client actually asks on reconnect, and costs nothing.

`--ircd-archive` lets a request reach past it into grappa's stored scrollback.
One rule decides the source, so it stays predictable: **the session's history
answers when it can answer fully, and anything short of that becomes a REST
query.** It is opt-in because that query is not free — one round trip per
request, against a table that can be very large, driven by whatever a client
asks for while someone scrolls.

`msgid=` selectors map exactly: grappa pages on integer message ids, and a
`msgid` IS that id. `timestamp=` has no server-side equivalent, so it is
resolved through the nearest id this session knows and filtered by time after
the fetch — exact where the bridge has seen that stretch of the conversation,
approximate where it has not.

`JOIN`, `PART`, `PRIVMSG`, `NOTICE`, `NAMES`, `WHO`, `WHOIS`, `TOPIC`, `PING`
and the registration commands are handled here. **Everything else is forwarded
to the real server in the words you typed** — `MODE`, `INVITE`, `KICK`, `OPER`,
`LIST` and whatever else that network knows — so anything you can type still
works. Their replies reach grappa's other clients rather than coming back as
numerics, which is the one place this is a bridge rather than a server.

## Panes

`/split` divides the chat area into two stacked panes; `/splitv` (or
`/splitw`) divides it side by side; `/unsplit` closes the focused one. A new
pane opens on the same window it was split from — splitting asks for another
view, and which conversation goes in it is the next thing you say (`/win`,
Ctrl-N).

Each pane scrolls independently, so two panes on the same channel are two
independent views of it. The focused pane's header is accented and marked
`*`, because the input box is nowhere near either header and "where does my
typing go" has to be answerable at a glance.

| key | does |
|---|---|
| `Ctrl-Alt-Up` / `Ctrl-Alt-Down` | move focus between panes |
| `Ctrl-Alt-Tab` | cycle focus |
| `Ctrl-Alt-+` / `Ctrl-Alt--` | grow / shrink the focused pane |
| `Ctrl-Up` / `Ctrl-Down` | scroll the chat one line |

Terminals disagree about what Ctrl-Alt sends, and some send nothing at all
for Ctrl-Alt-Tab (a desktop usually eats Alt-Tab before the terminal sees
it). Both the CSI dialect (`\033[1;7A`) and the ESC-prefix dialect (ESC then
the key) are accepted; `Ctrl-Alt-Up/Down` is the pair to rely on. Run
`/keys` to print the code your terminal actually sends for a key — a
binding that does not fire is then a bug report with a number in it.

## The userlist

`Ctrl-U` hands the arrow keys to the member list; `Esc` gives them back.
While it holds them, `Up`/`Down` move a line, `PgUp`/`PgDn` ten, `Home` and
`End` go to the ends, and anything else — a letter, `Enter`, `Tab` — returns
to the input line and is typed as usual. The header says which mode you are
in (`^U` when the chat has the keys, `↑↓` when the list does).

| key | does |
|---|---|
| `Ctrl-U` | give the arrows to the userlist, or take them back |
| right-click a name | query, whois, ping, block — plus kick/ban where you hold `@` — or type the nick |
| `Ctrl-Shift-Up` / `Ctrl-Shift-Down` | scroll it without changing mode |
| `Shift-PgUp` / `Shift-PgDn` | the same, by ten |
| wheel over the list | scrolls it |
| wheel over the chat | scrolls the pane under the pointer |

The modifier shortcuts are a convenience, not the way in: `Ctrl-Shift-Up` and
`Ctrl-Shift-Down` are the terminal's OWN scrollback shortcut in
gnome-terminal, konsole, kitty and terminator, which keep the key and never
forward it. No client can bind what it is not sent. `Ctrl-U` and plain arrows
are the two things every terminal delivers, which is why the way in is a mode
rather than a modifier.

## Replying

Right-click a message for a menu: reply to it, or open a query with whoever
sent it. `Ctrl-R` opens the same thing from the keyboard — the last 20 messages in the
focused pane's window, newest first. Type to search: the filter matches nick
**or** message text and runs over the window's WHOLE buffer, not just the
twenty on offer, because the point of a search is to reach what is not in
front of you. `Up`/`Down` to choose (the list scrolls under the selection),
`Enter` to reply, `Esc` to cancel.

Replying prefills the input with the address **and a citation of the message
you picked**:

```
alice: «the meeting is at four» 
```

IRC has no threading, so carrying a piece of the original is the only way to
say which message you are answering — and it stays readable in every client
that will see it. The citation is flattened to one line, stripped of
formatting codes, and cut on a word boundary with `…` when the original runs
long: an IRC line is ~450 usable bytes, and the point is to jog a memory, not
to repeat the channel back at it.

Anything already typed is kept after the citation rather than thrown away, and
picking a different message replaces the citation instead of stacking a second
one in front of the first.

Right-click works on a **name in the userlist** too, where the menu offers what
a person can do rather than what a message can: open a query, whois them, ping
them, block them, or type their nick into the input. Replying is offered only
on a message, since it quotes what was said.

**Kick**, **Ban** and **Kick and ban** appear only where they would work: in a
channel, and only while you hold `@` there. The client reads that off the
roster the server sent, so the menu never offers an action the server would
answer with 482.

The menu takes the mouse: the pointer highlights what it is over, a click
chooses it, the wheel walks the list, and a click anywhere outside the box
closes it — the same as Esc. Right-click needs mouse reporting, which is on by
default; `Ctrl-R` works either way.

## Tests

```sh
make check
```

Builds and runs every suite. The pure modules — the JSON reader, the wire
narrowers, alias expansion, mIRC formatting, and colour quantisation — are
deliberately kept free of app state and terminal state so they can be tested
without a TTY. Suites build with ASan and UBSan; override `SANITIZE=` on a
toolchain without the sanitizer runtime.

## Install from source

```sh
./configure --prefix=/usr/local
make
make install
```

## Run

```sh
frontends/shottino/shottino --user https://grappa.example.net USER PASSWORD
```

Or use an explicit grappa login email unrelated to the IRC nickname:

```sh
frontends/shottino/shottino --user --login-email user@example.net https://grappa.example.net PASSWORD
```

Auth modes:

- `--user` logs in as a registered grappa user. Plain `USER` is sent as
  `USER@shottino.local` because grappa's current account classifier routes
  email-like identifiers to user login and uses the local part as the account
  name.
- `--login-email EMAIL` uses `EMAIL` as the grappa login identifier. The IRC
  nickname remains the one configured in grappa's network credential; it is not
  derived from the email.
- `--visitor` logs in through grappa's visitor nick flow.
- `--auto` preserves the server's default classifier behavior.
- `--share https://grappa.example.net/share/<token>` consumes a visitor
  session-share link instead of logging in. Both the server origin and the token
  are read from the URL; no identifier or password is needed.

Use `--user` for multi-machine reattach. The user subject is durable on the
server, so channels/query windows/scrollback state are shared across clients.
Visitor mode needs the saved bearer token to reattach without spawning a new
visitor session.

## Visitor session sharing

Visitors have no password, so a registered-user login on a second device is not
available to them. The share link closes that gap — it lets a visitor attach
another device to the *same* session (shared scrollback and state):

1. On the first device (any visitor client, e.g. cic or a shottino visitor
   session), run `/share`. Shottino mints a short-TTL link
   `https://<host>/share/<token>` via `POST /me/share-token` and prints it.
   `/share` is visitor-only; a registered user gets a friendly rejection.
2. On the second device, run
   `shottino --share https://<host>/share/<token>`. Shottino consumes the token
   (`POST /auth/share/consume`), mints a fresh per-device session for the same
   visitor, and saves the bearer so subsequent launches reattach without
   re-consuming the (one-shot, already-spent) link.

Key bindings:

- `Enter` sends the input line to the current window.
- `Tab` completes commands, windows, networks, and known nicks.
- `Up` / `Down` browse input history.
- `PageUp` / `PageDown` scroll the active chat buffer.
- `Ctrl-N` / `Ctrl-P` cycle windows.
- `/help` lists supported commands.

Media link previews:

- **Inline media is on for every host by default**, and off entirely when
  `ffmpeg` is not installed — it decodes every picture and clip, so a default
  that promised pictures without it would deliver "[image could not be
  decoded]" on every row. Being on for every host means an image linked in a
  channel is fetched when its row scrolls into view, so **that host learns your
  IP address and when you read**. `/media first-party` limits fetching to your
  own deployment's uploads; `/media off` turns pictures off. shottino says which
  of these is in force every time it starts.
- `/preview` opens a picker over the last 20 pictures and clips posted in this
  window, newest first, each URL once — type to filter, `Enter` to open, `Esc`
  to cancel. `/preview <url>` skips the list. Press any key to return to the
  chat.
- `/view` offers the same list but hands the file to the DESKTOP: it downloads
  it and opens whatever your system uses for that file type. This is what
  `/open` cannot do — `xdg-open` on a URL picks the handler from the *scheme*
  and so always opens a browser; picking it from the file type means having the
  file. Downloads go to a temporary directory that is removed when shottino
  exits.
- Hovering an image or video link shows a `click to preview:` hint and
  left-clicking opens the same preview (mouse tracking, on by default).
- A terminal with a graphics protocol (Kitty, iTerm2, Sixel, WezTerm) shows a
  real bitmap. **Every other terminal gets coloured character art instead** —
  the frame is rendered as half-block glyphs, two pixels per cell, in truecolor
  or 256 colours depending on what the terminal advertises, degrading to a
  luminance ramp where there is no usable colour. Only `ffmpeg` is required;
  `chafa` is used when installed but is not needed.
- Sixel support cannot be probed reliably. Set `SHOTTINO_GRAPHICS=1` to force
  the bitmap path on a terminal you know supports it.
- **Mouse tracking is ON by default**: click a link, right-click a message,
  scroll the userlist with the wheel. The cost is the terminal's own click-drag
  selection, because the terminal forwards button and motion events to shottino
  instead of selecting — **hold Shift to select text as usual**, which works in
  xterm, vte (gnome-terminal), konsole, kitty, alacritty and iTerm2. `/mouse
  off` gives selection back unconditionally and turns click-to-preview off with
  it; bare `/mouse` toggles. Everything reachable by mouse is also reachable by
  keyboard (`/preview`, `Ctrl-R`, `Ctrl-U`), so turning it off costs no
  features.

## Commands

`/help` lists every verb. Beyond the basics:

- **Channel ops** — `/op` `/deop` `/voice` `/devoice` `/kick` `/kb` `/ban`
  `/unban` `/banlist` `/invite` `/mode [#chan] +modes [params]`
- **Server info** — `/whois` `/whowas` `/who` `/names` `/lusers` `/links`
  `/motd` `/info` `/version` `/stats [query]` `/rehash [opt]`

  Their answers land in the window you asked from, and stay filed there: switch
  away and they do not follow you, switch back and they are still there.
- **People** — `/ping <nick>` CTCP-pings somebody and times the round trip.
  `/block [nick]` (`/ignore`) hides somebody's messages **in this client
  only** — nothing is sent to the server, they keep talking, grappa keeps
  storing it, and the PWA on your phone keeps showing it. Bare `/block` lists
  who is blocked; `/unblock <nick>` (`/unignore`) lifts it. The list lives in
  `~/.local/share/shottino/blocked` and survives a restart.
- **Watching** — `/notify [nick…|del nick|list]` watches *people*;
  `/hilight <pattern>` and `/dehilight <pattern>` watch *words*. Different
  lists, despite the shared irssi heritage.
- **Services** — `/cs` `/ns` `/ms` `/os` `/hs` `/rs`; the bare form sends HELP.
- **Aliases** — `/alias <name> <expansion>` with `$1`…`$9` and `$*`; an
  expansion containing no placeholder gets the arguments appended. An alias
  may shadow any built-in except `/alias` and `/unalias` (#427), which stay
  reachable so a shadow can always be undone. `/unalias <name>`, bare
  `/alias` lists.
- **Files** — `/upload <path>` posts a file and shares its link. IRC stays
  text: the link is a clickable URL, never an inline embed.
- **Directory** — `/list [query]` browses the channel directory,
  `/list -refresh` starts a new background scan.
- **Archive** — `/archive` lists archived windows, `/archive open <target>`
  reopens one, `/archive purge <target>` deletes its history.

## Diagnosing a missing or misplaced line

A scrollback row's height is computed twice — once to size the scroll
region, once to draw it — and every "a line went missing" bug so far has
been those two disagreeing. The screen shows you the symptom, not which
pass was wrong, so shottino can dump both:

```sh
SHOTTINO_LAYOUT_LOG=/tmp/shottino-layout.log shottino …
```

Reproduce the problem, quit, and read the last frame. Each row shows its
reserved height (`h`), its text-only height (`text`), and any attached
image with its decode state. The `END` line shows the scroll budget:

```
   row=13 h=11 text=1 media=0 READY :: [net/#chan] <bob> pic https://…
   row=14 h=1  text=1 media=-1      :: [net/#chan] <carol> the next message
   END max_off=9 skip=9 used=18/18 drawn=8/17
```

`used` greater than the region height is flagged `*** OVERFLOW ***` and
means the budget was exceeded — the bottom of the buffer got clipped.
The log is written only when the variable is set.

## Window state

A window is identified by its **folded** name, so `#Chan`, `#chan` and `#CHAN`
are one window and not three — as are `Alice` and `alice`. The fold is the
ircd's: ASCII, `A-Z` only, which leaves `[ ] \ ~` alone (bahamut advertises
`CASEMAPPING=ascii`, so `foo[1]` and `foo{1}` are two different people, and
`#CAFÉ` is not `#café`). The window keeps whatever spelling it was first
opened with; only the matching folds.

Traffic addressed to the network's own name — azzurra's ircd sends its global
notices from a source spelled `AzzuRRa` — is the server talking, and lands in
that network's `$server` window rather than opening a tab named after the
network.

Windows mirror the server's state machine and shottino never originates a
transition. A non-joined window is greyed with a marker — `.` joining, `?`
invited, `!` join failed, `x` kicked, `~` network parked — and the status line
says why (`kicked by op: flooding`, not just an inert window).

Unread state is server-owned per (subject, network, channel): reading a window
here moves the cursor for every device attached to the same session, and the
`unread` divider marks where you left off no matter which client you were using.
