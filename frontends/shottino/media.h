/* media.h — terminal graphics: which protocol, and how to emit one.
 *
 * Terminals disagree about how to show a bitmap, so shottino picks the
 * best available and degrades:
 *
 *   kitty   — Kitty's graphics protocol (also spoken by WezTerm, Ghostty)
 *   iterm2  — iTerm2's inline-images escape (also WezTerm, some others)
 *   sixel   — DEC Sixel, the VT300-era format; xterm -ti vt340, foot,
 *             mlterm, contour, recent Windows Terminal
 *   none    — no bitmap protocol; the caller falls back to character art
 *             (termcolor.h), which is not a lesser feature so much as the
 *             universal one
 *
 * Detection is DELIBERATELY two-tier. Environment variables identify
 * kitty and iTerm2 reliably because those terminals advertise themselves.
 * Sixel cannot be inferred that way — plenty of terminals emulate a VT300
 * without saying so in $TERM — so it is probed with a DA1 query
 * (`ESC [ c`), whose reply enumerates capabilities and lists `4` when the
 * terminal does sixel. That probe reads the tty directly and must run
 * BEFORE ncurses takes it over.
 *
 * Encoding is split from detection so the encoders stay pure enough to
 * test without a terminal: they take pixels or a file and write bytes to
 * a FILE*.
 */
#ifndef SHOTTINO_MEDIA_H
#define SHOTTINO_MEDIA_H

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

typedef enum {
    MEDIA_PROTO_NONE = 0,
    MEDIA_PROTO_SIXEL,
    MEDIA_PROTO_ITERM2,
    MEDIA_PROTO_KITTY
} media_protocol;

const char *media_protocol_name(media_protocol p);

/* Environment-only detection: no tty I/O, so it is safe anywhere and is
 * what tests exercise. Returns KITTY or ITERM2 when a terminal advertises
 * itself, else NONE — it never claims sixel, which needs the probe. */
media_protocol media_detect_env(void);

/* Full detection: `media_detect_env` first, then a DA1 probe for sixel
 * when that came back NONE. `fd` must be a tty; `timeout_ms` bounds the
 * wait so a terminal that ignores DA1 costs a short pause, not a hang.
 * Honours SHOTTINO_GRAPHICS=kitty|iterm2|sixel|none as an override, for
 * terminals that lie or that we cannot probe. */
media_protocol media_detect(int fd, int timeout_ms);

/* Parse a DA1 reply body for sixel support (capability `4`). Exposed for
 * tests: the reply is `ESC [ ? 62 ; 1 ; 4 ; 6 c` and the naive `strstr`
 * for "4" matches "64" and "14" too, which is the trap this avoids. */
bool media_da1_has_sixel(const char *reply);

/* ── Encoders ──────────────────────────────────────────────────────────
 * Each writes a complete, self-contained escape sequence to `out`.
 * `cols`/`rows` are the CELL box the image should occupy; the terminal
 * scales into it. Return false only on unusable input. */

/* iTerm2: OSC 1337 File= with base64 payload. Takes encoded image bytes
 * (PNG/JPEG) rather than pixels — the terminal decodes. */
bool media_emit_iterm2(const unsigned char *img, size_t len, int cols, int rows, FILE *out);

/* Kitty: APC _G with base64 PNG, chunked at 4096 bytes as the protocol
 * requires. Also takes encoded bytes. */
bool media_emit_kitty(const unsigned char *png, size_t len, int cols, int rows, FILE *out);

/* Sixel: takes RGB24 PIXELS, because sixel carries its own palette and
 * the encoder must quantize. `w`/`h` are pixel dimensions. Uses a fixed
 * 240-entry palette (the xterm cube + greys, shared with termcolor) and
 * Floyd–Steinberg dithering, which is what keeps a photograph from
 * banding at 240 colours. */
/* True when a `w` x `h` RGB image can be sixel-encoded without the
 * intermediate buffers (`w*h*3` ints for the dither pass, `w*h` bytes
 * for the palette indices) overflowing size_t. `media_emit_sixel`
 * refuses when this is false. Terminal-bounded callers never approach
 * the limit (#451 L1) — this guards a future caller with unbounded
 * dims. Exposed for tests. */
bool media_sixel_dims_ok(int w, int h);

bool media_emit_sixel(const unsigned char *rgb, int w, int h, FILE *out);

/* Cell box for an image of `img_w` x `img_h`, fitted inside `max_cols` x
 * `max_rows` while preserving aspect. Terminal cells are about twice as
 * tall as wide, which this accounts for — without it every image renders
 * squashed. */
void media_fit_cells(int img_w, int img_h, int max_cols, int max_rows, int *cols, int *rows);

/* ── Animation timing ──────────────────────────────────────────────────
 *
 * Which frame a clip should be showing, given a monotonic clock. Pure so
 * the wrap, the catch-up and the "not yet" cases can be tested without a
 * terminal or a decoder.
 *
 * `now_ms` is monotonic milliseconds; `*next_ms` is when the CURRENT
 * frame is due to be replaced, updated in place. Returns the frame index
 * to show. A clip whose deadline passed several frames ago (the client
 * was busy, or the terminal was not being drawn) advances by ONE and
 * re-bases its deadline to now rather than replaying the backlog at full
 * speed — catching up would look like a stutter, and nobody is counting
 * the frames of a background GIF. */
size_t media_frame_advance(size_t frame, size_t count, long frame_ms, long now_ms, long *next_ms);

/* True when `url` points at this deployment's own upload store: its host
 * equals `connect_host` or one of the `n_aliases` server-provided host
 * aliases (#324), AND its path is under /uploads/. The shottino twin of
 * cic's mediaLink.ts — both clients MUST agree on what is first-party
 * (one feature, one rule, every door). Host match is case-insensitive
 * and ignores scheme + port (aliases are bare hostnames; prod has minted
 * http:// under an https deployment). A NULL/empty alias list is the
 * restrictive fallback: only `connect_host` matches, never "any
 * /uploads/ host" — in doubt, do not treat as first-party. */
bool media_url_is_first_party(const char *url, const char *connect_host,
                              const char *const *aliases, size_t n_aliases);

#endif /* SHOTTINO_MEDIA_H */
