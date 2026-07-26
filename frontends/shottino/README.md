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

- `ffmpeg` — fetches and decodes the linked image/video into a single frame.
  Required for in-terminal previews; without it a media link opens via
  `xdg-open` instead.
- `chafa` — optional. When present it renders the frame; when absent shottino
  renders it itself as coloured half-block character art.

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

- Moving the mouse over an image or video link shows a `click to preview:`
  hint on the chrome line.
- Left-clicking the link opens a full-screen preview (a still frame for video);
  press any key to return to the chat.
- A terminal with a graphics protocol (Kitty, iTerm2, Sixel, WezTerm) shows a
  real bitmap. **Every other terminal gets coloured character art instead** —
  the frame is rendered as half-block glyphs, two pixels per cell, in truecolor
  or 256 colours depending on what the terminal advertises, degrading to a
  luminance ramp where there is no usable colour. Only `ffmpeg` is required;
  `chafa` is used when installed but is not needed.
- Sixel support cannot be probed reliably. Set `SHOTTINO_GRAPHICS=1` to force
  the bitmap path on a terminal you know supports it.
- While shottino runs, mouse reporting is enabled, which suppresses the
  terminal's native text selection (Shift-drag still works in most terminals).

## Commands

`/help` lists every verb. Beyond the basics:

- **Channel ops** — `/op` `/deop` `/voice` `/devoice` `/kick` `/kb` `/ban`
  `/unban` `/banlist` `/invite` `/mode [#chan] +modes [params]`
- **Server info** — `/whois` `/whowas` `/who` `/names` `/lusers` `/links`
  `/motd` `/info` `/version` `/stats [query]` `/rehash [opt]`
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

## Window state

Windows mirror the server's state machine and shottino never originates a
transition. A non-joined window is greyed with a marker — `.` joining, `?`
invited, `!` join failed, `x` kicked, `~` network parked — and the status line
says why (`kicked by op: flooding`, not just an inert window).

Unread state is server-owned per (subject, network, channel): reading a window
here moves the cursor for every device attached to the same session, and the
`unread` divider marks where you left off no matter which client you were using.
