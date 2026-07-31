// Shottino, a standalone terminal client for grappa.
//
// Contract: authenticate against grappa's REST API, read scrollback via REST,
// send PRIVMSG/JOIN/PART via REST, and subscribe to Phoenix Channels for live
// typed JSON events. The client never parses IRC framing.

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <locale.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <ncurses.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <limits.h>
#include <dirent.h>

#include "alias.h"
#include "http.h"
#include "ircd.h"
#include "json.h"
#include "media.h"
#include "mirc.h"
#include "termcolor.h"
#include "wire.h"

#define MAX_TOKEN 4096
#define MAX_SUBJECT 512
#define MAX_NETWORKS 32
#define SHOTTINO_VERSION "0.1"
/* One column per step, and eight steps of stillness at each end. Fast
 * enough to finish a long topic while you read the channel, slow enough
 * not to be movement in the corner of your eye. */
#define TOPIC_SCROLL_MS 250
#define TOPIC_SCROLL_HOLD 8
#define MAX_WINDOWS 128
#define MAX_CHANNEL 256
#define MAX_SLUG 128
#define MAX_LINE 1024
#define MAX_TOPIC 4096
#define LOG_LINES 2000
#define HTTP_MAX (4 * 1024 * 1024)
#define WS_MAX_PAYLOAD (1024 * 1024)
#define JOB_QUEUE 256
#define SEEN_MESSAGES 12000
#define INPUT_HISTORY 200
#define PANEL_LINES 256
/* Four is a working limit, not a law: beyond it a pane is too small to
 * read a wrapped IRC line in, which is the point at which splitting
 * stops helping. */
#define MAX_PANES 4
#define MAX_LINK_REGIONS 256
/* How many decoded inline images to keep resident. Scrollback is long;
 * pictures are not, and each holds either a protocol payload or a pixel
 * buffer. Oldest slot is recycled. */
#define MAX_INLINE_MEDIA 24
/* Sentinel slot id for the full-screen preview, distinct from the inline
 * pool indices the decode job otherwise receives. */
#define MEDIA_SLOT_PREVIEW (-2)
#define INLINE_MAX_ROWS 14
/* Animation caps. Character-art frames are downsampled to the CELL grid
 * before they are stored, so a frame is a few kilobytes and 64 of them
 * is a rounding error — the scarce resources here are ncurses colour
 * pairs and ffmpeg time, not memory. 10fps is where motion reads as
 * motion in a terminal; more just spends pairs faster. */
#define MEDIA_ANIM_MAX_FRAMES 64
#define MEDIA_ANIM_FPS 10
#define MEDIA_ANIM_FPS_FILTER "fps=10,"
/* #451/#324 — cap on the deployment's HTTP host aliases retained from
 * /api/server-settings for first-party media classification. */
#define MAX_HTTP_ALIASES 16

enum color_pair {
    CP_MAIN = 1,
    CP_ALT,
    CP_BORDER,
    CP_ACCENT,
    CP_MUTED,
    CP_MENTION,
    CP_ERROR,
    CP_INPUT,
    CP_SELECTED,
    /* Chrome bands: see enum theme_color. Each band needs its own pairs
     * because a pair is (fg, bg) — text drawn in CP_ACCENT over the title
     * band would carry the CHAT background with it and punch a hole in
     * the band. */
    CP_TITLE,
    CP_TITLE_ACCENT,
    CP_STATUS,
    CP_STATUS_ERROR,
    CP_NICK0,
    CP_NICK1,
    CP_NICK2,
    CP_NICK3,
    CP_NICK4,
    CP_NICK5,
    CP_NICK6,
    CP_NICK7,
    CP_NICK8,
    CP_NICK9,
    CP_NICK10,
    CP_NICK11,
    CP_NICK12,
    CP_NICK13,
    CP_NICK14,
    CP_NICK15
};

enum theme_color {
    TC_BG = 16,
    TC_BG_ALT,
    TC_FG,
    TC_ACCENT,
    TC_MUTED,
    TC_BORDER,
    TC_MENTION,
    TC_ERROR,
    /* The chrome bands. The chat area is the only thing on screen that
     * scrolls, and it used to share its background with everything
     * around it — title, topic, status line and the input box all sat on
     * TC_BG, so the eye had a single-pixel border to tell them apart. A
     * band of its own per region says "this is not chat" without a
     * legend: cool above (title + topic), warm below (status), and a
     * lifted neutral for the input you type into. */
    TC_BG_TITLE,
    TC_TITLE_FG,
    TC_TITLE_ACCENT,
    TC_BG_STATUS,
    TC_STATUS_FG,
    TC_BG_INPUT,
    TC_NICK0,
    TC_NICK1,
    TC_NICK2,
    TC_NICK3,
    TC_NICK4,
    TC_NICK5,
    TC_NICK6,
    TC_NICK7,
    TC_NICK8,
    TC_NICK9,
    TC_NICK10,
    TC_NICK11,
    TC_NICK12,
    TC_NICK13,
    TC_NICK14,
    TC_NICK15
};

struct url {
    bool tls;
    char host[256];
    char port[16];
    char base[512];
};

struct http_response {
    int status;
    char *body;
    size_t body_len;
};

struct tls_conn {
    int fd;
    bool tls;
    SSL *ssl;
};

struct network {
    int id;
    char slug[MAX_SLUG];
    char nick[MAX_CHANNEL];
    /* ISUPPORT PREFIX, as parallel arrays: prefix_letters[i] is the mode
     * letter whose sigil is prefix_sigils[i], highest rank first. Empty
     * until the network sends 005, so the draw path falls back to the
     * conventional (qaohv) mapping rather than showing nothing. */
    char prefix_letters[16];
    char prefix_sigils[16];
    size_t prefix_count;
    /* Live per-session state mirrored off the user topic. */
    char umodes[32];
    bool away;
    char away_reason[MAX_LINE];
    wire_connection_state conn_state;
    bool conn_known;
    bool connecting;
};

/* Server-owned window state. Grappa owns this state machine; shottino
 * MIRRORS it and never originates a transition — same contract cicchetto
 * is held to. Adding a state here without a server change would be a
 * parallel client-side state machine, which is exactly what the project
 * invariant forbids.
 *
 *   pending  — JOIN sent, no terminal reply yet
 *   invited  — inbound INVITE we did not request; not joined, greyed
 *   joined   — in the channel
 *   failed   — JOIN rejected (reason + numeric explain why)
 *   kicked   — removed by an op (by + reason)
 *   parked   — the network itself is not connected
 */
enum window_state {
    WS_UNKNOWN = 0,
    WS_PENDING,
    WS_INVITED,
    WS_JOINED,
    WS_FAILED,
    WS_KICKED,
    WS_PARKED
};

struct member {
    char nick[MAX_CHANNEL];
    /* PREFIX SIGILS, not mode letters: the wire carries `["@"]`, `["+"]`,
     * `["@","+"]` (grappa's Identifier stores sigils; cic's tierRank
     * matches on them). Reading these as mode letters — which this client
     * did — matches nothing at all. */
    char modes[8];
};

struct window {
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    char topic[MAX_TOPIC];
    struct member members[512];
    size_t member_count;
    long last_id;
    unsigned unread;
    bool joined_ws;
    /* Mirrored window state + the metadata that explains a terminal one,
     * so the status line can say WHY a tab is dead rather than just
     * greying it. */
    enum window_state state;
    char state_detail[MAX_LINE];
    long failure_numeric;
    /* Server-owned read cursor for this (subject, network, channel). */
    long last_read_id;
    unsigned mentions;
    wire_counts_severity severity;
    /* Channel mode LETTERS currently set (from channel_modes_changed,
     * whose first delivery is the 324 snapshot the ircd sends on join).
     * `known` distinguishes "no modes set" from "never been told" — the
     * muted tier is only claimed when we actually know. */
    char chan_modes[128];
    bool chan_modes_known;
};

enum job_kind {
    JOB_FETCH,
    JOB_SEND,
    JOB_JOIN,
    JOB_PART,
    JOB_NICK,
    JOB_NETWORK_STATE,
    JOB_TOPIC,
    JOB_MEMBERS,
    JOB_CLOSE_QUERY,
    JOB_READ_CURSOR,
    JOB_MEDIA,
    JOB_VIEW,
    JOB_CHATHISTORY
};

struct job {
    enum job_kind kind;
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    char arg1[MAX_LINE];
    char arg2[MAX_LINE];
};

struct seen_message {
    long id;
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
};


struct pending_echo {
    unsigned long id;
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    char body[MAX_LINE];
};

enum panel_kind {
    PANEL_CHAT,
    PANEL_ARCHIVE,
    PANEL_SETTINGS,
    PANEL_ADMIN
};

/* An image attached to a scrollback row.
 *
 * Lifecycle is explicit because decoding is ASYNC: the UI thread never
 * waits on ffmpeg. A row starts IDLE, the draw path promotes it to
 * FETCHING when it first becomes visible (so we decode what is on screen
 * rather than everything ever linked), the worker fills it and marks it
 * READY or FAILED.
 *
 * `payload` holds a ready-to-write terminal escape when a graphics
 * protocol is in use; `rgb` holds pixels when falling back to character
 * art. Exactly one is populated. */
enum inline_state { IM_IDLE = 0, IM_FETCHING, IM_READY, IM_FAILED };

struct inline_media {
    /* Set when the URL is a clip — a video, or a GIF, which may or may
     * not turn out to have more than one frame. The decoder finds out;
     * this only says "worth asking". */
    bool is_animatable;
    char url[MAX_LINE];
    bool is_video;
    enum inline_state state;
    bool force_ascii;        /* /preview-ascii: skip any graphics protocol */
    int cols, rows;          /* cell box the image occupies */
    char *payload;           /* protocol escape bytes, or NULL */
    size_t payload_len;
    unsigned char *rgb;      /* art path: cols x (rows*2) RGB24, or NULL */
    /* Where it was last drawn, so a protocol image is re-emitted only
     * when its position actually moves. Re-emitting a multi-KB sixel
     * every 50 ms frame would saturate the tty for no benefit. */
    int drawn_y, drawn_x;
    bool drawn;
    /* The frame that last PAINTED this picture, against app->frame_seq.
     * `drawn` says a placement exists somewhere on the terminal; this
     * says whether the current frame still wants it there. The two
     * disagreeing is the definition of a stale placement — see
     * media_placements_drop_locked(). */
    unsigned long painted_frame;
    /* Animation. `rgb` holds frame_count frames back to back, each
     * rows*2 x cols pixels; frame_count == 1 is a still and every path
     * below degrades to exactly what it did before. */
    size_t frame_count;
    size_t frame;
    long frame_ms;
    long next_frame_ms;
};

/* What a URL points at, as far as this client cares. Declared up here
 * rather than beside media_kind_of() because both the link regions below
 * and the scrollback attach path need the COMPLETE type, and a forward
 * declaration cannot give an enum a size. */
enum media_kind { MEDIA_NONE = 0, MEDIA_IMAGE, MEDIA_VIDEO };

/* A clickable link rendered in the chat area. Recorded each draw() frame
 * (cleared at frame start) so mouse coordinates can be mapped back to the
 * URL under the cursor without re-deriving the wrapped layout.
 *
 * EVERY http(s) link gets a region, not just media: a link you can see is
 * a link you can click, and one that silently does nothing under the
 * cursor reads as a broken client. `kind` decides what the click does —
 * a picture previews in place, anything else opens in the browser. */
/* The topic band's rectangle, so the pointer resting on it can pause
 * the marquee. Recorded per frame like the link regions, and for the
 * same reason: the draw pass is the only thing that knows where it
 * ended up. */
struct topic_region {
    int y0, y1, x0, x1;
};

/* Where each pane ended up, so a wheel event can scroll the one under
 * the pointer rather than the one that happens to have focus — with two
 * panes on screen those are different answers, and the pointer is the
 * one the user meant. */
struct pane_region {
    int y0, y1, x0, x1;
    size_t pane;
};

struct link_region {
    int y0;
    int y1;
    int x0;
    int x1;
    bool is_video;
    enum media_kind kind;
    char url[MAX_LINE];
};

/* How the chat area is divided. One axis for the whole area rather than
 * a pane TREE: /split stacks, /splitv puts them side by side, and asking
 * for the other one re-lays the panes you already have. A tree would let
 * you nest arbitrarily, and nothing in the request needs that — but a
 * tree is also the thing you cannot retrofit cheaply, so the axis lives
 * in one enum and the layout in one function. */
enum split_axis { SPLIT_ROWS = 0, SPLIT_COLS };

struct pane {
    size_t window;          /* index into app->windows */
    size_t scroll_offset;   /* lines from the bottom of ITS window */
    bool scroll_pinned;
    size_t member_offset;   /* first roster row shown for it */
    /* Where the topic marquee has got to, and when it last moved. Per
     * pane, because two panes showing the same channel are two views of
     * it and a shared position would jump in both. */
    size_t topic_scroll;
    long topic_scroll_at;
    int weight;             /* share of the axis; equal by default */
};

/* A message row on screen, so a right-click can name the message under
 * the pointer. Sibling of link_region: same lifetime (rebuilt every
 * frame), same reason (the wrapped layout is not re-derivable from a
 * coordinate afterwards). */
struct msg_region {
    int y0, y1, x0, x1;
    char nick[MAX_CHANNEL];
    char body[MAX_LINE];
};

/* ── The overlay ───────────────────────────────────────────────────────
 *
 * Two things asked for a floating list — a right-click menu on a message
 * and a Ctrl-R reply picker — so there is ONE, with a kind. The items are
 * built by overlay_items(), called by BOTH the draw and the activation:
 * a list you draw from one source and act on from another is a list that
 * eventually acts on the row above the one you clicked. Same rule as the
 * chat area's measure/draw agreement, for the same reason. */
enum overlay_kind { OVERLAY_NONE = 0, OVERLAY_MENU, OVERLAY_REPLY, OVERLAY_MEDIA };

enum overlay_action { ACT_NONE = 0, ACT_REPLY, ACT_QUERY, ACT_WHOIS, ACT_INSERT, ACT_PREVIEW, ACT_VIEW };

/* How many entries a picker offers. Twenty is what fits the phrase "the
 * last twenty" and comfortably more than a box shows, which is why the
 * list scrolls under the selection. */
#define PICKER_MAX 20

struct overlay_item {
    char label[MAX_LINE];
    char nick[MAX_CHANNEL];
    /* What they said, so the reply can cite it. The label is for the
     * eye and carries the nick column; this is the raw text. */
    char body[MAX_LINE];
    enum overlay_action action;
};

struct overlay {
    enum overlay_kind kind;
    int x, y;                 /* anchor (menu only) */
    size_t sel;
    /* First entry shown. A picker offers more entries than the box has
     * rows, so the window into the list follows the selection — without
     * it, choosing the eighteenth of twenty means selecting something
     * nobody can see. */
    size_t top;
    char filter[64];          /* picker: matches nick OR message text */
    char nick[MAX_CHANNEL];   /* menu: whose message was clicked */
    char body[MAX_LINE];
    /* Media picker: what Enter does with the URL, decided by the command
     * that opened it (/preview or /view) rather than by the list. */
    enum overlay_action pick_action;
};

/* ── The downstream IRC server (--ircd) ────────────────────────────────
 *
 * With --ircd, shottino runs headless and listens as an IRC SERVER, so a
 * normal client — irssi, hexchat, weechat — connects to it and reaches
 * grappa through it. Everything above this point is reused unchanged:
 * the same REST calls, the same websocket, the same app state, the same
 * worker. Only the front end differs, which is why this is a mode of
 * shottino rather than a second program.
 *
 * Two decisions shape the rest.
 *
 * ONE CONNECTION IS ONE NETWORK. An IRC client has one nick, one MOTD
 * and one channel namespace per connection; grappa has several networks
 * at once, and #ops on two of them is two different rooms. Folding them
 * into a single connection means renaming channels to keep them apart,
 * which breaks every client's idea of what a channel is called and every
 * config the user already has. So a client says which network it wants
 * and gets that one — three networks is three connections, which is how
 * people already use bouncers. The network is named in PASS
 * ("network:secret"), because a password is a string every client can
 * already send without needing a plugin.
 *
 * THE PASSWORD IS REQUIRED OFF LOOPBACK. This bridge hands over the
 * user's entire IRC session — every channel, every DM, and the ability
 * to speak as them. On 127.0.0.1 that is bounded by "who can run
 * processes as you"; on any other address it is bounded by nothing at
 * all. A non-loopback bind without SHOTTINO_IRCD_PASS therefore refuses
 * to start rather than quietly listening.
 *
 * The protocol grammar lives in ircd.c, where it can be tested without a
 * socket. What is here is the part that needs the app: sockets, state,
 * and translation in both directions. */

#define IRCD_SERVER "grappa"
#define IRCD_MAX_CLIENTS 8
#define IRCD_IN_MAX 8192
#define IRCD_OUT_MAX (1024 * 1024)
#define IRCD_HISTORY 1024
#define IRCD_LISTEN_MAX 4

struct ircd_client {
    int fd;
    char in[IRCD_IN_MAX];
    size_t in_len;
    /* Output is buffered on the heap and grows only for a client that is
     * not reading. A bridge must never block its own event loop on a
     * downstream socket, so a client that will not drain is dropped
     * rather than allowed to stall the others — an ircd's SendQ. */
    char *out;
    size_t out_len, out_cap;
    bool registered, got_nick, got_user, cap_negotiating, closing;
    bool cap_server_time, cap_multi_prefix, cap_echo;
    bool cap_tags, cap_batch, cap_chathistory;
    unsigned batch_seq;
    char nick[MAX_CHANNEL];
    char user[64];
    char network[MAX_SLUG];
    char pass[256];
    /* Never reused. An archive query is answered by the worker, seconds
     * after it was asked, and by then this slot may hold somebody else:
     * the reply carries this number and is dropped if it no longer
     * matches. Without it, a slow query delivers one user's history into
     * another user's client. */
    unsigned long id;
};

/* Recent messages, kept STRUCTURALLY so a client connecting later can be
 * given what it missed. shottino already fetches scrollback at startup
 * and on join, and every row passes through render_message, so this ring
 * fills itself from what was fetched anyway: no extra request, and no
 * duplicate history when a second client connects. */
struct ircd_hist {
    /* grappa's scrollback id, which is what a client points at with
     * msgid= — the same identity the dedup in render_message uses, so
     * "the message with this id" means one thing everywhere. */
    long id;
    long server_time;
    wire_message_kind kind;
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    char sender[MAX_CHANNEL];
    char body[MAX_LINE];
};

struct ircd {
    bool enabled;
    char host[128];
    char port[16];
    char secret[128];
    bool secret_required;
    int listen_fd[IRCD_LISTEN_MAX];
    size_t listen_count;
    /* Its own lock. The tee runs on whichever thread delivered the
     * message (socket or worker); everything else runs on the main
     * thread. Held only around bridge state, and NEVER while calling
     * anything that takes app->lock — that ordering rule is what keeps
     * the two locks from ever deadlocking. */
    pthread_mutex_t lock;
    struct ircd_client clients[IRCD_MAX_CLIENTS];
    unsigned long next_client_id;
    /* --ircd-archive: let CHATHISTORY reach past what this session has
     * seen, at the cost of a REST query per request. Off by default —
     * see ircd_cmd_chathistory. */
    bool archive;
    struct ircd_hist hist[IRCD_HISTORY];
    size_t hist_count, hist_next;
};


struct app {
    struct url url;
    char token[MAX_TOKEN];
    char token_path[PATH_MAX];
    char subject[MAX_SUBJECT];
    char login_nick[MAX_CHANNEL];
    struct network networks[MAX_NETWORKS];
    size_t network_count;
    struct window windows[MAX_WINDOWS];
    size_t window_count;
    /* Panes divide the chat area; each shows one window and carries the
     * state that is about the VIEW rather than the window — where you
     * scrolled it, where you scrolled its roster. Two panes on the same
     * channel are two independent views of it, which is most of the
     * point of splitting.
     *
     * "The current window" is DERIVED from the focused pane
     * (focused_window_locked) rather than stored beside it: one number
     * that can disagree with another is a number that eventually will. */
    struct pane panes[MAX_PANES];
    size_t pane_count;
    size_t focus;
    enum split_axis split;
    char *log[LOG_LINES];
    bool log_mentions[LOG_LINES];
    bool log_pending[LOG_LINES];
    /* Scrollback id per log row (0 = not a scrollback message). Lets the
     * unread divider be placed at the exact row the server's read cursor
     * points at, rather than guessed from position. */
    long log_ids[LOG_LINES];
    size_t log_count;
    struct pending_echo pending[256];
    size_t pending_count;
    unsigned long next_pending_id;
    enum panel_kind panel;
    char *panel_lines[PANEL_LINES];
    size_t panel_line_count;
    struct seen_message seen[SEEN_MESSAGES];
    size_t seen_count;
    size_t seen_next;
    char input[MAX_LINE];
    size_t input_len;
    char last_url[MAX_LINE];
    /* Most recent IMAGE/VIDEO link, for keyboard-driven /preview. */
    char last_media_url[MAX_LINE];
    bool last_media_is_video;
    char hover_url[MAX_LINE];
    struct link_region link_regions[MAX_LINK_REGIONS];
    size_t link_region_count;
    struct msg_region msg_regions[MAX_LINK_REGIONS];
    size_t msg_region_count;
    struct topic_region topic_regions[MAX_PANES];
    size_t topic_region_count;
    struct pane_region pane_regions[MAX_PANES];
    size_t pane_region_count;
    bool topic_hover;
    struct overlay overlay;
    struct inline_media media[MAX_INLINE_MEDIA];
    /* The full-screen preview gets its OWN slot so opening one never
     * evicts an inline image that is currently on screen. */
    struct inline_media preview;
    bool preview_pending;
    size_t media_count;
    size_t media_next;              /* recycle cursor */
    /* Bumped once per draw(), so a picture can say which frame last
     * painted it. Wrapping after 2^64 frames is not a scenario. */
    unsigned long frame_seq;
    /* Index into `media` per log row, or -1. Parallel to log[] like the
     * mention/pending/id arrays. */
    int log_media[LOG_LINES];
    /* The window each row belongs to, "[network/channel]", or "" for a
     * row that predates every window. See log_scope_of_locked(). */
    char log_scope[LOG_LINES][MAX_SLUG + MAX_CHANNEL + 8];
    media_protocol proto;           /* detected once, before ncurses */
    /* --ircd: the downstream IRC server. Zeroed (and disabled) in every
     * other mode, so the tee in render_message costs one branch. */
    struct ircd ircd;
    /* Read by ircd_start, which memsets the struct above and so cannot
     * be handed the flag through it. */
    bool ircd_archive_wanted;
    /* Headless: no terminal to draw on, so the operational log goes to
     * stderr where a service manager can collect it. */
    bool headless;
    /* /view downloads here, and the directory goes at exit: a session
     * that opens fifty pictures must not leave fifty files behind. */
    char view_dir[1024];
    unsigned view_seq;
    /* Ctrl-U hands the arrow keys to the member list.
     *
     * The modified arrows the roster was reachable by are not reliably
     * DELIVERED: Ctrl-Shift-Up/Down is a scroll shortcut in the terminal
     * itself on gnome-terminal, konsole, kitty and terminator, so it
     * never reaches the client, and plenty of terminfo entries describe
     * no modified arrows at all. A plain control character and plain
     * arrows are the two things every terminal sends, so the way in
     * cannot be swallowed. The shortcuts stay for terminals that do
     * deliver them. */
    bool roster_focus;
    bool key_echo;
    bool animate_media;
    bool inline_media_enabled;
    /* #451 opt-in: also auto-render media from hosts that are NOT this
     * deployment's. OFF by default and deliberately not persisted — see
     * the /media command for what it costs. */
    bool inline_media_peers;
    /* #451/#324 — this deployment's HTTP host aliases (from
     * /api/server-settings). With app->url.host they define which
     * /uploads/ links are first-party and may auto-render inline; every
     * other peer URL stays click-to-preview. Empty = restrictive (only
     * the connect host). The shottino twin of cic's mediaLink.ts set. */
    char http_host_aliases[MAX_HTTP_ALIASES][256];
    size_t http_host_alias_count;
    char history[INPUT_HISTORY][MAX_LINE];
    size_t history_count;
    size_t history_pos;
    struct alias_table aliases;
    /* Mouse tracking preference. OFF by default: tracking necessarily
     * suppresses the terminal's own copy/paste selection, and for a
     * terminal client selection matters far more day-to-day than
     * click-to-preview — which `/preview` provides from the keyboard
     * anyway. `/mouse on` opts back in. */
    bool mouse_enabled;
    bool running;
    pthread_mutex_t lock;
    pthread_mutex_t jobs_lock;
    pthread_cond_t jobs_cond;
    pthread_t worker;
    struct job jobs[JOB_QUEUE];
    size_t jobs_head;
    size_t jobs_tail;
    bool worker_stop;
    struct tls_conn ws;
    bool ws_connected;
    unsigned long ws_ref;
    time_t next_heartbeat;
    /* Reconnect state: current backoff in seconds (0 = healthy) and the
     * earliest time the next attempt may run. */
    int ws_backoff;
    time_t ws_retry_at;
    SSL_CTX *ssl_ctx;
};

static void die(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void startup(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

static void die(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    exit(1);
}

static void startup(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("shottino: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    va_end(ap);
}

static char *xasprintf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

static char *xasprintf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) die("format failed");
    char *s = malloc((size_t)n + 1);
    if (!s) die("out of memory");
    vsnprintf(s, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    return s;
}

static void log_line(struct app *app, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void log_line_mention(struct app *app, bool mention, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
static size_t focused_window_locked(struct app *app);

/* ── IRC identifier casemapping ────────────────────────────────────────
 *
 * IRC names are case-INSENSITIVE, so `#Chan` and `#chan`, `AzzuRRa` and
 * `azzurra` are ONE window and not two. This client compared them with
 * strcmp everywhere, which is why the same channel opened twice and why
 * a message spelled differently from its window landed in neither.
 *
 * The fold itself is `ircd_fold` / `ircd_name_equal` in ircd.c, and it
 * is ASCII-ONLY — see `fold_char` there for why `[ ] \ ~` are ordinary
 * characters and why bytes above 127 are left alone. ONE fold in this
 * binary: the bridge and the app agreeing on what a name IS is the
 * point, and a second implementation here is what would drift.
 * Server-side twin: `Grappa.IRC.Identifier.canonical_nick/1` and
 * `canonical_channel/1` (CLAUDE.md, #525).
 *
 * strcasecmp is NOT this function: under a non-C locale it folds bytes
 * above 127 as well, which would merge exactly the pairs the ircd keeps
 * apart. */
static bool irc_name_eq(const char *a, const char *b) {
    return ircd_name_equal(a, b);
}

/* The canonical key a log row is filed under, "[network/channel]".
 *
 * FOLDED at the one door, so every later comparison is a plain strcmp
 * that cannot forget to fold — the same "canonical storage + `==`"
 * shape the server uses for its channel-keyed tables. The key is
 * internal bookkeeping; what the row DISPLAYS keeps the case it
 * arrived with (the prefix is stripped before drawing anyway). */
static void window_scope_key(const char *network, const char *channel, char *out, size_t out_sz) {
    char net[MAX_SLUG], chan[MAX_CHANNEL];
    ircd_fold(network, net, sizeof(net));
    ircd_fold(channel, chan, sizeof(chan));
    snprintf(out, out_sz, "[%s/%s]", net, chan);
}

/* Is this window the one named by (network, channel)? Every window
 * lookup in the client goes through here, so a new one cannot forget
 * the fold and quietly open a second `#Chan` beside `#chan`. */
static bool window_matches(const struct window *w, const char *network, const char *channel) {
    return irc_name_eq(w->network, network) && irc_name_eq(w->channel, channel);
}

/* The synthetic per-network window server replies land in. A name, not a
 * spelling: compared folded like every other IRC identifier. */
#define SERVER_WINDOW "$server"

static bool is_server_window(const char *channel) {
    return irc_name_eq(channel, SERVER_WINDOW);
}

/* ── The log ring ──────────────────────────────────────────────────────
 *
 * One text array and five parallel ones: mention, pending-echo, server
 * id, media slot, scope. Parallel arrays drift — the ring shift was
 * copy-pasted three times and the compaction once more, and twice a new
 * array reached some copies and not the others, which is how the unread
 * divider and the inline images ended up bound to the wrong rows after
 * a /clear.
 *
 * So exactly TWO functions know the full set: the shift that drops the
 * oldest row, and the move that compacts one. A NEW per-row array goes
 * in both, or it drifts again. */
static void log_shift_locked(struct app *app) {
    free(app->log[0]);
    memmove(app->log, app->log + 1, sizeof(app->log[0]) * (LOG_LINES - 1));
    memmove(app->log_mentions, app->log_mentions + 1, sizeof(app->log_mentions[0]) * (LOG_LINES - 1));
    memmove(app->log_pending, app->log_pending + 1, sizeof(app->log_pending[0]) * (LOG_LINES - 1));
    memmove(app->log_ids, app->log_ids + 1, sizeof(app->log_ids[0]) * (LOG_LINES - 1));
    memmove(app->log_media, app->log_media + 1, sizeof(app->log_media[0]) * (LOG_LINES - 1));
    memmove(app->log_scope, app->log_scope + 1, sizeof(app->log_scope[0]) * (LOG_LINES - 1));
    app->log_count--;
}

static void log_row_move_locked(struct app *app, size_t dst, size_t src) {
    if (dst == src) return;
    app->log[dst] = app->log[src];
    app->log_mentions[dst] = app->log_mentions[src];
    app->log_pending[dst] = app->log_pending[src];
    app->log_ids[dst] = app->log_ids[src];
    app->log_media[dst] = app->log_media[src];
    memcpy(app->log_scope[dst], app->log_scope[src], sizeof(app->log_scope[dst]));
}

/* Which window a row belongs to, as "[network/channel]".
 *
 * A chat row names its window in its own prefix. An operational row —
 * preview progress, an upload result, a command's answer, a WHOIS —
 * names nothing, and used to be shown in EVERY window: switch away from
 * the channel where you typed /preview and its output followed you, and
 * stayed. Those rows belong to the window that was focused when they
 * were written, which is both where they happened and where the user
 * will look for them after switching back.
 *
 * Decided HERE, at the only door into the buffer, and never at the draw
 * site: a scope computed while drawing is a scope that changes when the
 * focus does, which is the bug. Caller holds app->lock. */
static void log_scope_of_locked(struct app *app, const char *line, char *out, size_t out_sz) {
    if (line[0] == '[') {
        const char *close = strchr(line, ']');
        size_t n = close ? (size_t)(close - line) + 1 : 0;
        char raw[MAX_SLUG + MAX_CHANNEL + 8];
        if (n && n < out_sz && n < sizeof(raw)) {
            /* FOLDED on the way in, so a row that says `[azzurra/#Chan]`
             * files under the same key as its `#chan` window. */
            memcpy(raw, line, n);
            raw[n] = 0;
            ircd_fold(raw, out, out_sz);
            return;
        }
    }
    size_t cur = focused_window_locked(app);
    if (cur < app->window_count) {
        /* Formatted via a local: `out` points INTO app (the scope array),
         * and so do the arguments, which the compiler cannot prove is
         * not an overlapping copy. */
        const struct window *w = &app->windows[cur];
        char scope[MAX_SLUG + MAX_CHANNEL + 8];
        window_scope_key(w->network, w->channel, scope, sizeof(scope));
        snprintf(out, out_sz, "%s", scope);
    } else {
        out[0] = 0; /* before any window exists: nowhere to file it, show it everywhere */
    }
}

/* Append a row. Takes ownership of `line`. Caller holds app->lock. */
static void log_push_locked(struct app *app, char *line, bool mention, bool pending) {
    if (app->log_count == LOG_LINES) log_shift_locked(app);
    size_t i = app->log_count;
    app->log[i] = line;
    app->log_mentions[i] = mention;
    app->log_pending[i] = pending;
    app->log_ids[i] = 0;
    app->log_media[i] = -1;
    log_scope_of_locked(app, line, app->log_scope[i], sizeof(app->log_scope[i]));
    app->log_count++;
    /* Headless there is no window to file it under and nobody to read
     * it: the same line goes to stderr, which is where a service manager
     * or a terminal running --ircd will look for it. */
    if (app->headless) fprintf(stderr, "%s\n", line);
}

/* Does row `i` belong in the window whose scope is `scope`? A row with
 * no scope at all (written before any window existed) is shown
 * everywhere — the alternative is a startup diagnostic nobody can
 * reach. */
static bool log_row_in_scope(const struct app *app, size_t i, const char *scope) {
    return app->log_scope[i][0] == 0 || strcmp(app->log_scope[i], scope) == 0;
}

static void log_line(struct app *app, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    char *s = malloc((size_t)n + 1);
    if (!s) return;
    vsnprintf(s, (size_t)n + 1, fmt, ap2);
    va_end(ap2);

    pthread_mutex_lock(&app->lock);
    log_push_locked(app, s, false, false);
    pthread_mutex_unlock(&app->lock);
}

static void log_line_mention(struct app *app, bool mention, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    char *s = malloc((size_t)n + 1);
    if (!s) return;
    vsnprintf(s, (size_t)n + 1, fmt, ap2);
    va_end(ap2);

    pthread_mutex_lock(&app->lock);
    log_push_locked(app, s, mention, false);
    pthread_mutex_unlock(&app->lock);
}

static void add_pending_echo(struct app *app, const char *network, const char *channel, const char *sender, const char *body) {
    char clock[16];
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    strftime(clock, sizeof(clock), "%H:%M", &tm);
    char *line = xasprintf("[%s/%s] %s <%s> %s", network, channel, clock, sender && sender[0] ? sender : "me", body);
    pthread_mutex_lock(&app->lock);
    log_push_locked(app, line, false, true);
    if (app->pending_count < sizeof(app->pending) / sizeof(app->pending[0])) {
        struct pending_echo *p = &app->pending[app->pending_count++];
        p->id = ++app->next_pending_id;
        snprintf(p->network, sizeof(p->network), "%s", network);
        snprintf(p->channel, sizeof(p->channel), "%s", channel);
        snprintf(p->body, sizeof(p->body), "%s", body);
    }
    for (size_t p = 0; p < app->pane_count; p++) {
        app->panes[p].scroll_offset = 0;
        app->panes[p].scroll_pinned = false;
        app->panes[p].member_offset = 0;
    }
    pthread_mutex_unlock(&app->lock);
}

static void clear_matching_pending_echo(struct app *app, const char *network, const char *channel, const char *body) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->log_count; i++) {
        if (!app->log_pending[i]) continue;
        if (strstr(app->log[i], body) && strstr(app->log[i], network) && strstr(app->log[i], channel)) {
            free(app->log[i]);
            memmove(app->log + i, app->log + i + 1, sizeof(app->log[0]) * (app->log_count - i - 1));
            memmove(app->log_mentions + i, app->log_mentions + i + 1, sizeof(app->log_mentions[0]) * (app->log_count - i - 1));
            memmove(app->log_pending + i, app->log_pending + i + 1, sizeof(app->log_pending[0]) * (app->log_count - i - 1));
            app->log_count--;
            break;
        }
    }
    for (size_t i = 0; i < app->pending_count; i++) {
        if (irc_name_eq(app->pending[i].network, network) && irc_name_eq(app->pending[i].channel, channel) && strcmp(app->pending[i].body, body) == 0) {
            memmove(app->pending + i, app->pending + i + 1, sizeof(app->pending[0]) * (app->pending_count - i - 1));
            app->pending_count--;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

/* Caller holds app->lock. */
static void clear_panel_lines_locked(struct app *app) {
    for (size_t i = 0; i < app->panel_line_count; i++) free(app->panel_lines[i]);
    app->panel_line_count = 0;
}

static void panel_line(struct app *app, const char *fmt, ...) __attribute__((format(printf, 2, 3)));

/* Appends one panel row. Takes the lock itself: panel population runs on
 * the command thread and issues blocking HTTP between rows, so it cannot
 * hold the lock across the whole build — the draw thread would stall for
 * the duration of every request. Locking per row means a panel paints
 * progressively instead, which is also the better behaviour. */
static void panel_line(struct app *app, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    char *s = malloc((size_t)n + 1);
    if (!s) return;
    vsnprintf(s, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    pthread_mutex_lock(&app->lock);
    if (app->panel_line_count < PANEL_LINES) app->panel_lines[app->panel_line_count++] = s;
    else free(s);
    pthread_mutex_unlock(&app->lock);
}

/* Monotonic milliseconds. CLOCK_MONOTONIC, so a clock adjustment cannot
 * make a GIF freeze or sprint. */
static long monotonic_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static short rgb_component(int hex, int shift) {
    return (short)((((hex >> shift) & 0xff) * 1000) / 255);
}

static void define_color(short id, int hex) {
    if (can_change_color()) init_color(id, rgb_component(hex, 16), rgb_component(hex, 8), rgb_component(hex, 0));
}

static void init_theme(void) {
    if (!has_colors()) return;
    start_color();
    use_default_colors();

    define_color(TC_BG, 0x0a0a0a);
    define_color(TC_BG_ALT, 0x111111);
    define_color(TC_FG, 0xe0e0e0);
    define_color(TC_ACCENT, 0x5fafd7);
    define_color(TC_MUTED, 0x707070);
    define_color(TC_BORDER, 0x1f1f1f);
    define_color(TC_MENTION, 0x2a1f00);
    define_color(TC_ERROR, 0xd77070);
    define_color(TC_BG_TITLE, 0x152029);
    define_color(TC_TITLE_FG, 0xc2dced);
    define_color(TC_TITLE_ACCENT, 0x7fc8ea);
    define_color(TC_BG_STATUS, 0x241c14);
    define_color(TC_STATUS_FG, 0xc8b193);
    define_color(TC_BG_INPUT, 0x1c1c1c);
    define_color(TC_NICK0, 0xff8c8c);
    define_color(TC_NICK1, 0xffb060);
    define_color(TC_NICK2, 0xffd060);
    define_color(TC_NICK3, 0xd8e060);
    define_color(TC_NICK4, 0x90d870);
    define_color(TC_NICK5, 0x60d8a8);
    define_color(TC_NICK6, 0x60d8d8);
    define_color(TC_NICK7, 0x60b8e8);
    define_color(TC_NICK8, 0x88a8ff);
    define_color(TC_NICK9, 0xb890ff);
    define_color(TC_NICK10, 0xe088e0);
    define_color(TC_NICK11, 0xff90c0);
    define_color(TC_NICK12, 0xe0a888);
    define_color(TC_NICK13, 0xc0c0c0);
    define_color(TC_NICK14, 0xa0e8b8);
    define_color(TC_NICK15, 0xf0d090);

    init_pair(CP_MAIN, TC_FG, TC_BG);
    init_pair(CP_ALT, TC_FG, TC_BG_ALT);
    init_pair(CP_BORDER, TC_BORDER, TC_BG);
    init_pair(CP_ACCENT, TC_ACCENT, TC_BG);
    init_pair(CP_MUTED, TC_MUTED, TC_BG);
    init_pair(CP_MENTION, TC_FG, TC_MENTION);
    init_pair(CP_ERROR, TC_ERROR, TC_BG);
    init_pair(CP_INPUT, TC_FG, TC_BG_INPUT);
    init_pair(CP_SELECTED, TC_ACCENT, TC_BORDER);
    init_pair(CP_TITLE, TC_TITLE_FG, TC_BG_TITLE);
    init_pair(CP_TITLE_ACCENT, TC_TITLE_ACCENT, TC_BG_TITLE);
    init_pair(CP_STATUS, TC_STATUS_FG, TC_BG_STATUS);
    init_pair(CP_STATUS_ERROR, TC_ERROR, TC_BG_STATUS);
    for (short i = 0; i < 16; i++) init_pair((short)(CP_NICK0 + i), (short)(TC_NICK0 + i), TC_BG);
    bkgd(COLOR_PAIR(CP_MAIN));
}

static unsigned long djb2(const char *s) {
    unsigned long hash = 5381;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) hash = ((hash << 5) + hash) + *p;
    return hash;
}

static int nick_pair(const char *nick) {
    return CP_NICK0 + (int)(djb2(nick) % 16);
}

static char *url_encode(const char *s) {
    static const char *hex = "0123456789ABCDEF";
    size_t len = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (isalnum(*p) || *p == '-' || *p == '_' || *p == '.' || *p == '~') len++;
        else len += 3;
    }
    char *out = malloc(len + 1);
    if (!out) die("out of memory");
    char *w = out;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (isalnum(*p) || *p == '-' || *p == '_' || *p == '.' || *p == '~') {
            *w++ = (char)*p;
        } else {
            *w++ = '%';
            *w++ = hex[*p >> 4];
            *w++ = hex[*p & 15];
        }
    }
    *w = 0;
    return out;
}

static char *url_decode(const char *s) {
    size_t n = strlen(s);
    char *out = malloc(n + 1);
    if (!out) die("out of memory");
    size_t j = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '%' && i + 2 < n && isxdigit((unsigned char)s[i + 1]) && isxdigit((unsigned char)s[i + 2])) {
            out[j++] = (char)((hexval(s[i + 1]) << 4) | hexval(s[i + 2]));
            i += 2;
        } else {
            out[j++] = s[i];
        }
    }
    out[j] = 0;
    return out;
}

static char *dup_range(const char *s, size_t len) {
    char *out = malloc(len + 1);
    if (!out) die("out of memory");
    memcpy(out, s, len);
    out[len] = 0;
    return out;
}

// Split a share link `https://host[:port]/share/<token>` (the URL cic mints,
// `${origin}/share/${token}`) into its base origin and the percent-decoded
// token. Tolerates a hash-router artifact (`.../#/share/<token>`) and trailing
// query/fragment after the token. Returns false if no `/share/` segment.
static bool split_share_url(const char *url, char **base_out, char **token_out) {
    const char *marker = strstr(url, "/share/");
    if (!marker) return false;
    const char *tok = marker + 7; // strlen("/share/")
    size_t toklen = strcspn(tok, "?#");
    if (toklen == 0) return false;
    char *raw = dup_range(tok, toklen);
    *token_out = url_decode(raw);
    free(raw);
    size_t baselen = (size_t)(marker - url);
    if (baselen >= 2 && strncmp(marker - 2, "/#", 2) == 0) baselen -= 2; // strip hash-router "/#"
    *base_out = dup_range(url, baselen);
    return true;
}

static char *json_escape(const char *s) {
    size_t len = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '"': case '\\': case '\b': case '\f': case '\n': case '\r': case '\t': len += 2; break;
        default: len += (*p < 0x20) ? 6 : 1; break;
        }
    }
    char *out = malloc(len + 1);
    if (!out) die("out of memory");
    char *w = out;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '"': *w++ = '\\'; *w++ = '"'; break;
        case '\\': *w++ = '\\'; *w++ = '\\'; break;
        case '\b': *w++ = '\\'; *w++ = 'b'; break;
        case '\f': *w++ = '\\'; *w++ = 'f'; break;
        case '\n': *w++ = '\\'; *w++ = 'n'; break;
        case '\r': *w++ = '\\'; *w++ = 'r'; break;
        case '\t': *w++ = '\\'; *w++ = 't'; break;
        default:
            if (*p < 0x20) {
                sprintf(w, "\\u%04x", *p);
                w += 6;
            } else {
                *w++ = (char)*p;
            }
        }
    }
    *w = 0;
    return out;
}

static bool parse_url(const char *raw, struct url *out) {
    memset(out, 0, sizeof(*out));
    const char *p = raw;
    if (strncmp(p, "https://", 8) == 0) {
        out->tls = true;
        p += 8;
        strcpy(out->port, "443");
    } else if (strncmp(p, "http://", 7) == 0) {
        out->tls = false;
        p += 7;
        strcpy(out->port, "80");
    } else {
        return false;
    }

    const char *slash = strchr(p, '/');
    const char *end = slash ? slash : p + strlen(p);
    const char *colon = memchr(p, ':', (size_t)(end - p));
    size_t host_len = colon ? (size_t)(colon - p) : (size_t)(end - p);
    if (host_len == 0 || host_len >= sizeof(out->host)) return false;
    memcpy(out->host, p, host_len);
    out->host[host_len] = 0;
    if (colon) {
        size_t port_len = (size_t)(end - colon - 1);
        if (port_len == 0 || port_len >= sizeof(out->port)) return false;
        memcpy(out->port, colon + 1, port_len);
        out->port[port_len] = 0;
    }
    snprintf(out->base, sizeof(out->base), "%s://%s%s%s",
             out->tls ? "https" : "http", out->host,
             (strcmp(out->port, out->tls ? "443" : "80") == 0) ? "" : ":",
             (strcmp(out->port, out->tls ? "443" : "80") == 0) ? "" : out->port);
    return true;
}

static int connect_tcp(const char *host, const char *port) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    struct addrinfo *res = NULL;
    int err = getaddrinfo(host, port, &hints, &res);
    if (err != 0) return -1;
    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

/* Open a connection to an EXPLICIT host, so the same TLS setup serves
 * both the grappa connection and a one-off fetch of a link somebody
 * pasted (/view). The hostname is bound for verification either way —
 * a third-party host gets the same check the bouncer does. */
static bool conn_open_to(struct app *app, const char *host, const char *port, bool use_tls,
                         struct tls_conn *conn) {
    memset(conn, 0, sizeof(*conn));
    conn->fd = connect_tcp(host, port);
    if (conn->fd < 0) return false;
    conn->tls = use_tls;
    if (conn->tls) {
        conn->ssl = SSL_new(app->ssl_ctx);
        if (!conn->ssl) return false;
        SSL_set_fd(conn->ssl, conn->fd);
        SSL_set_tlsext_host_name(conn->ssl, host);
        /* SNI (above) only NAMES the host in the ClientHello — it does not
         * make OpenSSL verify anything. SSL_VERIFY_PEER (see ssl_ctx setup)
         * validates the certificate CHAIN but NOT that the cert belongs to
         * this host, so without binding the expected name any CA-signed cert
         * for ANY domain passes: an active MITM could present a valid cert
         * for attacker.example and read the bearer token we send on this
         * connection. SSL_set1_host makes the handshake fail on a hostname
         * mismatch — the client twin of the server's #89 hostname check. */
        if (SSL_set1_host(conn->ssl, host) != 1) return false;
        if (SSL_connect(conn->ssl) != 1) return false;
    }
    return true;
}

static bool conn_open(struct app *app, struct tls_conn *conn) {
    return conn_open_to(app, app->url.host, app->url.port, app->url.tls, conn);
}

static void conn_close(struct tls_conn *conn) {
    if (conn->ssl) {
        SSL_shutdown(conn->ssl);
        SSL_free(conn->ssl);
    }
    if (conn->fd >= 0) close(conn->fd);
    memset(conn, 0, sizeof(*conn));
    conn->fd = -1;
}

static ssize_t conn_write(struct tls_conn *conn, const void *buf, size_t len) {
    if (conn->tls) return SSL_write(conn->ssl, buf, (int)len);
    return write(conn->fd, buf, len);
}

static ssize_t conn_read(struct tls_conn *conn, void *buf, size_t len) {
    if (conn->tls) return SSL_read(conn->ssl, buf, (int)len);
    return read(conn->fd, buf, len);
}

static bool conn_write_all(struct tls_conn *conn, const char *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = conn_write(conn, buf + off, len - off);
        if (n <= 0) return false;
        off += (size_t)n;
    }
    return true;
}

static char *read_all(struct tls_conn *conn, size_t *out_len) {
    size_t cap = 8192;
    size_t len = 0;
    char *buf = malloc(cap + 1);
    if (!buf) die("out of memory");
    for (;;) {
        if (len == cap) {
            cap *= 2;
            if (cap > HTTP_MAX) die("HTTP response too large");
            buf = realloc(buf, cap + 1);
            if (!buf) die("out of memory");
        }
        ssize_t n = conn_read(conn, buf + len, cap - len);
        if (n <= 0) break;
        len += (size_t)n;
    }
    buf[len] = 0;
    *out_len = len;
    return buf;
}

/* Generalised request: an explicit content type and an explicit body
 * length, so a body containing NUL bytes (a file upload) survives. The
 * JSON wrapper below is the common case and keeps its old signature. */
static struct http_response http_request_raw(struct app *app, const char *method, const char *path,
                                             const char *body, size_t body_len,
                                             const char *content_type) {
    struct tls_conn conn;
    if (!conn_open(app, &conn)) die("failed to connect to %s:%s", app->url.host, app->url.port);
    char auth[MAX_TOKEN + 64] = "";
    if (app->token[0]) snprintf(auth, sizeof(auth), "Authorization: Bearer %s\r\n", app->token);
    char *head = xasprintf(
        "%s %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "User-Agent: shottino/0.1\r\n"
        "Accept: application/json\r\n"
        "Content-Type: %s\r\n"
        "%s"
        "Connection: close\r\n"
        "Content-Length: %zu\r\n\r\n",
        method, path, app->url.host, content_type, auth, body_len);
    bool ok = conn_write_all(&conn, head, strlen(head));
    free(head);
    /* Body written separately — it is binary and must not go through a
     * format string. */
    if (ok && body_len) ok = conn_write_all(&conn, body, body_len);
    if (!ok) die("HTTP write failed");
    size_t raw_len = 0;
    char *raw = read_all(&conn, &raw_len);
    conn_close(&conn);

    char *sep = strstr(raw, "\r\n\r\n");
    if (!sep) die("bad HTTP response");
    *sep = 0;
    char *statusp = strchr(raw, ' ');
    int status = statusp ? atoi(statusp + 1) : 0;
    char *body_start = sep + 4;
    size_t hdr_len = (size_t)(body_start - raw);
    size_t blen = raw_len >= hdr_len ? raw_len - hdr_len : 0;
    char *payload = NULL;
    size_t payload_len = 0;
    if (strcasestr(raw, "Transfer-Encoding: chunked")) {
        payload = http_decode_chunked(body_start, blen, &payload_len);
        if (!payload) die("out of memory");
    } else {
        payload = malloc(blen + 1);
        if (!payload) die("out of memory");
        memcpy(payload, body_start, blen);
        payload[blen] = 0;
        payload_len = blen;
    }
    free(raw);
    return (struct http_response){ .status = status, .body = payload, .body_len = payload_len };
}

static struct http_response http_request(struct app *app, const char *method, const char *path, const char *body) {
    return http_request_raw(app, method, path, body, body ? strlen(body) : 0, "application/json");
}

/* Read one top-level string out of a small REST response body.
 *
 * Replaces the old `json_find_string`, which searched for a key ANYWHERE
 * in the buffer at ANY depth and decoded `\uXXXX` as a literal '?'. Here
 * the lookup is anchored to the top-level object and the shared reader
 * does the unescaping, so a token containing a non-ASCII character is no
 * longer silently corrupted. */
static bool json_top_string(const char *body, size_t len, const char *key, char *out,
                            size_t out_sz) {
    json_doc *doc = json_parse(body, len, NULL, 0);
    if (!doc) return false;
    const char *s = NULL;
    bool found = json_str_req(json_root(doc), key, &s);
    if (found) snprintf(out, out_sz, "%s", s);
    json_free(doc);
    return found;
}

/* Thin wrapper: parse the body, hand the root to the tested resolver in
 * wire.[ch]. The shape handling lives there so it is covered by tests —
 * this used to read only the ROOT, which broke login (the subject is
 * nested under `subject` there, flat only on /me). */
static void parse_subject(const char *json, size_t len, char *out, size_t out_sz) {
    if (out_sz) out[0] = '\0';
    json_doc *doc = json_parse(json, len, NULL, 0);
    if (!doc) return;
    wire_subject_key(json_root(doc), out, out_sz);
    json_free(doc);
}

static void parse_networks(struct app *app, const char *json, size_t len) {
    app->network_count = 0;
    json_doc *doc = json_parse(json, len, NULL, 0);
    if (!doc) return;
    const json_value *list = json_root(doc);
    for (size_t i = 0; i < json_len(list) && app->network_count < MAX_NETWORKS; i++) {
        const json_value *row = json_at(list, i);
        const char *slug = json_string(json_get(row, "slug"));
        if (!slug || !slug[0]) continue;
        struct network *n = &app->networks[app->network_count];
        memset(n, 0, sizeof(*n));
        long id = 0;
        json_long(json_get(row, "id"), &id);
        n->id = (int)id;
        snprintf(n->slug, sizeof(n->slug), "%s", slug);
        const char *nick = json_string(json_get(row, "nick"));
        if (nick) snprintf(n->nick, sizeof(n->nick), "%s", nick);
        /* The listing carries the DB-canonical connection state; seeding
         * it here means a parked network is greyed from the first frame
         * rather than only after its first state-change event. */
        const char *state = json_string(json_get(row, "connection_state"));
        n->conn_known = true;
        if (state && strcmp(state, "connected") == 0) n->conn_state = CONN_CONNECTED;
        else if (state && strcmp(state, "parked") == 0) n->conn_state = CONN_PARKED;
        else if (state && strcmp(state, "failed") == 0) n->conn_state = CONN_FAILED;
        else n->conn_known = false;
        app->network_count++;
    }
    json_free(doc);
}

/* Pane focus is asked about from everywhere a window is; defined with the
 * other pane machinery, declared here. */
static struct pane *focused_pane_locked(struct app *app);
static size_t focused_window_locked(struct app *app);
static bool window_is_visible_locked(struct app *app, size_t idx);

/* The window a target actually belongs in.
 *
 * Traffic that names the NETWORK ITSELF is the server talking, not a
 * person: azzurra's ircd sends its global notices from a source spelled
 * like the network — `AzzuRRa` — and grappa, seeing a sender that is
 * nick-shaped and is not one of the well-known services, files it under
 * a window of that name and mints a query window to go with it. The
 * result is a stranger tab sitting next to the `$server` window where
 * every other server message already lands. Route it there.
 *
 * The rule is deliberately narrow — the target has to BE the network
 * name — so it cannot swallow an ordinary query. What it does cost: a
 * real user whose nick is exactly the network name would have their DM
 * land on `$server`. Networks reserve their own name, so that user does
 * not exist.
 *
 * This is the client half. The whole fix belongs upstream in grappa's
 * `route_non_channel_notice/3`, which should recognise server-sourced
 * traffic before it ever mints a window — cicchetto has no way to know
 * what shottino knows here. Until then, shottino keeps its own sidebar
 * honest. */
static const char *route_target(const char *network, const char *channel) {
    if (!network || !channel || !channel[0]) return channel;
    return irc_name_eq(network, channel) ? SERVER_WINDOW : channel;
}

static void add_window_ex(struct app *app, const char *network, const char *channel, bool focus) {
    channel = route_target(network, channel);
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (window_matches(&app->windows[i], network, channel)) {
            if (focus) focused_pane_locked(app)->window = i;
            pthread_mutex_unlock(&app->lock);
            return;
        }
    }
    if (app->window_count == MAX_WINDOWS) {
        pthread_mutex_unlock(&app->lock);
        return;
    }
    struct window *w = &app->windows[app->window_count++];
    memset(w, 0, sizeof(*w));
    snprintf(w->network, sizeof(w->network), "%s", network);
    snprintf(w->channel, sizeof(w->channel), "%s", channel);
    w->last_id = 0;
    if (focus) focused_pane_locked(app)->window = app->window_count - 1;
    pthread_mutex_unlock(&app->lock);
}

static void add_window(struct app *app, const char *network, const char *channel) {
    add_window_ex(app, network, channel, true);
}

static void remove_window(struct app *app, const char *network, const char *channel) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (window_matches(&app->windows[i], network, channel)) {
            memmove(app->windows + i, app->windows + i + 1, sizeof(app->windows[0]) * (app->window_count - i - 1));
            app->window_count--;
            /* Every pane holds an INDEX into the array that just shifted,
             * so every pane is renumbered — not only the focused one. A
             * pane left pointing at the old index would silently start
             * showing its neighbour. */
            for (size_t p = 0; p < app->pane_count; p++) {
                struct pane *pane = &app->panes[p];
                /* Whether this pane was SHOWING the closed window has to
                 * be decided before the index moves: after the shift,
                 * a pane that merely slid down from i+1 to i compares
                 * equal to the closed index and would lose a scroll
                 * position that is still perfectly valid. */
                bool showed_it = pane->window == i;
                if (app->window_count == 0) pane->window = 0;
                else if (pane->window > i) pane->window--;
                if (pane->window >= app->window_count && app->window_count > 0)
                    pane->window = app->window_count - 1;
                if (showed_it || app->window_count == 0) {
                    pane->scroll_offset = 0;
                    pane->scroll_pinned = false;
                    pane->member_offset = 0;
                }
            }
            size_t cur = focused_window_locked(app);
            if (cur < app->window_count) app->windows[cur].unread = 0;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static void parse_channels(struct app *app, const char *network, const char *json, size_t len) {
    json_doc *doc = json_parse(json, len, NULL, 0);
    if (!doc) return;
    const json_value *list = json_root(doc);
    for (size_t i = 0; i < json_len(list); i++) {
        const char *name = json_string(json_get(json_at(list, i), "name"));
        if (name && name[0]) add_window(app, network, name);
    }
    json_free(doc);
}

static void enqueue_fetch(struct app *app, const char *network, const char *channel);
static void ws_join(struct app *app, const char *topic);

static const char *network_slug_by_id(struct app *app, int id) {
    for (size_t i = 0; i < app->network_count; i++) {
        if (app->networks[i].id == id) return app->networks[i].slug;
    }
    return NULL;
}

/* Open a DM window per query the server knows about.
 *
 * The payload is a map keyed by NICK whose values are arrays of
 * {network_id, target_nick, opened_at}. The old reader scanned the raw
 * buffer for `"target_nick"` between bracket positions and read the
 * network id by assuming the first digit after a quote belonged to the
 * key — which broke as soon as a nick contained a digit or the encoder
 * reordered keys. The authoritative id lives on each ENTRY, so that is
 * where it is read from now. */
static void apply_query_windows(struct app *app, const struct wire_event *ev) {
    const json_value *windows = ev->u.query_windows.windows;
    for (size_t i = 0; i < ev->u.query_windows.nick_count; i++) {
        const json_value *entries = json_value_at(windows, i);
        for (size_t j = 0; j < json_len(entries); j++) {
            const json_value *entry = json_at(entries, j);
            long network_id = 0;
            const char *nick = NULL;
            if (!json_long_req(entry, "network_id", &network_id)) continue;
            if (!json_str_req(entry, "target_nick", &nick)) continue;
            const char *slug = network_slug_by_id(app, (int)network_id);
            if (!slug || !nick[0]) continue;
            add_window_ex(app, slug, nick, false);
            enqueue_fetch(app, slug, nick);
            if (app->ws_connected) {
                char *topic = xasprintf("grappa:user:%s/network:%s/channel:%s", app->subject, slug, nick);
                ws_join(app, topic);
                free(topic);
            }
        }
    }
}

static void enqueue_read_cursor(struct app *app, const char *network, const char *channel,
                                long message_id);

/* Focus landed on a window: clear its local badge AND tell the server how
 * far we have read, so the cursor follows the user to their other
 * devices. The HTTP write is queued rather than done inline — this runs
 * on the UI thread, holding the app lock, and a blocking POST here would
 * stall every keystroke. */
static void clear_current_unread_locked(struct app *app) {
    size_t cur = focused_window_locked(app);
    if (cur >= app->window_count) return;
    struct window *w = &app->windows[cur];
    w->unread = 0;
    w->mentions = 0;
    w->severity = COUNTS_NONE;
    if (w->last_id > w->last_read_id) {
        w->last_read_id = w->last_id;
        enqueue_read_cursor(app, w->network, w->channel, w->last_id);
    }
}

static void clear_active_window_log(struct app *app) {
    pthread_mutex_lock(&app->lock);
    size_t cur = focused_window_locked(app);
    if (cur >= app->window_count) {
        pthread_mutex_unlock(&app->lock);
        return;
    }
    char key[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key(app->windows[cur].network, app->windows[cur].channel, key, sizeof(key));
    size_t write_i = 0;
    for (size_t read_i = 0; read_i < app->log_count; read_i++) {
        /* Everything filed under this window goes, its operational rows
         * included: /clear clears the WINDOW, and a preview message left
         * behind by a cleared channel is exactly the leftover this scope
         * exists to prevent. */
        if (strcmp(app->log_scope[read_i], key) == 0) {
            free(app->log[read_i]);
            continue;
        }
        log_row_move_locked(app, write_i, read_i);
        write_i++;
    }
    app->log_count = write_i;
    for (size_t p = 0; p < app->pane_count; p++) {
        app->panes[p].scroll_offset = 0;
        app->panes[p].scroll_pinned = false;
        app->panes[p].member_offset = 0;
    }
    clear_current_unread_locked(app);
    pthread_mutex_unlock(&app->lock);
}

/* Prefix precedence + the tier a member sits in. Defined beside
 * member_sigil_locked (they share network_prefixes_locked, which needs
 * network_by_slug_locked); declared here because the roster sort below
 * ranks members as they enter the app. */
static size_t member_rank_locked(struct app *app, const char *network, const char *modes);
static const char *member_rank_label_locked(struct app *app, const char *network, const char *modes);

/* Rank a member for roster ordering: highest prefix first, then
 * alphabetical. Sorting lives HERE, at the single point where a roster
 * enters the app, rather than at the call sites that build one: the REST
 * /members reply sorted itself and the members_seeded event did not, so
 * the same channel was ordered or not depending on which door its roster
 * came through. Caller holds app->lock. */
static void sort_members_locked(struct app *app, const char *network, struct member *m, size_t count) {
    for (size_t i = 1; i < count; i++) {
        struct member key = m[i];
        size_t key_rank = member_rank_locked(app, network, key.modes);
        size_t j = i;
        while (j > 0) {
            size_t prev_rank = member_rank_locked(app, network, m[j - 1].modes);
            if (prev_rank < key_rank) break;
            if (prev_rank == key_rank && strcasecmp(m[j - 1].nick, key.nick) <= 0) break;
            m[j] = m[j - 1];
            j--;
        }
        m[j] = key;
    }
}

static void set_window_members(struct app *app, const char *network, const char *channel, const struct member *members, size_t count) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (window_matches(&app->windows[i], network, channel)) {
            app->windows[i].member_count = count > 512 ? 512 : count;
            for (size_t j = 0; j < app->windows[i].member_count; j++) app->windows[i].members[j] = members[j];
            sort_members_locked(app, network, app->windows[i].members, app->windows[i].member_count);
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

/* ── Keeping the roster live ───────────────────────────────────────────
 *
 * A roster arrives whole (NAMES, members_seeded, REST /members) and then
 * the channel moves under it. While the member list only appeared on very
 * wide terminals that was survivable; as a permanent pane it is not — a
 * list that still shows who was here when you joined is worse than no
 * list, because it looks current.
 *
 * Membership changes are applied incrementally from the typed presence
 * events this client already renders: join/part/quit/kick/nick say
 * exactly who, with no parsing. A PREFIX change (+o, -v) is deliberately
 * NOT parsed here — mode semantics are the server's job (one parser, on
 * the server), and a client-side mode parser would be a second, divergent
 * one. Those refetch the roster instead: rare event, one request, and the
 * answer comes from the side that actually knows. */
static bool nick_case_equal(const char *a, const char *b);

static bool roster_add_locked(struct window *w, const char *nick) {
    if (w->member_count >= 512) return false;
    for (size_t i = 0; i < w->member_count; i++)
        if (nick_case_equal(w->members[i].nick, nick)) return false;
    snprintf(w->members[w->member_count].nick, sizeof(w->members[0].nick), "%s", nick);
    w->members[w->member_count].modes[0] = '\0';
    w->member_count++;
    return true;
}

static bool roster_remove_locked(struct window *w, const char *nick) {
    for (size_t i = 0; i < w->member_count; i++) {
        if (!nick_case_equal(w->members[i].nick, nick)) continue;
        memmove(&w->members[i], &w->members[i + 1], sizeof(w->members[0]) * (w->member_count - i - 1));
        w->member_count--;
        return true;
    }
    return false;
}

/* A rename keeps the member's prefixes: ops stay ops across a NICK. */
static bool roster_rename_locked(struct window *w, const char *from, const char *to) {
    for (size_t i = 0; i < w->member_count; i++) {
        if (!nick_case_equal(w->members[i].nick, from)) continue;
        snprintf(w->members[i].nick, sizeof(w->members[0].nick), "%s", to);
        return true;
    }
    return false;
}

static void enqueue_members(struct app *app, const char *network, const char *channel);

/* Apply one presence row to the rosters it touches. `channel` is the row's
 * own channel; QUIT and NICK are network-wide, so they sweep every window
 * of that network — IRC delivers them once, not per channel. */
static void apply_membership_event(struct app *app, const char *network, const char *channel,
                                   wire_message_kind kind, const char *sender, const char *body) {
    if (!network[0] || !sender) return;
    bool refetch = false;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        struct window *w = &app->windows[i];
        if (!irc_name_eq(w->network, network)) continue;
        bool this_channel = channel[0] && irc_name_eq(w->channel, channel);
        bool touched = false;
        switch (kind) {
        case MSG_JOIN:
            if (this_channel) touched = roster_add_locked(w, sender);
            break;
        case MSG_PART:
            if (this_channel) touched = roster_remove_locked(w, sender);
            break;
        case MSG_KICK:
            /* The KICKED nick is the body; the sender is whoever did it. */
            if (this_channel && body && body[0]) touched = roster_remove_locked(w, body);
            break;
        case MSG_QUIT:
            touched = roster_remove_locked(w, sender);
            break;
        case MSG_NICK_CHANGE:
            if (body && body[0]) touched = roster_rename_locked(w, sender, body);
            break;
        case MSG_MODE:
            /* Might be a prefix change; the server knows, this client
             * deliberately does not. Ask, once, for this channel. */
            if (this_channel) refetch = true;
            break;
        default:
            break;
        }
        if (touched) sort_members_locked(app, w->network, w->members, w->member_count);
    }
    pthread_mutex_unlock(&app->lock);
    if (refetch) enqueue_members(app, network, channel);
}

/* Sigil for the highest-ranked prefix a member holds. Defaults match the
 * near-universal PREFIX=(qaohv)~&@%+ ordering; a network that advertises
 * something else is handled by isupport_prefix below. */
static char member_sigil(struct app *app, const char *network, const char *modes);

static void maybe_mark_unread(struct app *app, const char *network, const char *channel, bool live) {
    if (!live || !network[0] || !channel[0]) return;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (window_matches(&app->windows[i], network, channel)) {
            if (!window_is_visible_locked(app, i) || app->panel != PANEL_CHAT) app->windows[i].unread++;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static void set_window_topic(struct app *app, const char *network, const char *channel, const char *text) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (window_matches(&app->windows[i], network, channel)) {
            snprintf(app->windows[i].topic, sizeof(app->windows[i].topic), "%s", text && text[0] ? text : "no topic set");
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static void remember_url(struct app *app, const char *body);
static const char *find_url(const char *s);
static size_t copy_url_token(const char *url, char *out, size_t out_size);
static enum media_kind media_kind_of(const char *url);
static int media_claim_locked(struct app *app, const char *url, bool is_video);
static bool message_mentions_me(struct app *app, const char *network, const char *sender, const char *body);
static bool nick_case_equal(const char *a, const char *b);
static const char *own_nick_for_network(struct app *app, const char *network);

/* Adapter: classify `url` against this deployment's host set (connect
 * host + server aliases). The classification LOGIC is the tested pure
 * media_url_is_first_party in media.c; this only marshals app state to it
 * (the 2-D alias store into a pointer array). */
static bool url_is_first_party(struct app *app, const char *url) {
    const char *ptrs[MAX_HTTP_ALIASES];
    for (size_t i = 0; i < app->http_host_alias_count; i++)
        ptrs[i] = app->http_host_aliases[i];
    return media_url_is_first_party(url, app->url.host, ptrs, app->http_host_alias_count);
}

/* Render one scrollback row.
 *
 * Presence kinds (join/part/quit/nick_change/mode/kick/topic/server_event)
 * carry a NULL body — the event IS the row. The old reader bailed on an
 * empty body, so shottino showed no joins, parts, quits or nick changes at
 * all; they were parsed and thrown away. Each kind now gets its own line
 * shape, marked with a leading sigil so presence noise is visually
 * separable from conversation. */
static void format_presence_line(wire_message_kind kind, const char *sender, const char *body,
                                 char *out, size_t out_sz) {
    switch (kind) {
    case MSG_JOIN:
        snprintf(out, out_sz, "--> %s has joined", sender);
        break;
    case MSG_PART:
        if (body && body[0]) snprintf(out, out_sz, "<-- %s has left (%s)", sender, body);
        else snprintf(out, out_sz, "<-- %s has left", sender);
        break;
    case MSG_QUIT:
        if (body && body[0]) snprintf(out, out_sz, "<-- %s has quit (%s)", sender, body);
        else snprintf(out, out_sz, "<-- %s has quit", sender);
        break;
    case MSG_NICK_CHANGE:
        snprintf(out, out_sz, "--- %s is now known as %s", sender, body ? body : "?");
        break;
    case MSG_MODE:
        snprintf(out, out_sz, "--- %s sets mode %s", sender, body ? body : "");
        break;
    case MSG_KICK:
        snprintf(out, out_sz, "<-- %s was kicked%s%s", body ? body : "?", sender[0] ? " by " : "",
                 sender[0] ? sender : "");
        break;
    case MSG_TOPIC:
        if (body && body[0]) snprintf(out, out_sz, "--- %s changed the topic to: %s", sender, body);
        else snprintf(out, out_sz, "--- %s cleared the topic", sender);
        break;
    case MSG_SERVER_EVENT:
        snprintf(out, out_sz, "--- %s", body ? body : "");
        break;
    default:
        out[0] = '\0';
        break;
    }
}

static void ircd_publish(struct app *app, const struct wire_scrollback_message *m,
                         const char *display_channel);

static void render_message(struct app *app, const struct wire_scrollback_message *m, bool live) {
    long id = m->id;
    long server_time = m->server_time;
    const char *network = m->network;
    const char *channel = m->channel;
    const char *sender = m->sender ? m->sender : "";
    const char *body = m->body ? m->body : "";

    /* A conversation row with no body is nothing to show; a PRESENCE row
     * with no body is the whole point, so only the former is dropped. */
    bool conversational =
        m->kind == MSG_PRIVMSG || m->kind == MSG_NOTICE || m->kind == MSG_ACTION;
    if (conversational && !body[0]) return;

    char display_channel[MAX_CHANNEL];
    snprintf(display_channel, sizeof(display_channel), "%s", channel);
    const char *own_nick = own_nick_for_network(app, network);
    if (live && own_nick && nick_case_equal(channel, own_nick) && sender[0] && !nick_case_equal(sender, own_nick)) {
        snprintf(display_channel, sizeof(display_channel), "%s", sender);
        add_window_ex(app, network, display_channel, false);
    }
    /* Same door the windows use: a row addressed to the network's own
     * name is server output, and it reads in the window that holds the
     * rest of the server's output. Rewritten only when the routing
     * actually moved it — copying a buffer onto itself is undefined. */
    const char *routed = route_target(network, display_channel);
    if (routed != display_channel) snprintf(display_channel, sizeof(display_channel), "%s", routed);

    /* Dedup by ID, BEFORE mutating anything.
     *
     * Every message we send arrives TWICE: once as the POST /messages
     * response (worker thread), once as the `message` wire event
     * (socket). Both carry the same scrollback id, so the id IS the
     * identity — and the check has to come first.
     *
     * The previous order cleared a matching pending echo and only THEN
     * discovered the row was a duplicate, returning without rendering.
     * Because the echo was matched by BODY TEXT, the second delivery of
     * one message deleted the "[sending]" line of a DIFFERENT message
     * that merely said the same thing. Send "ok" twice and the second
     * vanished, reappearing only when some later delivery happened to
     * land — which is exactly "I don't see my message until another one
     * arrives".
     *
     * A duplicate delivery must be inert. */
    if (id > 0 && network[0] && channel[0]) {
        pthread_mutex_lock(&app->lock);
        for (size_t i = 0; i < app->seen_count; i++) {
            if (app->seen[i].id == id && irc_name_eq(app->seen[i].network, network) && irc_name_eq(app->seen[i].channel, channel)) {
                pthread_mutex_unlock(&app->lock);
                return;
            }
        }
        struct seen_message *seen = &app->seen[app->seen_next];
        seen->id = id;
        snprintf(seen->network, sizeof(seen->network), "%s", network);
        snprintf(seen->channel, sizeof(seen->channel), "%s", channel);
        app->seen_next = (app->seen_next + 1) % SEEN_MESSAGES;
        if (app->seen_count < SEEN_MESSAGES) app->seen_count++;
        pthread_mutex_unlock(&app->lock);
    }

    /* Only now that the row is known to be NEW, retire its optimistic
     * echo. Matching by text is still imprecise when two pending messages
     * say the same thing, but it can no longer delete a line without
     * putting the confirmed one in its place. */
    clear_matching_pending_echo(app, network, display_channel, body);

    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (network[0] && display_channel[0] && window_matches(&app->windows[i], network, display_channel) && id > app->windows[i].last_id) app->windows[i].last_id = id;
    }
    pthread_mutex_unlock(&app->lock);
    remember_url(app, body);
    /* The bridge sees the row here, where live pushes and fetched
     * scrollback have already become the same thing and the id-dedup
     * above has already run. Anywhere else means two feeds to keep in
     * step. */
    ircd_publish(app, m, display_channel);
    /* Presence rows are ambient: they must not bump the unread badge or
     * they drown the count that signals someone actually spoke. */
    if (conversational) maybe_mark_unread(app, network, display_channel, live);
    bool mention = conversational && message_mentions_me(app, network, sender, body);
    char clock[16];
    time_t ts = server_time > 100000000000L ? (time_t)(server_time / 1000) : time(NULL);
    struct tm tm;
    localtime_r(&ts, &tm);
    strftime(clock, sizeof(clock), "%H:%M", &tm);
    switch (m->kind) {
    case MSG_ACTION:
        log_line_mention(app, mention, "[%s/%s] %s * %s %s", network, display_channel, clock, sender, body);
        break;
    case MSG_NOTICE:
        log_line_mention(app, mention, "[%s/%s] %s -%s- %s", network, display_channel, clock, sender, body);
        break;
    case MSG_PRIVMSG:
        log_line_mention(app, mention, "[%s/%s] %s <%s> %s", network, display_channel, clock, sender, body);
        break;
    default: {
        char line[MAX_LINE];
        format_presence_line(m->kind, sender, m->body, line, sizeof(line));
        if (line[0]) log_line_mention(app, false, "[%s/%s] %s %s", network, display_channel, clock, line);
        /* The row is also a roster fact: the pane must not still show
         * someone who just left. */
        apply_membership_event(app, network, display_channel, m->kind, sender, m->body);
        break;
    }
    }

    pthread_mutex_lock(&app->lock);
    /* Stamp the row just appended with its scrollback id, so the unread
     * divider lands on the exact row the server's cursor names rather
     * than being guessed from position. */
    if (app->log_count > 0) app->log_ids[app->log_count - 1] = id;
    /* The row's inline image slot is NOT claimed here. It is claimed by
     * the draw path, the first time the row is actually on screen — the
     * #451 first-party test and the `/media` toggle are both questions
     * about the row you are looking at, and answering them at arrival
     * time made `/media on` a no-op for every row already in the log. See
     * the claim site in draw(). */
    for (size_t p = 0; p < app->pane_count; p++)
        if (!app->panes[p].scroll_pinned) app->panes[p].scroll_offset = 0;
    pthread_mutex_unlock(&app->lock);
}

static const char *find_url(const char *s) {
    const char *http = strstr(s, "http://");
    const char *https = strstr(s, "https://");
    if (!http) return https;
    if (!https) return http;
    return http < https ? http : https;
}

/* Copy the leading non-whitespace token of `url` into `out` (case preserved).
 * Returns the token length. Shared by URL remembering, link-region recording,
 * and the lowercasing classifier so the token-boundary rule stays in one place. */
static size_t copy_url_token(const char *url, char *out, size_t out_size) {
    size_t n = 0;
    while (url[n] && !isspace((unsigned char)url[n]) && n + 1 < out_size) {
        out[n] = url[n];
        n++;
    }
    out[n] = 0;
    return n;
}

/* Lowercased copy of the leading URL token with any `?query` stripped, so
 * extension matching ignores case and `?sig=...` suffixes. */
static void url_token_lower(const char *url, char *out, size_t out_size) {
    copy_url_token(url, out, out_size);
    for (char *p = out; *p; p++) *p = (char)tolower((unsigned char)*p);
    char *q = strchr(out, '?');
    if (q) *q = 0;
}

static bool token_has_suffix(const char *token, const char *const *exts) {
    for (size_t i = 0; exts[i]; i++) {
        if (strstr(token, exts[i])) return true;
    }
    return false;
}

/* Classify a URL by extension (and grappa's /uploads/ image convention) in a
 * single lowercasing pass. Video is checked first so an extension wins over the
 * /uploads/ heuristic. */
/* Is this URL a GIF? Same token-lowering rule as media_kind_of, so
 * "?x=1" and case cannot change the answer. */
static bool url_has_gif_suffix(const char *url) {
    /* Only a HINT, and only load-bearing on a terminal with a graphics
     * protocol — everywhere else the decoder is asked directly. WebP and
     * APNG carry animation under extensions that are usually still, so
     * they are hinted too: guessing "maybe" costs one decode that
     * answers itself. */
    static const char *const gif[] = {".gif", ".webp", ".apng", NULL};
    char lower[MAX_LINE];
    url_token_lower(url, lower, sizeof(lower));
    return token_has_suffix(lower, gif);
}

static enum media_kind media_kind_of(const char *url) {
    static const char *const img[] = {".jpg", ".jpeg", ".png", ".gif",
                                      ".webp", ".bmp", NULL};
    static const char *const vid[] = {".mp4", ".m4v", ".webm", ".mkv", ".mov",
                                      ".avi", ".ogv", ".flv", ".wmv", ".mpg",
                                      ".mpeg", NULL};
    char lower[MAX_LINE];
    url_token_lower(url, lower, sizeof(lower));
    if (token_has_suffix(lower, vid)) return MEDIA_VIDEO;
    if (token_has_suffix(lower, img) || strstr(lower, "/uploads/")) return MEDIA_IMAGE;
    return MEDIA_NONE;
}

static bool contains_ci(const char *haystack, const char *needle) {
    if (!needle || !needle[0]) return false;
    size_t nlen = strlen(needle);
    for (const char *p = haystack; *p; p++) {
        size_t i = 0;
        while (i < nlen && p[i] && tolower((unsigned char)p[i]) == tolower((unsigned char)needle[i])) i++;
        if (i == nlen) return true;
    }
    return false;
}

/* Nick identity, under the SAME casemapping windows use: strcasecmp
 * folded whatever the locale said was a letter, which is not what the
 * ircd does (see irc_name_eq). */
static bool nick_case_equal(const char *a, const char *b) {
    return irc_name_eq(a, b);
}

static bool message_mentions_me(struct app *app, const char *network, const char *sender, const char *body) {
    for (size_t i = 0; i < app->network_count; i++) {
        if (irc_name_eq(app->networks[i].slug, network) && app->networks[i].nick[0]) {
            if (contains_ci(sender, app->networks[i].nick)) return false;
            return contains_ci(body, app->networks[i].nick);
        }
    }
    const char *colon = strchr(app->subject, ':');
    const char *subject_name = colon ? colon + 1 : app->subject;
    if (contains_ci(sender, subject_name)) return false;
    return contains_ci(body, subject_name);
}

static void remember_url(struct app *app, const char *body) {
    const char *url = find_url(body);
    if (!url) return;
    char token[MAX_LINE];
    copy_url_token(url, token, sizeof(token));
    enum media_kind kind = media_kind_of(token);
    pthread_mutex_lock(&app->lock);
    snprintf(app->last_url, sizeof(app->last_url), "%s", token);
    /* Tracked separately from last_url so `/preview` targets the last
     * IMAGE OR VIDEO rather than whatever link happened to arrive most
     * recently — a plain link after a picture must not shadow it. This is
     * what makes previews reachable without the mouse. */
    if (kind != MEDIA_NONE) {
        snprintf(app->last_media_url, sizeof(app->last_media_url), "%s", token);
        app->last_media_is_video = (kind == MEDIA_VIDEO);
    }
    pthread_mutex_unlock(&app->lock);
}

/* Echo the row POST /messages just created (a single object, not a page). */
static void render_created_message(struct app *app, const char *json, size_t len) {
    char err[160];
    json_doc *doc = json_parse(json, len, err, sizeof(err));
    if (!doc) return;
    struct wire_scrollback_message m;
    if (wire_narrow_message(json_root(doc), &m)) render_message(app, &m, false);
    json_free(doc);
}

/* Ingest a REST scrollback page.
 *
 * Two fixes over the previous reader. It located rows by scanning for
 * `"body"` and then walking BACKWARDS to the nearest `{` — which lands
 * inside `meta` whenever meta is non-empty, and misses any row whose body
 * is null (every join/part/quit). And it appended in buffer order: the
 * endpoint returns DESC (newest first, `Scrollback.fetch/6`), so replayed
 * scrollback rendered upside down. cicchetto reverses on ingestion; this
 * now does the same. */
/* What to do with each row of a scrollback page, oldest first.
 *
 * The page has ONE parser and two destinations: the client's own
 * scrollback (render_message, which also feeds the bridge and every
 * connected IRC client), and a CHATHISTORY reply, which belongs to the
 * one client that asked and must NOT arrive at the others as live
 * traffic. Two parsers would be two places for the wire shape to
 * change under. */
typedef void (*scrollback_sink)(struct app *app, const struct wire_scrollback_message *m,
                               void *ctx);

static void scrollback_to_client(struct app *app, const struct wire_scrollback_message *m,
                                 void *ctx) {
    (void)ctx;
    render_message(app, m, false);
}

static void parse_messages_into(struct app *app, const char *json, size_t len,
                                scrollback_sink sink, void *ctx) {
    char err[160];
    json_doc *doc = json_parse(json, len, err, sizeof(err));
    if (!doc) {
        log_line(app, "malformed scrollback response: %s", err);
        return;
    }
    const json_value *list = json_root(doc);
    if (json_type_of(list) != JSON_ARRAY) {
        json_free(doc);
        return;
    }
    size_t n = json_len(list);
    /* The server pages DESC; both destinations want oldest first. */
    for (size_t i = n; i > 0; i--) {
        struct wire_scrollback_message m;
        if (wire_narrow_message(json_at(list, i - 1), &m)) sink(app, &m, ctx);
    }
    json_free(doc);
}

static void parse_messages(struct app *app, const char *json, size_t len) {
    parse_messages_into(app, json, len, scrollback_to_client, NULL);
}

static void draw_fill(int y, int x, int n, int pair) {
    attron(COLOR_PAIR(pair));
    for (int i = 0; i < n; i++) mvaddch(y, x + i, ' ');
    attroff(COLOR_PAIR(pair));
}

static void draw_text(int y, int x, int max, int pair, attr_t attrs, const char *fmt, ...) __attribute__((format(printf, 6, 7)));
static int split_message_line(const char *line, char *prefix, size_t prefix_sz, char *nick, size_t nick_sz, const char **body);

static void draw_text(int y, int x, int max, int pair, attr_t attrs, const char *fmt, ...) {
    if (max <= 0) return;
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    attron(COLOR_PAIR(pair) | attrs);
    mvprintw(y, x, "%.*s", max, buf);
    attroff(COLOR_PAIR(pair) | attrs);
}

static int wrapped_text_lines(const char *s, int width) {
    if (width <= 0) return 0;
    int lines = 1;
    int col = 0;
    for (const char *p = s; *p; p++) {
        if (*p == '\n' || *p == '\r') {
            lines++;
            col = 0;
            if (*p == '\r' && p[1] == '\n') p++;
            continue;
        }
        if (col >= width) {
            lines++;
            col = 0;
        }
        col++;
    }
    return lines;
}

/* How many bytes of `s` belong on the first line of the topic band.
 *
 * Whole words where possible: a marquee that starts mid-word reads as
 * corrupted text rather than as a continuation. Falls back to a hard cut
 * when there is no space to break at, and never cuts inside a UTF-8
 * character, whose remains the terminal would draw as a replacement
 * glyph. Columns are counted as BYTES, the same approximation the
 * wrapper above makes. */
static int topic_head_len(const char *s, int width) {
    if (width <= 0) return 0;
    int len = (int)strlen(s);
    if (len <= width) return len;
    int cut = width;
    while (cut > 0 && ((unsigned char)s[cut] & 0xC0) == 0x80) cut--;
    for (int i = cut; i > width / 2; i--) {
        if (s[i] == ' ') return i;
    }
    return cut;
}

/* Wrapped height of a body, measured on its VISIBLE text.
 *
 * Control bytes occupy no cells, so measuring the raw string over-counts
 * the height of any formatted message — the layout then reserves rows the
 * text does not fill, leaving gaps in the scrollback. Strip first when the
 * body carries formatting; skip the copy when it does not. */
static int wrapped_text_lines_visible(const char *s, int width) {
    if (!mirc_has_formatting(s)) return wrapped_text_lines(s, width);
    char stripped[MAX_LINE * 2];
    mirc_strip(s, stripped, sizeof(stripped));
    return wrapped_text_lines(stripped, width);
}

/* ── mIRC colour → terminal colour ─────────────────────────────────────
 *
 * mIRC's palette is 99 RGB values and \x04 can name any RGB at all;
 * terminals offer 8, 16 or 256 indexed colours. Everything is therefore
 * mapped to the nearest xterm-256 index (or nearest basic-16 on a poorer
 * terminal), which is what every other terminal IRC client does and works
 * without requiring can_change_color().
 *
 * Colour PAIRS are the scarce resource: ncurses wants a pair per (fg, bg)
 * combination and a terminal typically offers 256. They are allocated
 * lazily from a pool above the theme's fixed pairs and cached, so a
 * channel full of colourful bots settles on a small working set instead
 * of exhausting the table on the first screenful. */
#define CP_MIRC_BASE 40

#define MIRC_PAIR_POOL 4096
static struct {
    short fg;
    short bg;
    short pair;
} mirc_pairs[MIRC_PAIR_POOL];
static size_t mirc_pair_count;
static short mirc_pair_next = CP_MIRC_BASE;
static short mirc_pair_limit;

static void mirc_colors_init(void) {
    /* Leave headroom below the cap: exhausting COLOR_PAIRS makes
     * init_pair fail silently and text renders in the last pair set. */
    /* Inline image art needs one pair per (top,bottom) colour pair in the
     * picture, which is far more than coloured TEXT ever asks for. A
     * 256-colour terminal reports COLOR_PAIRS in the tens of thousands, so
     * the old 256 cap was needlessly tight and would have made every
     * image collapse onto the fallback pair after the first few rows. */
    long cap = COLOR_PAIRS > 0 ? COLOR_PAIRS - 1 : 0;
    if (cap > CP_MIRC_BASE + MIRC_PAIR_POOL) cap = CP_MIRC_BASE + MIRC_PAIR_POOL;
    if (cap > 32000) cap = 32000; /* short */
    mirc_pair_limit = (short)cap;
}

/* Quantisation lives in termcolor.[ch]; the choice of WHICH quantiser is
 * a curses-runtime question (COLORS), so it stays here. */
static short mirc_terminal_color(long rgb) {
    if (rgb < 0) return -1;
    return (short)(COLORS >= 256 ? termcolor_xterm256(rgb) : termcolor_basic8(rgb));
}

/* Resolve a run's colour spec to an RGB, or -1 for "inherit". */
static long mirc_run_rgb(int value, bool is_rgb) {
    if (value == MIRC_COLOR_DEFAULT) return -1;
    return is_rgb ? (long)value : mirc_palette_rgb(value);
}

/* A colour pair for (fg, bg), reusing one if already allocated. Returns 0
 * (meaning "use the caller's pair") when the pool is exhausted or the run
 * asks for no colour at all. */
static int mirc_pair_for(long fg_rgb, long bg_rgb, int fallback_pair) {
    if (fg_rgb < 0 && bg_rgb < 0) return fallback_pair;
    if (!has_colors()) return fallback_pair;
    short fg = fg_rgb < 0 ? (short)-1 : mirc_terminal_color(fg_rgb);
    short bg = bg_rgb < 0 ? (short)-1 : mirc_terminal_color(bg_rgb);
    for (size_t i = 0; i < mirc_pair_count; i++)
        if (mirc_pairs[i].fg == fg && mirc_pairs[i].bg == bg) return mirc_pairs[i].pair;
    if (mirc_pair_next >= mirc_pair_limit || mirc_pair_count >= MIRC_PAIR_POOL) {
        /* The pool is a CACHE, and animation churns it: every frame of a
         * clip can want its own (top, bottom) combinations, so a few
         * seconds of video will exhaust any fixed table. Recycling beats
         * degrading — the old behaviour was to hand back the fallback
         * pair forever, i.e. the picture goes flat and STAYS flat.
         *
         * Safe precisely because draw() erases and repaints the whole
         * screen every frame: redefining a pair cannot leave a stale cell
         * behind, since every cell that used it is about to be drawn
         * again this same frame or the next. */
        mirc_pair_count = 0;
        mirc_pair_next = CP_MIRC_BASE;
    }
    short pair = mirc_pair_next++;
    if (init_pair(pair, fg, bg) == ERR) return fallback_pair;
    mirc_pairs[mirc_pair_count].fg = fg;
    mirc_pairs[mirc_pair_count].bg = bg;
    mirc_pairs[mirc_pair_count].pair = pair;
    mirc_pair_count++;
    return pair;
}

static attr_t mirc_run_attrs(const struct mirc_run *r, attr_t base) {
    attr_t a = base;
    if (r->bold) a |= A_BOLD;
    if (r->underline) a |= A_UNDERLINE;
    if (r->reverse) a |= A_REVERSE;
    /* ncurses has no strikethrough and A_ITALIC is not universal; both
     * degrade to dim rather than being dropped, so the emphasis survives
     * even where the exact style cannot. */
    if (r->italic || r->strikethrough) a |= A_DIM;
    return a;
}

/* Draw `s` wrapped at `width`, starting from its `skip_rows`-th wrapped
 * line and drawing at most `max_lines` of them at (y, x).
 *
 * `skip_rows` is what makes a row that is PARTIALLY scrolled off the top
 * renderable: the wrap is computed over the whole text exactly as if it
 * were fully drawn — same width, same break points — and only the cells
 * of the skipped lines are withheld. Wrapping and clipping are separate
 * concerns; re-wrapping a tail would break at different places than the
 * full row does, and the row would visibly reflow as it scrolls past. */
static void draw_wrapped_text(int y, int x, int width, int skip_rows, int max_lines, int pair, attr_t attrs, const char *s) {
    if (width <= 0 || max_lines <= 0) return;
    if (skip_rows < 0) skip_rows = 0;
    int line = 0;
    int col = 0;
    /* First wrapped line past the visible window. */
    const int last = skip_rows + max_lines;

    /* Fast path: the overwhelming majority of messages carry no control
     * bytes, and parsing runs for them would be pure overhead. */
    if (!mirc_has_formatting(s)) {
        attron(COLOR_PAIR(pair) | attrs);
        if (skip_rows == 0) move(y, x);
        for (const char *p = s; *p && line < last; p++) {
            if (*p == '\r') {
                if (p[1] == '\n') p++;
                line++;
                col = 0;
                if (line < last && line >= skip_rows) move(y + line - skip_rows, x);
                continue;
            }
            if (*p == '\n') {
                line++;
                col = 0;
                if (line < last && line >= skip_rows) move(y + line - skip_rows, x);
                continue;
            }
            if (col >= width) {
                line++;
                col = 0;
                if (line >= last) break;
                if (line >= skip_rows) move(y + line - skip_rows, x);
            }
            if (line >= skip_rows) addch((unsigned char)*p);
            col++;
        }
        attroff(COLOR_PAIR(pair) | attrs);
        return;
    }

    struct mirc_run runs[MIRC_MAX_RUNS];
    size_t nruns = mirc_parse(s, runs, MIRC_MAX_RUNS);
    if (skip_rows == 0) move(y, x);
    for (size_t i = 0; i < nruns && line < last; i++) {
        const struct mirc_run *r = &runs[i];
        long fg = mirc_run_rgb(r->fg, r->fg_is_rgb);
        long bg = mirc_run_rgb(r->bg, r->bg_is_rgb);
        int run_pair = mirc_pair_for(fg, bg, pair);
        attr_t run_attrs = mirc_run_attrs(r, attrs);
        attron(COLOR_PAIR(run_pair) | run_attrs);
        for (size_t k = 0; k < r->len && line < last; k++) {
            char ch = r->text[k];
            if (ch == '\r') {
                if (k + 1 < r->len && r->text[k + 1] == '\n') k++;
                line++;
                col = 0;
                if (line < last && line >= skip_rows) move(y + line - skip_rows, x);
                continue;
            }
            if (ch == '\n') {
                line++;
                col = 0;
                if (line < last && line >= skip_rows) move(y + line - skip_rows, x);
                continue;
            }
            if (col >= width) {
                line++;
                col = 0;
                if (line >= last) break;
                if (line >= skip_rows) move(y + line - skip_rows, x);
            }
            /* Runs are walked from the start whether or not their cells
             * land on a visible line: a run that opens in a skipped line
             * still owns the cells it reaches on a visible one, so the
             * tail keeps the colour the full row would have had. */
            if (line >= skip_rows) addch((unsigned char)ch);
            col++;
        }
        attroff(COLOR_PAIR(run_pair) | run_attrs);
    }
}

static int message_display_lines(const char *line, int width) {
    if (width <= 0) return 1;
    char prefix[256], nick[256];
    const char *body;
    if (split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body)) {
        int body_x = (int)strlen(prefix) + (int)strlen(nick) + 3;
        int body_w = width - body_x;
        if (body_w < 12) body_w = width > 12 ? width - 2 : width;
        return wrapped_text_lines_visible(body, body_w);
    }
    return wrapped_text_lines_visible(line, width);
}

/* Draw one log row at (y, x), omitting its first `skip_rows` wrapped
 * lines — the ones scrolled off the top of the region.
 *
 * The timestamp and `<nick>` live ON the row's first wrapped line, so
 * they are drawn only when that line is on screen. A tail keeps the body
 * column the header established, which is where the row's continuation
 * lines already sit: a partially scrolled message reads as the same
 * shape it had before it started leaving the viewport. */
static void draw_message_line(int y, int x, int width, int skip_rows, int max_lines, const char *line, bool mention_row, bool pending_row) {
    if (width <= 0 || max_lines <= 0) return;
    if (skip_rows < 0) skip_rows = 0;
    for (int row = 0; row < max_lines; row++) {
        if (mention_row) draw_fill(y + row, x, width, CP_MENTION);
    }

    char prefix[256], nick[256];
    const char *body;
    if (split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body)) {
        int base_pair = mention_row ? CP_MENTION : (pending_row ? CP_MUTED : CP_MUTED);
        int body_pair = mention_row ? CP_MENTION : (pending_row ? CP_MUTED : CP_MAIN);
        attr_t body_attr = mention_row ? A_BOLD : (pending_row ? A_DIM : 0);
        attr_t base_attr = pending_row ? A_DIM : 0;
        int px = x + (int)strlen(prefix);
        if (skip_rows == 0) {
            draw_text(y, x, width, base_pair, base_attr, "%s", prefix);
            draw_text(y, px, 1, base_pair, base_attr, "<");
            draw_text(y, px + 1, (int)strlen(nick), mention_row ? CP_MENTION : nick_pair(nick), A_BOLD | base_attr, "%s", nick);
            draw_text(y, px + 1 + (int)strlen(nick), 1, base_pair, base_attr, ">");
        }
        int body_x = px + 3 + (int)strlen(nick);
        int body_w = width - (body_x - x);
        if (body_w < 12) {
            body_x = x + 2;
            body_w = width - 2;
        }
        draw_wrapped_text(y, body_x, body_w, skip_rows, max_lines, body_pair, body_attr, body);
        if (pending_row && width > 11) draw_text(y + max_lines - 1, x + width - 11, 11, CP_MUTED, A_DIM, "[sending]");
    } else if (find_url(line)) {
        draw_wrapped_text(y, x, width, skip_rows, max_lines, media_kind_of(find_url(line)) != MEDIA_NONE ? CP_ACCENT : CP_MUTED, A_UNDERLINE, line);
    } else if (strstr(line, "failed") || strstr(line, "error")) {
        draw_wrapped_text(y, x, width, skip_rows, max_lines, CP_ERROR, 0, line);
    } else {
        draw_wrapped_text(y, x, width, skip_rows, max_lines, CP_MUTED, 0, line);
    }
}

static int input_display_lines(const char *prompt, const char *input, int width) {
    if (width <= 0) return 1;
    size_t total = strlen(prompt) + strlen(input);
    int lines = (int)(total / (size_t)width) + 1;
    return lines < 1 ? 1 : lines;
}

static void draw_input_box(int y, int x, int width, int height, const char *prompt, const char *input, int *cursor_y, int *cursor_x) {
    if (width <= 0 || height <= 0) return;
    for (int row = 0; row < height; row++) draw_fill(y + row, x, width, CP_INPUT);
    int inner_x = x + 1;
    int inner_w = width - 2;
    if (inner_w <= 0) inner_w = width;

    char *joined = xasprintf("%s%s", prompt, input);
    int total_lines = input_display_lines(prompt, input, inner_w);
    int first_line = total_lines > height ? total_lines - height : 0;
    int pos = 0;
    int row = 0;
    const int prompt_len = (int)strlen(prompt);
    const int joined_len = (int)strlen(joined);
    while (row < height && pos < joined_len) {
        int line_no = pos / inner_w;
        int take = inner_w - (pos % inner_w);
        if (take > joined_len - pos) take = joined_len - pos;
        if (line_no >= first_line) {
            attron(COLOR_PAIR(CP_INPUT) | A_BOLD);
            for (int i = 0; i < take; i++) {
                if (pos + i == prompt_len) attroff(COLOR_PAIR(CP_INPUT) | A_BOLD), attron(COLOR_PAIR(CP_INPUT));
                mvaddch(y + row, inner_x + (pos % inner_w) + i, (unsigned char)joined[pos + i]);
            }
            attroff(COLOR_PAIR(CP_INPUT) | A_BOLD);
            attroff(COLOR_PAIR(CP_INPUT));
            row++;
        }
        pos += take;
    }
    if (joined_len == 0) draw_text(y, inner_x, inner_w, CP_INPUT, 0, "%s", "");

    int cursor_pos = joined_len;
    int cursor_line = cursor_pos / inner_w;
    int cursor_col = cursor_pos % inner_w;
    if (cursor_line < first_line) {
        cursor_line = first_line;
        cursor_col = 0;
    }
    if (cursor_line - first_line >= height) {
        cursor_line = first_line + height - 1;
        cursor_col = inner_w - 1;
    }
    *cursor_y = y + cursor_line - first_line;
    *cursor_x = inner_x + cursor_col;
    free(joined);
}

static const char *panel_name(enum panel_kind panel) {
    switch (panel) {
    case PANEL_CHAT: return "chat";
    case PANEL_ARCHIVE: return "archive";
    case PANEL_SETTINGS: return "settings";
    case PANEL_ADMIN: return "admin";
    }
    return "chat";
}

/* ── Panels ────────────────────────────────────────────────────────────
 *
 * All three of these used to print a paragraph describing what the panel
 * would eventually show ("This panel shell is wired; ... is the next REST
 * pass"). They read the real endpoints now.
 *
 * Panel population does HTTP, so it must NOT hold app->lock — a blocking
 * request under the lock freezes the whole UI, including the draw thread.
 * Rows are gathered first and installed at the end. */

/* Format a byte count for a table cell. */
static void human_bytes(long bytes, char *out, size_t out_sz) {
    static const char *const unit[] = {"B", "KB", "MB", "GB", "TB"};
    double v = (double)bytes;
    size_t u = 0;
    while (v >= 1024.0 && u + 1 < sizeof(unit) / sizeof(unit[0])) {
        v /= 1024.0;
        u++;
    }
    if (u == 0) snprintf(out, out_sz, "%ld %s", bytes, unit[u]);
    else snprintf(out, out_sz, "%.1f %s", v, unit[u]);
}

/* Format a unix-second or ISO-8601 timestamp for a table cell. */
static void human_time(const json_value *v, char *out, size_t out_sz) {
    long secs = 0;
    if (json_long(v, &secs) && secs > 0) {
        time_t t = secs > 100000000000L ? (time_t)(secs / 1000) : (time_t)secs;
        struct tm tm;
        localtime_r(&t, &tm);
        strftime(out, out_sz, "%Y-%m-%d %H:%M", &tm);
        return;
    }
    const char *s = json_string(v);
    /* ISO-8601 truncated to minutes — the seconds and zone are noise in
     * a fixed-width table. */
    if (s) snprintf(out, out_sz, "%.16s", s);
    else snprintf(out, out_sz, "—");
}

/* GET a path and hand the parsed document to `render`. Centralises the
 * error reporting so a failing tab says WHICH call failed and why rather
 * than rendering as mysteriously empty. */
static void panel_fetch(struct app *app, const char *label, const char *path,
                        void (*render)(struct app *, const json_value *)) {
    struct http_response r = http_request(app, "GET", path, NULL);
    if (r.status < 200 || r.status >= 300) {
        panel_line(app, "  %s: HTTP %d%s%.80s", label, r.status, r.body ? " — " : "",
                   r.body ? r.body : "");
        free(r.body);
        return;
    }
    json_doc *doc = json_parse(r.body, r.body_len, NULL, 0);
    if (!doc) {
        panel_line(app, "  %s: malformed response", label);
        free(r.body);
        return;
    }
    render(app, json_root(doc));
    json_free(doc);
    free(r.body);
}

/* Some admin endpoints answer with a bare array, others with a named
 * envelope. Accept either rather than guessing wrong and showing empty. */
static const json_value *rows_of(const json_value *root, const char *key) {
    if (json_type_of(root) == JSON_ARRAY) return root;
    const json_value *v = json_get(root, key);
    if (json_type_of(v) == JSON_ARRAY) return v;
    v = json_get(root, "data");
    return json_type_of(v) == JSON_ARRAY ? v : NULL;
}

static void render_archive_rows(struct app *app, const json_value *root) {
    const json_value *rows = rows_of(root, "archive");
    size_t n = json_len(rows);
    panel_line(app, "  %-28s %-8s %8s  %s", "TARGET", "KIND", "ROWS", "LAST ACTIVITY");
    for (size_t i = 0; i < n; i++) {
        const json_value *e = json_at(rows, i);
        const char *target = json_string(json_get(e, "target"));
        const char *kind = json_string(json_get(e, "kind"));
        long count = 0;
        json_long(json_get(e, "row_count"), &count);
        char when[32];
        human_time(json_get(e, "last_activity"), when, sizeof(when));
        if (target)
            panel_line(app, "  %-28s %-8s %8ld  %s", target, kind ? kind : "?", count, when);
    }
    if (n == 0) panel_line(app, "  (nothing archived on this network)");
}

static void render_admin_users(struct app *app, const json_value *root) {
    const json_value *rows = rows_of(root, "users");
    size_t n = json_len(rows);
    panel_line(app, "  users (%zu)", n);
    panel_line(app, "    %-24s %-6s %s", "NAME", "ADMIN", "ID");
    for (size_t i = 0; i < n && i < 50; i++) {
        const json_value *e = json_at(rows, i);
        const char *name = json_string(json_get(e, "name"));
        const char *id = json_string(json_get(e, "id"));
        bool is_admin = json_bool(json_get(e, "is_admin"), false);
        if (name)
            panel_line(app, "    %-24s %-6s %.8s", name, is_admin ? "yes" : "no", id ? id : "");
    }
    if (n > 50) panel_line(app, "    ... %zu more", n - 50);
}

static void render_admin_sessions(struct app *app, const json_value *root) {
    const json_value *rows = rows_of(root, "sessions");
    size_t n = json_len(rows);
    panel_line(app, "  sessions (%zu)", n);
    /* DB state and live pid are separate sources of truth and are allowed
     * to disagree; showing both (with an explicit "—" for a missing live
     * state) is the honesty signal that something diverged. */
    panel_line(app, "    %-18s %-16s %-12s %s", "NETWORK", "NICK", "DB STATE", "LIVE");
    for (size_t i = 0; i < n && i < 50; i++) {
        const json_value *e = json_at(rows, i);
        const char *net = json_string(json_get(e, "network_slug"));
        const char *nick = json_string(json_get(e, "nick"));
        const char *db = json_string(json_get(e, "connection_state"));
        const json_value *live = json_get(e, "live_state");
        const char *live_s = json_string(live);
        panel_line(app, "    %-18s %-16s %-12s %s", net ? net : "?", nick ? nick : "?",
                   db ? db : "?", live_s ? live_s : "—");
    }
    if (n > 50) panel_line(app, "    ... %zu more", n - 50);
}

static void render_admin_visitors(struct app *app, const json_value *root) {
    const json_value *rows = rows_of(root, "visitors");
    size_t n = json_len(rows);
    panel_line(app, "  visitors (%zu)", n);
    for (size_t i = 0; i < n && i < 30; i++) {
        const json_value *e = json_at(rows, i);
        const char *nick = json_string(json_get(e, "nick"));
        char when[32];
        human_time(json_get(e, "expires_at"), when, sizeof(when));
        if (nick) panel_line(app, "    %-20s expires %s", nick, when);
    }
    if (n > 30) panel_line(app, "    ... %zu more", n - 30);
}

static void render_admin_uploads(struct app *app, const json_value *root) {
    const json_value *rows = rows_of(root, "uploads");
    size_t n = json_len(rows);
    long total = 0;
    for (size_t i = 0; i < n; i++) {
        long sz = 0;
        json_long(json_get(json_at(rows, i), "byte_size"), &sz);
        total += sz;
    }
    char human[32];
    human_bytes(total, human, sizeof(human));
    panel_line(app, "  uploads (%zu, %s total)", n, human);
}

static void render_admin_networks(struct app *app, const json_value *root) {
    const json_value *rows = rows_of(root, "networks");
    size_t n = json_len(rows);
    panel_line(app, "  networks (%zu)", n);
    panel_line(app, "    %-18s %-8s %s", "SLUG", "ID", "SERVICES");
    for (size_t i = 0; i < n && i < 30; i++) {
        const json_value *e = json_at(rows, i);
        const char *slug = json_string(json_get(e, "slug"));
        long id = 0;
        json_long(json_get(e, "id"), &id);
        const char *flavor = json_string(json_get(e, "services_flavor"));
        if (slug) panel_line(app, "    %-18s %-8ld %s", slug, id, flavor ? flavor : "—");
    }
}

static void render_settings_caps(struct app *app, const json_value *root) {
    const json_value *up = json_get(root, "upload");
    if (!up) up = root;
    const char *host = json_string(json_get(up, "active_host"));
    panel_line(app, "  upload host      %s", host ? host : "—");
    const struct { const char *key; const char *label; } caps[] = {
        {"image_per_file_cap_bytes", "image cap"},
        {"video_per_file_cap_bytes", "video cap"},
        {"document_per_file_cap_bytes", "document cap"},
        {"audio_per_file_cap_bytes", "audio cap"},
        {"global_cap_bytes", "global cap"},
    };
    for (size_t i = 0; i < sizeof(caps) / sizeof(caps[0]); i++) {
        long v = 0;
        if (json_long(json_get(up, caps[i].key), &v)) {
            char human[32];
            human_bytes(v, human, sizeof(human));
            panel_line(app, "  %-16s %s", caps[i].label, human);
        }
    }
}

static void render_notify_rows(struct app *app, const json_value *root) {
    const json_value *rows = rows_of(root, "notify");
    size_t n = json_len(rows);
    panel_line(app, "  watched nicks (%zu)", n);
    for (size_t i = 0; i < n && i < 30; i++) {
        const json_value *e = json_at(rows, i);
        const char *nick = json_string(json_get(e, "nick"));
        const char *presence = json_string(json_get(e, "presence"));
        if (nick) panel_line(app, "    %-20s %s", nick, presence ? presence : "unknown");
    }
    if (n == 0) panel_line(app, "    (none — /notify <nick> to add)");
}

static void open_panel(struct app *app, enum panel_kind panel) {
    /* Snapshot what the fetches need, then release the lock: everything
     * below blocks on HTTP. */
    pthread_mutex_lock(&app->lock);
    clear_panel_lines_locked(app);
    app->panel = panel;
    struct window current = app->windows[focused_window_locked(app)];
    size_t window_count = app->window_count;
    size_t alias_count = app->aliases.count;
    /* Snapshot the network table too — the event thread mutates it. */
    struct network nets[MAX_NETWORKS];
    size_t net_count = app->network_count;
    for (size_t i = 0; i < net_count; i++) nets[i] = app->networks[i];
    pthread_mutex_unlock(&app->lock);

    panel_line(app, "%s", panel_name(panel));
    panel_line(app, "%s", "");

    switch (panel) {
    case PANEL_ARCHIVE: {
        panel_line(app, "archive — %s", current.network);
        panel_line(app, "%s", "");
        char *slug = url_encode(current.network);
        char *path = xasprintf("/networks/%s/archive", slug);
        free(slug);
        panel_fetch(app, "archive", path, render_archive_rows);
        free(path);
        panel_line(app, "%s", "");
        panel_line(app, "  /archive open <target>   re-open an archived window");
        panel_line(app, "  /archive purge <target>  delete its scrollback (irreversible)");
        break;
    }

    case PANEL_SETTINGS:
        panel_line(app, "connection");
        panel_line(app, "  server         %s", app->url.base);
        panel_line(app, "  subject        %s", app->subject);
        panel_line(app, "  websocket      %s", app->ws_connected ? "connected" : "reconnecting");
        panel_line(app, "  windows        %zu", window_count);
        panel_line(app, "  aliases        %zu", alias_count);
        panel_line(app, "%s", "");
        panel_line(app, "networks");
        for (size_t i = 0; i < net_count; i++) {
            struct network *n = &nets[i];
            panel_line(app, "  %-16s %-10s nick %s%s%s", n->slug,
                       n->conn_known ? wire_connection_state_name(n->conn_state) : "unknown",
                       n->nick[0] ? n->nick : "—", n->umodes[0] ? " +" : "",
                       n->umodes[0] ? n->umodes : "");
        }
        panel_line(app, "%s", "");
        {
            char *nslug = url_encode(current.network);
            char *npath = xasprintf("/networks/%s/notify", nslug);
            free(nslug);
            panel_fetch(app, "notify", npath, render_notify_rows);
            free(npath);
        }
        panel_line(app, "%s", "");
        panel_line(app, "server settings");
        panel_fetch(app, "settings", "/api/server-settings", render_settings_caps);
        panel_line(app, "%s", "");
        panel_line(app, "keys");
        panel_line(app, "  PgUp/PgDn scroll   End bottom   Ctrl-N/Ctrl-P cycle windows");
        panel_line(app, "  Tab complete       Up/Down history   Esc or /chat returns to chat");
        panel_line(app, "  click a media link to preview it in the terminal");
        break;

    case PANEL_ADMIN:
        panel_line(app, "admin");
        panel_line(app, "%s", "");
        /* Every tab is fetched independently and reports its own failure,
         * so a 403 on one (a non-admin subject, or a resource missing
         * from the proxy allowlist) does not blank the whole panel. */
        panel_fetch(app, "sessions", "/admin/sessions", render_admin_sessions);
        panel_line(app, "%s", "");
        panel_fetch(app, "users", "/admin/users", render_admin_users);
        panel_line(app, "%s", "");
        panel_fetch(app, "networks", "/admin/networks", render_admin_networks);
        panel_line(app, "%s", "");
        panel_fetch(app, "visitors", "/admin/visitors", render_admin_visitors);
        panel_line(app, "%s", "");
        panel_fetch(app, "uploads", "/admin/uploads", render_admin_uploads);
        break;

    case PANEL_CHAT:
        break;
    }
}

static int split_message_line(const char *line, char *prefix, size_t prefix_sz, char *nick, size_t nick_sz, const char **body) {
    const char *visible = line;
    if (*visible == '[') {
        const char *end = strchr(visible, ']');
        if (end && end[1] == ' ') visible = end + 2;
    }
    const char *lt = strchr(visible, '<');
    const char *gt = lt ? strchr(lt, '>') : NULL;
    if (!lt || !gt || gt <= lt + 1) {
        prefix[0] = 0;
        nick[0] = 0;
        *body = visible;
        return 0;
    }
    size_t plen = (size_t)(lt - visible);
    if (plen >= prefix_sz) plen = prefix_sz - 1;
    memcpy(prefix, visible, plen);
    prefix[plen] = 0;
    size_t nlen = (size_t)(gt - lt - 1);
    if (nlen >= nick_sz) nlen = nick_sz - 1;
    memcpy(nick, lt + 1, nlen);
    nick[nlen] = 0;
    *body = gt + 1;
    while (**body == ' ') (*body)++;
    return 1;
}

static bool login(struct app *app, const char *identifier, const char *password) {
    char *id = json_escape(identifier);
    char *pw = json_escape(password);
    char *body = xasprintf("{\"identifier\":\"%s\",\"password\":\"%s\"}", id, pw);
    free(id);
    free(pw);
    struct http_response r = http_request(app, "POST", "/auth/login", body);
    free(body);
    if (r.status < 200 || r.status >= 300) {
        fprintf(stderr, "login failed HTTP %d: %s\n", r.status, r.body);
        free(r.body);
        return false;
    }
    if (!json_top_string(r.body, r.body_len, "token", app->token, sizeof(app->token))) die("login response missing token");
    parse_subject(r.body, r.body_len, app->subject, sizeof(app->subject));
    if (!app->subject[0]) die("login response missing subject");
    free(r.body);
    return true;
}

static unsigned long token_key_hash(const char *server, const char *identifier) {
    char *key = xasprintf("%s|%s", server, identifier);
    unsigned long h = djb2(key);
    free(key);
    return h;
}

static char *token_path_for(const char *server, const char *identifier) {
    const char *home = getenv("HOME");
    if (!home || !home[0]) home = ".";
    char *dir = xasprintf("%s/.local", home);
    mkdir(dir, 0700);
    free(dir);
    dir = xasprintf("%s/.local/share", home);
    mkdir(dir, 0700);
    free(dir);
    dir = xasprintf("%s/.local/share/shottino", home);
    mkdir(dir, 0700);
    char *path = xasprintf("%s/%lx.token", dir, token_key_hash(server, identifier));
    free(dir);
    return path;
}

static bool load_saved_token(struct app *app, const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return false;
    if (!fgets(app->token, sizeof(app->token), f)) {
        fclose(f);
        return false;
    }
    fclose(f);
    app->token[strcspn(app->token, "\r\n")] = 0;
    return app->token[0] != 0;
}

static void save_token(struct app *app, const char *path) {
    FILE *f = fopen(path, "w");
    if (!f) return;
    chmod(path, 0600);
    fprintf(f, "%s\n", app->token);
    fclose(f);
    chmod(path, 0600);
}

static bool validate_saved_token(struct app *app) {
    struct http_response me = http_request(app, "GET", "/me", NULL);
    bool ok = me.status >= 200 && me.status < 300;
    if (ok) parse_subject(me.body, me.body_len, app->subject, sizeof(app->subject));
    free(me.body);
    return ok && app->subject[0];
}

static bool attach_or_login(struct app *app, const char *identifier, const char *password) {
    char *path = token_path_for(app->url.base, identifier);
    snprintf(app->token_path, sizeof(app->token_path), "%s", path);
    if (load_saved_token(app, path) && validate_saved_token(app)) {
        log_line(app, "reattached saved grappa session as %s", app->subject);
        free(path);
        return true;
    }
    app->token[0] = 0;
    app->subject[0] = 0;
    bool ok = login(app, identifier, password);
    if (ok) save_token(app, path);
    free(path);
    return ok;
}

static char *login_identifier_for_mode(const char *mode, const char *identifier) {
    if (strcmp(mode, "user") == 0 && strchr(identifier, '@') == NULL) {
        return xasprintf("%s@shottino.local", identifier);
    }
    return xasprintf("%s", identifier);
}

// Visitor session-sharing — consume side. Unauthenticated by design: the
// signed token IS the credential. POST /auth/share/consume {token} returns the
// same wire shape as /auth/login ({token, subject}) for the SAME visitor row.
static bool consume_share(struct app *app, const char *share_token) {
    char *t = json_escape(share_token);
    char *body = xasprintf("{\"token\":\"%s\"}", t);
    free(t);
    struct http_response r = http_request(app, "POST", "/auth/share/consume", body);
    free(body);
    if (r.status < 200 || r.status >= 300) {
        fprintf(stderr, "share consume failed HTTP %d: %s\n", r.status, r.body);
        free(r.body);
        return false;
    }
    if (!json_top_string(r.body, r.body_len, "token", app->token, sizeof(app->token))) die("share consume response missing token");
    parse_subject(r.body, r.body_len, app->subject, sizeof(app->subject));
    if (!app->subject[0]) die("share consume response missing subject");
    free(r.body);
    return true;
}

// Mirror of attach_or_login for the share path: reattach a previously consumed
// session if its bearer still validates, else consume the one-shot share token.
// Keyed on a fixed "visitor-share" identifier so a relaunch with the (now
// spent) link reattaches via the saved bearer instead of a doomed re-consume.
static bool attach_or_consume(struct app *app, const char *base, const char *share_token) {
    char *path = token_path_for(base, "visitor-share");
    snprintf(app->token_path, sizeof(app->token_path), "%s", path);
    if (load_saved_token(app, path) && validate_saved_token(app)) {
        log_line(app, "reattached saved grappa session as %s", app->subject);
        free(path);
        return true;
    }
    app->token[0] = 0;
    app->subject[0] = 0;
    bool ok = consume_share(app, share_token);
    if (ok) save_token(app, path);
    free(path);
    return ok;
}

static void logout_grappa(struct app *app) {
    struct http_response r = http_request(app, "DELETE", "/auth/logout", NULL);
    if (r.status == 204 || (r.status >= 200 && r.status < 300)) {
        log_line(app, "grappa session terminated");
        if (app->token_path[0]) unlink(app->token_path);
    } else {
        log_line(app, "logout failed HTTP %d: %.200s", r.status, r.body);
    }
    free(r.body);
}

static void seed_state(struct app *app) {
    struct http_response me = http_request(app, "GET", "/me", NULL);
    if (me.status >= 200 && me.status < 300) log_line(app, "authenticated as %s", app->subject);
    free(me.body);

    struct http_response nets = http_request(app, "GET", "/networks", NULL);
    if (nets.status < 200 || nets.status >= 300) die("GET /networks failed HTTP %d: %s", nets.status, nets.body);
    parse_networks(app, nets.body, nets.body_len);
    free(nets.body);
    if (app->network_count == 0) die("no networks available");

    for (size_t i = 0; i < app->network_count; i++) {
        /* Every network gets a $server window, not just a network with no
         * channels. It is where server replies land — MOTD, LUSERS, WHOIS,
         * LINKS, connection-state transitions — and previously those had
         * nowhere network-scoped to go, so a network with one channel had
         * its server output land in the channel or nowhere at all. */
        add_window_ex(app, app->networks[i].slug, "$server", false);
        char *slug = url_encode(app->networks[i].slug);
        char *path = xasprintf("/networks/%s/channels", slug);
        free(slug);
        struct http_response ch = http_request(app, "GET", path, NULL);
        free(path);
        if (ch.status >= 200 && ch.status < 300) parse_channels(app, app->networks[i].slug, ch.body, ch.body_len);
        free(ch.body);
    }
    /* Land on a real conversation, not on $server.
     *
     * $server is READ-ONLY by server contract — `validate_post_target_name/1`
     * rejects it with :bad_request — so focusing it at startup meant the
     * first thing a user typed came back as a bare "send failed HTTP 400".
     * Prefer the first channel or query; fall back to $server only when
     * there is genuinely nothing else, which is the case it exists for. */
    struct pane *p = focused_pane_locked(app);
    p->window = 0;
    for (size_t i = 0; i < app->window_count; i++) {
        if (!is_server_window(app->windows[i].channel)) {
            p->window = i;
            break;
        }
    }
}

static void fetch_scrollback(struct app *app, struct window *w) {
    char *net = url_encode(w->network);
    char *chan = url_encode(w->channel);
    char *path = xasprintf("/networks/%s/channels/%s/messages?limit=80", net, chan);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "GET", path, NULL);
    free(path);
    if (r.status >= 200 && r.status < 300) parse_messages(app, r.body, r.body_len);
    else log_line(app, "GET messages failed HTTP %d", r.status);
    free(r.body);
}

static void fetch_scrollback_target(struct app *app, const char *network, const char *channel) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *path = xasprintf("/networks/%s/channels/%s/messages?limit=80", net, chan);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "GET", path, NULL);
    free(path);
    if (r.status >= 200 && r.status < 300) parse_messages(app, r.body, r.body_len);
    else log_line(app, "GET messages failed HTTP %d", r.status);
    free(r.body);
}

static char *base64_encode(const unsigned char *buf, size_t len) {
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO *mem = BIO_new(BIO_s_mem());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_push(b64, mem);
    BIO_write(b64, buf, (int)len);
    BIO_flush(b64);
    BUF_MEM *bptr = NULL;
    BIO_get_mem_ptr(mem, &bptr);
    char *out = malloc(bptr->length + 1);
    if (!out) die("out of memory");
    memcpy(out, bptr->data, bptr->length);
    out[bptr->length] = 0;
    BIO_free_all(b64);
    return out;
}

/* base64url (RFC 4648 §5): standard base64 with `-`/`_` substituted for
 * `+`/`/` and the `=` padding stripped. Phoenix's websocket transport
 * expects the bearer in exactly this form, and phoenix.js builds it the
 * same way (btoa, the two substitutions, then strip padding). */
static char *base64url_encode(const unsigned char *buf, size_t len) {
    char *b64 = base64_encode(buf, len);
    for (char *p = b64; *p; p++) {
        if (*p == '+') *p = '-';
        else if (*p == '/') *p = '_';
    }
    size_t n = strlen(b64);
    while (n > 0 && b64[n - 1] == '=') b64[--n] = '\0';
    return b64;
}

static bool ws_connect(struct app *app) {
    if (!conn_open(app, &app->ws)) return false;
    unsigned char nonce[16];
    RAND_bytes(nonce, sizeof(nonce));
    char *key = base64_encode(nonce, sizeof(nonce));

    /* The bearer rides the Sec-WebSocket-Protocol SUBPROTOCOL, never the
     * upgrade URL.
     *
     * #95 introduced this path — a `?token=…` query string is visible in
     * nginx access logs before redaction — and kept the query-string
     * bearer as a fallback. #202 (2026-07-19) DROPPED that fallback:
     * `UserSocket.connect/3` now reads the token ONLY from
     * `connect_info.auth_token`, which Phoenix decodes from
     * `base64url.bearer.phx.<base64url(token)>`.
     *
     * Shottino was still sending `?token=…` with no subprotocol, so every
     * handshake since #202 landed was rejected before it reached the
     * channel. That is what "websocket unavailable" was reporting. */
    char *tok_b64 = base64url_encode((const unsigned char *)app->token, strlen(app->token));
    char *req = xasprintf(
        "GET /socket/websocket?vsn=2.0.0 HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Protocol: base64url.bearer.phx.%s\r\n"
        "User-Agent: shottino/0.1\r\n\r\n",
        app->url.host, key, tok_b64);
    free(tok_b64);
    free(key);
    if (!conn_write_all(&app->ws, req, strlen(req))) {
        free(req);
        return false;
    }
    free(req);
    char hdr[4096];
    size_t len = 0;
    while (len + 1 < sizeof(hdr)) {
        char c;
        ssize_t n = conn_read(&app->ws, &c, 1);
        if (n <= 0) {
            log_line(app, "websocket handshake: connection closed before a reply");
            return false;
        }
        hdr[len++] = c;
        hdr[len] = 0;
        if (strstr(hdr, "\r\n\r\n")) break;
    }
    if (!strstr(hdr, " 101 ")) {
        /* Report WHAT the server said. "websocket unavailable" with no
         * status is what made this bug take a server-side code read to
         * diagnose: a 403 (bad/expired bearer) and a 404 (wrong path, or
         * a proxy not forwarding /socket) are entirely different repairs
         * and looked identical from here. */
        char status[128] = "";
        const char *eol = strstr(hdr, "\r\n");
        size_t status_len = eol ? (size_t)(eol - hdr) : len;
        if (status_len >= sizeof(status)) status_len = sizeof(status) - 1;
        memcpy(status, hdr, status_len);
        status[status_len] = '\0';
        log_line(app, "websocket handshake rejected: %s", status[0] ? status : "(no status line)");
        return false;
    }
    int flags = fcntl(app->ws.fd, F_GETFL, 0);
    fcntl(app->ws.fd, F_SETFL, flags | O_NONBLOCK);
    app->ws_connected = true;
    app->next_heartbeat = time(NULL) + 25;
    return true;
}

static bool ws_send_text(struct app *app, const char *text) {
    if (!app->ws_connected) return false;
    size_t len = strlen(text);
    unsigned char hdr[14];
    size_t hlen = 0;
    hdr[hlen++] = 0x81;
    if (len < 126) {
        hdr[hlen++] = 0x80 | (unsigned char)len;
    } else if (len <= 65535) {
        hdr[hlen++] = 0x80 | 126;
        hdr[hlen++] = (unsigned char)(len >> 8);
        hdr[hlen++] = (unsigned char)len;
    } else {
        hdr[hlen++] = 0x80 | 127;
        for (int i = 7; i >= 0; i--) hdr[hlen++] = (unsigned char)(len >> (i * 8));
    }
    unsigned char mask[4];
    RAND_bytes(mask, sizeof(mask));
    memcpy(hdr + hlen, mask, 4);
    hlen += 4;
    unsigned char *frame = malloc(hlen + len);
    if (!frame) die("out of memory");
    memcpy(frame, hdr, hlen);
    for (size_t i = 0; i < len; i++) frame[hlen + i] = ((const unsigned char *)text)[i] ^ mask[i % 4];
    bool ok = conn_write_all(&app->ws, (const char *)frame, hlen + len);
    free(frame);
    return ok;
}

static void ws_join(struct app *app, const char *topic) {
    char ref[32];
    snprintf(ref, sizeof(ref), "%lu", ++app->ws_ref);
    char *topic_json = json_escape(topic);
    char *frame = xasprintf("[\"%s\",\"%s\",\"%s\",\"phx_join\",{}]", ref, ref, topic_json);
    free(topic_json);
    ws_send_text(app, frame);
    free(frame);
}

static void ws_push_user(struct app *app, const char *event, const char *payload) {
    if (!app->ws_connected) {
        log_line(app, "websocket is not connected; /%s not sent", event);
        return;
    }
    char ref[32];
    snprintf(ref, sizeof(ref), "%lu", ++app->ws_ref);
    char *topic = xasprintf("grappa:user:%s", app->subject);
    char *topic_json = json_escape(topic);
    char *event_json = json_escape(event);
    char *frame = xasprintf("[\"%s\",\"%s\",\"%s\",\"%s\",%s]", ref, ref, topic_json, event_json, payload);
    free(topic);
    free(topic_json);
    free(event_json);
    ws_send_text(app, frame);
    free(frame);
}

/* ── Panes ─────────────────────────────────────────────────────────────
 *
 * There is ALWAYS at least one pane; an unsplit client is the one-pane
 * case of the same code, not a separate path. */
static struct pane *focused_pane_locked(struct app *app) {
    if (app->pane_count == 0) {
        app->pane_count = 1;
        app->focus = 0;
        app->panes[0].window = 0;
        app->panes[0].weight = 1;
    }
    if (app->focus >= app->pane_count) app->focus = app->pane_count - 1;
    return &app->panes[app->focus];
}

static size_t focused_window_locked(struct app *app) {
    return focused_pane_locked(app)->window;
}

/* Is this window on screen in ANY pane? Unread is about what you have
 * not seen, and a window you are looking at in the other pane is a
 * window you have seen. */
static bool window_is_visible_locked(struct app *app, size_t idx) {
    for (size_t i = 0; i < app->pane_count; i++)
        if (app->panes[i].window == idx) return true;
    return false;
}

/* ── Which window am I typing into? ───────────────────────────────────
 *
 * ONE door, and it copies.
 *
 * `current_channel()` used to hand back a pointer straight into
 * app->windows[app->current].channel, and every command handler read
 * app->windows[app->current] directly. Neither holds the lock, and the
 * focused window is not the command thread's private property: the
 * socket thread renames windows, rewrites rosters and appends new ones,
 * and `/win` itself moves app->current. A pointer into that array is
 * only valid for as long as nobody touches it, which is not a guarantee
 * anyone was making — the string could be rewritten between the call and
 * the xasprintf that used it, and app->current could name a different
 * window by the time the value landed in a payload.
 *
 * Copying under the lock costs two snprintfs and removes the whole
 * class. The _locked forms are for the draw path, which holds the lock
 * for its entire frame. */
static int current_network_id_locked(struct app *app) {
    const char *slug = app->windows[focused_window_locked(app)].network;
    for (size_t i = 0; i < app->network_count; i++) {
        if (irc_name_eq(app->networks[i].slug, slug)) return app->networks[i].id;
    }
    return app->network_count > 0 ? app->networks[0].id : 0;
}

static int current_network_id(struct app *app) {
    pthread_mutex_lock(&app->lock);
    int id = current_network_id_locked(app);
    pthread_mutex_unlock(&app->lock);
    return id;
}

/* Copy the focused window's (network, channel) out. Either buffer may be
 * NULL. Returns false — leaving the buffers empty — when there is no
 * window, which a caller about to address one must check rather than
 * sending a payload naming "". */
static bool current_window_key(struct app *app, char *network, size_t net_sz, char *channel,
                               size_t chan_sz) {
    if (network && net_sz) network[0] = '\0';
    if (channel && chan_sz) channel[0] = '\0';
    pthread_mutex_lock(&app->lock);
    size_t cur = focused_window_locked(app);
    bool have = app->window_count > 0 && cur < app->window_count;
    if (have) {
        const struct window *w = &app->windows[cur];
        if (network && net_sz) snprintf(network, net_sz, "%s", w->network);
        if (channel && chan_sz) snprintf(channel, chan_sz, "%s", w->channel);
    }
    pthread_mutex_unlock(&app->lock);
    return have;
}

static void ws_join_topics(struct app *app) {
    char *subject = json_escape(app->subject);
    char *topic = xasprintf("grappa:user:%s", subject);
    free(subject);
    ws_join(app, topic);
    free(topic);
    for (size_t i = 0; i < app->window_count; i++) {
        char *chan = json_escape(app->windows[i].channel);
        char *net = json_escape(app->windows[i].network);
        char *t = xasprintf("grappa:user:%s/network:%s/channel:%s", app->subject, net, chan);
        free(chan);
        free(net);
        ws_join(app, t);
        app->windows[i].joined_ws = true;
        free(t);
    }
}

static int ws_read_frame(struct app *app, char **out) {
    unsigned char h[2];
    ssize_t n = conn_read(&app->ws, h, 2);
    if (n < 0) {
        int e = app->ws.tls ? SSL_get_error(app->ws.ssl, (int)n) : 0;
        if ((!app->ws.tls && (errno == EAGAIN || errno == EWOULDBLOCK)) || e == SSL_ERROR_WANT_READ) return 0;
        return -1;
    }
    if (n == 0) return -1;
    if (n != 2) return 0;
    int opcode = h[0] & 0x0f;
    bool masked = (h[1] & 0x80) != 0;
    uint64_t len = h[1] & 0x7f;
    if (len == 126) {
        unsigned char x[2];
        if (conn_read(&app->ws, x, 2) != 2) return 0;
        len = ((uint64_t)x[0] << 8) | x[1];
    } else if (len == 127) {
        unsigned char x[8];
        if (conn_read(&app->ws, x, 8) != 8) return 0;
        len = 0;
        for (int i = 0; i < 8; i++) len = (len << 8) | x[i];
    }
    if (len > WS_MAX_PAYLOAD) return -1;
    unsigned char mask[4] = {0};
    if (masked && conn_read(&app->ws, mask, 4) != 4) return 0;
    char *payload = malloc((size_t)len + 1);
    if (!payload) die("out of memory");
    size_t off = 0;
    while (off < len) {
        ssize_t r = conn_read(&app->ws, payload + off, (size_t)len - off);
        if (r <= 0) {
            free(payload);
            return 0;
        }
        off += (size_t)r;
    }
    for (size_t i = 0; masked && i < len; i++) payload[i] ^= mask[i % 4];
    payload[len] = 0;
    if (opcode == 0x8) {
        free(payload);
        return -1;
    }
    if (opcode == 0x9) {
        free(payload);
        return 0;
    }
    if (opcode != 0x1) {
        free(payload);
        return 0;
    }
    *out = payload;
    return 1;
}

/* ── Typed wire-event handling ─────────────────────────────────────────
 *
 * One narrow, one dispatch. Every arm receives a fully-validated event, so
 * no handler re-reads the raw frame and none can half-apply a malformed
 * payload. A kind shottino does not consume falls through silently: a
 * version-skewed server WILL push events this build has never heard of,
 * and that is not an error worth a line in the user's chat buffer. */

static struct network *network_by_slug_locked(struct app *app, const char *slug) {
    for (size_t i = 0; i < app->network_count; i++)
        if (irc_name_eq(app->networks[i].slug, slug)) return &app->networks[i];
    return NULL;
}

static struct network *network_by_id_locked(struct app *app, long id) {
    for (size_t i = 0; i < app->network_count; i++)
        if (app->networks[i].id == (int)id) return &app->networks[i];
    return NULL;
}

/* Caller holds app->lock. The draw path is already inside the lock, so
 * the locking wrapper below would self-deadlock there — hence the split. */
/* This network's prefix precedence, highest rank first, as parallel
 * letter/sigil tables. Falls back to the near-universal (qaohv)~&@%+ map
 * until 005 lands, so a roster drawn before ISUPPORT still tiers.
 * `letters` may be NULL when the caller only wants sigils. Caller holds
 * app->lock. */
static size_t network_prefixes_locked(struct app *app, const char *network, const char **letters,
                                      const char **sigils) {
    static const char fallback_letters[] = "qaohv";
    static const char fallback_sigils[] = "~&@%+";
    struct network *n = network_by_slug_locked(app, network);
    if (n && n->prefix_count) {
        if (letters) *letters = n->prefix_letters;
        *sigils = n->prefix_sigils;
        return n->prefix_count;
    }
    if (letters) *letters = fallback_letters;
    *sigils = fallback_sigils;
    return sizeof(fallback_sigils) - 1;
}

/* Rank of the highest prefix a member holds: 0 = highest (owner/op),
 * `count` = no prefix at all, so a plain user always sorts last.
 *
 * The member's `modes` are PREFIX SIGILS — `@`, `+` — because that is
 * what the wire carries (grappa stores sigils; cic's tierRank matches on
 * them). This used to test mode LETTERS (`strchr(modes, 'o')`), which
 * matches nothing a server ever sends: every member ranked plain, the
 * roster never tiered, and no sigil was ever drawn beside a nick.
 * Caller holds app->lock. */
static size_t member_rank_locked(struct app *app, const char *network, const char *modes) {
    const char *sigils;
    size_t count = network_prefixes_locked(app, network, NULL, &sigils);
    for (size_t i = 0; i < count; i++)
        if (strchr(modes, sigils[i])) return i;
    return count;
}

static char member_sigil_locked(struct app *app, const char *network, const char *modes) {
    const char *sigils;
    size_t count = network_prefixes_locked(app, network, NULL, &sigils);
    size_t rank = member_rank_locked(app, network, modes);
    return rank < count ? sigils[rank] : 0;
}

/* Word for a member's tier, for the /members listing. Derived from the
 * mode LETTER the network pairs with the sigil the member holds, so a
 * network with an unusual PREFIX still gets a truthful label. */
static const char *member_rank_label_locked(struct app *app, const char *network,
                                            const char *modes) {
    const char *letters, *sigils;
    size_t count = network_prefixes_locked(app, network, &letters, &sigils);
    size_t rank = member_rank_locked(app, network, modes);
    if (rank >= count) return "user";
    switch (letters[rank]) {
    case 'q': return "owner";
    case 'a': return "admin";
    case 'o': return "op";
    case 'h': return "halfop";
    case 'v': return "voice";
    default: return "prefix";
    }
}

/* Locking twins, for the command thread. The draw path holds app->lock
 * for the whole frame and must use the _locked forms. */
static const char *member_rank_label(struct app *app, const char *network, const char *modes) {
    pthread_mutex_lock(&app->lock);
    const char *label = member_rank_label_locked(app, network, modes);
    pthread_mutex_unlock(&app->lock);
    return label;
}

static void sort_members(struct app *app, const char *network, struct member *m, size_t count) {
    pthread_mutex_lock(&app->lock);
    sort_members_locked(app, network, m, count);
    pthread_mutex_unlock(&app->lock);
}

static char member_sigil(struct app *app, const char *network, const char *modes) {
    pthread_mutex_lock(&app->lock);
    char sigil = member_sigil_locked(app, network, modes);
    pthread_mutex_unlock(&app->lock);
    return sigil;
}

static void set_window_state(struct app *app, const char *network, const char *channel,
                            enum window_state state, const char *detail, long numeric) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (window_matches(&app->windows[i], network, channel)) {
            app->windows[i].state = state;
            snprintf(app->windows[i].state_detail, sizeof(app->windows[i].state_detail), "%s",
                     detail ? detail : "");
            app->windows[i].failure_numeric = numeric;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static void copy_members_from_wire(struct app *app, const char *network, const char *channel,
                                   const json_value *list, size_t count) {
    /* Zero-init: wire_member_at cannot fail on a narrowed event today, but if
     * it ever did, the `continue` below would leave members[i] as uninitialised
     * stack that set_window_members still copies (interior hole -> a nick made
     * of stack garbage). One line closes that narrower/accessor coupling. */
    struct member members[512] = {0};
    size_t n = count > 512 ? 512 : count;
    for (size_t i = 0; i < n; i++) {
        struct wire_member wm;
        if (!wire_member_at(list, i, &wm)) continue;
        snprintf(members[i].nick, sizeof(members[i].nick), "%s", wm.nick);
        members[i].modes[0] = '\0';
        for (size_t j = 0, w = 0; j < wm.mode_count && w + 1 < sizeof(members[i].modes); j++) {
            const char *mode = wire_string_at(wm.modes, j);
            if (mode && mode[0]) {
                members[i].modes[w++] = mode[0];
                members[i].modes[w] = '\0';
            }
        }
    }
    set_window_members(app, network, channel, members, n);
}

/* ── Reply cards ───────────────────────────────────────────────────────
 *
 * Every one of these is a reply to something the user typed. Shottino
 * pushed the request upstream and then dropped the bundle that came back,
 * so /whois, /who, /names, /lusers, /banlist, /links, /motd, /info and
 * /version were all write-only verbs: they did something on the server and
 * showed the user nothing.
 *
 * They render where the user ASKED — the window that had focus when the
 * answer arrived — because that is where they are looking and where they
 * will look for it again. A /whois typed in a channel used to answer on
 * $server, two tabs away, which reads as the command having done
 * nothing. The row is filed under that window and stays there: switch
 * away and it does not follow, switch back and it is still there. Same
 * rule the rest of the operational output already follows (see
 * log_scope_of_locked).
 *
 * A card for a network the focused window does not belong to still lands
 * on that network's $server: the answer to a question asked elsewhere
 * has no business in the conversation you are reading, and it keeps one
 * network's MOTD out of another's.
 */

/* One card row, filed under the window that is being read. */
static void card(struct app *app, const char *network, const char *fmt, ...)
    __attribute__((format(printf, 3, 4)));

static void card(struct app *app, const char *network, const char *fmt, ...) {
    char body[MAX_LINE];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(body, sizeof(body), fmt, ap);
    va_end(ap);
    /* The scope travels as the row's own prefix rather than being left
     * to the focused window at push time: it is decided HERE, under one
     * lock, so a card cannot be filed under a window the user switched
     * to between the decision and the write. The prefix is stripped
     * before drawing. */
    char scope[MAX_SLUG + MAX_CHANNEL + 8];
    pthread_mutex_lock(&app->lock);
    size_t cur = focused_window_locked(app);
    if (cur < app->window_count && irc_name_eq(app->windows[cur].network, network))
        snprintf(scope, sizeof(scope), "[%s/%s]", app->windows[cur].network,
                 app->windows[cur].channel);
    else
        snprintf(scope, sizeof(scope), "[%s/" SERVER_WINDOW "]", network);
    pthread_mutex_unlock(&app->lock);
    log_line(app, "%s %s", scope, body);
}

/* Skip a NULL/empty field rather than printing "(null)" or a blank row —
 * a WHOIS against a hidden user is mostly empty and should read as short,
 * not as a wall of dashes. */
static void card_field(struct app *app, const char *network, const char *label, const char *value) {
    if (value && value[0]) card(app, network, "  %-12s %s", label, value);
}

static void render_whois(struct app *app, const struct wire_event *ev) {
    const char *net = ev->u.whois.network;
    card(app, net, "--- WHOIS %s", ev->u.whois.target);
    if (ev->u.whois.user || ev->u.whois.host) {
        card(app, net, "  %-12s %s@%s", "user", ev->u.whois.user ? ev->u.whois.user : "?",
             ev->u.whois.host ? ev->u.whois.host : "?");
    }
    card_field(app, net, "realname", ev->u.whois.realname);
    card_field(app, net, "account", ev->u.whois.account);
    if (ev->u.whois.server) {
        card(app, net, "  %-12s %s%s%s", "server", ev->u.whois.server,
             ev->u.whois.server_info ? " — " : "",
             ev->u.whois.server_info ? ev->u.whois.server_info : "");
    }
    card_field(app, net, "modes", ev->u.whois.umodes);
    card_field(app, net, "away", ev->u.whois.away_message);
    card_field(app, net, "actually", ev->u.whois.actually_host);
    card_field(app, net, "ip", ev->u.whois.actually_ip);

    if (ev->u.whois.has_idle) {
        long s = ev->u.whois.idle_seconds;
        card(app, net, "  %-12s %ldh %ldm %lds", "idle", s / 3600, (s % 3600) / 60, s % 60);
    }
    if (ev->u.whois.has_signon) {
        time_t t = (time_t)ev->u.whois.signon;
        struct tm tm;
        char when[64];
        localtime_r(&t, &tm);
        strftime(when, sizeof(when), "%Y-%m-%d %H:%M", &tm);
        card(app, net, "  %-12s %s", "signon", when);
    }

    /* Flags collapse onto one line — nine separate "yes" rows would bury
     * the fields that carry actual information. */
    char flags[256] = "";
    size_t w = 0;
    const struct { bool on; const char *name; } flag_list[] = {
        {ev->u.whois.is_operator, "operator"},
        {ev->u.whois.is_admin, "admin"},
        {ev->u.whois.is_services_admin, "services-admin"},
        {ev->u.whois.is_helper, "helper"},
        {ev->u.whois.is_chanop, "chanop"},
        {ev->u.whois.is_registered, "registered"},
        {ev->u.whois.using_ssl || ev->u.whois.secure, "secure"},
        {ev->u.whois.is_agent, "agent"},
        {ev->u.whois.is_java, "java"},
    };
    for (size_t i = 0; i < sizeof(flag_list) / sizeof(flag_list[0]); i++) {
        if (!flag_list[i].on) continue;
        int n = snprintf(flags + w, sizeof(flags) - w, "%s%s", w ? ", " : "", flag_list[i].name);
        if (n > 0 && (size_t)n < sizeof(flags) - w) w += (size_t)n;
    }
    card_field(app, net, "flags", flags);
    card_field(app, net, "oper", ev->u.whois.oper_text);
    card_field(app, net, "cipher", ev->u.whois.secure_cipher);
    card_field(app, net, "certfp", ev->u.whois.certfp);

    if (ev->u.whois.has_channels && ev->u.whois.channel_count) {
        /* Channels wrap across rows instead of one row each — an active
         * user is in dozens and would otherwise fill the buffer. */
        char line[MAX_LINE] = "";
        size_t lw = 0;
        bool first_row = true;
        for (size_t i = 0; i < ev->u.whois.channel_count; i++) {
            const char *ch = wire_string_at(ev->u.whois.channels, i);
            if (!ch) continue;
            if (lw && lw + strlen(ch) + 1 >= 68) {
                /* Only the first row carries the label; continuation rows
                 * align under it so the block reads as one field. */
                card(app, net, "  %-12s %s", first_row ? "channels" : "", line);
                first_row = false;
                line[0] = '\0';
                lw = 0;
            }
            int n = snprintf(line + lw, sizeof(line) - lw, "%s%s", lw ? " " : "", ch);
            if (n > 0 && (size_t)n < sizeof(line) - lw) lw += (size_t)n;
        }
        if (lw) card(app, net, "  %-12s %s", first_row ? "channels" : "", line);
    }
    for (size_t i = 0; i < ev->u.whois.extra_count; i++) {
        struct wire_whois_extra x;
        if (wire_whois_extra_at(ev->u.whois.extra_lines, i, &x))
            card(app, net, "  %-12s %s", "", x.text);
    }
}

static void render_whowas(struct app *app, const struct wire_event *ev) {
    const char *net = ev->u.whowas.network;
    if (ev->u.whowas.not_found) {
        card(app, net, "--- WHOWAS %s: no such nick in history", ev->u.whowas.target);
        return;
    }
    card(app, net, "--- WHOWAS %s", ev->u.whowas.target);
    if (ev->u.whowas.user || ev->u.whowas.host)
        card(app, net, "  %-12s %s@%s", "user", ev->u.whowas.user ? ev->u.whowas.user : "?",
             ev->u.whowas.host ? ev->u.whowas.host : "?");
    card_field(app, net, "realname", ev->u.whowas.realname);
    card_field(app, net, "server", ev->u.whowas.server);
    card_field(app, net, "last seen", ev->u.whowas.logoff_time);
}

static void render_who(struct app *app, const struct wire_event *ev) {
    const char *net = ev->u.who_reply.network;
    card(app, net, "--- WHO %s (%zu)", ev->u.who_reply.target, ev->u.who_reply.user_count);
    for (size_t i = 0; i < ev->u.who_reply.user_count; i++) {
        struct wire_who_user u;
        if (!wire_who_user_at(ev->u.who_reply.users, i, &u)) continue;
        card(app, net, "  %-16s %-4s %s@%s%s%s", u.nick, u.modes ? u.modes : "",
             u.user ? u.user : "?", u.host ? u.host : "?", u.realname ? " — " : "",
             u.realname ? u.realname : "");
    }
    if (ev->u.who_reply.user_count == 0) card(app, net, "  (no matches)");
}

static void render_names(struct app *app, const struct wire_event *ev) {
    const char *net = ev->u.names_reply.network;
    card(app, net, "--- NAMES %s (%zu)", ev->u.names_reply.channel,
         ev->u.names_reply.member_count);
    /* Wrapped columns, sigils resolved from this network's PREFIX. */
    char line[MAX_LINE] = "";
    size_t lw = 0;
    for (size_t i = 0; i < ev->u.names_reply.member_count; i++) {
        struct wire_member m;
        if (!wire_member_at(ev->u.names_reply.members, i, &m)) continue;
        char modes[8] = "";
        for (size_t j = 0, w = 0; j < m.mode_count && w + 1 < sizeof(modes); j++) {
            const char *mode = wire_string_at(m.modes, j);
            if (mode && mode[0]) { modes[w++] = mode[0]; modes[w] = '\0'; }
        }
        char sigil = member_sigil(app, net, modes);
        char entry[MAX_CHANNEL + 2];
        snprintf(entry, sizeof(entry), "%c%s", sigil ? sigil : ' ', m.nick);
        if (lw && lw + strlen(entry) + 1 >= 70) {
            card(app, net, "  %s", line);
            line[0] = '\0';
            lw = 0;
        }
        int n = snprintf(line + lw, sizeof(line) - lw, "%s%s", lw ? " " : "", entry);
        if (n > 0 && (size_t)n < sizeof(line) - lw) lw += (size_t)n;
    }
    if (lw) card(app, net, "  %s", line);
    /* NAMES doubles as a roster refresh for the channel's member pane. */
    copy_members_from_wire(app, net, ev->u.names_reply.channel, ev->u.names_reply.members,
                           ev->u.names_reply.member_count);
}

static void render_lusers(struct app *app, const struct wire_event *ev) {
    const char *net = ev->u.lusers.network;
    card(app, net, "--- LUSERS");
    const struct { int idx; const char *label; long value; } rows[] = {
        {LUSERS_TOTAL_USERS, "users", ev->u.lusers.total_users},
        {LUSERS_INVISIBLE, "invisible", ev->u.lusers.invisible},
        {LUSERS_OPERATORS, "operators", ev->u.lusers.operators},
        {LUSERS_SERVERS, "servers", ev->u.lusers.servers},
        {LUSERS_UNKNOWN_CONNECTIONS, "unknown", ev->u.lusers.unknown_connections},
        {LUSERS_CHANNELS_FORMED, "channels", ev->u.lusers.channels_formed},
        {LUSERS_LOCAL_CLIENTS, "local", ev->u.lusers.local_clients},
        {LUSERS_LOCAL_SERVERS, "local srv", ev->u.lusers.local_servers},
        {LUSERS_CURRENT_LOCAL, "cur local", ev->u.lusers.current_local},
        {LUSERS_MAX_LOCAL, "max local", ev->u.lusers.max_local},
        {LUSERS_CURRENT_GLOBAL, "cur global", ev->u.lusers.current_global},
        {LUSERS_MAX_GLOBAL, "max global", ev->u.lusers.max_global},
    };
    for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); i++) {
        /* An absent count renders as an em dash rather than 0 — "we were
         * not told" and "there are none" are different facts. */
        if (ev->u.lusers.has[rows[i].idx]) card(app, net, "  %-12s %ld", rows[i].label, rows[i].value);
        else card(app, net, "  %-12s —", rows[i].label);
    }
}

static void render_banlist(struct app *app, const struct wire_event *ev) {
    const char *net = ev->u.banlist.network;
    card(app, net, "--- BANLIST %s (%zu)", ev->u.banlist.channel, ev->u.banlist.entry_count);
    for (size_t i = 0; i < ev->u.banlist.entry_count; i++) {
        struct wire_banlist_entry b;
        if (!wire_banlist_entry_at(ev->u.banlist.entries, i, &b)) continue;
        char when[64] = "";
        if (b.set_ts) {
            /* set_ts is a unix-second STRING on the wire. */
            time_t t = (time_t)strtol(b.set_ts, NULL, 10);
            if (t > 0) {
                struct tm tm;
                localtime_r(&t, &tm);
                strftime(when, sizeof(when), "%Y-%m-%d", &tm);
            }
        }
        card(app, net, "  %-32s %s%s%s", b.mask, b.setter ? b.setter : "?", when[0] ? " " : "",
             when);
    }
    if (ev->u.banlist.entry_count == 0) card(app, net, "  (no bans set)");
}

static void render_links(struct app *app, const struct wire_event *ev) {
    const char *net = ev->u.links.network;
    card(app, net, "--- LINKS (%zu)", ev->u.links.entry_count);
    if (ev->u.links.entry_count == 0) {
        /* An empty topology is the restricted/hidden signal, not an error
         * — say so rather than leaving a bare count of zero. */
        card(app, net, "  (topology hidden or restricted by the server)");
        return;
    }
    for (size_t i = 0; i < ev->u.links.entry_count; i++) {
        struct wire_links_entry l;
        if (!wire_links_entry_at(ev->u.links.entries, i, &l)) continue;
        /* Indent by hop count so the tree shape is visible in a terminal
         * the way cicchetto's radial map shows it graphically. */
        int depth = l.has_hopcount && l.hopcount > 0 && l.hopcount < 16 ? (int)l.hopcount : 0;
        card(app, net, "  %*s%s%s%s", depth * 2, "", l.server, l.description ? " — " : "",
             l.description ? l.description : "");
    }
}

static void render_server_reply(struct app *app, const struct wire_event *ev) {
    const char *net = ev->u.server_reply.network;
    const char *label = ev->u.server_reply.source == REPLY_INFO
                            ? "INFO"
                            : (ev->u.server_reply.source == REPLY_VERSION ? "VERSION" : "MOTD");
    card(app, net, "--- %s", label);
    for (size_t i = 0; i < ev->u.server_reply.line_count; i++) {
        const char *line = wire_string_at(ev->u.server_reply.lines, i);
        if (line) card(app, net, "  %s", line);
    }
}

static void render_channel_modes(struct app *app, const struct wire_event *ev) {
    char modes[128] = "+";
    size_t w = 1;
    for (size_t i = 0; i < ev->u.channel_modes.mode_count && w + 1 < sizeof(modes); i++) {
        const char *m = wire_string_at(ev->u.channel_modes.modes, i);
        if (m && m[0]) { modes[w++] = m[0]; modes[w] = '\0'; }
    }
    /* Retain them, don't just print them: the member pane needs to know
     * whether the channel is moderated (+m) to say that plain users are
     * muted. Stored WITHOUT the leading '+', and stored even when empty —
     * "no modes" is an answer, and it is a different answer from "never
     * been told", which is what the muted tier turns on. */
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        struct window *win = &app->windows[i];
        if (!irc_name_eq(win->network, ev->u.channel_modes.network)) continue;
        if (!irc_name_eq(win->channel, ev->u.channel_modes.channel)) continue;
        snprintf(win->chan_modes, sizeof(win->chan_modes), "%s", modes + 1);
        win->chan_modes_known = true;
        break;
    }
    pthread_mutex_unlock(&app->lock);
    if (w == 1) return; /* no modes set — nothing worth a row */
    log_line(app, "[%s/%s] --- channel modes %s", ev->u.channel_modes.network,
             ev->u.channel_modes.channel, modes);
}

/* ── Server-owned read state ───────────────────────────────────────────
 *
 * The cursor is `last_read_message_id` per (subject, network, channel)
 * and it lives on the SERVER — that is a project invariant, not a cache.
 * It is what makes "where I left off" survive a restart and stay
 * consistent across devices. Shottino tracked unread as a purely local
 * counter, so reading a channel on the phone left it bold here forever,
 * and restarting reset every window to zero unread regardless of truth.
 *
 * `read_cursor_set` carries no channel: it is scoped by the per-channel
 * topic it arrives on. Rather than thread topic identity through the
 * dispatcher, the cursor is matched to the window that has actually seen
 * that id — ids are globally unique, so at most one window matches. */
static void apply_read_cursor(struct app *app, long last_read_id) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (app->windows[i].last_id >= last_read_id && last_read_id > app->windows[i].last_read_id) {
            app->windows[i].last_read_id = last_read_id;
            /* Everything up to the cursor is read by definition. */
            if (app->windows[i].last_id <= last_read_id) app->windows[i].unread = 0;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

/* Publish the cursor for the focused window. Called when focus lands on a
 * window that has unread rows — the settle cadence is deliberately "on
 * focus change", not per keystroke, so a scroll through history does not
 * write a row per frame. */
static void push_read_cursor(struct app *app, const char *network, const char *channel,
                             long message_id) {
    if (message_id <= 0) return;
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *path = xasprintf("/networks/%s/channels/%s/read-cursor", net, chan);
    char *body = xasprintf("{\"message_id\":%ld}", message_id);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "POST", path, body);
    /* The server clamps monotonically, so an older id is refused rather
     * than moving the cursor backwards; that is not an error worth
     * reporting. A genuine failure is. */
    if (r.status >= 400 && r.status != 409)
        log_line(app, "read-cursor failed HTTP %d: %.120s", r.status, r.body ? r.body : "");
    free(path);
    free(body);
    free(r.body);
}

static void handle_wire_event(struct app *app, const struct wire_event *ev) {
    switch (ev->kind) {
    case WIRE_MESSAGE:
        render_message(app, &ev->u.message, true);
        break;

    case WIRE_TOPIC_CHANGED:
        set_window_topic(app, ev->u.topic_changed.network, ev->u.topic_changed.channel,
                         ev->u.topic_changed.text);
        break;

    case WIRE_MEMBERS_SEEDED:
        copy_members_from_wire(app, ev->u.members_seeded.network, ev->u.members_seeded.channel,
                               ev->u.members_seeded.members, ev->u.members_seeded.member_count);
        set_window_state(app, ev->u.members_seeded.network, ev->u.members_seeded.channel,
                         WS_JOINED, NULL, 0);
        break;

    case WIRE_QUERY_WINDOWS_LIST:
        apply_query_windows(app, ev);
        break;

    /* ── Window state: mirrored, never originated ───────────────────── */
    case WIRE_WINDOW_PENDING:
        add_window_ex(app, ev->u.window_open.network, ev->u.window_open.channel, false);
        set_window_state(app, ev->u.window_open.network, ev->u.window_open.channel, WS_PENDING,
                         NULL, 0);
        break;

    case WIRE_WINDOW_INVITED:
        /* An INVITE we did not ask for: open a greyed, not-joined tab so
         * the invitation is visible without silently joining. */
        add_window_ex(app, ev->u.window_open.network, ev->u.window_open.channel, false);
        set_window_state(app, ev->u.window_open.network, ev->u.window_open.channel, WS_INVITED,
                         NULL, 0);
        log_line(app, "[%s/%s] --- you were invited to %s", ev->u.window_open.network,
                 ev->u.window_open.channel, ev->u.window_open.channel);
        break;

    case WIRE_JOINED:
        set_window_state(app, ev->u.window_state.network, ev->u.window_state.channel, WS_JOINED,
                         NULL, 0);
        break;

    case WIRE_JOIN_FAILED:
        set_window_state(app, ev->u.window_state.network, ev->u.window_state.channel, WS_FAILED,
                         ev->u.window_state.reason,
                         ev->u.window_state.has_numeric ? ev->u.window_state.numeric : 0);
        log_line(app, "[%s/%s] --- cannot join %s%s%s", ev->u.window_state.network,
                 ev->u.window_state.channel, ev->u.window_state.channel,
                 ev->u.window_state.reason ? ": " : "",
                 ev->u.window_state.reason ? ev->u.window_state.reason : "");
        break;

    case WIRE_KICKED:
        set_window_state(app, ev->u.window_state.network, ev->u.window_state.channel, WS_KICKED,
                         ev->u.window_state.reason, 0);
        log_line(app, "[%s/%s] <-- you were kicked from %s%s%s%s%s", ev->u.window_state.network,
                 ev->u.window_state.channel, ev->u.window_state.channel,
                 ev->u.window_state.by ? " by " : "",
                 ev->u.window_state.by ? ev->u.window_state.by : "",
                 ev->u.window_state.reason ? ": " : "",
                 ev->u.window_state.reason ? ev->u.window_state.reason : "");
        break;

    /* ── Identity + session state ───────────────────────────────────── */
    case WIRE_OWN_NICK_CHANGED: {
        pthread_mutex_lock(&app->lock);
        struct network *n = network_by_id_locked(app, ev->u.own_nick.network_id);
        const char *slug = n ? n->slug : NULL;
        if (n) snprintf(n->nick, sizeof(n->nick), "%s", ev->u.own_nick.nick);
        pthread_mutex_unlock(&app->lock);
        if (slug) log_line(app, "[%s/$server] --- you are now known as %s", slug, ev->u.own_nick.nick);
        break;
    }

    case WIRE_AWAY_CONFIRMED: {
        pthread_mutex_lock(&app->lock);
        struct network *n = network_by_slug_locked(app, ev->u.away_confirmed.network);
        if (n) n->away = ev->u.away_confirmed.away;
        pthread_mutex_unlock(&app->lock);
        log_line(app, "[%s/$server] --- you are now %s", ev->u.away_confirmed.network,
                 ev->u.away_confirmed.away ? "away" : "back");
        break;
    }

    case WIRE_PEER_AWAY:
        log_line(app, "[%s/%s] --- %s is away: %s", ev->u.peer_away.network, ev->u.peer_away.peer,
                 ev->u.peer_away.peer, ev->u.peer_away.message);
        break;

    case WIRE_UMODE_CHANGED: {
        char modes[32] = "";
        size_t w = 0;
        for (size_t i = 0; i < ev->u.umodes.mode_count && w + 1 < sizeof(modes); i++) {
            const char *m = wire_string_at(ev->u.umodes.modes, i);
            if (m && m[0]) modes[w++] = m[0];
        }
        modes[w] = '\0';
        pthread_mutex_lock(&app->lock);
        struct network *n = network_by_id_locked(app, ev->u.umodes.network_id);
        const char *slug = n ? n->slug : NULL;
        if (n) snprintf(n->umodes, sizeof(n->umodes), "%s", modes);
        pthread_mutex_unlock(&app->lock);
        if (slug) log_line(app, "[%s/$server] --- your user modes are +%s", slug, modes);
        break;
    }

    case WIRE_ISUPPORT_CHANGED: {
        pthread_mutex_lock(&app->lock);
        struct network *n = network_by_id_locked(app, ev->u.isupport.network_id);
        if (n) {
            size_t count = json_len(ev->u.isupport.prefix);
            if (count > sizeof(n->prefix_letters)) count = sizeof(n->prefix_letters);
            n->prefix_count = 0;
            for (size_t i = 0; i < count; i++) {
                const char *letter = json_key_at(ev->u.isupport.prefix, i);
                const char *sigil = json_string(json_value_at(ev->u.isupport.prefix, i));
                if (letter && letter[0] && sigil && sigil[0]) {
                    n->prefix_letters[n->prefix_count] = letter[0];
                    n->prefix_sigils[n->prefix_count] = sigil[0];
                    n->prefix_count++;
                }
            }
        }
        pthread_mutex_unlock(&app->lock);
        break;
    }

    case WIRE_CONNECTION_STATE_CHANGED: {
        pthread_mutex_lock(&app->lock);
        struct network *n = network_by_slug_locked(app, ev->u.connection_state.network_slug);
        if (n) {
            n->conn_state = ev->u.connection_state.state;
            n->conn_known = true;
            snprintf(n->nick, sizeof(n->nick), "%s", ev->u.connection_state.nick);
        }
        /* A parked/failed network's windows are all dead — mark them so
         * the sidebar greys the whole network, not just the tab that
         * happened to receive a terminal event. */
        if (ev->u.connection_state.state != CONN_CONNECTED) {
            for (size_t i = 0; i < app->window_count; i++)
                if (irc_name_eq(app->windows[i].network, ev->u.connection_state.network_slug))
                    app->windows[i].state = WS_PARKED;
        }
        pthread_mutex_unlock(&app->lock);
        log_line(app, "[%s/$server] --- network %s -> %s%s%s", ev->u.connection_state.network_slug,
                 wire_connection_state_name(ev->u.connection_state.from),
                 wire_connection_state_name(ev->u.connection_state.to),
                 ev->u.connection_state.reason ? ": " : "",
                 ev->u.connection_state.reason ? ev->u.connection_state.reason : "");
        break;
    }

    case WIRE_CONNECTION_PROGRESS: {
        pthread_mutex_lock(&app->lock);
        struct network *n = network_by_slug_locked(app, ev->u.connection_progress.network);
        if (n) n->connecting = !ev->u.connection_progress.connected;
        pthread_mutex_unlock(&app->lock);
        break;
    }

    case WIRE_INVITE_ACK:
        log_line(app, "[%s/$server] --- invited %s to %s", ev->u.invite_ack.network,
                 ev->u.invite_ack.peer, ev->u.invite_ack.channel);
        break;

    /* ── Reply cards ────────────────────────────────────────────────── */
    case WIRE_WHOIS_BUNDLE:   render_whois(app, ev); break;
    case WIRE_WHOWAS_BUNDLE:  render_whowas(app, ev); break;
    case WIRE_WHO_REPLY:      render_who(app, ev); break;
    case WIRE_NAMES_REPLY:    render_names(app, ev); break;
    case WIRE_LUSERS_BUNDLE:  render_lusers(app, ev); break;
    case WIRE_BANLIST_BUNDLE: render_banlist(app, ev); break;
    case WIRE_LINKS_BUNDLE:   render_links(app, ev); break;
    case WIRE_SERVER_REPLY:   render_server_reply(app, ev); break;
    case WIRE_CHANNEL_MODES_CHANGED: render_channel_modes(app, ev); break;

    case WIRE_PRESENCE_CHANGED: {
        /* A watched nick coming or going. `initial` marks the snapshot
         * edge the server sends on (re)subscribe — reporting those would
         * announce "bob is online" for everyone on the list at every
         * reconnect, so they seed state silently. */
        if (ev->u.presence_changed.initial) break;
        pthread_mutex_lock(&app->lock);
        struct network *n = network_by_id_locked(app, ev->u.presence_changed.network_id);
        const char *slug = n ? n->slug : NULL;
        pthread_mutex_unlock(&app->lock);
        if (slug)
            card(app, slug, "--- %s is now %s", ev->u.presence_changed.nick,
                 ev->u.presence_changed.online ? "online" : "offline");
        break;
    }

    case WIRE_PRESENCE_ERROR: {
        pthread_mutex_lock(&app->lock);
        struct network *n = network_by_id_locked(app, ev->u.presence_error.network_id);
        const char *slug = n ? n->slug : NULL;
        pthread_mutex_unlock(&app->lock);
        if (slug) card(app, slug, "--- watch list full: %s", ev->u.presence_error.detail);
        break;
    }

    case WIRE_READ_CURSOR_SET:
        /* Read state is server-owned per (subject, network, channel), so
         * marking a window read on one device must move the divider on
         * every other. The payload carries no channel — it is scoped by
         * the per-channel topic it arrives on — so it is applied to the
         * window whose last_id brackets the cursor. */
        apply_read_cursor(app, ev->u.read_cursor.last_read_message_id);
        break;

    case WIRE_WINDOW_COUNTS: {
        /* Server-authoritative counts REPLACE the local tally. The server
         * knows about messages this client never received (it was
         * offline) and about reads from other devices; a locally
         * incremented badge drifts from the truth in both directions. */
        pthread_mutex_lock(&app->lock);
        for (size_t i = 0; i < app->window_count; i++) {
            if (!irc_name_eq(app->windows[i].channel, ev->u.window_counts.channel)) continue;
            app->windows[i].unread = (unsigned)ev->u.window_counts.messages;
            app->windows[i].mentions = (unsigned)ev->u.window_counts.mentions;
            app->windows[i].severity = ev->u.window_counts.severity;
        }
        pthread_mutex_unlock(&app->lock);
        break;
    }

    case WIRE_MENTIONS_BUNDLE: {
        /* Everything that mentioned you while you were away, replayed in
         * one card so the catch-up is not a hunt through N channels. */
        const char *net = ev->u.mentions_bundle.network;
        if (ev->u.mentions_bundle.message_count == 0) break;
        card(app, net, "--- %zu mention%s while away%s%s", ev->u.mentions_bundle.message_count,
             ev->u.mentions_bundle.message_count == 1 ? "" : "s",
             ev->u.mentions_bundle.away_reason ? ": " : "",
             ev->u.mentions_bundle.away_reason ? ev->u.mentions_bundle.away_reason : "");
        for (size_t i = 0; i < ev->u.mentions_bundle.message_count; i++) {
            struct wire_mention m;
            if (!wire_mention_at(ev->u.mentions_bundle.messages, i, &m)) continue;
            char clock[16];
            time_t ts = m.server_time > 100000000000L ? (time_t)(m.server_time / 1000)
                                                      : (time_t)m.server_time;
            struct tm tm;
            localtime_r(&ts, &tm);
            strftime(clock, sizeof(clock), "%H:%M", &tm);
            card(app, net, "  %s %-14s <%s> %.*s", clock, m.channel, m.sender, 60,
                 m.body ? m.body : "");
        }
        break;
    }

    /* A /list scan runs in the background and can take a while on a
     * large network; without these the user types /list, sees an empty
     * cache, and has no idea a scan is running. */
    case WIRE_DIRECTORY_PROGRESS:
        card(app, ev->u.directory.network, "--- channel scan: %ld so far", ev->u.directory.count);
        break;

    case WIRE_DIRECTORY_COMPLETE:
        card(app, ev->u.directory.network, "--- channel scan complete: %ld channels — /list to browse",
             ev->u.directory.count);
        break;

    case WIRE_DIRECTORY_FAILED:
        card(app, ev->u.directory.network, "--- channel scan failed: %s", ev->u.directory.reason);
        break;

    case WIRE_CHANNEL_CREATED:
    case WIRE_CHANNELS_CHANGED:
    case WIRE_NOTIFY_LIST:
    case WIRE_PRESENCE_SNAPSHOT:
    case WIRE_SUPPORTED_UMODES_CHANGED:
    case WIRE_BUNDLE_HASH:
    case WIRE_SERVER_SETTINGS_CHANGED:
    case WIRE_ARCHIVE_CHANGED:
    case WIRE_ARCHIVE_PURGED:
    case WIRE_UNKNOWN:
        /* Narrowed but not yet rendered — landing here is deliberate, not
         * a gap in the switch. Each becomes a card or a store update in a
         * later commit; listing them explicitly means -Wswitch flags the
         * NEXT kind the server adds instead of it silently vanishing. */
        break;
    }
}

static void handle_ws_frame(struct app *app, const char *frame) {
    char err[160];
    json_doc *doc = json_parse(frame, strlen(frame), err, sizeof(err));
    if (!doc) {
        log_line(app, "malformed websocket frame: %s", err);
        return;
    }
    struct wire_frame f;
    if (!wire_frame_split(json_root(doc), &f)) {
        json_free(doc);
        return;
    }
    if (strcmp(f.event, "phx_reply") == 0) {
        if (json_str_is(json_get(f.payload, "status"), "error"))
            log_line(app, "channel join error: %.200s", frame);
    } else if (strcmp(f.event, "event") == 0) {
        struct wire_event ev;
        if (wire_narrow(f.payload, &ev)) handle_wire_event(app, &ev);
    }
    json_free(doc);
}

/* ── Reconnect + backfill ──────────────────────────────────────────────
 *
 * A dropped socket used to be terminal: ws_pump logged "websocket
 * disconnected", cleared the flag, and nothing ever set it again. The
 * client stayed up looking connected-ish while receiving nothing — the
 * worst failure shape, because the user has no reason to distrust what
 * they see. A laptop suspend or a brief network blip ended the session.
 *
 * Reconnect is exponential with a cap and jitter. Jitter matters: without
 * it, every client that a bouncer restart knocked offline comes back in
 * lockstep and does it again on the next failure.
 *
 * Reconnecting is only half the job. PubSub broadcast is fire-and-forget,
 * so anything sent during the gap is GONE — rejoining the topics does not
 * replay it. Each window therefore refetches from the last id it saw
 * (`?after=`), which is exactly what cicchetto's reconnect backfill does.
 * Without this the client silently misses every message in the gap, which
 * is worse than a visible disconnect. */
#define WS_BACKOFF_MIN 1
#define WS_BACKOFF_MAX 60

static void ws_schedule_retry(struct app *app) {
    if (app->ws_backoff == 0) app->ws_backoff = WS_BACKOFF_MIN;
    else {
        app->ws_backoff *= 2;
        if (app->ws_backoff > WS_BACKOFF_MAX) app->ws_backoff = WS_BACKOFF_MAX;
    }
    /* Up to 25% jitter, so a fleet of clients does not resynchronise on a
     * server restart and thunder back together. */
    unsigned char r = 0;
    RAND_bytes(&r, 1);
    int jitter = (int)((unsigned)app->ws_backoff * r / (255 * 4));
    app->ws_retry_at = time(NULL) + app->ws_backoff + jitter;
}

/* Pull anything that arrived while the socket was down. Uses `?after=<id>`
 * (ascending, per Scrollback.fetch_after) rather than re-reading the tail,
 * so a long gap is filled completely instead of to an arbitrary depth. */
static void backfill_window(struct app *app, const char *network, const char *channel,
                            long after_id) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *path = xasprintf("/networks/%s/channels/%s/messages?after=%ld", net, chan, after_id);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "GET", path, NULL);
    free(path);
    if (r.status >= 200 && r.status < 300) {
        /* This endpoint answers ASCENDING, unlike the DESC tail fetch, so
         * rows are rendered in array order rather than reversed. */
        json_doc *doc = json_parse(r.body, r.body_len, NULL, 0);
        const json_value *list = json_root(doc);
        size_t n = json_len(list);
        for (size_t i = 0; i < n; i++) {
            struct wire_scrollback_message m;
            if (wire_narrow_message(json_at(list, i), &m)) render_message(app, &m, false);
        }
        if (n) log_line(app, "[%s/%s] --- %zu message%s recovered", network, channel, n,
                        n == 1 ? "" : "s");
        json_free(doc);
    }
    free(r.body);
}

static void ws_backfill_all(struct app *app) {
    /* Snapshot the window list under the lock; the HTTP calls must not
     * hold it (they block for as long as the server takes). */
    struct { char network[MAX_SLUG]; char channel[MAX_CHANNEL]; long last_id; } snap[MAX_WINDOWS];
    size_t count;
    pthread_mutex_lock(&app->lock);
    count = app->window_count;
    for (size_t i = 0; i < count; i++) {
        snprintf(snap[i].network, sizeof(snap[i].network), "%s", app->windows[i].network);
        snprintf(snap[i].channel, sizeof(snap[i].channel), "%s", app->windows[i].channel);
        snap[i].last_id = app->windows[i].last_id;
    }
    pthread_mutex_unlock(&app->lock);
    for (size_t i = 0; i < count; i++) {
        if (is_server_window(snap[i].channel)) continue; /* no scrollback */
        /* last_id 0 means this window never saw a message; a full tail
         * fetch is the right recovery there, not an ?after=0 flood. */
        if (snap[i].last_id > 0) backfill_window(app, snap[i].network, snap[i].channel, snap[i].last_id);
        else fetch_scrollback_target(app, snap[i].network, snap[i].channel);
    }
}

/* Attempt one reconnect if the backoff timer has expired. */
static void ws_try_reconnect(struct app *app) {
    time_t now = time(NULL);
    if (now < app->ws_retry_at) return;

    conn_close(&app->ws);
    if (!ws_connect(app)) {
        ws_schedule_retry(app);
        log_line(app, "reconnect failed; retrying in %ds", (int)(app->ws_retry_at - now));
        return;
    }
    app->ws_backoff = 0;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) app->windows[i].joined_ws = false;
    pthread_mutex_unlock(&app->lock);
    ws_join_topics(app);
    log_line(app, "websocket reconnected");
    ws_backfill_all(app);
}

static void ws_pump(struct app *app) {
    if (!app->ws_connected) {
        ws_try_reconnect(app);
        return;
    }
    time_t now = time(NULL);
    if (now >= app->next_heartbeat) {
        char ref[32];
        snprintf(ref, sizeof(ref), "%lu", ++app->ws_ref);
        char *hb = xasprintf("[null,\"%s\",\"phoenix\",\"heartbeat\",{}]", ref);
        ws_send_text(app, hb);
        free(hb);
        app->next_heartbeat = now + 25;
    }
    for (;;) {
        char *frame = NULL;
        int r = ws_read_frame(app, &frame);
        if (r == 0) break;
        if (r < 0) {
            conn_close(&app->ws);
            app->ws_connected = false;
            ws_schedule_retry(app);
            log_line(app, "websocket disconnected; reconnecting in %ds",
                     (int)(app->ws_retry_at - time(NULL)));
            break;
        }
        handle_ws_frame(app, frame);
        free(frame);
    }
}

/* Draw a decoded image at (y, x).
 *
 * Character art goes through ncurses like any other text, so it
 * participates in normal repaint and scrolling — no special handling.
 * A protocol image cannot: ncurses knows nothing about it, so the escape
 * is written directly and only when the picture MOVES. That works
 * precisely because ncurses repaints changed cells only; the cells under
 * an image stay blank in its model, so it leaves them alone.
 *
 * Caller holds app->lock. */
static void draw_inline_media(struct inline_media *m, int y, int x, int skip_rows,
                              int max_rows, int max_cols) {
    if (m->state != IM_READY || m->rows <= 0) return;
    if (skip_rows < 0) skip_rows = 0;
    /* Clamp BOTH axes. The cell box was fitted when the row was first
     * measured; a terminal resize since then leaves it stale, and an
     * image that overruns its box writes over the member pane or past
     * the scroll region. */
    int rows = m->rows - skip_rows;
    if (rows > max_rows) rows = max_rows;
    int cols = m->cols > max_cols ? max_cols : m->cols;
    if (rows <= 0 || cols <= 0) return;

    if (m->rgb) {
        /* Half blocks: two image rows per cell, upper glyph in the top
         * pixel's colour over the bottom pixel's. Character art clips per
         * cell, so a picture whose top has scrolled off draws its bottom
         * `rows` cells — it slides under the region edge like text.
         *
         * Frames sit back to back in one buffer, so playing one is an
         * offset: a still is the frame_count == 1 case of the same
         * arithmetic, not a branch. */
        size_t stride = (size_t)m->cols * (size_t)(m->rows * 2) * 3;
        size_t idx = m->frame_count > 1 && m->frame < m->frame_count ? m->frame : 0;
        const unsigned char *plane = m->rgb + idx * stride;
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                int sr = r + skip_rows;
                const unsigned char *top = plane + (((size_t)(sr * 2) * m->cols) + c) * 3;
                const unsigned char *bot = plane + (((size_t)(sr * 2 + 1) * m->cols) + c) * 3;
                long tv = ((long)top[0] << 16) | ((long)top[1] << 8) | top[2];
                long bv = ((long)bot[0] << 16) | ((long)bot[1] << 8) | bot[2];
                int pair = mirc_pair_for(tv, bv, CP_MAIN);
                attron(COLOR_PAIR(pair));
                mvaddstr(y + r, x + c, "\u2580");
                attroff(COLOR_PAIR(pair));
            }
        }
        return;
    }

    if (m->payload) {
        /* Reserve the cells so ncurses does not paint over the picture,
         * then place it. Re-emitted only when the position changed. */
        for (int r = 0; r < rows; r++)
            for (int c = 0; c < cols; c++) mvaddch(y + r, x + c, ' ');
        /* A terminal-protocol image is atomic: the escape places the whole
         * picture at the cursor, so there is no way to draw the bottom of
         * one — emitting it here would paint UP over the topic bar. It
         * therefore stays blank (in cells the caller has already paid for,
         * so the rest of the layout does not move) until it is fully back
         * on screen, and is marked undrawn so that repaint happens. Only
         * the character-art path above can slide under the edge. */
        if (skip_rows > 0) {
            m->drawn = false;
            return;
        }
        if (!m->drawn || m->drawn_y != y || m->drawn_x != x) {
            refresh();
            printf("\033[%d;%dH", y + 1, x + 1); /* 1-based cursor address */
            fwrite(m->payload, 1, m->payload_len, stdout);
            fflush(stdout);
            m->drawn = true;
            m->drawn_y = y;
            m->drawn_x = x;
        }
    }
}

/* What to call the key that scrolls the roster, in the space there is.
 *
 * It used to read "^U", which is how a terminal PRINTS a control
 * character and not how anyone reads one: on screen, beside a list of
 * nicknames, it looks like stray output rather than like a key to press.
 * Spelled out where the pane is wide enough to spell it. */
static const char *roster_hint(const struct app *app, int width) {
    if (app->roster_focus) return width >= 12 ? "\u2191\u2193 Esc" : "\u2191\u2193";
    if (width >= 18) return "Ctrl-U scrolls";
    if (width >= 12) return "Ctrl-U";
    return "C-u";
}

/* Rows a message's image adds, by state.
 *
 * ONE definition, used by BOTH the measuring pass (which sizes the scroll
 * region) and the draw pass (which consumes the rows). They disagreed:
 * measuring reserved the full picture height for an image that was still
 * LOADING, while drawing spent a single line on the placeholder. That
 * inflated total_visible_lines, which inflated the scroll offset, which
 * made the draw loop skip rows that should have been on screen — a chat
 * window that goes blank and stays blank while a decode is slow or
 * wedged. Two numbers that must agree belong in one function.
 *
 * Caller holds app->lock, which draw() holds for the whole frame, so a
 * worker cannot flip the state between the two passes. */
static int media_extra_rows(const struct inline_media *m) {
    if (!m) return 0;
    switch (m->state) {
    case IM_READY:
        return m->rows;
    case IM_IDLE:     /* promoted to FETCHING by the draw pass */
    case IM_FETCHING: /* "[loading image…]" */
    case IM_FAILED:   /* "[image could not be decoded…]" */
        return 1;
    }
    return 0;
}

/* Open the layout log once, if SHOTTINO_LAYOUT_LOG is set. Returns NULL
 * when the diagnostic is off, which is the normal case — the call sites
 * check for NULL and cost nothing. */
static FILE *layout_log(void) {
    static FILE *f;
    static bool tried;
    if (!tried) {
        tried = true;
        const char *path = getenv("SHOTTINO_LAYOUT_LOG");
        if (path && *path) f = fopen(path, "w");
    }
    return f;
}

/* One-character marker for a non-joined window state. A joined window (or
 * one whose state the server has not told us yet) gets a blank, so only
 * genuinely-abnormal windows draw the eye. */
static char window_state_mark(enum window_state state) {
    switch (state) {
    case WS_PENDING: return '.';
    case WS_INVITED: return '?';
    case WS_FAILED:  return '!';
    case WS_KICKED:  return 'x';
    case WS_PARKED:  return '~';
    case WS_JOINED:
    case WS_UNKNOWN: return ' ';
    }
    return ' ';
}

/* Human-readable reason a window is in its current state, for the status
 * line. Returns NULL when there is nothing worth saying. */
static const char *window_state_label(enum window_state state) {
    switch (state) {
    case WS_PENDING: return "joining";
    case WS_INVITED: return "invited — /join to accept";
    case WS_FAILED:  return "join failed";
    case WS_KICKED:  return "kicked";
    case WS_PARKED:  return "network parked";
    case WS_JOINED:
    case WS_UNKNOWN: return NULL;
    }
    return NULL;
}

/* ── Inline media ──────────────────────────────────────────────────────
 *
 * Decoding is asynchronous by construction: the UI thread only ever
 * allocates a slot and reads a finished one. ffmpeg runs on the worker,
 * which is why a picture arriving no longer freezes the client the way
 * the old synchronous preview did.
 *
 * Slots are claimed lazily from the DRAW path — a row's image is fetched
 * the first time it is actually on screen. Scrollback holds thousands of
 * rows; decoding every link ever seen would burn CPU and bandwidth on
 * pictures nobody scrolled to. */

static void media_decode_job(struct app *app, int slot);
static void view_fetch_and_open(struct app *app, const char *url);
static void ircd_archive_job(struct app *app, const struct job *job);
static bool enqueue_job(struct app *app, struct job job);

static void media_slot_reset(struct inline_media *m) {
    free(m->payload);
    free(m->rgb);
    memset(m, 0, sizeof(*m));
}

/* Drop every terminal-graphics placement, and the image data behind it.
 *
 * A protocol image (kitty) lives ABOVE the cell grid: ncurses has no
 * model of it, cannot erase it, and will happily paint the new channel's
 * text around a picture from the channel you just left. Nothing but this
 * escape removes it — which is why leaving a window, or returning from a
 * preview, has to say so explicitly.
 *
 * `d=A` frees the stored image data as well as the placement. The
 * placement alone (`d=a`) leaves the pixels in the terminal's image
 * store for the rest of the session, so every preview and every picture
 * scrolled past would add to it — the long-session growth this is meant
 * to avoid. Nothing is lost by letting it go: the payload is re-sent
 * whenever a picture is placed again.
 *
 * Every slot is therefore marked undrawn, and the next frame re-places
 * whatever is genuinely on screen. Caller holds app->lock. */
static void media_placements_drop_locked(struct app *app) {
    fputs("\033_Ga=d,d=A\033\\", stdout);
    fflush(stdout);
    for (size_t i = 0; i < app->media_count; i++) app->media[i].drawn = false;
}

/* Is anything placed on the terminal that the frame just drawn did not
 * paint? That — and not "did the window change" — is what makes a
 * placement stale, so it is the only question asked. Caller holds
 * app->lock. */
static bool media_placements_stale_locked(const struct app *app) {
    for (size_t i = 0; i < app->media_count; i++)
        if (app->media[i].drawn && app->media[i].painted_frame != app->frame_seq) return true;
    return false;
}

/* Claim a slot for `url`, recycling the oldest when full. Caller holds
 * app->lock. Returns the index, or -1 when inline media is off. */
static int media_claim_locked(struct app *app, const char *url, bool is_video) {
    if (!app->inline_media_enabled) return -1;
    size_t idx;
    if (app->media_count < MAX_INLINE_MEDIA) {
        idx = app->media_count++;
    } else {
        idx = app->media_next;
        app->media_next = (app->media_next + 1) % MAX_INLINE_MEDIA;
        /* Any log row still pointing at the recycled slot must let go, or
         * it would render someone else's picture. */
        for (size_t i = 0; i < app->log_count; i++)
            if (app->log_media[i] == (int)idx) app->log_media[i] = -1;
    }
    struct inline_media *m = &app->media[idx];
    media_slot_reset(m);
    snprintf(m->url, sizeof(m->url), "%s", url);
    m->is_video = is_video;
    /* A GIF is the other animated thing on IRC, and it classifies as an
     * IMAGE. Asking by extension keeps the decision where the rest of
     * the media typing lives. */
    m->is_animatable = is_video || url_has_gif_suffix(url);
    m->state = IM_IDLE;
    return (int)idx;
}

/* Record the screen rectangle of a media link so a later mouse event can map
 * back to its URL. Caller holds app->lock (draw path). */
static void add_link_region(struct app *app, int y0, int y1, int x0, int x1,
                            const char *url, enum media_kind kind) {
    if (app->link_region_count >= MAX_LINK_REGIONS) return;
    struct link_region *r = &app->link_regions[app->link_region_count++];
    r->y0 = y0;
    r->y1 = y1;
    r->x0 = x0;
    r->x1 = x1;
    r->kind = kind;
    r->is_video = kind == MEDIA_VIDEO;
    snprintf(r->url, sizeof(r->url), "%s", url);
}

/* Is this channel moderated? Plain users cannot speak in a +m channel —
 * that is what "muted" means here. There is no per-member muted state on
 * the wire (only @ / % / + and plain), so the tier is DERIVED from the
 * channel's own mode, and only claimed when the modes are actually
 * known: guessing "not muted" from silence would be a lie in the one
 * case the label matters. */
static bool channel_is_moderated(const struct window *w) {
    return w->chan_modes_known && strchr(w->chan_modes, 'm') != NULL;
}

/* Rows the roster occupies: one per member, plus a separator above the
 * muted group when the channel is +m and anyone is in it. Computed by
 * the same walk that draws, so scrolling and drawing cannot disagree —
 * the lesson the chat area learned the hard way. Caller holds app->lock.
 *
 * `y < 0` measures without drawing. Returns the total row count. */
static void add_nick_region(struct app *app, int y, int x0, int x1, const char *nick);

static size_t draw_member_list(struct app *app, struct window *w, int y, int x, int width,
                               int height, size_t offset) {
    bool moderated = channel_is_moderated(w);
    const char *sigils;
    size_t prefix_count = network_prefixes_locked(app, w->network, NULL, &sigils);
    size_t row = 0;      /* index into the whole list */
    bool split_drawn = false;
    for (size_t i = 0; i < w->member_count; i++) {
        size_t rank = member_rank_locked(app, w->network, w->members[i].modes);
        bool plain = rank >= prefix_count;
        if (moderated && plain && !split_drawn) {
            split_drawn = true;
            if (y >= 0 && row >= offset && (int)(row - offset) < height)
                draw_text(y + (int)(row - offset), x, width, CP_MUTED, A_DIM, "%s", "— muted —");
            row++;
        }
        if (y >= 0 && row >= offset && (int)(row - offset) < height) {
            int line_y = y + (int)(row - offset);
            char sigil = rank < prefix_count ? sigils[rank] : 0;
            int pair = nick_pair(w->members[i].nick);
            /* A muted member is dimmed: the pane says at a glance who can
             * actually talk here. */
            attr_t attrs = (moderated && plain) ? A_DIM : (sigil ? A_BOLD : 0);
            if (sigil) draw_text(line_y, x, width, pair, attrs, "%c%s", sigil, w->members[i].nick);
            else draw_text(line_y, x, width, pair, attrs, " %s", w->members[i].nick);
            /* Recorded on the DRAW pass only: the measuring call passes a
             * negative y and paints nothing, and a region for a row that
             * was never drawn is a click that hits the wrong nick. */
            add_nick_region(app, line_y, x, x + width - 1, w->members[i].nick);
        }
        row++;
    }
    return row;
}

/* Draw one chat pane: its own header band, its own scrollback view.
 *
 * Everything that used to be "the chat area" lives here, parameterised by
 * the rectangle it gets and the pane whose view it is. A pane carries its
 * OWN scroll offset, so two panes on the same channel scroll
 * independently — which is most of the reason to split at all — and the
 * measure/draw budget rules are unchanged, just applied per rectangle.
 *
 * Caller holds app->lock. */
static size_t overlay_items(struct app *app, struct overlay_item *out, size_t max);

/* Record a message row's rectangle plus who said it, so a right-click can
 * name it. Rows without a nick (joins, parts, server notices) are skipped:
 * there is nobody to reply to. Caller holds app->lock (draw path). */
/* A NICK under the pointer, with no message attached — a roster row.
 *
 * The same region type as a chat row, deliberately: right-click already
 * means "the person under the pointer", the hit test is already written,
 * and the only difference is that this one has nothing they said. A
 * parallel array would be a second thing to keep in step for no new
 * behaviour. Caller holds app->lock (draw path). */
static void add_nick_region(struct app *app, int y, int x0, int x1, const char *nick) {
    if (app->msg_region_count >= MAX_LINK_REGIONS) return;
    if (!nick || !nick[0]) return;
    struct msg_region *r = &app->msg_regions[app->msg_region_count++];
    r->y0 = y;
    r->y1 = y;
    r->x0 = x0;
    r->x1 = x1;
    snprintf(r->nick, sizeof(r->nick), "%s", nick);
    r->body[0] = '\0';
}

static void add_msg_region(struct app *app, int y0, int y1, int x0, int x1, const char *line) {
    if (app->msg_region_count >= MAX_LINK_REGIONS) return;
    char prefix[256], nick[256];
    const char *body = NULL;
    if (!split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body)) return;
    if (!nick[0]) return;
    struct msg_region *r = &app->msg_regions[app->msg_region_count++];
    r->y0 = y0;
    r->y1 = y1;
    r->x0 = x0;
    r->x1 = x1;
    snprintf(r->nick, sizeof(r->nick), "%s", nick);
    snprintf(r->body, sizeof(r->body), "%s", body ? body : "");
}

static void draw_chat_pane(struct app *app, struct pane *pane, int x, int y, int width, int height,
                           bool focused, bool split) {
    if (width < 8 || height < 2) return;
    struct window *w = &app->windows[pane->window];

    /* Header band. Unsplit, it is the topic bar as it always was; split,
     * each pane needs its own or the bar describes one pane and lies
     * about the other. The focused pane's is accented — with two panes
     * on screen, "where does my typing go" has to be answerable at a
     * glance, and the input box is nowhere near either header. */
    /* The label takes what it NEEDS, capped so a long name cannot take
     * the band. It used to take a fixed third of the width whatever it
     * said, so every line of the topic began a third of the way across
     * and the band read as right-aligned with a hole in it. */
    const char *topic_text = w->topic[0] ? w->topic : "(not loaded yet)";
    char label[MAX_SLUG + MAX_CHANNEL + 8];
    snprintf(label, sizeof(label), "%s%s/%s", focused && split ? "* " : "", w->network, w->channel);
    int topic_label_w = (int)strlen(label);
    int label_cap = width / 3;
    if (label_cap < 12) label_cap = 12;
    if (topic_label_w > label_cap) topic_label_w = label_cap;
    int topic_text_x = x + 1 + topic_label_w + 1;
    int topic_text_w = width - topic_label_w - 3;
    if (topic_text_w < 1) topic_text_w = 1;

    /* Its VISIBLE text, on one geometric line. The band has its own
     * colours and a topic's own formatting fights them; more to the
     * point, a marquee has to know how many COLUMNS it is moving over,
     * and control bytes occupy none. Newlines would break the two-line
     * geometry, so they become spaces. */
    char topic_plain[MAX_TOPIC];
    if (mirc_has_formatting(topic_text)) mirc_strip(topic_text, topic_plain, sizeof(topic_plain));
    else snprintf(topic_plain, sizeof(topic_plain), "%s", topic_text);
    for (char *tc = topic_plain; *tc; tc++)
        if (*tc == '\n' || *tc == '\r' || *tc == '\t') *tc = ' ';

    /* Two lines, never more. A paragraph of a topic used to be allowed
     * the whole pane but two rows, which left a channel with a wordy
     * topic almost no room for the conversation it is about. */
    int head_len = topic_head_len(topic_plain, topic_text_w);
    const char *topic_tail = topic_plain + head_len;
    while (*topic_tail == ' ') topic_tail++;
    int topic_h = *topic_tail ? 2 : 1;
    if (split || height < 4) topic_h = 1;

    int head_pair = focused ? CP_TITLE : CP_ALT;
    int head_accent = focused ? CP_TITLE_ACCENT : CP_MUTED;
    for (int ty = 0; ty < topic_h; ty++) draw_fill(y + ty, x, width, head_pair);
    draw_text(y, x + 1, topic_label_w, head_accent, A_BOLD, "%s", label);
    draw_text(y, topic_text_x, topic_text_w, head_pair, 0, "%.*s", head_len, topic_plain);

    if (topic_h > 1) {
        /* What did not fit scrolls, so "two lines" does not mean "you
         * cannot read your topic". It pauses at both ends — a line that
         * only ever slides is a line you have to wait for — and pauses
         * entirely while the pointer is over the band, which is what a
         * reader does when they want to finish a sentence. */
        int tail_cols = (int)strlen(topic_tail);
        int overflow = tail_cols - topic_text_w;
        int off = 0;
        if (overflow > 0) {
            long now = monotonic_ms();
            if (!app->topic_hover && now - pane->topic_scroll_at >= TOPIC_SCROLL_MS) {
                pane->topic_scroll_at = now;
                pane->topic_scroll++;
                if ((long)pane->topic_scroll > overflow + 2 * TOPIC_SCROLL_HOLD)
                    pane->topic_scroll = 0;
            }
            off = (int)pane->topic_scroll - TOPIC_SCROLL_HOLD;
            if (off < 0) off = 0;
            if (off > overflow) off = overflow;
            /* Never start inside a UTF-8 character: the terminal would
             * draw the remains of one as a replacement glyph. */
            while (off > 0 && ((unsigned char)topic_tail[off] & 0xC0) == 0x80) off++;
        }
        draw_text(y + 1, topic_text_x, topic_text_w, head_pair, 0, "%.*s", topic_text_w,
                  topic_tail + off);
        if (overflow > 0)
            draw_text(y + 1, x + 1, topic_label_w, head_accent, A_DIM, "%s",
                      app->topic_hover ? "(paused)" : "…");
    }
    if (app->pane_region_count < MAX_PANES) {
        struct pane_region *pr = &app->pane_regions[app->pane_region_count++];
        pr->y0 = y;
        pr->y1 = y + height - 1;
        pr->x0 = x;
        pr->x1 = x + width - 1;
        pr->pane = (size_t)(pane - app->panes);
    }
    /* Recorded so the pointer can pause it. Mouse tracking is off by
     * default, so this is a courtesy for those who turned it on, never
     * the only way to read a topic — that is what the scrolling is. */
    if (app->topic_region_count < MAX_PANES) {
        struct topic_region *tr = &app->topic_regions[app->topic_region_count++];
        tr->y0 = y;
        tr->y1 = y + topic_h - 1;
        tr->x0 = x;
        tr->x1 = x + width - 1;
    }

    int scroll_y = y + topic_h;
    int scroll_h = height - topic_h;
    if (scroll_h < 1) return;

    char wanted_prefix[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key(w->network, w->channel, wanted_prefix, sizeof(wanted_prefix));
    size_t visible[LOG_LINES];
    int heights[LOG_LINES];
    size_t visible_count = 0;
    static int text_heights[LOG_LINES];
    /* Which visible row carries the unread divider, decided ONCE here and
     * obeyed verbatim by the draw pass below. -1 = no divider this frame. */
    int divider_vi = -1;
    int total_visible_lines = 0;
    for (size_t i = 0; i < app->log_count; i++) {
        if (log_row_in_scope(app, i, wanted_prefix)) {
            visible[visible_count] = i;
            heights[visible_count] = message_display_lines(app->log[i], width - 2);
            if (heights[visible_count] < 1) heights[visible_count] = 1;
            /* The TEXT height, kept apart from the total below. Conflating
             * the two put the image after text+image rows instead of
             * after the text, and double-counted it in used_lines — which
             * pushed later rows past the scroll region and over the input
             * box, leaving the client looking dead. */
            text_heights[visible_count] = heights[visible_count];
            /* The unread divider occupies a row of its own above the first
             * unread message, and the DRAW pass spends one (`used_lines +=
             * 1`). Measuring has to reserve it too: otherwise the budget is
             * a line short of what gets drawn, the content overflows the
             * region by one, and the bottom line — the newest message —
             * never appears. Reserved on the same row the draw pass tests,
             * so the two agree — and the ROW is recorded, not just the fact
             * that one was reserved: see the draw pass. */
            if (divider_vi < 0 && w->last_read_id > 0 &&
                app->log_ids[i] > w->last_read_id) {
                heights[visible_count] += 1;
                divider_vi = (int)visible_count;
            }
            /* An image reserves rows UNDER its message line. The height is
             * known before the picture is decoded (the cell box is chosen
             * from the available width), so the layout does not jump when
             * the decode lands. */
            int mi = app->log_media[i];
            if (mi >= 0 && mi < (int)app->media_count) {
                struct inline_media *m = &app->media[mi];
                if (m->rows <= 0) {
                    int box_rows = INLINE_MAX_ROWS;
                    if (box_rows > scroll_h / 2) box_rows = scroll_h / 2;
                    if (box_rows < 3) box_rows = 3;
                    /* Aspect is unknown until decode; assume 4:3, which is
                     * close enough that the reserved box rarely changes. */
                    media_fit_cells(4, 3, width - 4, box_rows, &m->cols, &m->rows);
                }
                heights[visible_count] += media_extra_rows(m);
            }
            total_visible_lines += heights[visible_count];
            visible_count++;
        }
    }
    /* Layout diagnostic, off unless SHOTTINO_LAYOUT_LOG names a file.
     *
     * A scrollback row's height is computed in TWO places — here, to size
     * the scroll region, and again in the draw loop, to consume it. Every
     * "a line went missing" bug in this client so far has been those two
     * disagreeing, and the disagreement is invisible from the screen:
     * you see a missing line, not which pass was wrong. This dumps both
     * sides so a report can carry the numbers instead of a description.
     *
     * Written from the draw path, which already holds app->lock. */
    FILE *lay = layout_log();
    if (lay) {
        fprintf(lay, "\n== frame scroll_y=%d scroll_h=%d visible=%zu total=%d divider_row=%d\n",
                scroll_y, scroll_h, visible_count, total_visible_lines,
                divider_vi >= 0 ? (int)visible[divider_vi] : -1);
        for (size_t k = 0; k < visible_count; k++) {
            int mi = app->log_media[visible[k]];
            fprintf(lay, "   row=%zu h=%d text=%d media=%d%s :: %.56s\n", visible[k], heights[k],
                    text_heights[k], mi,
                    mi >= 0 && mi < (int)app->media_count
                        ? (app->media[mi].state == IM_READY      ? " READY"
                           : app->media[mi].state == IM_FETCHING ? " FETCHING"
                           : app->media[mi].state == IM_FAILED   ? " FAILED"
                                                                 : " IDLE")
                        : "",
                    app->log[visible[k]]);
        }
    }
    int max_offset = total_visible_lines > scroll_h ? total_visible_lines - scroll_h : 0;
    if ((int)pane->scroll_offset > max_offset) pane->scroll_offset = (size_t)max_offset;
    int skip_lines = max_offset - (int)pane->scroll_offset;
    int used_lines = 0;
    int drawn_rows = 0;
    int last_drawn_vi = -1;
    for (size_t vi = 0; vi < visible_count; vi++) {
        if (skip_lines >= heights[vi]) {
            skip_lines -= heights[vi];
            continue;
        }
        size_t i = visible[vi];
        /* The topmost row is usually only PARTLY scrolled off — the offset
         * is counted in lines, and a row is several. Its remaining lines
         * are drawn, in the row's own order (divider, then text, then
         * image), each pass of `row_skip` eating the part that is above
         * the region. Dropping the whole row instead — the old behaviour —
         * left the region short by the lines it had already been measured
         * for, so a wrapped message at the top made the newest message
         * float clear of the bottom border, and a whole message vanished
         * rather than sliding under the top edge. Spending exactly what
         * was reserved is what keeps the newest line glued to the bottom;
         * it is the same budget rule the divider broke. */
        int row_skip = skip_lines;
        skip_lines = 0;
        int available = scroll_h - used_lines;
        if (available <= 0) break;
        int msg_y = scroll_y + used_lines;
        /* Unread divider: drawn once, immediately above the first row the
         * server's cursor says has not been read. It is deliberately
         * anchored to the CURSOR rather than to "where I was scrolled
         * last", so it means the same thing here as on every other device
         * attached to this session.
         *
         * The row is the one the MEASURING pass reserved a line for — not
         * "the first unread row that happens to be on screen". Those two
         * differ as soon as the first unread row scrolls off the top, which
         * is the steady state of a window you sit in: the read cursor
         * freezes on focus, so after a screenful of traffic the divider's
         * row is above the viewport. Re-anchoring it to the topmost visible
         * row then spent a line the measurement had reserved for a row that
         * is no longer drawn, and the budget is paid at the BOTTOM: the
         * newest message is clipped away every frame, appearing only once
         * the next message pushes it up. A client permanently one line
         * behind. When the reserved row is scrolled off, the divider goes
         * with it — its line was skipped along with its row, so the two
         * passes still agree. */
        if ((int)vi == divider_vi) {
            if (row_skip > 0) {
                row_skip -= 1; /* the divider itself is above the region */
            } else if (used_lines + 1 < scroll_h) {
                attron(COLOR_PAIR(CP_ERROR) | A_BOLD);
                mvhline(msg_y, x + 1, ACS_HLINE, width - 2);
                mvprintw(msg_y, x + 3, " unread ");
                attroff(COLOR_PAIR(CP_ERROR) | A_BOLD);
                used_lines += 1;
                msg_y += 1;
                available -= 1;
            }
        }
        int text_skip = row_skip < text_heights[vi] ? row_skip : text_heights[vi];
        row_skip -= text_skip;
        int draw_lines = text_heights[vi] - text_skip;
        if (draw_lines > available) draw_lines = available;
        const char *msg_url = find_url(app->log[i]);
        enum media_kind mk = MEDIA_NONE;
        char url_tok[MAX_LINE] = "";
        if (msg_url) {
            copy_url_token(msg_url, url_tok, sizeof(url_tok));
            mk = media_kind_of(url_tok);
        }
        if (draw_lines > 0) {
            last_drawn_vi = (int)vi;
            drawn_rows++;
            draw_message_line(msg_y, x + 1, width - 2, text_skip, draw_lines, app->log[i],
                              app->log_mentions[i], app->log_pending[i]);
            /* EVERY link is clickable, not only the ones that turn into
             * pictures: `kind` decides whether the click previews or hands
             * the URL to the browser. */
            if (url_tok[0])
                add_link_region(app, msg_y, msg_y + draw_lines - 1, x + 1,
                                x + width - 2, url_tok, mk);
            /* And every row that carries a nick is right-clickable. */
            add_msg_region(app, msg_y, msg_y + draw_lines - 1, x + 1, x + width - 2, app->log[i]);
        }
        /* Claim the row's inline slot HERE, the first time the row is on
         * screen — not when the message arrived.
         *
         * Claiming at ingest froze two decisions at the wrong moment. It
         * asked `inline_media_enabled` once, so `/media on` could not
         * affect a single row already in the log: the toggle looked dead
         * for everything on screen, which is the whole scrollback. And it
         * froze the first-party verdict at arrival time. Both are
         * questions about the row you are LOOKING at, so they are asked
         * where the row is drawn. It also stops rows nobody ever scrolls
         * to from consuming the 24-slot pool, which is what the comment
         * below always claimed the code did.
         *
         * The slot is claimed but NOT rendered this frame: the measuring
         * pass ran before the claim and reserved no rows for the picture,
         * and spending rows the measurement did not reserve is exactly the
         * bug class that clips the newest message off the bottom. The next
         * frame measures it and draws it. */
        int mi = app->log_media[i];
        if (mi < 0 && mk != MEDIA_NONE && app->inline_media_enabled &&
            (app->inline_media_peers || url_is_first_party(app, url_tok))) {
            app->log_media[i] = media_claim_locked(app, url_tok, mk == MEDIA_VIDEO);
            mi = -1;
        }
        /* Draw the row's image beneath it, and kick off its decode the
         * first time it is on screen — lazy by design, so scrollback full
         * of links costs nothing until you scroll to them. */
        if (mi >= 0 && mi < (int)app->media_count) {
            struct inline_media *m = &app->media[mi];
            if (m->state == IM_IDLE && m->cols > 0) {
                m->state = IM_FETCHING;
                struct job mj = {.kind = JOB_MEDIA};
                snprintf(mj.arg1, sizeof(mj.arg1), "%d", mi);
                enqueue_job(app, mj);
            }
            int img_y = msg_y + draw_lines;
            int room = scroll_y + scroll_h - img_y;
            /* Spend exactly what the measuring pass reserved, less whatever
             * of the picture is above the region (only possible once the
             * row's text has scrolled off entirely), clamped to the room
             * actually left. A one-line placeholder that has scrolled off
             * asks for nothing, which is what the measurement skipped. */
            int want = media_extra_rows(m) - row_skip;
            if (want < 0) want = 0;
            int spend = want < room ? want : room;
            if (spend > 0) {
                if (m->state == IM_READY) {
                    /* Advance here, at the draw, so only pictures that
                     * are ON SCREEN cost anything: a scrollback full of
                     * GIFs you have scrolled past is not a scrollback
                     * full of running animations. */
                    if (m->frame_count > 1)
                        m->frame = media_frame_advance(m->frame, m->frame_count, m->frame_ms,
                                                       monotonic_ms(), &m->next_frame_ms);
                    /* Claimed by THIS frame, so the reconciliation at the
                     * end of draw() knows the placement is still wanted. */
                    m->painted_frame = app->frame_seq;
                    draw_inline_media(m, img_y, x + 2, row_skip, spend, width - 4);
                } else if (m->state == IM_FAILED) {
                    draw_text(img_y, x + 2, width - 4, CP_MUTED, A_DIM,
                              "  [image could not be decoded — /open to view externally]");
                } else {
                    draw_text(img_y, x + 2, width - 4, CP_MUTED, A_DIM, "  [loading image…]");
                }
                used_lines += spend;
                /* A tall picture can fill the region on its own, with its
                 * message line scrolled off above it: the row IS on screen,
                 * so the clipped-tail diagnostic must not call it missing. */
                last_drawn_vi = (int)vi;
            }
        }
        used_lines += draw_lines;
    }
    if (lay) {
        /* used < scroll_h with rows left undrawn means the budget ran out
         * early: the bottom of the buffer was clipped. used == scroll_h
         * with rows left is the normal "scrolled" case.
         *
         * CLIPPED is the one that matters and the one a screenshot cannot
         * show: sitting at the bottom (offset 0) with the NEWEST row not
         * drawn. That is the shape every measure-vs-draw disagreement
         * takes — whatever line the draw pass spends that the measuring
         * pass did not reserve is paid for out of the last row. */
        bool clipped = visible_count > 0 && pane->scroll_offset == 0 &&
                       last_drawn_vi != (int)visible_count - 1;
        fprintf(lay, "   END max_off=%d skip=%d used=%d/%d drawn=%d/%zu last_drawn=%d%s%s\n",
                max_offset, max_offset - (int)pane->scroll_offset, used_lines, scroll_h,
                drawn_rows, visible_count, last_drawn_vi,
                (used_lines > scroll_h) ? "  *** OVERFLOW: budget exceeded ***" : "",
                clipped ? "  *** CLIPPED: newest row not drawn ***" : "");
        fflush(lay);
    }

}

static void draw(struct app *app) {
    pthread_mutex_lock(&app->lock);
    erase();
    app->frame_seq++;
    app->link_region_count = 0;
    app->msg_region_count = 0;
    app->topic_region_count = 0;
    app->pane_region_count = 0;
    int rows, cols;
    getmaxyx(stdscr, rows, cols);
    int side = cols > 118 ? 22 : (cols > 90 ? 18 : 14);
    int members = cols > 118 ? 24 : 0;
    int main_x = side + 1;
    int main_w = cols - side - members - 2;
    int members_x = cols - members;
    int chrome_y = 0;
    int topic_y = 1;
    struct window *w = &app->windows[focused_window_locked(app)];
    char prompt[MAX_CHANNEL + 4];
    if (app->panel == PANEL_CHAT) snprintf(prompt, sizeof(prompt), "%s> ", w->channel);
    else snprintf(prompt, sizeof(prompt), "%s> ", panel_name(app->panel));
    int input_h = input_display_lines(prompt, app->input, main_w - 4);
    int max_input_h = rows / 3;
    if (max_input_h < 1) max_input_h = 1;
    if (input_h > max_input_h) input_h = max_input_h;
    int input_y = rows - input_h - 1;
    int compose_y = input_y - 1;
    /* The chat AREA: everything between the chrome line and the rule
     * above the status line. One pane fills it; several divide it. */
    int area_y = topic_y;
    int area_h = compose_y - 1 - area_y;
    if (area_h < 0) area_h = 0;

    for (int y = 0; y < rows; y++) {
        draw_fill(y, 0, side, CP_ALT);
        if (members) draw_fill(y, members_x, members, CP_ALT);
    }
    attron(COLOR_PAIR(CP_BORDER));
    mvvline(0, side, ACS_VLINE, rows);
    if (members) mvvline(0, members_x - 1, ACS_VLINE, rows);
    mvhline(compose_y - 1, main_x, ACS_HLINE, main_w);
    attroff(COLOR_PAIR(CP_BORDER));

    draw_text(0, 1, side - 2, CP_ACCENT, A_BOLD, "shottino");
    if (app->ws_connected) {
        draw_text(1, 1, side - 2, CP_MUTED, 0, "ws");
    } else {
        /* Count down to the next attempt. "offline" alone reads as a dead
         * end; the countdown says recovery is in progress. */
        long wait = (long)(app->ws_retry_at - time(NULL));
        if (wait < 0) wait = 0;
        draw_text(1, 1, side - 2, CP_ERROR, A_BOLD, "retry %lds", wait);
    }

    char last_net[MAX_SLUG] = "";
    int y = 3;
    for (size_t i = 0; i < app->window_count && y < rows - 1; i++) {
        struct window *win = &app->windows[i];
        if (!irc_name_eq(last_net, win->network)) {
            snprintf(last_net, sizeof(last_net), "%s", win->network);
            draw_text(y++, 1, side - 2, CP_ACCENT, A_BOLD, "%s", win->network);
            if (y >= rows - 1) break;
        }
        bool selected = window_is_visible_locked(app, i);
        bool unread = app->windows[i].unread > 0;
        /* A not-joined window is greyed and marked. cicchetto renders the
         * same states as greyed synthetic rows; the sigil is the terminal
         * equivalent of its badge, so a dead tab reads as dead at a glance
         * instead of looking like an ordinary empty channel. */
        char state_mark = window_state_mark(win->state);
        bool dead = state_mark != ' ';
        int pair = selected ? CP_SELECTED : (unread ? CP_ACCENT : (dead ? CP_MUTED : CP_ALT));
        draw_fill(y, 0, side, pair);
        draw_text(y, 1, 2, pair, (selected || unread) ? A_BOLD : 0, "%2zu", i + 1);
        if (dead) draw_text(y, 4, side - 5, pair, A_DIM, "%c%s", state_mark, win->channel);
        else if (win->mentions > 0) {
            /* A mention outranks a plain-message count: it is the reason
             * to look now rather than later, so it gets its own colour
             * and marker instead of being folded into one number. */
            draw_text(y, 4, side - 5, selected ? pair : CP_MENTION, A_BOLD, "%s (%u)",
                      win->channel, win->mentions);
        }
        else if (unread) draw_text(y, 4, side - 5, pair, A_BOLD, "%s [%u]", win->channel, app->windows[i].unread);
        else draw_text(y, 4, side - 5, pair, selected ? A_BOLD : 0, "%s", win->channel);
        y++;
    }

    /* The roster lives UNDER the window list, in whatever the window list
     * left. Windows keep priority: a channel you cannot see in the list is
     * a channel you cannot reach, while a roster that needs scrolling is
     * merely a roster that needs scrolling.
     *
     * It is drawn here only when the wide-terminal pane on the right is
     * NOT showing. One roster on screen at a time, in one of two places —
     * the same list either way, since both call draw_member_list. */
    size_t roster_rows = 0;
    if (!members && w->member_count > 0) {
        int roster_y = y + 1;
        int roster_h = rows - 1 - roster_y;
        if (roster_h > 0) {
            attron(COLOR_PAIR(CP_BORDER));
            mvhline(y, 0, ACS_HLINE, side);
            attroff(COLOR_PAIR(CP_BORDER));
            draw_fill(roster_y, 0, side, app->roster_focus ? CP_MENTION : CP_ALT);
            draw_text(roster_y, 1, side - 2, app->roster_focus ? CP_MENTION : CP_ACCENT, A_BOLD,
                      "users %zu%s", w->member_count, app->roster_focus ? " \u2191\u2193" : "");
            roster_rows = draw_member_list(app, w, -1, 0, 0, 0, 0);
            size_t max_off = roster_rows > (size_t)(roster_h - 1) ? roster_rows - (size_t)(roster_h - 1) : 0;
            struct pane *fp = focused_pane_locked(app);
            if (fp->member_offset > max_off) fp->member_offset = max_off;
            draw_member_list(app, w, roster_y + 1, 1, side - 2, roster_h - 1, fp->member_offset);
            /* Say so when the list runs past the pane, or a roster that is
             * simply taller than the sidebar reads as a truncated one. */
            if (roster_rows > (size_t)(roster_h - 1))
                draw_text(rows - 1, 1, side - 2, CP_MUTED, A_DIM, "%s %zu/%zu",
                          roster_hint(app, side - 2),
                          focused_pane_locked(app)->member_offset + 1, roster_rows);
        }
    }

    /* Title + topic ride one continuous band, so the chat area begins
     * where the colour changes rather than where a one-cell rule sits. */
    draw_fill(chrome_y, main_x, main_w, CP_TITLE);
    if (app->hover_url[0])
        draw_text(chrome_y, main_x + 1, main_w - 2, CP_TITLE_ACCENT, A_BOLD,
                  "%s: %s", media_kind_of(app->hover_url) != MEDIA_NONE ? "click to preview" : "click to open",
                  app->hover_url);
    else
        draw_text(chrome_y, main_x + 1, main_w - 2, CP_TITLE, 0,
                  "/archive  /settings  /admin  /chat  ws:%s", app->ws_connected ? "connected" : "offline");

    if (app->panel != PANEL_CHAT) {
        /* A panel replaces the whole chat area, panes and all: it is a
         * different mode, not another window. */
        draw_text(area_y, main_x + 1, main_w - 2, CP_ACCENT, A_BOLD, "%s", panel_name(app->panel));
        for (size_t i = 0; i < app->panel_line_count && (int)i + area_y + 2 < compose_y - 1; i++) {
            int pair = i == 0 ? CP_ACCENT : CP_MAIN;
            attr_t attr = i == 0 ? A_BOLD : 0;
            draw_text(area_y + 2 + (int)i, main_x + 1, main_w - 2, pair, attr, "%s", app->panel_lines[i]);
        }
        draw_fill(compose_y, main_x, main_w, CP_STATUS);
        draw_text(compose_y, main_x + 1, main_w - 2, CP_STATUS, 0, "panel: %s | Esc or /chat returns to chat", panel_name(app->panel));
        int cursor_y = input_y;
        int cursor_x = main_x + 2;
        draw_input_box(input_y, main_x + 1, main_w - 2, input_h, prompt, app->input, &cursor_y, &cursor_x);
        move(cursor_y, cursor_x);
        pthread_mutex_unlock(&app->lock);
        refresh();
        return;
    }

    /* Lay the panes out along the split axis, proportionally to their
     * weights, and hand each its rectangle. One pane is the same code
     * with the whole area — there is no unsplit special case. */
    bool split = app->pane_count > 1;
    int total_weight = 0;
    for (size_t i = 0; i < app->pane_count; i++) {
        if (app->panes[i].weight < 1) app->panes[i].weight = 1;
        total_weight += app->panes[i].weight;
    }
    if (total_weight < 1) total_weight = 1;
    int axis_total = app->split == SPLIT_ROWS ? area_h : main_w;
    /* Separators between panes cost a line/column each. */
    int gaps = (int)app->pane_count - 1;
    int usable = axis_total - gaps;
    if (usable < (int)app->pane_count) usable = (int)app->pane_count;
    int consumed = 0;
    for (size_t i = 0; i < app->pane_count; i++) {
        bool last = i + 1 == app->pane_count;
        int extent = last ? usable - consumed
                          : (usable * app->panes[i].weight) / total_weight;
        int floor_extent = app->split == SPLIT_ROWS ? 3 : 24;
        if (extent < floor_extent && !last) extent = floor_extent;
        if (extent > usable - consumed) extent = usable - consumed;
        if (extent < 1) extent = 1;
        bool focused = i == app->focus;
        if (app->split == SPLIT_ROWS) {
            draw_chat_pane(app, &app->panes[i], main_x, area_y + consumed, main_w, extent, focused,
                           split);
            if (!last) {
                attron(COLOR_PAIR(CP_BORDER));
                mvhline(area_y + consumed + extent, main_x, ACS_HLINE, main_w);
                attroff(COLOR_PAIR(CP_BORDER));
            }
        } else {
            draw_chat_pane(app, &app->panes[i], main_x + consumed, area_y, extent, area_h, focused,
                           split);
            if (!last) {
                attron(COLOR_PAIR(CP_BORDER));
                mvvline(area_y, main_x + consumed + extent, ACS_VLINE, area_h);
                attroff(COLOR_PAIR(CP_BORDER));
            }
        }
        consumed += extent + (last ? 0 : 1);
        if (consumed >= usable + gaps) break;
    }
    /* A window in a terminal state says WHY on the status line — the
     * sidebar sigil says "dead", this says "kicked by op: flooding". */
    /* The status line gets its own warm band: it is the boundary between
     * what the channel said and what YOU are about to say, and it used to
     * be muted grey on the chat background — indistinguishable from a
     * dimmed system row until you read it. */
    draw_fill(compose_y, main_x, main_w, CP_STATUS);
    const char *state_label = window_state_label(w->state);
    if (state_label) {
        draw_text(compose_y, main_x + 1, main_w - 2, CP_STATUS_ERROR, A_BOLD, "[%s] %s%s%s%s",
                  w->channel, state_label, w->state_detail[0] ? ": " : "", w->state_detail,
                  focused_pane_locked(app)->scroll_pinned ? " | scrolled" : "");
    } else {
        draw_text(compose_y, main_x + 1, main_w - 2, CP_STATUS, 0,
                  "[%s] %s | End bottom | Tab complete | Up/Down history | /open | /exit%s",
                  w->channel,
                  app->pane_count > 1 ? "PgUp/PgDn scroll | C-M-\u2191\u2193 pane | C-M-+/- size"
                                      : "PgUp/PgDn scroll",
                  focused_pane_locked(app)->scroll_pinned ? " | scrolled" : "");
    }
    int cursor_y = input_y;
    int cursor_x = main_x + 2;
    draw_input_box(input_y, main_x + 1, main_w - 2, input_h, prompt, app->input, &cursor_y, &cursor_x);

    /* The member pane used to render three lines of prose describing what
     * a member pane would show. It shows the members now: ops first, then
     * halfops, voiced, plain — each with the sigil its network actually
     * advertises via ISUPPORT PREFIX, nick-coloured to match scrollback. */
    if (members) {
        draw_fill(0, members_x, members, app->roster_focus ? CP_MENTION : CP_ALT);
        draw_text(0, members_x + 1, members - 2, app->roster_focus ? CP_MENTION : CP_ACCENT, A_BOLD,
                  "members %zu%s", w->member_count, app->roster_focus ? " ↑↓" : "");
        /* Same list, same tiers, same scroll offset as the sidebar pane —
         * only the column differs. */
        int pane_h = rows - 3;
        if (pane_h > 0) {
            roster_rows = draw_member_list(app, w, -1, 0, 0, 0, 0);
            size_t max_off = roster_rows > (size_t)pane_h ? roster_rows - (size_t)pane_h : 0;
            struct pane *fp = focused_pane_locked(app);
            if (fp->member_offset > max_off) fp->member_offset = max_off;
            draw_member_list(app, w, 2, members_x + 1, members - 2, pane_h, fp->member_offset);
            if (roster_rows > (size_t)pane_h)
                draw_text(rows - 1, members_x + 1, members - 2, CP_MUTED, A_DIM, "%s %zu/%zu",
                          roster_hint(app, members - 2),
                          focused_pane_locked(app)->member_offset + 1, roster_rows);
        }
        if (w->member_count == 0)
            draw_text(2, members_x + 1, members - 2, CP_MUTED, 0, "(not seeded)");
    }

    /* The overlay is drawn LAST and over everything: it is modal, and a
     * pane border crossing a menu would read as part of the menu. */
    if (app->overlay.kind != OVERLAY_NONE) {
        struct overlay_item items[64];
        size_t n = overlay_items(app, items, sizeof(items) / sizeof(items[0]));
        bool picker = app->overlay.kind == OVERLAY_REPLY || app->overlay.kind == OVERLAY_MEDIA;
        int box_w = picker ? (main_w > 76 ? 76 : main_w - 2) : 34;
        if (box_w > main_w - 2) box_w = main_w - 2;
        if (box_w < 20) box_w = 20;
        int list_h = (int)(n > 12 ? 12 : n);
        if (list_h < 1) list_h = 1;
        int box_h = list_h + (picker ? 2 : 0);
        int box_x = picker ? main_x + (main_w - box_w) / 2 : app->overlay.x;
        int box_y = picker ? (rows - box_h) / 2 : app->overlay.y;
        /* Clamped below, then written back: the click handler maps a row
         * to an item from these, so they have to be where it ACTUALLY
         * landed, not where it was asked to go. */
        if (box_x + box_w > cols) box_x = cols - box_w;
        if (box_x < 0) box_x = 0;
        if (box_y + box_h > rows - 1) box_y = rows - 1 - box_h;
        if (box_y < 0) box_y = 0;
        if (app->overlay.sel >= n && n) app->overlay.sel = n - 1;
        /* The window into the list follows the selection: a picker offers
         * more entries than the box has rows, and a selection nobody can
         * see is a selection nobody can trust. */
        if (app->overlay.sel < app->overlay.top) app->overlay.top = app->overlay.sel;
        if (app->overlay.sel >= app->overlay.top + (size_t)list_h)
            app->overlay.top = app->overlay.sel - (size_t)list_h + 1;
        if (app->overlay.top + (size_t)list_h > n)
            app->overlay.top = n > (size_t)list_h ? n - (size_t)list_h : 0;
        app->overlay.x = box_x;
        app->overlay.y = box_y;

        const char *verb = app->overlay.kind == OVERLAY_MEDIA
                               ? (app->overlay.pick_action == ACT_VIEW ? "open" : "preview")
                               : "reply to";
        const char *empty = app->overlay.kind == OVERLAY_MEDIA ? "(no pictures or clips here)"
                                                               : "(nothing to reply to)";
        for (int row = 0; row < box_h; row++) draw_fill(box_y + row, box_x, box_w, CP_SELECTED);
        int line_y = box_y;
        if (picker) {
            draw_text(line_y, box_x + 1, box_w - 2, CP_TITLE_ACCENT, A_BOLD, "%s: %s%s", verb,
                      app->overlay.filter, "_");
            line_y++;
        }
        for (size_t i = 0; i < (size_t)list_h; i++) {
            size_t idx = app->overlay.top + i;
            bool on = idx == app->overlay.sel;
            draw_fill(line_y, box_x, box_w, on ? CP_MENTION : CP_SELECTED);
            draw_text(line_y, box_x + 1, box_w - 2, on ? CP_MENTION : CP_SELECTED,
                      on ? A_BOLD : 0, "%s", idx < n ? items[idx].label : empty);
            line_y++;
        }
        if (picker)
            draw_text(line_y, box_x + 1, box_w - 2, CP_SELECTED, A_DIM,
                      "%zu/%zu | type to filter | Up/Down | Enter | Esc", n ? app->overlay.sel + 1 : 0,
                      n);
    }
    /* Reconcile the terminal's graphics placements with what this frame
     * actually drew.
     *
     * A placement outlives the cells around it: switch windows and the
     * picture from the channel you left is still hanging over the one you
     * opened, because nothing in ncurses' model knows it is there. So the
     * question is asked once per frame, generally — "is anything placed
     * that this frame did not paint?" — rather than at each of the half
     * dozen sites that change what is visible (/win, /close, scroll,
     * resize, split, a slot recycled out from under a row). One of those
     * sites will always be the one nobody remembered. */
    if (media_placements_stale_locked(app)) media_placements_drop_locked(app);
    move(cursor_y, cursor_x);
    pthread_mutex_unlock(&app->lock);
    refresh();
}

static void send_message(struct app *app, const char *body) {
    struct window *w = &app->windows[focused_window_locked(app)];
    char *net = url_encode(w->network);
    char *chan = url_encode(w->channel);
    char *escaped = json_escape(body);
    char *path = xasprintf("/networks/%s/channels/%s/messages", net, chan);
    char *json = xasprintf("{\"body\":\"%s\"}", escaped);
    free(net);
    free(chan);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, json);
    if (r.status < 200 || r.status >= 300) log_line(app, "send failed HTTP %d: %.200s", r.status, r.body);
    else if (r.status == 201) render_created_message(app, r.body, r.body_len);
    free(path);
    free(json);
    free(r.body);
}

static void send_message_target(struct app *app, const char *network, const char *channel, const char *body) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *escaped = json_escape(body);
    char *path = xasprintf("/networks/%s/channels/%s/messages", net, chan);
    char *json = xasprintf("{\"body\":\"%s\"}", escaped);
    free(net);
    free(chan);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, json);
    if (r.status < 200 || r.status >= 300) log_line(app, "send failed HTTP %d: %.200s", r.status, r.body);
    else if (r.status == 201) render_created_message(app, r.body, r.body_len);
    free(path);
    free(json);
    free(r.body);
}

static void set_network_state(struct app *app, const char *network, const char *state, const char *reason) {
    char *net = url_encode(network);
    char *path = xasprintf("/networks/%s/", net);
    char *why = json_escape(reason ? reason : "");
    char *body = reason && reason[0]
        ? xasprintf("{\"connection_state\":\"%s\",\"reason\":\"%s\"}", state, why)
        : xasprintf("{\"connection_state\":\"%s\"}", state);
    free(net);
    free(why);
    struct http_response r = http_request(app, "PATCH", path, body);
    if (r.status >= 200 && r.status < 300) log_line(app, "%s is %s", network, state);
    else log_line(app, "network state failed HTTP %d: %.200s", r.status, r.body);
    free(path);
    free(body);
    free(r.body);
}

static void set_nick(struct app *app, const char *nick) {
    char net_now[MAX_SLUG];
    if (!current_window_key(app, net_now, sizeof(net_now), NULL, 0)) return;
    char *net = url_encode(net_now);
    char *path = xasprintf("/networks/%s/nick", net);
    char *escaped = json_escape(nick);
    char *body = xasprintf("{\"nick\":\"%s\"}", escaped);
    free(net);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, body);
    if (r.status >= 200 && r.status < 300) log_line(app, "nick change requested: %s", nick);
    else log_line(app, "nick failed HTTP %d: %.200s", r.status, r.body);
    free(path);
    free(body);
    free(r.body);
}

static void set_topic_target(struct app *app, const char *network, const char *channel, const char *topic) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *escaped = json_escape(topic);
    char *path = xasprintf("/networks/%s/channels/%s/topic", net, chan);
    char *body = xasprintf("{\"body\":\"%s\"}", escaped);
    free(net);
    free(chan);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, body);
    if (r.status >= 200 && r.status < 300) log_line(app, "topic change requested for %s", channel);
    else log_line(app, "topic failed HTTP %d: %.200s", r.status, r.body);
    free(path);
    free(body);
    free(r.body);
}

/* `announce` false = fill the roster without printing it. The pane
 * refreshes itself on focus and after a MODE, and dumping the whole
 * member list into scrollback every time would bury the conversation
 * under the furniture. /members still prints, because that is what the
 * user asked for. */
static void list_members_target(struct app *app, const char *network, const char *channel,
                                bool announce) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *path = xasprintf("/networks/%s/channels/%s/members", net, chan);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "GET", path, NULL);
    if (r.status == 204) {
        log_line(app, "members for %s are not seeded yet", channel);
    } else if (r.status >= 200 && r.status < 300) {
        /* The previous reader scanned for `"nick"` / `"modes"` and copied
         * every character following a quote that was not 'm' — an attempt
         * to skip the literal key "modes" that also mangled any mode
         * letter 'm' and any nick containing a quote. Parse properly. */
        char err[160];
        json_doc *doc = json_parse(r.body, r.body_len, err, sizeof(err));
        /* This endpoint answers with an ENVELOPE — `{"members": [...]}`
         * (`Session.Wire.members_index/1`) — unlike the messages and
         * channels endpoints, which return a bare array. Accept either:
         * assuming a bare array here made every /members call report
         * "malformed response". */
        const json_value *root = json_root(doc);
        const json_value *list = root;
        if (json_type_of(root) == JSON_OBJECT) list = json_get(root, "members");
        if (!doc || json_type_of(list) != JSON_ARRAY) {
            log_line(app, "members %s: malformed response (%s)", channel, doc ? "not a list" : err);
            json_free(doc);
            free(path);
            free(r.body);
            return;
        }
        struct member rows[512];
        size_t count = 0;
        for (size_t i = 0; i < json_len(list) && count < 512; i++) {
            const json_value *m = json_at(list, i);
            const char *nick = NULL;
            if (!json_str_req(m, "nick", &nick)) continue;
            snprintf(rows[count].nick, sizeof(rows[count].nick), "%s", nick);
            rows[count].modes[0] = '\0';
            const json_value *modes = json_get(m, "modes");
            for (size_t j = 0, w = 0; j < json_len(modes) && w + 1 < sizeof(rows[count].modes); j++) {
                const char *mode = json_string(json_at(modes, j));
                if (mode && mode[0]) {
                    rows[count].modes[w++] = mode[0];
                    rows[count].modes[w] = '\0';
                }
            }
            count++;
        }
        json_free(doc);
        /* No sort here: set_window_members owns the ordering, so the REST
         * roster and the seeded one cannot disagree. */
        set_window_members(app, network, channel, rows, count);
        if (announce) {
            sort_members(app, network, rows, count); /* same order as the pane */
            log_line(app, "members %s (%zu):", channel, count);
            for (size_t i = 0; i < count; i++) {
                const char *label = member_rank_label(app, network, rows[i].modes);
                char sigil = member_sigil(app, network, rows[i].modes);
                log_line(app, "  %-6s %c%s", label, sigil ? sigil : ' ', rows[i].nick);
            }
            if (count == 0) log_line(app, "members %s: (none)", channel);
        }
    } else if (announce) {
        log_line(app, "members failed HTTP %d: %.200s", r.status, r.body);
    }
    free(path);
    free(r.body);
}

static void push_simple_channel_action(struct app *app, const char *event, const char *extra_json) {
    char chan_now[MAX_CHANNEL];
    if (!current_window_key(app, NULL, 0, chan_now, sizeof(chan_now))) return;
    int id = current_network_id(app);
    char *channel = json_escape(chan_now);
    char *payload = extra_json
        ? xasprintf("{\"network_id\":%d,\"channel\":\"%s\",%s}", id, channel, extra_json)
        : xasprintf("{\"network_id\":%d,\"channel\":\"%s\"}", id, channel);
    free(channel);
    ws_push_user(app, event, payload);
    free(payload);
}

static char *json_array_words(const char *words) {
    char *copy = xasprintf("%s", words);
    char *out = xasprintf("[");
    bool first = true;
    for (char *tok = strtok(copy, " \t"); tok; tok = strtok(NULL, " \t")) {
        char *e = json_escape(tok);
        char *next = xasprintf("%s%s\"%s\"", out, first ? "" : ",", e);
        free(out);
        free(e);
        out = next;
        first = false;
    }
    char *next = xasprintf("%s]", out);
    free(out);
    free(copy);
    return next;
}

static void query_window(struct app *app, const char *target) {
    char net_now[MAX_SLUG];
    if (!current_window_key(app, net_now, sizeof(net_now), NULL, 0)) return;
    int id = current_network_id(app);
    char *t = json_escape(target);
    char *payload = xasprintf("{\"network_id\":%d,\"target_nick\":\"%s\"}", id, t);
    ws_push_user(app, "open_query_window", payload);
    add_window(app, net_now, target);
    free(t);
    free(payload);
}

/* Join `name` on an EXPLICIT network.
 *
 * The network used to be derived from whichever window had focus, which
 * is right for a keystroke and wrong for anything else: JOB_JOIN carries
 * a network and the worker threw it away, so a join requested for one
 * network landed on whatever the user happened to be looking at. The
 * bridge (--ircd) has no focus at all, which is what made the latent bug
 * unavoidable. */
static void join_channel_on(struct app *app, const char *network, const char *name) {
    const char *net_slug = network && network[0] ? network : app->networks[0].slug;
    char *net = url_encode(net_slug);
    char *path = xasprintf("/networks/%s/channels", net);
    char *escaped = json_escape(name);
    char *body = xasprintf("{\"name\":\"%s\"}", escaped);
    free(net);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, body);
    if (r.status >= 200 && r.status < 300) {
        add_window(app, net_slug, name);
        fetch_scrollback(app, &app->windows[focused_window_locked(app)]);
        if (app->ws_connected) {
            char *t = xasprintf("grappa:user:%s/network:%s/channel:%s", app->subject, net_slug, name);
            ws_join(app, t);
            free(t);
        }
    } else {
        log_line(app, "join failed HTTP %d: %.200s", r.status, r.body);
    }
    free(path);
    free(body);
    free(r.body);
}

/* Part an EXPLICIT (network, channel), for the same reason as
 * join_channel_on: the caller knows which one, and deriving it from the
 * focused window means a request for one channel parting another. */
static void part_target(struct app *app, const char *network, const char *channel) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *path = xasprintf("/networks/%s/channels/%s", net, chan);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "DELETE", path, NULL);
    if (r.status >= 200 && r.status < 300) {
        log_line(app, "parted %s", channel);
        remove_window(app, network, channel);
    } else {
        log_line(app, "part failed HTTP %d: %.200s", r.status, r.body);
    }
    free(path);
    free(r.body);
}

static void close_query_target(struct app *app, const char *network, const char *target) {
    int id = 0;
    for (size_t i = 0; i < app->network_count; i++) {
        if (irc_name_eq(app->networks[i].slug, network)) {
            id = app->networks[i].id;
            break;
        }
    }
    if (id == 0) {
        log_line(app, "close query failed: unknown network %s", network);
        return;
    }
    char *nick = json_escape(target);
    char *payload = xasprintf("{\"network_id\":%d,\"target_nick\":\"%s\"}", id, nick);
    free(nick);
    ws_push_user(app, "close_query_window", payload);
    free(payload);
    remove_window(app, network, target);
    log_line(app, "closed query %s", target);
}

static bool enqueue_job(struct app *app, struct job job) {
    pthread_mutex_lock(&app->jobs_lock);
    size_t next = (app->jobs_tail + 1) % JOB_QUEUE;
    if (next == app->jobs_head) {
        pthread_mutex_unlock(&app->jobs_lock);
        log_line(app, "background queue full; command not sent");
        return false;
    }
    app->jobs[app->jobs_tail] = job;
    app->jobs_tail = next;
    pthread_cond_signal(&app->jobs_cond);
    pthread_mutex_unlock(&app->jobs_lock);
    return true;
}

static bool dequeue_job(struct app *app, struct job *job) {
    pthread_mutex_lock(&app->jobs_lock);
    while (!app->worker_stop && app->jobs_head == app->jobs_tail) pthread_cond_wait(&app->jobs_cond, &app->jobs_lock);
    if (app->worker_stop && app->jobs_head == app->jobs_tail) {
        pthread_mutex_unlock(&app->jobs_lock);
        return false;
    }
    *job = app->jobs[app->jobs_head];
    app->jobs_head = (app->jobs_head + 1) % JOB_QUEUE;
    pthread_mutex_unlock(&app->jobs_lock);
    return true;
}

static void *worker_main(void *arg) {
    struct app *app = arg;
    struct job job;
    while (dequeue_job(app, &job)) {
        switch (job.kind) {
        case JOB_FETCH:
            fetch_scrollback_target(app, job.network, job.channel);
            break;
        case JOB_READ_CURSOR:
            push_read_cursor(app, job.network, job.channel, strtol(job.arg1, NULL, 10));
            break;
        case JOB_MEDIA:
            media_decode_job(app, (int)strtol(job.arg1, NULL, 10));
            break;
        case JOB_VIEW:
            view_fetch_and_open(app, job.arg1);
            break;
        case JOB_CHATHISTORY:
            ircd_archive_job(app, &job);
            break;
        case JOB_SEND: {
            send_message_target(app, job.network, job.channel, job.arg1);
            break;
        }
        case JOB_JOIN:
            join_channel_on(app, job.network, job.channel);
            break;
        case JOB_PART:
            part_target(app, job.network, job.channel);
            break;
        case JOB_NICK:
            add_window(app, job.network, job.channel);
            set_nick(app, job.arg1);
            break;
        case JOB_NETWORK_STATE:
            set_network_state(app, job.network, job.arg1, job.arg2[0] ? job.arg2 : NULL);
            break;
        case JOB_TOPIC:
            set_topic_target(app, job.network, job.channel, job.arg1);
            break;
        case JOB_MEMBERS:
            /* arg1 is the announce flag: "quiet" for the pane's own
             * refreshes, empty for an explicit /members. */
            list_members_target(app, job.network, job.channel, strcmp(job.arg1, "quiet") != 0);
            break;
        case JOB_CLOSE_QUERY:
            close_query_target(app, job.network, job.channel);
            break;
        }
    }
    return NULL;
}

/* Queue a read-cursor publish. Deliberately fire-and-forget: the cursor
 * is advisory catch-up state, and a failed write costs a stale divider,
 * not a lost message. */
static void enqueue_read_cursor(struct app *app, const char *network, const char *channel,
                                long message_id) {
    struct job job = { .kind = JOB_READ_CURSOR };
    snprintf(job.network, sizeof(job.network), "%s", network);
    snprintf(job.channel, sizeof(job.channel), "%s", channel);
    snprintf(job.arg1, sizeof(job.arg1), "%ld", message_id);
    enqueue_job(app, job);
}

static void enqueue_fetch(struct app *app, const char *network, const char *channel) {
    struct job job = { .kind = JOB_FETCH };
    snprintf(job.network, sizeof(job.network), "%s", network);
    snprintf(job.channel, sizeof(job.channel), "%s", channel);
    enqueue_job(app, job);
}

static void enqueue_members(struct app *app, const char *network, const char *channel) {
    if (!network[0] || !channel[0] || is_server_window(channel)) return;
    struct job job = { .kind = JOB_MEMBERS };
    snprintf(job.network, sizeof(job.network), "%s", network);
    snprintf(job.channel, sizeof(job.channel), "%s", channel);
    snprintf(job.arg1, sizeof(job.arg1), "quiet");
    enqueue_job(app, job);
}

/* Focus landed on a window with no roster: ask for one. The pane is
 * always on screen now, so "empty until you type /members" is not a
 * state worth having. Gated on empty, so switching windows in a channel
 * whose roster is already live costs nothing. */
static void ensure_roster(struct app *app, const char *network, const char *channel) {
    bool empty = false;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (window_matches(&app->windows[i], network, channel)) {
            empty = app->windows[i].member_count == 0;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
    if (empty) enqueue_members(app, network, channel);
}

static void enqueue_send(struct app *app, const char *network, const char *channel, const char *body) {
    struct job job = { .kind = JOB_SEND };
    snprintf(job.network, sizeof(job.network), "%s", network);
    snprintf(job.channel, sizeof(job.channel), "%s", channel);
    snprintf(job.arg1, sizeof(job.arg1), "%s", body);
    enqueue_job(app, job);
}

static const char *own_nick_for_network(struct app *app, const char *network) {
    for (size_t i = 0; i < app->network_count; i++) {
        if (irc_name_eq(app->networks[i].slug, network) && app->networks[i].nick[0]) return app->networks[i].nick;
    }
    if (app->login_nick[0]) return app->login_nick;
    const char *colon = strchr(app->subject, ':');
    return colon ? colon + 1 : app->subject;
}

static void add_history(struct app *app, const char *line) {
    if (!line[0]) return;
    if (app->history_count > 0 && strcmp(app->history[app->history_count - 1], line) == 0) {
        app->history_pos = app->history_count;
        return;
    }
    if (app->history_count == INPUT_HISTORY) {
        memmove(app->history, app->history + 1, sizeof(app->history[0]) * (INPUT_HISTORY - 1));
        app->history_count--;
    }
    snprintf(app->history[app->history_count++], MAX_LINE, "%s", line);
    app->history_pos = app->history_count;
}

static void history_prev(struct app *app) {
    if (app->history_count == 0 || app->history_pos == 0) return;
    app->history_pos--;
    snprintf(app->input, sizeof(app->input), "%s", app->history[app->history_pos]);
    app->input_len = strlen(app->input);
}

static void history_next(struct app *app) {
    if (app->history_pos >= app->history_count) return;
    app->history_pos++;
    if (app->history_pos == app->history_count) app->input[0] = 0;
    else snprintf(app->input, sizeof(app->input), "%s", app->history[app->history_pos]);
    app->input_len = strlen(app->input);
}


/* ── /split, /splitv, /unsplit ─────────────────────────────────────────
 *
 * A new pane opens on the SAME window as the one it was split from, not
 * on a guessed "next" one: splitting is a request for another view, and
 * which conversation goes in it is the next thing you say (/win, Ctrl-N).
 * Landing it on some other channel would be the client picking. */
static void split_pane(struct app *app, enum split_axis axis) {
    pthread_mutex_lock(&app->lock);
    if (app->pane_count >= MAX_PANES) {
        pthread_mutex_unlock(&app->lock);
        log_line(app, "/split: %d panes is the limit — /unsplit closes one", MAX_PANES);
        return;
    }
    struct pane *from = focused_pane_locked(app);
    struct pane fresh = {.window = from->window, .weight = 1};
    app->split = axis;
    /* The new pane goes directly after the focused one and takes focus:
     * you asked for it, so you are looking at it. */
    size_t at = app->focus + 1;
    memmove(&app->panes[at + 1], &app->panes[at], sizeof(app->panes[0]) * (app->pane_count - at));
    app->panes[at] = fresh;
    app->pane_count++;
    app->focus = at;
    size_t count = app->pane_count;
    pthread_mutex_unlock(&app->lock);
    log_line(app, "split %s — %zu panes; Ctrl-Alt-Up/Down or Ctrl-Alt-Tab to switch, Ctrl-Alt-+/- to resize",
             axis == SPLIT_ROWS ? "horizontally" : "vertically", count);
}

static void unsplit_pane(struct app *app) {
    pthread_mutex_lock(&app->lock);
    if (app->pane_count <= 1) {
        pthread_mutex_unlock(&app->lock);
        log_line(app, "/unsplit: only one pane");
        return;
    }
    size_t at = app->focus;
    memmove(&app->panes[at], &app->panes[at + 1],
            sizeof(app->panes[0]) * (app->pane_count - at - 1));
    app->pane_count--;
    if (app->focus >= app->pane_count) app->focus = app->pane_count - 1;
    size_t count = app->pane_count;
    pthread_mutex_unlock(&app->lock);
    log_line(app, "%zu pane%s", count, count == 1 ? "" : "s");
}

/* Move focus between panes. The window list, the roster and the input all
 * follow, because they all ask focused_pane_locked() where they are. */
static void focus_pane(struct app *app, int delta) {
    pthread_mutex_lock(&app->lock);
    if (app->pane_count > 1) {
        if (delta > 0) app->focus = (app->focus + 1) % app->pane_count;
        else app->focus = app->focus == 0 ? app->pane_count - 1 : app->focus - 1;
        clear_current_unread_locked(app);
    }
    pthread_mutex_unlock(&app->lock);
}

/* Grow or shrink the focused pane. Weights, not absolute sizes: a
 * terminal resize then re-divides in the same proportions instead of
 * leaving one pane pinned at a size the window can no longer hold. */
static void resize_pane(struct app *app, int delta) {
    pthread_mutex_lock(&app->lock);
    struct pane *p = focused_pane_locked(app);
    int w = p->weight + delta;
    if (w < 1) w = 1;
    if (w > 16) w = 16;
    p->weight = w;
    pthread_mutex_unlock(&app->lock);
}


/* ── Overlay ───────────────────────────────────────────────────────────
 *
 * Items are derived, never stored: the reply picker reads the log every
 * time it is drawn or acted on, so a message arriving under an open
 * picker cannot make the highlighted row mean something else than what
 * gets sent. Caller holds app->lock. */
static size_t overlay_items(struct app *app, struct overlay_item *out, size_t max) {
    if (max == 0) return 0;
    struct overlay *ov = &app->overlay;
    size_t n = 0;
    if (ov->kind == OVERLAY_MENU) {
        if (!ov->nick[0]) return n;
        /* Replying needs something they SAID, which a roster row does not
         * have: the menu offers what the thing under the pointer can
         * actually do, rather than an entry that fails when chosen. */
        if (ov->body[0]) {
            snprintf(out[n].label, sizeof(out[n].label), "Reply to %s", ov->nick);
            snprintf(out[n].nick, sizeof(out[n].nick), "%s", ov->nick);
            snprintf(out[n].body, sizeof(out[n].body), "%s", ov->body);
            out[n].action = ACT_REPLY;
            if (++n >= max) return n;
        }
        snprintf(out[n].label, sizeof(out[n].label), "Open query with %s", ov->nick);
        snprintf(out[n].nick, sizeof(out[n].nick), "%s", ov->nick);
        out[n].action = ACT_QUERY;
        if (++n >= max) return n;
        snprintf(out[n].label, sizeof(out[n].label), "Whois %s", ov->nick);
        snprintf(out[n].nick, sizeof(out[n].nick), "%s", ov->nick);
        out[n].action = ACT_WHOIS;
        if (++n >= max) return n;
        snprintf(out[n].label, sizeof(out[n].label), "Type %s", ov->nick);
        snprintf(out[n].nick, sizeof(out[n].nick), "%s", ov->nick);
        out[n].action = ACT_INSERT;
        n++;
        return n;
    }
    /* The media picker: the last PICKER_MAX pictures and clips posted in
     * this window, newest first, each URL once however many times it was
     * repeated. Same list for /preview and /view — what Enter does with
     * the URL is the command's decision, not the list's. */
    if (ov->kind == OVERLAY_MEDIA) {
        if (max > PICKER_MAX) max = PICKER_MAX;
        size_t cur = focused_window_locked(app);
        if (cur >= app->window_count) return 0;
        struct window *w = &app->windows[cur];
        char want[MAX_SLUG + MAX_CHANNEL + 8];
        window_scope_key(w->network, w->channel, want, sizeof(want));
        for (size_t k = app->log_count; k > 0 && n < max; k--) {
            if (!log_row_in_scope(app, k - 1, want)) continue;
            const char *line = app->log[k - 1];
            const char *url = find_url(line);
            if (!url) continue;
            char tok[MAX_LINE];
            copy_url_token(url, tok, sizeof(tok));
            enum media_kind kind = media_kind_of(tok);
            if (kind == MEDIA_NONE) continue;
            if (ov->filter[0] && !contains_ci(tok, ov->filter)) continue;
            bool already = false;
            for (size_t j = 0; j < n && !already; j++) already = strcmp(out[j].body, tok) == 0;
            if (already) continue;
            char prefix[256], nick[256];
            const char *body = NULL;
            if (!split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body))
                nick[0] = 0;
            snprintf(out[n].nick, sizeof(out[n].nick), "%s", nick);
            snprintf(out[n].body, sizeof(out[n].body), "%s", tok);
            snprintf(out[n].label, sizeof(out[n].label), "%-12.20s %s%.900s", nick[0] ? nick : "-",
                     kind == MEDIA_VIDEO ? "▶ " : "", tok);
            out[n].action = ov->pick_action;
            n++;
        }
        return n;
    }

    if (ov->kind != OVERLAY_REPLY) return 0;
    if (max > PICKER_MAX) max = PICKER_MAX;

    /* Newest first: you almost always mean something you just read. Only
     * rows from the focused pane's window, and only rows that carry a
     * nick — a join/part is not something to reply to.
     *
     * Unfiltered this is the last PICKER_MAX messages, every one of
     * them. It used to keep only the most recent line of each run of one
     * nick, which reads well and answers the wrong question: the picker
     * is for choosing a LINE (it is quoted into the reply), and in a
     * conversation between two people the collapse hid every line but
     * two. Typing filters instead, and the filter searches the whole
     * buffer of the window rather than the visible list — the point of a
     * search is to reach what is not in front of you. */
    size_t cur = focused_window_locked(app);
    if (cur >= app->window_count) return 0;
    struct window *w = &app->windows[cur];
    char want[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key(w->network, w->channel, want, sizeof(want));
    for (size_t k = app->log_count; k > 0 && n < max; k--) {
        const char *line = app->log[k - 1];
        if (!log_row_in_scope(app, k - 1, want)) continue;
        char prefix[256], nick[256];
        const char *body = NULL;
        if (!split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body)) continue;
        if (!nick[0] || !body) continue;
        if (ov->filter[0] && !contains_ci(nick, ov->filter) && !contains_ci(body, ov->filter))
            continue;
        snprintf(out[n].nick, sizeof(out[n].nick), "%s", nick);
        snprintf(out[n].body, sizeof(out[n].body), "%s", body);
        snprintf(out[n].label, sizeof(out[n].label), "%-14s %s", nick, body);
        out[n].action = ACT_REPLY;
        n++;
    }
    return n;
}

static void overlay_close(struct app *app) {
    pthread_mutex_lock(&app->lock);
    app->overlay.kind = OVERLAY_NONE;
    app->overlay.filter[0] = 0;
    app->overlay.sel = 0;
    app->overlay.top = 0;
    pthread_mutex_unlock(&app->lock);
}


/* ── Composing a reply ─────────────────────────────────────────────────
 *
 * IRC has no threading: a reply is a line like any other, so the only way
 * to say WHICH message you are answering is to carry a piece of it. The
 * shape is
 *
 *     nick: «what they said…» your answer
 *
 * chosen because it survives every client that will see it — it is plain
 * text, the guillemets do not collide with mIRC formatting codes or with
 * anything a shell or markdown renderer would eat, and `nick:` at the
 * front is the addressing convention every IRC client already highlights
 * on. The citation is TRUNCATED hard: an IRC line is ~450 usable bytes
 * and the point is to jog a memory, not to repeat the channel back at
 * it.
 *
 * Pure, so the awkward parts — re-picking a different message while a
 * half-written answer sits in the input, a citation that must be cut on a
 * word boundary, formatting codes in the original — are testable without
 * a terminal.
 */
#define REPLY_CITE_MAX 56

/* Strip a reply prefix this function previously wrote, so choosing a
 * different message REPLACES the citation instead of stacking a second
 * one in front of the first. Anything the user typed themselves survives;
 * a line that does not look like our own prefix is returned untouched,
 * because guessing wrong here deletes someone's sentence. */
static const char *skip_reply_prefix(const char *input) {
    const char *colon = strstr(input, ": ");
    if (!colon) return input;
    /* Only our own shape: no spaces in the addressed nick. */
    for (const char *p = input; p < colon; p++)
        if (isspace((unsigned char)*p)) return input;
    const char *rest = colon + 2;
    if (strncmp(rest, "\xc2\xab", 2) != 0) return rest; /* addressed, no citation */
    const char *close = strstr(rest, "\xc2\xbb");
    if (!close) return rest;
    close += 2;
    while (*close == ' ') close++;
    return close;
}

/* One line of the original, with formatting codes removed and runs of
 * whitespace collapsed: a citation is a reminder, and a newline or a
 * colour code in the middle of one is neither. */
static void cite_text(const char *body, char *out, size_t out_sz) {
    if (!out_sz) return;
    out[0] = '\0';
    if (!body) return;
    char plain[MAX_LINE * 2];
    if (mirc_has_formatting(body)) mirc_strip(body, plain, sizeof(plain));
    else snprintf(plain, sizeof(plain), "%s", body);

    /* Collapse whitespace while copying, bounded by the cite width. */
    char flat[REPLY_CITE_MAX + 1];
    size_t w = 0;
    bool gap = false;
    const char *p = plain;
    for (; *p && w < REPLY_CITE_MAX; p++) {
        unsigned char c = (unsigned char)*p;
        if (isspace(c)) { gap = w > 0; continue; }
        if (gap && w < REPLY_CITE_MAX) flat[w++] = ' ';
        gap = false;
        if (w < REPLY_CITE_MAX) flat[w++] = (char)c;
    }
    flat[w] = '\0';

    /* Was it actually CUT, or merely shorter once the whitespace
     * collapsed? Comparing lengths cannot tell those apart — collapsing
     * "two\n\nlines   and    spaces" shortens it by six characters
     * without dropping a word — so the question is whether anything but
     * whitespace is left where the copy stopped. */
    bool cut = false;
    for (const char *q = p; *q; q++)
        if (!isspace((unsigned char)*q)) { cut = true; break; }
    if (cut) {
        char *last = strrchr(flat, ' ');
        if (last && last - flat > REPLY_CITE_MAX / 3) *last = '\0';
        snprintf(out, out_sz, "%s\xe2\x80\xa6", flat);
    } else {
        snprintf(out, out_sz, "%s", flat);
    }
}

/* nick + citation + whatever was already being typed. */
static void compose_reply(const char *nick, const char *body, const char *existing, char *out,
                          size_t out_sz) {
    if (!out_sz) return;
    const char *tail = existing ? skip_reply_prefix(existing) : "";
    char cite[REPLY_CITE_MAX + 8];
    cite_text(body, cite, sizeof(cite));
    /* Built in bounded steps so that if anything has to give it is the
     * TAIL: the address and the citation are what make the line mean
     * something to the person reading it. */
    int n = cite[0] ? snprintf(out, out_sz, "%s: \xc2\xab%s\xc2\xbb ", nick, cite)
                    : snprintf(out, out_sz, "%s: ", nick);
    if (n < 0) { out[0] = '\0'; return; }
    if ((size_t)n >= out_sz) return;
    size_t off = (size_t)n;
    size_t room = out_sz - off - 1;
    size_t take = strnlen(tail, room);
    memcpy(out + off, tail, take);
    out[off + take] = '\0';
}

/* Prefill the input with the IRC convention for a reply. Anything already
 * typed is kept after the address rather than thrown away — losing a
 * half-written line to a stray keypress is its own bug. */
static void reply_to(struct app *app, const char *nick, const char *body) {
    pthread_mutex_lock(&app->lock);
    char composed[MAX_LINE];
    compose_reply(nick, body, app->input, composed, sizeof(composed));
    snprintf(app->input, sizeof(app->input), "%s", composed);
    app->input_len = strlen(app->input);
    pthread_mutex_unlock(&app->lock);
}

static void query_window(struct app *app, const char *target);
static void handle_command(struct app *app, const char *input);
static void request_preview(struct app *app, const char *url, bool is_video, bool force_ascii);
static void request_view(struct app *app, const char *url);

static void overlay_activate(struct app *app) {
    struct overlay_item items[64];
    char nick[MAX_CHANNEL] = "";
    char body[MAX_LINE] = "";
    enum overlay_action action = ACT_NONE;
    pthread_mutex_lock(&app->lock);
    size_t n = overlay_items(app, items, sizeof(items) / sizeof(items[0]));
    if (app->overlay.sel < n) {
        action = items[app->overlay.sel].action;
        snprintf(nick, sizeof(nick), "%s", items[app->overlay.sel].nick);
        snprintf(body, sizeof(body), "%s", items[app->overlay.sel].body);
    }
    pthread_mutex_unlock(&app->lock);
    overlay_close(app);
    /* A media row need not carry a nick — a bare URL is still something
     * to look at — so each action checks the field it actually needs. */
    switch (action) {
    case ACT_REPLY:
        if (nick[0]) reply_to(app, nick, body);
        break;
    case ACT_QUERY:
        if (nick[0]) query_window(app, nick);
        break;
    case ACT_WHOIS:
        if (nick[0]) {
            /* Through the ordinary command path, so the menu cannot
             * become a second implementation of /whois that drifts. */
            char cmd[MAX_CHANNEL + 8];
            snprintf(cmd, sizeof(cmd), "/whois %s", nick);
            handle_command(app, cmd);
        }
        break;
    case ACT_INSERT:
        /* What tab-completion would have typed. Appended rather than
         * replacing, because the input may already be half a sentence. */
        if (nick[0]) {
            pthread_mutex_lock(&app->lock);
            size_t len = strlen(app->input);
            const char *sep = len == 0 ? "" : (app->input[len - 1] == ' ' ? "" : " ");
            snprintf(app->input + len, sizeof(app->input) - len, "%s%s%s", sep, nick,
                     len == 0 ? ": " : " ");
            app->input_len = strlen(app->input);
            pthread_mutex_unlock(&app->lock);
        }
        break;
    case ACT_PREVIEW:
        if (body[0]) request_preview(app, body, media_kind_of(body) == MEDIA_VIDEO, false);
        break;
    case ACT_VIEW:
        if (body[0]) request_view(app, body);
        break;
    case ACT_NONE:
        break;
    }
}

/* Keys, while an overlay is up. Returns true when the key was consumed —
 * an open overlay owns the keyboard, or typing into the picker's filter
 * would also be typing into the message you are composing. */
static bool overlay_key(struct app *app, int ch) {
    pthread_mutex_lock(&app->lock);
    enum overlay_kind kind = app->overlay.kind;
    pthread_mutex_unlock(&app->lock);
    if (kind == OVERLAY_NONE) return false;

    if (ch == 27) {
        overlay_close(app);
        return true;
    }
    if (ch == '\n' || ch == '\r') {
        overlay_activate(app);
        return true;
    }
    if (ch == KEY_UP || ch == KEY_DOWN) {
        struct overlay_item items[64];
        pthread_mutex_lock(&app->lock);
        size_t n = overlay_items(app, items, sizeof(items) / sizeof(items[0]));
        if (n) {
            if (ch == KEY_DOWN) app->overlay.sel = (app->overlay.sel + 1) % n;
            else app->overlay.sel = app->overlay.sel == 0 ? n - 1 : app->overlay.sel - 1;
        }
        pthread_mutex_unlock(&app->lock);
        return true;
    }
    if (kind == OVERLAY_REPLY || kind == OVERLAY_MEDIA) {
        pthread_mutex_lock(&app->lock);
        size_t len = strlen(app->overlay.filter);
        if ((ch == KEY_BACKSPACE || ch == 127 || ch == 8) && len) app->overlay.filter[len - 1] = 0;
        else if (isprint(ch) && len + 1 < sizeof(app->overlay.filter)) {
            app->overlay.filter[len] = (char)ch;
            app->overlay.filter[len + 1] = 0;
        }
        /* The list just changed under the selection. */
        app->overlay.sel = 0;
        app->overlay.top = 0;
        pthread_mutex_unlock(&app->lock);
        return true;
    }
    return true; /* the menu swallows everything else rather than acting on it */
}

static void open_reply_picker(struct app *app) {
    pthread_mutex_lock(&app->lock);
    app->overlay.kind = OVERLAY_REPLY;
    app->overlay.filter[0] = 0;
    app->overlay.sel = 0;
    app->overlay.top = 0;
    pthread_mutex_unlock(&app->lock);
}

/* The same picker over this window's pictures and clips. `action` is
 * what Enter does with the one you choose — /preview renders it here,
 * /view hands it to the system viewer. Returns false when the window
 * has no media to offer, so the caller can say so rather than opening
 * an empty box. */
static bool open_media_picker(struct app *app, enum overlay_action action) {
    struct overlay_item items[PICKER_MAX];
    pthread_mutex_lock(&app->lock);
    app->overlay.kind = OVERLAY_MEDIA;
    app->overlay.pick_action = action;
    app->overlay.filter[0] = 0;
    app->overlay.sel = 0;
    app->overlay.top = 0;
    size_t n = overlay_items(app, items, PICKER_MAX);
    if (n == 0) app->overlay.kind = OVERLAY_NONE;
    pthread_mutex_unlock(&app->lock);
    return n > 0;
}

/* Scroll ONE pane. Positive = further back. The focused-pane form below
 * is this with the focus filled in, so a key and a wheel event cannot
 * drift into two different notions of scrolling. */
static void scroll_pane(struct app *app, size_t index, int delta) {
    pthread_mutex_lock(&app->lock);
    if (index >= app->pane_count) index = app->focus < app->pane_count ? app->focus : 0;
    struct pane *p = &app->panes[index];
    if (delta > 0) p->scroll_offset += (size_t)delta;
    else {
        size_t n = (size_t)(-delta);
        p->scroll_offset = n > p->scroll_offset ? 0 : p->scroll_offset - n;
    }
    p->scroll_pinned = p->scroll_offset > 0;
    pthread_mutex_unlock(&app->lock);
}

static void scroll_chat(struct app *app, int delta) {
    pthread_mutex_lock(&app->lock);
    size_t index = (size_t)(focused_pane_locked(app) - app->panes);
    pthread_mutex_unlock(&app->lock);
    scroll_pane(app, index, delta);
}

static void scroll_bottom(struct app *app) {
    pthread_mutex_lock(&app->lock);
    for (size_t p = 0; p < app->pane_count; p++) {
        app->panes[p].scroll_offset = 0;
        app->panes[p].scroll_pinned = false;
        app->panes[p].member_offset = 0;
    }
    pthread_mutex_unlock(&app->lock);
}

/* Scroll the member pane. Positive = further down the roster. The upper
 * bound is the draw path's business — it is the only thing that knows how
 * many rows the pane got — so this only floors at zero and lets the frame
 * clamp the top. */
static void scroll_members(struct app *app, int delta) {
    pthread_mutex_lock(&app->lock);
    struct pane *p = focused_pane_locked(app);
    if (delta > 0) p->member_offset += (size_t)delta;
    else {
        size_t n = (size_t)(-delta);
        p->member_offset = n > p->member_offset ? 0 : p->member_offset - n;
    }
    pthread_mutex_unlock(&app->lock);
}

/* Keys while the member list holds the keyboard. Returns true when the
 * key was consumed.
 *
 * This exists because the modified arrows the roster was reachable by
 * are not reliably DELIVERED: Ctrl-Shift-Up/Down is the terminal's own
 * scroll shortcut in gnome-terminal, konsole, kitty and terminator, so
 * the client never sees it, and a terminfo entry that describes no
 * modified arrows turns the rest into raw bytes. A plain control
 * character and plain arrows are the two things every terminal sends,
 * so this way in cannot be swallowed. The shortcuts stay for terminals
 * that do deliver them; this is the one that always works.
 *
 * Any key that is not a movement hands the keyboard straight back — a
 * mode you can get stuck in is worse than a list you cannot scroll. */
static bool roster_key(struct app *app, int ch) {
    pthread_mutex_lock(&app->lock);
    bool focused = app->roster_focus;
    size_t cur = focused_window_locked(app);
    size_t members = cur < app->window_count ? app->windows[cur].member_count : 0;
    pthread_mutex_unlock(&app->lock);

    if (ch == 21) { /* Ctrl-U */
        if (!focused && members == 0) {
            log_line(app, "this window has no member list to scroll");
            return true;
        }
        pthread_mutex_lock(&app->lock);
        app->roster_focus = !focused;
        pthread_mutex_unlock(&app->lock);
        return true;
    }
    if (!focused) return false;

    int delta;
    switch (ch) {
    case KEY_UP: delta = -1; break;
    case KEY_DOWN: delta = 1; break;
    case KEY_PPAGE: delta = -10; break;
    case KEY_NPAGE: delta = 10; break;
    /* The frame clamps the far end — it is the only thing that knows how
     * tall the pane got — so "top" and "bottom" are just big numbers. */
    case KEY_HOME: delta = -1000000; break;
    case KEY_END: delta = 1000000; break;
    default:
        pthread_mutex_lock(&app->lock);
        app->roster_focus = false;
        pthread_mutex_unlock(&app->lock);
        return ch == 27; /* Escape leaves the mode and does nothing else */
    }
    scroll_members(app, delta);
    return true;
}

static void cycle_window(struct app *app, int delta) {
    pthread_mutex_lock(&app->lock);
    if (app->window_count == 0) {
        pthread_mutex_unlock(&app->lock);
        return;
    }
    struct pane *p = focused_pane_locked(app);
    if (delta > 0) p->window = (p->window + 1) % app->window_count;
    else p->window = p->window == 0 ? app->window_count - 1 : p->window - 1;
    p->scroll_offset = 0;
    p->scroll_pinned = false;
    p->member_offset = 0;
    clear_current_unread_locked(app);
    for (size_t p = 0; p < app->pane_count; p++) {
        app->panes[p].scroll_offset = 0;
        app->panes[p].scroll_pinned = false;
        app->panes[p].member_offset = 0;
    }
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    snprintf(network, sizeof(network), "%s", app->windows[focused_window_locked(app)].network);
    snprintf(channel, sizeof(channel), "%s", app->windows[focused_window_locked(app)].channel);
    pthread_mutex_unlock(&app->lock);
    enqueue_fetch(app, network, channel);
    ensure_roster(app, network, channel);
}

/* Every verb the dispatcher in handle_input() accepts, sorted. The list is
 * data and the dispatcher is code, so the two can drift — and they had:
 * 36 of the 79 working verbs did not tab-complete, including everything
 * added after the first cut (/media, /split*, the services shortcuts, /kb).
 * A missing entry is invisible in use — Tab simply does nothing, which
 * reads as "no such command" — so tests/test_commands.c scans this file for
 * the dispatcher's own literals and fails when one is not listed here.
 * Adding a verb means adding it in three places; that test names them. */
static const char *commands[] = {
    "/admin", "/alias", "/archive", "/away", "/ban", "/banlist", "/chat", "/clear", "/close",
    "/connect", "/cs", "/dehilight", "/deop", "/devoice", "/disconnect", "/exit", "/help",
    "/highlight", "/hilight", "/hs", "/info", "/invite", "/j", "/join", "/kb", "/keys", "/kick",
    "/kickban", "/links", "/list", "/lusers", "/me", "/media", "/members", "/mode", "/motd",
    "/mouse", "/ms", "/msg", "/names", "/nick", "/notify", "/ns", "/op", "/open", "/oper", "/os",
    "/part", "/preview", "/q", "/query", "/quit", "/quote", "/rehash", "/rs", "/settings",
    "/share", "/split", "/splith", "/splitv", "/splitw", "/stats", "/topic", "/umode", "/unalias",
    "/unban", "/unsplit", "/upload", "/users", "/version", "/view", "/voice", "/w", "/watch",
    "/who", "/whois", "/whowas", "/win", "/window"
};

static bool prefix_ci(const char *s, const char *prefix) {
    while (*prefix) {
        if (!*s) return false;
        if (tolower((unsigned char)*s) != tolower((unsigned char)*prefix)) return false;
        s++;
        prefix++;
    }
    return true;
}

static bool candidate_seen(char candidates[][MAX_CHANNEL], size_t count, const char *candidate) {
    for (size_t i = 0; i < count; i++) {
        if (strcasecmp(candidates[i], candidate) == 0) return true;
    }
    return false;
}

static void add_completion_candidate(char candidates[][MAX_CHANNEL], size_t *count, const char *candidate, const char *stem) {
    if (!candidate || !candidate[0]) return;
    if (!prefix_ci(candidate, stem)) return;
    if (candidate_seen(candidates, *count, candidate)) return;
    if (*count >= 64) return;
    snprintf(candidates[*count], MAX_CHANNEL, "%s", candidate);
    (*count)++;
}

static void collect_log_nick_candidate(struct app *app, char candidates[][MAX_CHANNEL], size_t *count, const char *line, const char *stem) {
    char prefix[256];
    char nick[MAX_CHANNEL];
    const char *body;
    (void)app;
    if (split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body)) {
        add_completion_candidate(candidates, count, nick, stem);
    }
}

static void complete_input(struct app *app) {
    char prefix[MAX_LINE];
    snprintf(prefix, sizeof(prefix), "%s", app->input);
    char *last_space = strrchr(prefix, ' ');
    const char *stem = last_space ? last_space + 1 : prefix;
    size_t stem_len = strlen(stem);

    if (app->input_len == 0 || stem_len == 0) return;

    char candidates[64][MAX_CHANNEL];
    size_t matches = 0;

    if (prefix[0] == '/' && !last_space) {
        for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); i++) {
            add_completion_candidate(candidates, &matches, commands[i], stem);
        }
        /* A user's own aliases are commands too — /alias hi /me waves then
         * /hi has to complete, or the feature is only usable by memory. No
         * lock: the alias table is written and read on this thread only.
         * Names are stored bare, and one that shadows a built-in dedupes
         * against the entry already added above (#427 lets it shadow). */
        for (size_t i = 0; i < app->aliases.count; i++) {
            char verb[ALIAS_MAX_NAME + 2];
            snprintf(verb, sizeof(verb), "/%s", app->aliases.entries[i].name);
            add_completion_candidate(candidates, &matches, verb, stem);
        }
    } else {
        /* Tab completion reads the roster, the window list, the network
         * table AND the whole log — every one of them mutated by the
         * socket thread. One critical section over the gather rather
         * than a snapshot per table: the candidates only need to be
         * consistent with each other, and this runs on a keystroke. */
        char cur_net[MAX_SLUG];
        current_window_key(app, cur_net, sizeof(cur_net), NULL, 0);
        const char *current_network = cur_net;
        pthread_mutex_lock(&app->lock);
        if (app->window_count > 0) {
            struct window *w = &app->windows[focused_window_locked(app)];
            for (size_t i = 0; i < w->member_count; i++) add_completion_candidate(candidates, &matches, w->members[i].nick, stem);
        }
        for (size_t i = 0; i < app->window_count; i++) {
            const char *name = app->windows[i].channel;
            add_completion_candidate(candidates, &matches, name, stem);
        }
        for (size_t i = 0; i < app->network_count; i++) {
            const char *name = app->networks[i].slug;
            add_completion_candidate(candidates, &matches, name, stem);
            if (irc_name_eq(app->networks[i].slug, current_network)) add_completion_candidate(candidates, &matches, app->networks[i].nick, stem);
        }
        for (size_t i = 0; i < app->log_count; i++) {
            collect_log_nick_candidate(app, candidates, &matches, app->log[i], stem);
        }
        pthread_mutex_unlock(&app->lock);
    }

    if (matches == 1) {
        size_t head = last_space ? (size_t)(last_space + 1 - prefix) : 0;
        snprintf(app->input + head, sizeof(app->input) - head, "%s", candidates[0]);
        app->input_len = strlen(app->input);
        if (app->input_len + 1 < sizeof(app->input)) {
            app->input[app->input_len++] = ' ';
            app->input[app->input_len] = 0;
        }
    } else if (matches > 1) {
        char list[1024] = "";
        size_t used = 0;
        for (size_t i = 0; i < matches; i++) {
            int n = snprintf(list + used, sizeof(list) - used, "%s%s", i == 0 ? "" : " ", candidates[i]);
            if (n < 0 || (size_t)n >= sizeof(list) - used) break;
            used += (size_t)n;
        }
        log_line(app, "completions for '%s': %s", stem, list);
    }
}

static void open_external_url(struct app *app, const char *url) {
    if (!url || !url[0]) {
        log_line(app, "no URL captured yet");
        return;
    }
    /* Double-fork: the grandchild runs xdg-open and is reparented to init,
     * so it is auto-reaped — we must not block the UI thread waiting on a
     * browser launcher, and a single fork would leak a zombie per call.
     * xdg-open's own diagnostics are sent to /dev/null so they can't scribble
     * over the ncurses screen. */
    pid_t pid = fork();
    if (pid == 0) {
        if (fork() == 0) {
            int devnull = open("/dev/null", O_WRONLY);
            if (devnull >= 0) {
                dup2(devnull, STDOUT_FILENO);
                dup2(devnull, STDERR_FILENO);
                if (devnull > STDERR_FILENO) close(devnull);
            }
            execlp("xdg-open", "xdg-open", url, (char *)NULL);
            _exit(127);
        }
        _exit(0);
    }
    if (pid < 0) {
        log_line(app, "failed to launch xdg-open");
        return;
    }
    while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {}
    log_line(app, "opened %s", url);
}


/* ── /view: fetch it, then let the desktop choose the viewer ───────────
 *
 * xdg-open on a URL opens a BROWSER: the handler is picked from the
 * SCHEME. "Open this in my picture viewer" therefore means fetching the
 * bytes first and opening the FILE, whose handler is picked from its
 * type. That is the whole difference between /view and /open, and it is
 * why this needs a download at all.
 *
 * It runs on the worker thread, because it is a network round trip and
 * the UI thread never waits on one — the same rule the inline decoder
 * follows.
 *
 * The session token is never sent. The URL points wherever a stranger's
 * message pointed, and a bearer token is not something to hand to a
 * host because its link was pasted in a channel. Uploads on this
 * deployment are fetchable without it, which is how the inline decoder
 * reaches them too.
 *
 * Fetching a third-party URL does tell that host your IP and that you
 * are reading — the #451 exposure. /view is an explicit act on a link
 * you chose, which is the bargain /open already makes by handing the
 * same URL to a browser. What #451 turned off was doing it
 * AUTOMATICALLY for every link that scrolled past. */
#define VIEW_MAX_BYTES (32u * 1024u * 1024u)
#define VIEW_MAX_REDIRECTS 3

/* One GET. Returns false when the response never arrived; a response
 * that arrived with a bad status is a `true` with that status in it, so
 * the caller can tell "no route" from "404". */
struct fetch_result {
    int status;
    char *body;
    size_t len;
    char location[MAX_LINE];
    char content_type[128];
};

static void fetch_result_free(struct fetch_result *r) {
    free(r->body);
    r->body = NULL;
    r->len = 0;
}

/* Copy a header's value out of a NUL-terminated header block. */
static void header_value(const char *headers, const char *name, char *out, size_t out_sz) {
    out[0] = 0;
    const char *p = strcasestr(headers, name);
    if (!p) return;
    p += strlen(name);
    while (*p == ' ' || *p == '\t') p++;
    size_t n = 0;
    while (p[n] && p[n] != '\r' && p[n] != '\n' && n + 1 < out_sz) n++;
    memcpy(out, p, n);
    out[n] = 0;
}

static bool http_fetch(struct app *app, const char *url, struct fetch_result *out) {
    memset(out, 0, sizeof(*out));
    struct url u;
    if (!parse_url(url, &u)) return false;
    /* parse_url keeps the authority; the path is whatever follows it. */
    const char *after_scheme = strstr(url, "://");
    const char *path = after_scheme ? strchr(after_scheme + 3, '/') : NULL;

    struct tls_conn conn;
    if (!conn_open_to(app, u.host, u.port, u.tls, &conn)) {
        conn_close(&conn);
        return false;
    }
    char *head = xasprintf("GET %s HTTP/1.1\r\n"
                           "Host: %s\r\n"
                           "User-Agent: shottino/0.1\r\n"
                           "Accept: */*\r\n"
                           "Connection: close\r\n\r\n",
                           path && *path ? path : "/", u.host);
    bool ok = conn_write_all(&conn, head, strlen(head));
    free(head);
    if (!ok) {
        conn_close(&conn);
        return false;
    }

    /* Read with a cap and NO die(): a third-party URL may serve
     * gigabytes, and a client that exits because someone pasted a link
     * is worse than one that says the file was too big. */
    size_t cap = 65536, len = 0;
    char *buf = malloc(cap + 1);
    if (!buf) {
        conn_close(&conn);
        return false;
    }
    bool truncated = false;
    for (;;) {
        if (len == cap) {
            if (cap >= VIEW_MAX_BYTES) {
                truncated = true;
                break;
            }
            cap *= 2;
            char *bigger = realloc(buf, cap + 1);
            if (!bigger) {
                free(buf);
                conn_close(&conn);
                return false;
            }
            buf = bigger;
        }
        ssize_t n = conn_read(&conn, buf + len, cap - len);
        if (n <= 0) break;
        len += (size_t)n;
    }
    buf[len] = 0;
    conn_close(&conn);
    if (truncated) {
        free(buf);
        return false;
    }

    char *sep = strstr(buf, "\r\n\r\n");
    if (!sep) {
        free(buf);
        return false;
    }
    *sep = 0;
    const char *status_sp = strchr(buf, ' ');
    out->status = status_sp ? atoi(status_sp + 1) : 0;
    header_value(buf, "Location:", out->location, sizeof(out->location));
    header_value(buf, "Content-Type:", out->content_type, sizeof(out->content_type));
    bool chunked = strcasestr(buf, "Transfer-Encoding: chunked") != NULL;
    char *body_start = sep + 4;
    size_t hdr_len = (size_t)(body_start - buf);
    size_t blen = len >= hdr_len ? len - hdr_len : 0;
    if (chunked) {
        out->body = http_decode_chunked(body_start, blen, &out->len);
        free(buf);
        if (!out->body) return false;
    } else {
        out->body = malloc(blen ? blen : 1);
        if (!out->body) {
            free(buf);
            return false;
        }
        memcpy(out->body, body_start, blen);
        out->len = blen;
        free(buf);
    }
    return true;
}

/* The extension the saved file should carry, since it is what the
 * desktop picks the viewer from. The URL is asked first because it is
 * what the sender meant; Content-Type answers for the links that carry
 * no extension at all. */
static void view_extension(const char *url, const char *content_type, char *out, size_t out_sz) {
    static const struct {
        const char *type;
        const char *ext;
    } TYPES[] = {
        {"image/png", "png"},   {"image/jpeg", "jpg"}, {"image/gif", "gif"},
        {"image/webp", "webp"}, {"image/avif", "avif"}, {"image/bmp", "bmp"},
        {"image/svg", "svg"},   {"video/mp4", "mp4"},  {"video/webm", "webm"},
        {"video/quicktime", "mov"}, {"video/x-matroska", "mkv"}, {"application/pdf", "pdf"},
    };
    snprintf(out, out_sz, "%s", "bin");
    const char *after_scheme = strstr(url, "://");
    const char *path = after_scheme ? strchr(after_scheme + 3, '/') : NULL;
    const char *last_slash = path ? strrchr(path, '/') : NULL;
    const char *dot = last_slash ? strrchr(last_slash, '.') : NULL;
    if (dot && dot[1]) {
        size_t n = 0;
        while (dot[1 + n] && isalnum((unsigned char)dot[1 + n]) && n < 5) n++;
        if (n && !dot[1 + n]) { /* the whole tail is the extension */
            snprintf(out, out_sz, "%.*s", (int)n, dot + 1);
            return;
        }
    }
    for (size_t i = 0; i < sizeof(TYPES) / sizeof(TYPES[0]); i++)
        if (strncasecmp(content_type, TYPES[i].type, strlen(TYPES[i].type)) == 0) {
            snprintf(out, out_sz, "%s", TYPES[i].ext);
            return;
        }
}

/* A directory of our own, made once and removed at exit, so a session
 * that views fifty pictures leaves nothing behind. Caller holds
 * app->lock. */
static bool view_dir_locked(struct app *app) {
    if (app->view_dir[0]) return true;
    const char *tmp = getenv("TMPDIR");
    if (!tmp || !*tmp) tmp = "/tmp";
    char pattern[sizeof(app->view_dir)];
    snprintf(pattern, sizeof(pattern), "%s/shottino-XXXXXX", tmp);
    if (!mkdtemp(pattern)) return false;
    snprintf(app->view_dir, sizeof(app->view_dir), "%s", pattern);
    return true;
}

static void view_dir_cleanup(struct app *app) {
    if (!app->view_dir[0]) return;
    DIR *d = opendir(app->view_dir);
    if (d) {
        struct dirent *e;
        while ((e = readdir(d))) {
            if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
            char path[PATH_MAX];
            snprintf(path, sizeof(path), "%s/%s", app->view_dir, e->d_name);
            unlink(path);
        }
        closedir(d);
    }
    rmdir(app->view_dir);
    app->view_dir[0] = 0;
}

static void open_external_url(struct app *app, const char *url);

/* Worker side of /view: fetch, save, hand to the desktop. */
static void view_fetch_and_open(struct app *app, const char *url) {
    struct fetch_result res;
    char current[MAX_LINE];
    snprintf(current, sizeof(current), "%s", url);
    bool got = false;
    for (int hop = 0; hop <= VIEW_MAX_REDIRECTS; hop++) {
        if (!http_fetch(app, current, &res)) {
            log_line(app, "/view: could not fetch %.60s", current);
            return;
        }
        if ((res.status == 301 || res.status == 302 || res.status == 303 ||
             res.status == 307 || res.status == 308) &&
            res.location[0]) {
            char next[MAX_LINE];
            snprintf(next, sizeof(next), "%s", res.location);
            fetch_result_free(&res);
            /* Only absolute redirects are followed: resolving a relative
             * Location means reimplementing URL joining, and every host
             * that serves media sends an absolute one. */
            if (strncmp(next, "http://", 7) != 0 && strncmp(next, "https://", 8) != 0) {
                log_line(app, "/view: %.40s redirected somewhere this client cannot follow", current);
                return;
            }
            snprintf(current, sizeof(current), "%s", next);
            continue;
        }
        got = true;
        break;
    }
    if (!got) {
        log_line(app, "/view: %.40s redirects in circles", url);
        return;
    }
    if (res.status != 200 || res.len == 0) {
        log_line(app, "/view: %.50s answered %d%s", current, res.status,
                 res.len == 0 ? " with nothing" : "");
        fetch_result_free(&res);
        return;
    }

    char ext[16];
    view_extension(current, res.content_type, ext, sizeof(ext));
    char path[PATH_MAX];
    pthread_mutex_lock(&app->lock);
    bool have_dir = view_dir_locked(app);
    unsigned seq = ++app->view_seq;
    if (have_dir) snprintf(path, sizeof(path), "%s/%u.%s", app->view_dir, seq, ext);
    pthread_mutex_unlock(&app->lock);
    if (!have_dir) {
        log_line(app, "/view: no writable temporary directory");
        fetch_result_free(&res);
        return;
    }

    FILE *f = fopen(path, "wb");
    if (!f || fwrite(res.body, 1, res.len, f) != res.len) {
        if (f) fclose(f);
        log_line(app, "/view: could not write %s", path);
        fetch_result_free(&res);
        return;
    }
    fclose(f);
    fetch_result_free(&res);
    open_external_url(app, path);
}

static void request_view(struct app *app, const char *url) {
    struct job job = {.kind = JOB_VIEW};
    snprintf(job.arg1, sizeof(job.arg1), "%s", url);
    if (enqueue_job(app, job)) log_line(app, "fetching %.60s for the system viewer", url);
}

/* Run argv[0] with execvp (no shell). stderr always discarded; stdout goes to
 * the controlling terminal when `inherit_stdout` (so chafa can paint), else to
 * /dev/null (ffmpeg writes its frame to a file, not stdout). Returns the
 * process exit code, or -1 on spawn/abnormal exit. */
static int run_cmd(char *const argv[], bool inherit_stdout) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            if (!inherit_stdout) dup2(devnull, STDOUT_FILENO);
            dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO) close(devnull);
        }
        execvp(argv[0], argv);
        _exit(127);
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return -1;
}

/* Block for a single raw keypress on stdin, used to dismiss the preview while
 * ncurses is suspended. Restores the prior terminal mode before returning. */
static void wait_for_dismiss_key(void) {
    struct termios old_tio, raw;
    if (tcgetattr(STDIN_FILENO, &old_tio) != 0) {
        getchar();
        return;
    }
    raw = old_tio;
    cfmakeraw(&raw);
    unsigned char c;
    /* First drain whatever the terminal sent in reply to chafa's graphics
     * capability probes (DA / cursor-position / Kitty responses). If left in
     * the buffer, the blocking read below would consume one of those bytes as
     * the dismiss key and flash the preview shut. VMIN=0/VTIME=1 polls with a
     * 100ms idle window: read until a quiet gap, then there is nothing stray
     * left. */
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 1;
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    while (read(STDIN_FILENO, &c, 1) > 0) {}
    /* Then block for a genuine keypress. */
    raw.c_cc[VMIN] = 1;
    raw.c_cc[VTIME] = 0;
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    while (read(STDIN_FILENO, &c, 1) < 0 && errno == EINTR) {}
    tcsetattr(STDIN_FILENO, TCSANOW, &old_tio);
}

/* Mouse motion/button reporting escapes. Enabled while shottino owns the
 * screen; disabled around the preview (so frame bytes aren't read as a
 * dismiss key) and at shutdown. */
/* Mouse tracking is what makes click-to-preview work — and it is also
 * what stops the terminal doing its own text selection, because the
 * terminal hands motion/button events to us instead of acting on them.
 * Nothing the application can do restores native selection while tracking
 * is on: the only fix is to turn it off, which is why this is toggleable
 * from `/mouse` rather than being unconditional.
 *
 * `app->mouse_enabled` is the user's PREFERENCE; this function is the
 * mechanism. The two are separate because the media-preview path disables
 * tracking around a full-screen preview and must restore whatever the
 * user chose, not force it back on. */
static void mouse_reporting(bool on) {
    fputs(on ? "\033[?1000h\033[?1003h\033[?1006h"
             : "\033[?1006l\033[?1003l\033[?1000l",
          stdout);
    fflush(stdout);
}

/* Apply the user's preference. Used everywhere tracking is (re-)asserted
 * so a `/mouse off` is never silently undone by a preview or a resize.
 *
 * BOTH halves are required, and sending only the escape sequences (as the
 * first attempt at this did) does not work: ncurses OWNS the mouse mode
 * once `mousemask()` is set non-zero, and re-emits the enable sequence on
 * its own schedule, so a raw `\033[?1000l` is silently undone and
 * selection never comes back. Clearing the mask is what actually makes
 * ncurses stop; the raw sequences then mop up 1003/1006, which it does
 * not consistently manage. */
static void mouse_apply(struct app *app) {
    if (app->mouse_enabled) {
        mousemask(ALL_MOUSE_EVENTS | REPORT_MOUSE_POSITION, NULL);
        mouseinterval(0);
        mouse_reporting(true);
    } else {
        mousemask(0, NULL);
        mouse_reporting(false);
    }
    /* ncurses buffers its own output; without this the mode change does
     * not reach the terminal until the next unrelated repaint. */
    refresh();
}

/* Full-screen modal media preview. Both images and videos are normalized to a
 * single PNG frame by ffmpeg (which also does the network fetch + decode),
 * then rendered by chafa, which auto-detects the terminal graphics protocol
 * (Kitty > iTerm2 > Sixel > symbols). Falls back to xdg-open when either tool
 * is absent or the frame extraction fails. Blocks until a key is pressed; the
 * caller's next draw() repaints the chat, clearing the preview. */
/* Decode one inline image on the WORKER thread.
 *
 * Two output shapes, chosen by protocol:
 *   kitty / iTerm2 — a PNG, which the terminal decodes itself;
 *   sixel / art    — raw RGB24 at the exact pixel grid we will draw.
 *
 * Either way ffmpeg does the fetch, decode and scale in one pass, and the
 * `thumbnail` filter picks a representative frame so a video does not
 * render as a black leader frame.
 *
 * Runs entirely off the UI thread; the only shared-state touch is the
 * short critical section at the end that publishes the result. */
static void media_decode_job(struct app *app, int slot) {
    if (slot != MEDIA_SLOT_PREVIEW && (slot < 0 || slot >= MAX_INLINE_MEDIA)) return;

    char url[MAX_LINE];
    media_protocol proto;
    int cols, rows;
    pthread_mutex_lock(&app->lock);
    struct inline_media *m =
        (slot == MEDIA_SLOT_PREVIEW) ? &app->preview : &app->media[slot];
    snprintf(url, sizeof(url), "%s", m->url);
    /* /preview-ascii forces the pixel path regardless of what the
     * terminal can do. */
    proto = m->force_ascii ? MEDIA_PROTO_NONE : app->proto;
    cols = m->cols;
    rows = m->rows;
    /* Motion is a CHARACTER-ART capability here. A terminal graphics
     * protocol places a whole picture at the cursor, so animating one
     * means re-emitting the escape per frame — flicker, bandwidth, and a
     * different code path per protocol. Character art goes through
     * ncurses like text, so it repaints, clips and scrolls with
     * everything else. A clip therefore renders as art even where a
     * protocol is available: consistent motion beats a still that is
     * slightly sharper. */
    /* Does this decode ask for FRAMES?
     *
     * The URL is a bad witness for "is this animated" and was the bug
     * that shipped: a GIF whose link does not end in .gif — or is an
     * animated WebP, or an APNG — decoded as a single frame and sat
     * there. The decoder knows and the URL only guesses.
     *
     * So: when the picture is going to be rendered as CHARACTER ART
     * anyway, always ask for frames and let the count decide. A still
     * image comes back as exactly one frame and costs precisely what it
     * costs today. The URL hint survives only where it buys something —
     * a terminal with a graphics protocol, where forcing art for a still
     * would trade real sharpness for a guess.
     *
     * (Asking for frames must not be done with the fps filter on a
     * still: a single image has no duration for fps to sample, and it
     * yields ZERO frames. Stills go through passthrough, which gives the
     * one frame they have; only video takes fps, which is what makes its
     * playback rate right.) */
    bool art = proto == MEDIA_PROTO_NONE;
    bool hinted = m->is_animatable;
    bool animate = app->animate_media && (art || hinted);
    if (animate) proto = MEDIA_PROTO_NONE;
    bool timed = animate && m->is_video; /* fps filter, vs native frames */
    int want_frames = animate ? MEDIA_ANIM_MAX_FRAMES : 1;
    pthread_mutex_unlock(&app->lock);
    if (!url[0] || cols <= 0 || rows <= 0) return;

    char dir[] = "/tmp/shottino-media-XXXXXX";
    if (!mkdtemp(dir)) return;

    bool ok = false;
    char *payload = NULL;
    size_t payload_len = 0;
    unsigned char *rgb = NULL;
    size_t frames = 1;

    if (proto == MEDIA_PROTO_KITTY || proto == MEDIA_PROTO_ITERM2) {
        /* Let the terminal scale: ask ffmpeg for a reasonable pixel size
         * and pass the CELL box in the escape. */
        char png[PATH_MAX];
        snprintf(png, sizeof(png), "%s/m.png", dir);
        char scale[96];
        snprintf(scale, sizeof(scale), "thumbnail,scale=%d:-1:flags=lanczos", cols * 8);
        char *argv[] = {"ffmpeg", "-y", "-loglevel", "error", "-rw_timeout", "15000000",
                        /* #451: fetch untrusted peer media, so bound ffmpeg to the
                         * protocols this path actually needs — file (temp output),
                         * http/https + tcp/tls/crypto (the fetch). Blocks the
                         * concat/hls/rtp/data/pipe demuxers a hostile URL could
                         * otherwise reach. Input option, so it precedes -i. */
                        "-protocol_whitelist", "file,crypto,tcp,tls,http,https",
                        "-i", url, "-vf", scale, "-frames:v", "1", png, NULL};
        if (run_cmd(argv, false) == 0) {
            FILE *f = fopen(png, "rb");
            if (f) {
                fseek(f, 0, SEEK_END);
                long n = ftell(f);
                rewind(f);
                if (n > 0 && n < 8L * 1024 * 1024) {
                    unsigned char *buf = malloc((size_t)n);
                    if (buf && fread(buf, 1, (size_t)n, f) == (size_t)n) {
                        char *mem = NULL;
                        size_t mem_len = 0;
                        FILE *ms = open_memstream(&mem, &mem_len);
                        if (ms) {
                            ok = (proto == MEDIA_PROTO_KITTY)
                                     ? media_emit_kitty(buf, (size_t)n, cols, rows, ms)
                                     : media_emit_iterm2(buf, (size_t)n, cols, rows, ms);
                            fclose(ms);
                            if (ok) { payload = mem; payload_len = mem_len; }
                            else free(mem);
                        }
                    }
                    free(buf);
                }
                fclose(f);
            }
            unlink(png);
        }
    } else {
        /* Sixel and character art both want pixels. Two source rows per
         * cell row: sixel draws at pixel resolution, and the art renderer
         * packs two pixels into one cell as a half block. */
        int px_w = cols, px_h = rows * 2;
        if (proto == MEDIA_PROTO_SIXEL) { px_w = cols * 6; px_h = rows * 12; }
        char raw[PATH_MAX];
        snprintf(raw, sizeof(raw), "%s/m.rgb", dir);
        /* An animated clip asks ffmpeg for a STREAM of frames at a fixed
         * rate instead of one representative frame. Same scale and pad,
         * so a frame of an animation is byte-identical in shape to the
         * still it would otherwise have been — everything downstream
         * indexes it the same way. */
        char scale[224];
        char frames_arg[16];
        const char *head = timed   ? MEDIA_ANIM_FPS_FILTER      /* video: resample to a known rate */
                           : animate ? ""           /* image: whatever frames it has */
                                     : "thumbnail,"; /* one representative frame */
        snprintf(scale, sizeof(scale),
                 "%sscale=%d:%d:force_original_aspect_ratio=decrease:flags=lanczos,"
                 "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,format=rgb24",
                 head, px_w, px_h, px_w, px_h);
        snprintf(frames_arg, sizeof(frames_arg), "%d", want_frames);
        char *argv[] = {"ffmpeg", "-y", "-loglevel", "error", "-rw_timeout", "15000000",
                        /* #451: fetch untrusted peer media, so bound ffmpeg to the
                         * protocols this path actually needs — file (temp output),
                         * http/https + tcp/tls/crypto (the fetch). Blocks the
                         * concat/hls/rtp/data/pipe demuxers a hostile URL could
                         * otherwise reach. Input option, so it precedes -i. */
                        "-protocol_whitelist", "file,crypto,tcp,tls,http,https",
                        "-i", url, "-vf", scale, "-frames:v", frames_arg,
                        /* passthrough: without it ffmpeg may resample an
                         * image sequence to a default rate, which for a
                         * single-frame input means dropping it entirely. */
                        "-fps_mode", "passthrough",
                        "-f", "rawvideo", "-pix_fmt", "rgb24", raw, NULL};
        if (run_cmd(argv, false) == 0) {
            size_t one = (size_t)px_w * (size_t)px_h * 3;
            size_t want = one * (size_t)want_frames;
            unsigned char *buf = malloc(want);
            FILE *f = buf ? fopen(raw, "rb") : NULL;
            if (f) {
                /* Short is normal: a two-second GIF asked for 64 frames
                 * yields what it has. Whole frames only — a partial one
                 * would render as a band of garbage at the bottom. */
                size_t got = buf ? fread(buf, 1, want, f) : 0;
                size_t whole = one ? got / one : 0;
                if (whole > 0) {
                    frames = whole;
                    if (proto == MEDIA_PROTO_SIXEL) {
                        /* Sixel is a still: it gets the first frame. */
                        char *mem = NULL;
                        size_t mem_len = 0;
                        FILE *ms = open_memstream(&mem, &mem_len);
                        if (ms) {
                            ok = media_emit_sixel(buf, px_w, px_h, ms);
                            fclose(ms);
                            if (ok) { payload = mem; payload_len = mem_len; }
                            else free(mem);
                        }
                        free(buf);
                        buf = NULL;
                    } else {
                        rgb = buf;
                        buf = NULL;
                        ok = true;
                    }
                }
                fclose(f);
            }
            free(buf);
            unlink(raw);
        }
    }
    rmdir(dir);

    pthread_mutex_lock(&app->lock);
    m = (slot == MEDIA_SLOT_PREVIEW) ? &app->preview : &app->media[slot];
    /* The slot may have been recycled while ffmpeg ran; publishing then
     * would attach this picture to a different message. */
    if (strcmp(m->url, url) == 0 && m->state == IM_FETCHING) {
        m->payload = payload;
        m->payload_len = payload_len;
        m->rgb = rgb;
        m->frame_count = rgb ? frames : 1;
        m->frame = 0;
        m->frame_ms = 1000 / MEDIA_ANIM_FPS;
        m->next_frame_ms = 0;
        m->state = ok ? IM_READY : IM_FAILED;
        m->drawn = false;
    } else {
        free(payload);
        free(rgb);
    }
    pthread_mutex_unlock(&app->lock);
}


/* Full-screen preview. `force_ascii` bypasses any graphics protocol and
 * renders character art — the `/preview-ascii` path. */
/* ── Full-screen preview, decoded off the UI thread ────────────────────
 *
 * The old preview ran ffmpeg inline: `/preview` froze the whole client
 * for as long as the fetch and decode took, which on a large image over a
 * slow link is seconds of a dead terminal. It reused the same modal
 * takeover for the display, so the two were welded together.
 *
 * They are split now. `request_preview` claims a slot sized to the screen
 * and hands the decode to the worker — the client keeps drawing, chat
 * keeps arriving, input keeps working. The event loop notices when the
 * slot is ready and only THEN takes the screen over.
 *
 * chafa is no longer used: with a dithered sixel encoder and the
 * half-block renderer in-tree there is no reason to keep a second,
 * differently-tuned path that may or may not be installed. */
static void request_preview(struct app *app, const char *url, bool is_video, bool force_ascii) {
    int rows_avail = LINES > 4 ? LINES - 3 : 1;
    int cols_avail = COLS > 4 ? COLS - 2 : 1;

    pthread_mutex_lock(&app->lock);
    /* Reuse the dedicated preview slot rather than competing with the
     * inline pool, so opening a preview never evicts an image that is on
     * screen. */
    struct inline_media *m = &app->preview;
    media_slot_reset(m);
    snprintf(m->url, sizeof(m->url), "%s", url);
    m->is_video = is_video;
    m->force_ascii = force_ascii;
    /* Aspect is unknown until decode; ffmpeg letterboxes into this box. */
    m->cols = cols_avail;
    m->rows = rows_avail;
    m->state = IM_FETCHING;
    app->preview_pending = true;
    pthread_mutex_unlock(&app->lock);

    struct job job = {.kind = JOB_MEDIA};
    snprintf(job.arg1, sizeof(job.arg1), "%d", MEDIA_SLOT_PREVIEW);
    enqueue_job(app, job);
    log_line(app, "preparing preview of %.60s%s", url, force_ascii ? " (ascii)" : "");
}

/* Display an already-decoded preview. Runs on the UI thread — it owns the
 * screen — but does no fetching, so the takeover is brief. */
/* Play a decoded clip full-screen until a key is pressed.
 *
 * The frame clock IS the terminal's read timeout: VTIME=1 is a 100ms
 * idle window, so a read that returns nothing is both "no key yet" and
 * "next frame due" — 10fps, the rate the frames were decoded at, with no
 * sleep to drift against and no second timer to keep in step.
 *
 * Everything is written to stdout directly, outside curses, exactly as
 * the still preview does: this runs after endwin(). */
static void preview_play(const unsigned char *rgb, int cols, int rows, size_t frames,
                         const char *url, int term_rows, int term_cols) {
    struct termios old_tio, raw;
    bool raw_ok = tcgetattr(STDIN_FILENO, &old_tio) == 0;
    if (raw_ok) {
        raw = old_tio;
        cfmakeraw(&raw);
        raw.c_cc[VMIN] = 0;
        raw.c_cc[VTIME] = 1; /* 100ms */
        tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    }
    unsigned char c;
    /* Drain the terminal's replies to the graphics capability probes, or
     * the first frame would be dismissed by a byte the terminal sent. */
    if (raw_ok) while (read(STDIN_FILENO, &c, 1) > 0) {}

    int depth = termcolor_detect_depth();
    size_t stride = (size_t)cols * (size_t)(rows * 2) * 3;
    int url_w = term_cols - 10;
    if (url_w < 0) url_w = 0;
    size_t f = 0;
    for (;;) {
        fputs("\033[H", stdout);
        printf("preview: %.*s\r\n", url_w, url);
        termcolor_render_rgb(rgb + f * stride, cols, rows * 2, depth, stdout);
        printf("\033[%d;1H[ playing %zu frames — press any key to return ]", term_rows, frames);
        fflush(stdout);
        if (!raw_ok) { getchar(); break; }
        if (read(STDIN_FILENO, &c, 1) > 0) break;
        f = (f + 1) % frames;
    }
    if (raw_ok) tcsetattr(STDIN_FILENO, TCSANOW, &old_tio);
}

static void show_preview(struct app *app) {
    char url[MAX_LINE];
    bool is_video, ok;
    char *payload = NULL;
    size_t payload_len = 0;
    unsigned char *rgb = NULL;
    int cols, rows;

    pthread_mutex_lock(&app->lock);
    struct inline_media *m = &app->preview;
    snprintf(url, sizeof(url), "%s", m->url);
    is_video = m->is_video;
    ok = (m->state == IM_READY);
    /* Take ownership of the buffers so the modal can run without the
     * lock and without the worker recycling them underneath it. */
    payload = m->payload;
    payload_len = m->payload_len;
    rgb = m->rgb;
    cols = m->cols;
    rows = m->rows;
    size_t frame_count = m->frame_count;
    m->payload = NULL;
    m->rgb = NULL;
    m->state = IM_IDLE;
    app->preview_pending = false;
    pthread_mutex_unlock(&app->lock);

    if (!ok) {
        log_line(app, "preview: could not decode %.60s — /open to view externally", url);
        free(payload);
        free(rgb);
        return;
    }

    struct winsize ws = {0};
    int term_rows = LINES, term_cols = COLS;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == 0 && ws.ws_row > 2 && ws.ws_col > 0) {
        term_rows = ws.ws_row;
        term_cols = ws.ws_col;
    }

    /* Suspend curses WITHOUT leaving the alternate screen.
     *
     * endwin() was the obvious call and the wrong one: it emits rmcup, so
     * everything below — the image, the art, the "press any key" line —
     * was written onto the user's NORMAL screen, under the shell they
     * started shottino from. It is still there when they quit, and every
     * preview adds another one. reset_shell_mode() restores the tty modes
     * endwin() would have restored and stops there, so the preview draws
     * over the alternate screen, where it belongs: the repaint below
     * erases it, and quitting takes the whole screen with it.
     *
     * (Verified against ncurses rather than assumed: endwin() emits
     * \033[?1049l, reset_shell_mode() does not.) */
    def_prog_mode();
    reset_shell_mode();
    mouse_reporting(false);
    fputs("\033[2J\033[H", stdout);
    int url_w = term_cols - 10;
    if (url_w < 0) url_w = 0;
    printf("preview: %.*s\r\n", url_w, url);
    fflush(stdout);

    if (rgb && frame_count > 1) {
        /* A clip: play it rather than freezing on one frame. */
        preview_play(rgb, cols, rows, frame_count, url, term_rows, term_cols);
    } else {
        const char *how;
        if (payload) {
            fwrite(payload, 1, payload_len, stdout);
            how = "image";
        } else {
            termcolor_render_rgb(rgb, cols, rows * 2, termcolor_detect_depth(), stdout);
            how = termcolor_detect_depth() == TERM_COLOR_NONE ? "ascii" : "colour ascii";
        }
        fflush(stdout);

        printf("\033[%d;1H[ %s%s — press any key to return ]", term_rows,
               is_video ? "video frame, " : "", how);
        fflush(stdout);
        wait_for_dismiss_key();
    }

    /* The preview's own placement has to go, or it floats over the chat
     * repaint underneath (a no-op on terminals without the protocol). The
     * inline pictures go with it — they are placements too, and the
     * escape cannot spare them — so they are marked undrawn and the next
     * frame puts back the ones that are actually on screen. */
    pthread_mutex_lock(&app->lock);
    media_placements_drop_locked(app);
    pthread_mutex_unlock(&app->lock);

    free(payload);
    free(rgb);

    reset_prog_mode();
    clearok(stdscr, TRUE);
    refresh();
    mouse_apply(app);
}


static void show_help(struct app *app) {
    log_line(app, "commands: /help /archive /settings /admin /chat /exit /quit /window N [/w N, /win N] /join #chan [/j] /part /close /clear /msg nick text /query nick [/q nick] /me text");
    log_line(app, "network: /connect slug /disconnect [slug] [reason] /nick nick /away [reason] /umode +modes /mode [#chan] +modes [params]");
    log_line(app, "info: /topic [text|-delete] /members [/users] /whois nick /whowas nick /who [#chan] /names [#chan] /lusers /list [-refresh|query] /links /motd /info /version /stats [q] /rehash [opt]");
    log_line(app, "ops: /op nicks /deop nicks /voice nicks /devoice nicks /kick nick [reason] /kb nick [reason] /ban mask /unban mask /banlist /invite nick");
    log_line(app, "watch: /notify [nick...|del nick|list] watches PEOPLE; /hilight pattern, /dehilight pattern watch WORDS (/watch add|del|list is the older spelling)");
    log_line(app, "services: /cs /ns /ms /os /hs /rs [command] — bare form sends HELP; aliases: /alias name expansion ($1..$9, $*), /unalias name, bare /alias lists");
    log_line(app, "files: /upload <path> — post a local file and share its link (IRC stays text; the link is clickable)");
    log_line(app, "terminal: mouse tracking is ON by default (click links, right-click a message, wheel over the userlist); hold Shift to select text as usual, or /mouse off to give selection back unconditionally");
    log_line(app, "media: images render INLINE when the terminal supports it (kitty/iTerm2/sixel) or as colour art otherwise; video and GIFs PLAY as colour art (/media still for one frame)");
    log_line(app, "       /media [on|off|all|first-party] — ON for ALL hosts by default (off entirely without ffmpeg): every image link is fetched when it scrolls into view, so the host learns your IP; /media first-party limits it to this deployment's uploads");
    log_line(app, "       /preview [url] full-screen here; bare /preview picks from the last 20 pictures and clips in this window; /preview-ascii forces the art renderer");
    log_line(app, "       /view [url] downloads it and opens your desktop's viewer for that file type (bare /view offers the same list); /open hands a URL to the browser");
    log_line(app, "reply: right-click a message for reply/query, or Ctrl-R for the last 20 messages here — type to search the whole window buffer, Enter replies");
    log_line(app, "userlist: Ctrl-U gives it the arrow keys (Up/Down/PgUp/PgDn/Home/End, Esc back to chat); Ctrl-Shift-Up/Down and Shift-PgUp/PgDn work where the terminal does not keep them; the wheel scrolls it with /mouse on");
    log_line(app, "panes: /split (stacked) /splitv (side by side) /unsplit; Ctrl-Alt-Up/Down or Ctrl-Alt-Tab switch, Ctrl-Alt-+/- resize, /keys shows what your terminal sends");
    log_line(app, "raw/media: /quote line /oper name password /open last-url; keys: PgUp/PgDn scroll, End bottom, Tab complete, Up/Down history, Ctrl-N/Ctrl-P window cycle");
}

static void show_command_help(struct app *app, const char *raw) {
    while (*raw == ' ') raw++;
    const char *cmd = raw[0] == '/' ? raw + 1 : raw;
    if (!*cmd) {
        show_help(app);
        return;
    }
    if (strcmp(cmd, "quit") == 0) log_line(app, "/quit — terminate the grappa session, delete saved token, and exit Shottino");
    else if (strcmp(cmd, "exit") == 0) log_line(app, "/exit — close Shottino only; grappa stays connected and token remains for reattach");
    else if (strcmp(cmd, "window") == 0 || strcmp(cmd, "win") == 0 || strcmp(cmd, "w") == 0) log_line(app, "/window N, /win N, /w N — switch to window number N and clear its unread count");
    else if (strcmp(cmd, "join") == 0 || strcmp(cmd, "j") == 0) log_line(app, "/join #chan [key], /j #chan [key] — join a channel");
    else if (strcmp(cmd, "part") == 0) log_line(app, "/part — part the current channel");
    else if (strcmp(cmd, "close") == 0) log_line(app, "/close — close current channel/query; channels PART, queries close the query window");
    else if (strcmp(cmd, "clear") == 0) log_line(app, "/clear — clear the local visible buffer for the active window; does not delete server scrollback");
    else if (strcmp(cmd, "msg") == 0) log_line(app, "/msg nick text — send a private message and open/reuse the query window");
    else if (strcmp(cmd, "query") == 0 || strcmp(cmd, "q") == 0) log_line(app, "/query nick, /q nick — open a query window without sending a message");
    else if (strcmp(cmd, "me") == 0) log_line(app, "/me text — send an ACTION (/me) message to the current window");
    else if (strcmp(cmd, "topic") == 0) log_line(app, "/topic [text|-delete] — set or clear the current channel topic; bare /topic requests a snapshot");
    else if (strcmp(cmd, "members") == 0 || strcmp(cmd, "users") == 0) log_line(app, "/members, /users — list known members for the current channel");
    else if (strcmp(cmd, "nick") == 0) log_line(app, "/nick nick — request an IRC nick change on the current network");
    else if (strcmp(cmd, "away") == 0) log_line(app, "/away [reason] — set away with reason; bare /away returns present");
    else if (strcmp(cmd, "connect") == 0) log_line(app, "/connect network — mark a parked network connected so grappa can spawn it");
    else if (strcmp(cmd, "disconnect") == 0) log_line(app, "/disconnect [network] [reason] — park a network while keeping Shottino running");
    else if (strcmp(cmd, "whois") == 0) log_line(app, "/whois nick — request WHOIS for nick");
    else if (strcmp(cmd, "whowas") == 0) log_line(app, "/whowas nick — request WHOWAS for nick");
    else if (strcmp(cmd, "who") == 0) log_line(app, "/who [#chan] — request WHO for target/current channel");
    else if (strcmp(cmd, "names") == 0) log_line(app, "/names [#chan] — request NAMES for target/current channel");
    else if (strcmp(cmd, "lusers") == 0) log_line(app, "/lusers — request IRC network user/server counts");
    else if (strcmp(cmd, "watch") == 0 || strcmp(cmd, "highlight") == 0) log_line(app, "/watch add|del|list pattern — manage highlight watchlist");
    else if (strcmp(cmd, "op") == 0 || strcmp(cmd, "deop") == 0 || strcmp(cmd, "voice") == 0 || strcmp(cmd, "devoice") == 0) log_line(app, "/%s nick [nick...] — change channel privileges", cmd);
    else if (strcmp(cmd, "kick") == 0) log_line(app, "/kick nick [reason] — kick nick from the current channel");
    else if (strcmp(cmd, "ban") == 0 || strcmp(cmd, "unban") == 0) log_line(app, "/%s mask — set or remove a channel ban mask", cmd);
    else if (strcmp(cmd, "banlist") == 0) log_line(app, "/banlist — request current channel ban list");
    else if (strcmp(cmd, "invite") == 0) log_line(app, "/invite nick — invite nick to the current channel");
    else if (strcmp(cmd, "quote") == 0) log_line(app, "/quote raw-line — send a raw IRC line through grappa");
    else if (strcmp(cmd, "oper") == 0) log_line(app, "/oper name password — send IRC OPER credentials; password is not logged");
    else if (strcmp(cmd, "open") == 0) log_line(app, "/open — open the most recent URL using xdg-open (the browser: the handler comes from the scheme)");
    else if (strcmp(cmd, "view") == 0) log_line(app, "/view [url] — download it and open the desktop viewer for that file TYPE; bare /view offers the last 20 pictures and clips posted in this window");
    else if (strcmp(cmd, "preview") == 0) log_line(app, "/preview [url] — render it full-screen in the terminal; bare /preview offers the last 20 pictures and clips posted in this window");
    else if (strcmp(cmd, "share") == 0) log_line(app, "/share — (visitor only) mint a session-share link; open it on another device to attach it to this same session");
    else if (strcmp(cmd, "archive") == 0 || strcmp(cmd, "settings") == 0 || strcmp(cmd, "admin") == 0 || strcmp(cmd, "chat") == 0) log_line(app, "/%s — switch to the %s panel", cmd, cmd);
    else if (strcmp(cmd, "help") == 0) log_line(app, "/help [command] — bare /help lists every command by group; /help command explains one");
    else if (strcmp(cmd, "kb") == 0 || strcmp(cmd, "kickban") == 0) log_line(app, "/kb nick [reason], /kickban nick [reason] — ban nick!*@* and then kick; the ban lands first so the kick cannot be outrun by a rejoin");
    else if (strcmp(cmd, "mode") == 0) log_line(app, "/mode [#chan] +modes [params] — change channel modes; without a channel it applies to the current one, and bare /mode requests the current modes");
    else if (strcmp(cmd, "umode") == 0) log_line(app, "/umode +modes — change your own user modes on the current network");
    else if (strcmp(cmd, "list") == 0) log_line(app, "/list [query|-refresh] — search this network's channel directory; -refresh asks grappa to rescan it");
    else if (strcmp(cmd, "links") == 0) log_line(app, "/links — request the network's server map");
    else if (strcmp(cmd, "motd") == 0) log_line(app, "/motd — request the server's message of the day");
    else if (strcmp(cmd, "info") == 0) log_line(app, "/info — request the server's INFO text");
    else if (strcmp(cmd, "version") == 0) log_line(app, "/version — request the IRC server's version (Shottino's own is in /settings)");
    else if (strcmp(cmd, "stats") == 0) log_line(app, "/stats [letter] — request server statistics; most servers want a letter, e.g. /stats q");
    else if (strcmp(cmd, "rehash") == 0) log_line(app, "/rehash [option] — ask the server to reload its configuration; operators only");
    else if (strcmp(cmd, "notify") == 0) log_line(app, "/notify [nick...|del nick|list] — watch PEOPLE; bare /notify lists the watched nicks with their presence");
    else if (strcmp(cmd, "hilight") == 0 || strcmp(cmd, "dehilight") == 0) log_line(app, "/hilight pattern, /dehilight pattern — watch WORDS: add or remove a highlight pattern (/watch add|del|list is the older spelling)");
    else if (strcmp(cmd, "alias") == 0) log_line(app, "/alias name expansion — define a command ($1..$9 positional, $* all arguments, neither appends them); bare /alias lists what is defined. An alias may shadow a built-in");
    else if (strcmp(cmd, "unalias") == 0) log_line(app, "/unalias name — remove a user-defined alias");
    else if (strcmp(cmd, "media") == 0) log_line(app, "/media [on|off|all|first-party|anim|still] — inline pictures, ON for ALL hosts by default: every image link is fetched when it scrolls into view, so the host learns your IP");
    else if (strcmp(cmd, "mouse") == 0) log_line(app, "/mouse [on|off] — mouse tracking; bare /mouse toggles, off gives text selection back unconditionally");
    else if (strcmp(cmd, "keys") == 0) log_line(app, "/keys — echo key codes as you press them, to see what your terminal actually sends; /keys again stops");
    else if (strcmp(cmd, "split") == 0 || strcmp(cmd, "splith") == 0) log_line(app, "/split, /splith — split the chat area into stacked panes; Ctrl-Alt-Up/Down switches, Ctrl-Alt-+/- resizes");
    else if (strcmp(cmd, "splitv") == 0 || strcmp(cmd, "splitw") == 0) log_line(app, "/splitv, /splitw — split the chat area side by side; both spellings do the same thing");
    else if (strcmp(cmd, "unsplit") == 0) log_line(app, "/unsplit — close the split and give the whole chat area back to one window");
    else if (strcmp(cmd, "upload") == 0) log_line(app, "/upload path — post a local file and share its link; IRC stays text, the link is clickable");
    else if (strcmp(cmd, "cs") == 0 || strcmp(cmd, "ns") == 0 || strcmp(cmd, "ms") == 0 || strcmp(cmd, "os") == 0 || strcmp(cmd, "hs") == 0 || strcmp(cmd, "rs") == 0) log_line(app, "/%s [command] — send a private message to this network's service; the bare form sends HELP", cmd);
    else log_line(app, "no help for /%s; use /help for the command list", cmd);
}

// Visitor session-sharing — mint side. POST /me/share-token (visitor-only;
// the server 403s a registered user) returns {token, expires_at}. We wrap the
// token in `<base>/share/<token>` — the URL the other device feeds to
// /share/<token> (consume) to land on this same session.
static void mint_share_link(struct app *app) {
    struct http_response r = http_request(app, "POST", "/me/share-token", NULL);
    if (r.status == 403) {
        log_line(app, "/share: solo le sessioni visitor possono generare un link di condivisione");
        free(r.body);
        return;
    }
    if (r.status < 200 || r.status >= 300) {
        log_line(app, "/share failed HTTP %d: %.200s", r.status, r.body ? r.body : "");
        free(r.body);
        return;
    }
    char token[MAX_TOKEN];
    char expires[64] = "";
    if (!json_top_string(r.body, r.body_len, "token", token, sizeof(token))) {
        log_line(app, "/share: response missing token");
        free(r.body);
        return;
    }
    json_top_string(r.body, r.body_len, "expires_at", expires, sizeof(expires));
    free(r.body);
    char *enc = url_encode(token);
    snprintf(app->last_url, sizeof(app->last_url), "%s/share/%s", app->url.base, enc);
    if (expires[0]) log_line(app, "share link (scade %s): %s", expires, app->last_url);
    else log_line(app, "share link: %s", app->last_url);
    log_line(app, "  aprilo sull'altro dispositivo, o /open per lanciarlo");
    free(enc);
}

static void handle_command_dispatch(struct app *app, char *line);

/* ── /upload ───────────────────────────────────────────────────────────
 *
 * Posts a local file to grappa's upload surface and sends the resulting
 * URL to the current window as TEXT. That is the whole model: IRC stays
 * text, the URL is a clickable link, and the 📸 prefix matches what
 * cicchetto ships so the two clients produce identical wire bytes.
 * Nothing is rendered inline in scrollback. */
/* Declared MIME per extension.
 *
 * The server validates against a CLOSED allowlist
 * (`UploadsController.@mime_categories`) and trusts what we declare, so
 * this table must mirror it: a type it does not list is a 415, and a type
 * we mislabel is a 415 the user cannot act on. Kept in the same order as
 * the server's map so the two can be diffed.
 *
 * Deliberately ABSENT: ogg and opus. The server does not accept them
 * (Safari support is patchy, so they were left out on purpose) and
 * claiming a MIME it will reject only converts a clear local message into
 * a confusing server error. */
static const char *mime_for_path(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return NULL;
    static const struct { const char *ext; const char *mime; } table[] = {
        /* image */
        {"png", "image/png"},   {"jpg", "image/jpeg"},  {"jpeg", "image/jpeg"},
        {"gif", "image/gif"},   {"webp", "image/webp"}, {"apng", "image/apng"},
        /* video */
        {"mp4", "video/mp4"},   {"mov", "video/quicktime"}, {"webm", "video/webm"},
        /* document */
        {"pdf", "application/pdf"}, {"txt", "text/plain"},
        {"odt", "application/vnd.oasis.opendocument.text"},
        {"ods", "application/vnd.oasis.opendocument.spreadsheet"},
        {"docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
        {"xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
        /* audio */
        {"mp3", "audio/mpeg"},  {"m4a", "audio/mp4"},   {"m4r", "audio/mp4"},
        {"aac", "audio/aac"},   {"wav", "audio/wav"},   {"flac", "audio/flac"},
    };
    for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++)
        if (strcasecmp(dot + 1, table[i].ext) == 0) return table[i].mime;
    return NULL; /* unsupported — refused locally, see upload_command */
}

static void upload_command(struct app *app, const char *path) {
    while (*path == ' ') path++;
    if (!*path) {
        log_line(app, "/upload requires a file path");
        return;
    }
    /* Refuse an unsupported type HERE. The server would answer 415, and
     * "HTTP 415" tells the user nothing about which types it takes. */
    const char *mime = mime_for_path(path);
    if (!mime) {
        log_line(app, "/upload: unsupported file type — images (png jpg gif webp apng), "
                      "video (mp4 mov webm), audio (mp3 m4a aac wav flac), "
                      "documents (pdf txt odt ods docx xlsx)");
        return;
    }
    /* Same read-only rule as a typed message: the link would be posted to
     * the current window, and $server rejects a PRIVMSG. */
    char up_net[MAX_SLUG], up_chan[MAX_CHANNEL];
    if (!current_window_key(app, up_net, sizeof(up_net), up_chan, sizeof(up_chan)) ||
        is_server_window(up_chan)) {
        log_line(app, "/upload: the server window is read-only — switch to a channel or query first");
        return;
    }
    FILE *f = fopen(path, "rb");
    if (!f) {
        log_line(app, "/upload: cannot open %s", path);
        return;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        log_line(app, "/upload: cannot size %s", path);
        return;
    }
    long size = ftell(f);
    rewind(f);
    /* Bounded so a mistyped path at a huge file cannot exhaust memory
     * before the server's cap ever sees it. */
    if (size < 0 || size > 64L * 1024 * 1024) {
        fclose(f);
        log_line(app, "/upload: %s is too large (%ld bytes)", path, size);
        return;
    }
    char *data = malloc((size_t)size);
    if (!data) {
        fclose(f);
        log_line(app, "/upload: out of memory");
        return;
    }
    size_t got = fread(data, 1, (size_t)size, f);
    fclose(f);
    if (got != (size_t)size) {
        free(data);
        log_line(app, "/upload: short read on %s", path);
        return;
    }

    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    const char *boundary = "----shottino7RcH2mQx";
    char *head = xasprintf("--%s\r\n"
                           "Content-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
                           "Content-Type: %s\r\n\r\n",
                           boundary, base, mime);
    char *tail = xasprintf("\r\n--%s--\r\n", boundary);
    size_t hlen = strlen(head), tlen = strlen(tail);
    size_t total = hlen + got + tlen;
    char *body = malloc(total);
    if (!body) {
        free(head); free(tail); free(data);
        log_line(app, "/upload: out of memory");
        return;
    }
    memcpy(body, head, hlen);
    memcpy(body + hlen, data, got);
    memcpy(body + hlen + got, tail, tlen);
    free(head);
    free(tail);
    free(data);

    char ctype[128];
    snprintf(ctype, sizeof(ctype), "multipart/form-data; boundary=%s", boundary);
    log_line(app, "uploading %s (%ld bytes)...", base, size);
    struct http_response r = http_request_raw(app, "POST", "/api/uploads", body, total, ctype);
    free(body);

    if (r.status < 200 || r.status >= 300) {
        log_line(app, "/upload failed HTTP %d: %.200s", r.status, r.body ? r.body : "");
        free(r.body);
        return;
    }
    char url[MAX_LINE] = "";
    if (!json_top_string(r.body, r.body_len, "url", url, sizeof(url)) || !url[0]) {
        log_line(app, "/upload: response missing url");
        free(r.body);
        return;
    }
    free(r.body);

    /* The server may answer with a path rather than an absolute URL;
     * make it absolute so the link is clickable from any client.
     *
     * Sized for base + url + the marker so no spelling of either can be
     * truncated: a cut URL is not a shorter link, it is a dead one, and
     * the row would look perfectly ordinary in scrollback. */
    char message[sizeof(app->url.base) + MAX_LINE + 8];
    if (strncmp(url, "http://", 7) == 0 || strncmp(url, "https://", 8) == 0)
        snprintf(message, sizeof(message), "📸 %s", url);
    else
        snprintf(message, sizeof(message), "📸 %s%s", app->url.base, url);

    add_pending_echo(app, up_net, up_chan, own_nick_for_network(app, up_net), message);
    enqueue_send(app, up_net, up_chan, message);
}

/* ── /archive open|purge ───────────────────────────────────────────────
 * `open` re-opens an archived window locally and pulls its scrollback
 * back; `purge` is the DESTRUCTIVE delete of that target's history and
 * requires the target to be named explicitly — there is deliberately no
 * "purge everything" form. */
static void archive_command(struct app *app, const char *rest) {
    while (*rest == ' ') rest++;
    char net_buf[MAX_SLUG];
    current_window_key(app, net_buf, sizeof(net_buf), NULL, 0);
    const char *network = net_buf;

    if (strncmp(rest, "open ", 5) == 0) {
        const char *target = rest + 5;
        while (*target == ' ') target++;
        if (!*target) {
            log_line(app, "/archive open requires a target");
            return;
        }
        add_window_ex(app, network, target, true);
        enqueue_fetch(app, network, target);
        log_line(app, "reopened archived window %s", target);
        return;
    }

    if (strncmp(rest, "purge ", 6) == 0) {
        const char *target = rest + 6;
        while (*target == ' ') target++;
        if (!*target) {
            log_line(app, "/archive purge requires a target");
            return;
        }
        char *slug = url_encode(network);
        char *tgt = url_encode(target);
        char *path = xasprintf("/networks/%s/archive/%s", slug, tgt);
        free(slug);
        free(tgt);
        struct http_response r = http_request(app, "DELETE", path, NULL);
        free(path);
        if (r.status >= 200 && r.status < 300) log_line(app, "purged archived scrollback for %s", target);
        else log_line(app, "/archive purge failed HTTP %d: %.200s", r.status, r.body ? r.body : "");
        free(r.body);
        return;
    }

    log_line(app, "/archive [open <target>|purge <target>]");
}

/* ── Services shortcuts ────────────────────────────────────────────────
 * /cs /ns /ms /os /hs /rs → the conventional service nicks. Keyed on the
 * first letter, which is unambiguous across the six. */
static const char *service_for_shortcut(char c) {
    switch (c) {
    case 'c': return "ChanServ";
    case 'n': return "NickServ";
    case 'm': return "MemoServ";
    case 'o': return "OperServ";
    case 'h': return "HelpServ";
    case 'r': return "RootServ";
    default:  return "NickServ";
    }
}

/* ── /notify — presence watch list ─────────────────────────────────────
 * A REST resource (GET/POST/DELETE /notify), NOT the `watchlist` push,
 * which is the separate keyword-highlight list. Sharing the irssi verb
 * names between two different server stores is a real trap: /notify
 * watches PEOPLE, /hilight watches WORDS. */
static void notify_command(struct app *app, const char *rest) {
    while (*rest == ' ') rest++;
    /* The watch list is per-network (it maps to that session's
     * MONITOR/WATCH registration upstream), so every call is scoped to
     * the active window's network. */
    char watch_net[MAX_SLUG];
    current_window_key(app, watch_net, sizeof(watch_net), NULL, 0);
    char *slug = url_encode(watch_net);
    if (!*rest || strcmp(rest, "list") == 0) {
        char *path = xasprintf("/networks/%s/notify", slug);
        struct http_response r = http_request(app, "GET", path, NULL);
        free(path);
        if (r.status < 200 || r.status >= 300) {
            log_line(app, "/notify failed HTTP %d", r.status);
        } else {
            json_doc *doc = json_parse(r.body, r.body_len, NULL, 0);
            const json_value *list = json_root(doc);
            log_line(app, "--- watched nicks (%zu)", json_len(list));
            for (size_t i = 0; i < json_len(list); i++) {
                const json_value *row = json_at(list, i);
                const char *nick = json_string(json_get(row, "nick"));
                const char *presence = json_string(json_get(row, "presence"));
                if (nick) log_line(app, "  %-20s %s", nick, presence ? presence : "unknown");
            }
            if (json_len(list) == 0) log_line(app, "  (none — /notify <nick> to add)");
            json_free(doc);
        }
        free(r.body);
        free(slug);
        return;
    }
    if (strncmp(rest, "del ", 4) == 0 || strncmp(rest, "-", 1) == 0) {
        const char *nick = rest[0] == '-' ? rest + 1 : rest + 4;
        while (*nick == ' ') nick++;
        char *enc = url_encode(nick);
        char *path = xasprintf("/networks/%s/notify/%s", slug, enc);
        free(enc);
        struct http_response r = http_request(app, "DELETE", path, NULL);
        free(path);
        if (r.status >= 200 && r.status < 300) log_line(app, "no longer watching %s", nick);
        else log_line(app, "/notify del failed HTTP %d", r.status);
        free(r.body);
        free(slug);
        return;
    }
    /* Bare nicks (possibly several) are an add. */
    char nicks_json[MAX_LINE];
    char *arr = json_array_words(rest);
    snprintf(nicks_json, sizeof(nicks_json), "{\"nicks\":%s}", arr);
    free(arr);
    char *add_path = xasprintf("/networks/%s/notify", slug);
    struct http_response r = http_request(app, "POST", add_path, nicks_json);
    free(add_path);
    if (r.status >= 200 && r.status < 300) log_line(app, "watching %s", rest);
    else log_line(app, "/notify failed HTTP %d: %.200s", r.status, r.body);
    free(r.body);
    free(slug);
}

/* ── /list — channel directory ─────────────────────────────────────────
 * A full LIST is expensive on a large network, so grappa runs it as a
 * background scan (POST .../directory/refresh) that reports progress via
 * directory_* events, and serves the result from a cached table. Bare
 * /list reads the cache; `/list -refresh` starts a new scan. */
static void directory_command(struct app *app, const char *rest) {
    while (*rest == ' ') rest++;
    char dir_net[MAX_SLUG];
    current_window_key(app, dir_net, sizeof(dir_net), NULL, 0);
    const char *network = dir_net;
    char *slug = url_encode(network);
    if (strcmp(rest, "-refresh") == 0) {
        char *path = xasprintf("/networks/%s/directory/refresh", slug);
        free(slug);
        struct http_response r = http_request(app, "POST", path, "{}");
        free(path);
        if (r.status >= 200 && r.status < 300) log_line(app, "scanning %s channel list...", network);
        else log_line(app, "/list refresh failed HTTP %d: %.200s", r.status, r.body);
        free(r.body);
        return;
    }
    char *path;
    if (*rest) {
        char *q = url_encode(rest);
        path = xasprintf("/networks/%s/directory?q=%s", slug, q);
        free(q);
    } else {
        path = xasprintf("/networks/%s/directory", slug);
    }
    free(slug);
    struct http_response r = http_request(app, "GET", path, NULL);
    free(path);
    if (r.status < 200 || r.status >= 300) {
        log_line(app, "/list failed HTTP %d: %.200s", r.status, r.body);
        free(r.body);
        return;
    }
    json_doc *doc = json_parse(r.body, r.body_len, NULL, 0);
    /* The endpoint may answer with a bare array or an envelope carrying
     * the rows plus scan metadata; accept either rather than guessing. */
    const json_value *root = json_root(doc);
    const json_value *rows = json_type_of(root) == JSON_ARRAY ? root : json_get(root, "channels");
    if (!rows) rows = json_get(root, "entries");
    size_t n = json_len(rows);
    log_line(app, "--- channel directory %s (%zu)", network, n);
    for (size_t i = 0; i < n; i++) {
        const json_value *row = json_at(rows, i);
        const char *name = json_string(json_get(row, "name"));
        const char *topic = json_string(json_get(row, "topic"));
        long users = 0;
        json_long(json_get(row, "users"), &users);
        if (name) log_line(app, "  %-28s %4ld  %.80s", name, users, topic ? topic : "");
    }
    if (n == 0) log_line(app, "  (empty — /list -refresh to scan)");
    json_free(doc);
    free(r.body);
}

/* ── User-defined aliases ──────────────────────────────────────────────
 * Grammar mirrors cicchetto's: $1..$9 positional (missing → empty), $*
 * all args, and an implicit verbatim append when the expansion holds no
 * placeholder. An alias may shadow any builtin except /alias and /unalias
 * (#427); expansion is depth-bounded so `/alias a /a` cannot spin. */
/* Alias storage + expansion live in alias.[ch] — pure, and tested there.
 * These wrappers only add the app lock and the user-facing log lines. */

static void alias_command(struct app *app, const char *rest) {
    while (*rest == ' ') rest++;
    if (!*rest) {
        pthread_mutex_lock(&app->lock);
        size_t count = app->aliases.count;
        log_line(app, "--- aliases (%zu)", count);
        for (size_t i = 0; i < count; i++)
            log_line(app, "  /%-12s %s", app->aliases.entries[i].name,
                     app->aliases.entries[i].expansion);
        pthread_mutex_unlock(&app->lock);
        if (count == 0) log_line(app, "  (none — /alias <name> <expansion>)");
        return;
    }
    const char *sp = strchr(rest, ' ');
    if (!sp) {
        log_line(app, "/alias requires <name> <expansion>");
        return;
    }
    char name[ALIAS_MAX_NAME];
    size_t nlen = (size_t)(sp - rest);
    if (nlen >= sizeof(name)) nlen = sizeof(name) - 1;
    memcpy(name, rest, nlen);
    name[nlen] = '\0';
    const char *expansion = sp + 1;
    while (*expansion == ' ') expansion++;

    pthread_mutex_lock(&app->lock);
    alias_set_result res = alias_set(&app->aliases, name, expansion);
    pthread_mutex_unlock(&app->lock);
    switch (res) {
    case ALIAS_SET_OK:
        log_line(app, "alias /%s = %s", name, expansion);
        break;
    case ALIAS_SET_NON_SHADOWABLE:
        log_line(app, "/alias: /%s can't be aliased — it's needed to manage aliases", name);
        break;
    case ALIAS_SET_FULL:
        log_line(app, "/alias: table full (%d)", ALIAS_MAX_ENTRIES);
        break;
    case ALIAS_SET_INVALID:
        log_line(app, "/alias requires <name> <expansion>");
        break;
    }
}

static void alias_remove(struct app *app, const char *name) {
    while (*name == ' ') name++;
    pthread_mutex_lock(&app->lock);
    bool found = alias_unset(&app->aliases, name);
    pthread_mutex_unlock(&app->lock);
    if (found) log_line(app, "alias /%s removed", name);
    else log_line(app, "/unalias: no such alias: %s", name);
}

static void handle_command(struct app *app, const char *input) {
    /* Alias expansion happens BEFORE dispatch, so an expanded alias flows
     * through the ordinary command path and cannot reach a second, parallel
     * implementation. Bounded so a self-referential alias terminates.
     *
     * Works on a LOCAL copy: internal callers pass string literals
     * (`handle_command(app, "/close")`), and the dispatcher itself splits
     * arguments in place with `*sp = 0`. Writing through to the caller's
     * buffer would be undefined behaviour for those. */
    char line[MAX_LINE];
    pthread_mutex_lock(&app->lock);
    alias_expand(&app->aliases, input, line, sizeof(line));
    pthread_mutex_unlock(&app->lock);
    handle_command_dispatch(app, line);
}

static void handle_command_dispatch(struct app *app, char *line) {
    if (strcmp(line, "/quit") == 0) {
        logout_grappa(app);
        app->running = false;
    } else if (strcmp(line, "/exit") == 0) {
        app->running = false;
    } else if (strcmp(line, "/help") == 0) {
        show_help(app);
    } else if (strncmp(line, "/help ", 6) == 0) {
        show_command_help(app, line + 6);
    } else if (strncmp(line, "/mouse", 6) == 0 && (line[6] == ' ' || line[6] == '\0')) {
        /* Mouse tracking and the terminal's own text selection are mutually
         * exclusive — while shottino is tracking, the terminal forwards
         * button/motion events here instead of selecting. Shift-drag
         * overrides tracking in most terminals, but that is a workaround,
         * not a setting, so this makes the trade explicit and switchable. */
        const char *rest = line + 6;
        while (*rest == ' ') rest++;
        bool want = app->mouse_enabled;
        if (!*rest) want = !app->mouse_enabled;
        else if (strcmp(rest, "on") == 0) want = true;
        else if (strcmp(rest, "off") == 0) want = false;
        else {
            log_line(app, "/mouse [on|off] — bare /mouse toggles");
            return;
        }
        app->mouse_enabled = want;
        mouse_apply(app);
        if (want)
            log_line(app, "mouse tracking ON — click media links to preview; "
                          "terminal text selection is suppressed (Shift-drag usually still works)");
        else
            log_line(app, "mouse tracking OFF — select and copy with the mouse as usual; "
                          "click-to-preview is disabled until /mouse on");
    } else if (strcmp(line, "/chat") == 0) {
        pthread_mutex_lock(&app->lock);
        app->panel = PANEL_CHAT;
        pthread_mutex_unlock(&app->lock);
    } else if (strcmp(line, "/archive") == 0) {
        open_panel(app, PANEL_ARCHIVE);
    } else if (strncmp(line, "/archive ", 9) == 0) {
        archive_command(app, line + 9);
    } else if (strcmp(line, "/settings") == 0) {
        open_panel(app, PANEL_SETTINGS);
    } else if (strcmp(line, "/admin") == 0) {
        open_panel(app, PANEL_ADMIN);
    } else if (strcmp(line, "/share") == 0) {
        mint_share_link(app);
    } else if (strcmp(line, "/keys") == 0) {
        /* Debugging tools are infrastructure: which escape sequence your
         * terminal sends for Ctrl-Alt-+ is not something to guess at
         * across a bug report. */
        app->key_echo = !app->key_echo;
        log_line(app, "key echo %s — press keys to see their codes; /keys again to stop",
                 app->key_echo ? "ON" : "OFF");
    } else if (strcmp(line, "/split") == 0 || strcmp(line, "/splith") == 0) {
        split_pane(app, SPLIT_ROWS);
    } else if (strcmp(line, "/splitv") == 0 || strcmp(line, "/splitw") == 0) {
        /* Both spellings: /splitv reads as "vertical" and /splitw as
         * "width", and both were asked for. Same door either way. */
        split_pane(app, SPLIT_COLS);
    } else if (strcmp(line, "/unsplit") == 0) {
        unsplit_pane(app);
    } else if (strcmp(line, "/media") == 0 || strncmp(line, "/media ", 7) == 0) {
        const char *rest = line[6] ? line + 7 : "";
        while (*rest == ' ') rest++;
        if (!*rest) app->inline_media_enabled = !app->inline_media_enabled;
        else if (strcmp(rest, "on") == 0) app->inline_media_enabled = true;
        else if (strcmp(rest, "off") == 0) app->inline_media_enabled = false;
        else if (strcmp(rest, "all") == 0) {
            /* Auto-rendering a peer URL means fetching it the moment the
             * row scrolls into view: anyone who can post in the channel
             * learns your IP and when you read, and ffmpeg gets pointed
             * at bytes they chose. That is exactly what #451 turned off
             * by default. Saying yes is allowed; being told what you
             * said yes to is not optional. */
            app->inline_media_enabled = true;
            app->animate_media = true;
            app->inline_media_peers = true;
            log_line(app, "inline images ON for ALL hosts — every image link in a channel is");
            log_line(app, "  fetched when it scrolls into view: the host learns your IP and read");
            log_line(app, "  times, and ffmpeg decodes bytes a stranger chose. This is the default;");
            log_line(app, "  /media first-party returns to %s uploads only.", app->url.host);
        } else if (strcmp(rest, "anim") == 0 || strcmp(rest, "anim on") == 0) {
            app->animate_media = true;
            log_line(app, "video and animated GIFs will play inline as colour art");
        } else if (strcmp(rest, "anim off") == 0 || strcmp(rest, "still") == 0) {
            app->animate_media = false;
            log_line(app, "clips will show a single representative frame");
        } else if (strcmp(rest, "first-party") == 0) {
            app->inline_media_peers = false;
            log_line(app, "inline images restricted to this deployment's uploads");
        } else {
            log_line(app, "/media [on|off|all|first-party|anim|still] — bare /media toggles inline images;");
            log_line(app, "  'all' also auto-renders images hosted elsewhere (see the warning it prints);");
            log_line(app, "  'anim'/'still' control whether video and GIFs play or show one frame");
            return;
        }
        log_line(app, "inline images %s, hosts: %s, clips: %s (terminal graphics: %s)",
                 app->inline_media_enabled ? "ON" : "OFF",
                 app->inline_media_peers ? "ALL" : "first-party only",
                 app->animate_media ? "animated" : "still",
                 media_protocol_name(app->proto));
    } else if (strcmp(line, "/preview-ascii") == 0) {
        /* Force the character-art renderer even where a graphics protocol
         * exists — useful over a link that mangles binary escapes, or just
         * to see the art. */
        char url[MAX_LINE];
        bool is_video;
        pthread_mutex_lock(&app->lock);
        snprintf(url, sizeof(url), "%s", app->last_media_url);
        is_video = app->last_media_is_video;
        pthread_mutex_unlock(&app->lock);
        if (!url[0]) log_line(app, "/preview-ascii: no image or video link seen yet");
        else request_preview(app, url, is_video, true);
    } else if (strcmp(line, "/preview") == 0 || strncmp(line, "/preview ", 9) == 0) {
        /* The keyboard route to click-to-preview. With mouse tracking off
         * by default (so the terminal keeps its own selection), this is
         * how the preview stays reachable — the feature is not gated on
         * surrendering copy/paste.
         *
         * Bare, it offers the last pictures and clips posted HERE rather
         * than silently taking the most recent one seen anywhere in the
         * session: the one you want is rarely the one that happens to be
         * last, and a picker makes that choice visible. A URL as an
         * argument skips the list. */
        const char *arg = line[8] ? line + 9 : "";
        while (*arg == ' ') arg++;
        if (*arg) request_preview(app, arg, media_kind_of(arg) == MEDIA_VIDEO, false);
        else if (!open_media_picker(app, ACT_PREVIEW))
            log_line(app, "/preview: nothing to preview — no picture or clip has been posted in this window");
    } else if (strcmp(line, "/view") == 0 || strncmp(line, "/view ", 6) == 0) {
        /* Same list, different destination: the desktop's own viewer for
         * that file type, which is the one thing a terminal cannot do
         * itself. */
        const char *arg = line[5] ? line + 6 : "";
        while (*arg == ' ') arg++;
        if (*arg) request_view(app, arg);
        else if (!open_media_picker(app, ACT_VIEW))
            log_line(app, "/view: nothing to open — no picture or clip has been posted in this window");
    } else if (strcmp(line, "/open") == 0) {
        open_external_url(app, app->last_url);
    } else if (strcmp(line, "/clear") == 0) {
        clear_active_window_log(app);
    } else if (strcmp(line, "/close") == 0) {
        struct window w;
        pthread_mutex_lock(&app->lock);
        w = app->windows[focused_window_locked(app)];
        pthread_mutex_unlock(&app->lock);
        if (w.channel[0] == '#' || w.channel[0] == '&' || w.channel[0] == '+' || w.channel[0] == '!') {
            struct job job = { .kind = JOB_PART };
            snprintf(job.network, sizeof(job.network), "%s", w.network);
            snprintf(job.channel, sizeof(job.channel), "%s", w.channel);
            enqueue_job(app, job);
        } else if (is_server_window(w.channel)) {
            log_line(app, "cannot close server window");
        } else {
            struct job job = { .kind = JOB_CLOSE_QUERY };
            snprintf(job.network, sizeof(job.network), "%s", w.network);
            snprintf(job.channel, sizeof(job.channel), "%s", w.channel);
            enqueue_job(app, job);
        }
    } else if (strncmp(line, "/join ", 6) == 0 && line[6]) {
        struct job job = { .kind = JOB_JOIN };
        current_window_key(app, job.network, sizeof(job.network), NULL, 0);
        snprintf(job.channel, sizeof(job.channel), "%s", line + 6);
        enqueue_job(app, job);
    } else if (strncmp(line, "/j ", 3) == 0 && line[3]) {
        struct job job = { .kind = JOB_JOIN };
        current_window_key(app, job.network, sizeof(job.network), NULL, 0);
        snprintf(job.channel, sizeof(job.channel), "%s", line + 3);
        enqueue_job(app, job);
    } else if (strcmp(line, "/part") == 0) {
        handle_command(app, "/close");
    } else if (strncmp(line, "/nick ", 6) == 0 && line[6]) {
        struct job job = { .kind = JOB_NICK };
        current_window_key(app, job.network, sizeof(job.network), job.channel, sizeof(job.channel));
        snprintf(job.arg1, sizeof(job.arg1), "%s", line + 6);
        enqueue_job(app, job);
    } else if (strncmp(line, "/msg ", 5) == 0) {
        char *sp = strchr(line + 5, ' ');
        if (!sp) log_line(app, "/msg requires <target> <body>");
        else {
            *sp = 0;
            const char *target = line + 5;
            const char *body = sp + 1;
            char msg_net[MAX_SLUG];
            if (!current_window_key(app, msg_net, sizeof(msg_net), NULL, 0)) return;
            query_window(app, target);
            add_pending_echo(app, msg_net, target, own_nick_for_network(app, msg_net), body);
            enqueue_send(app, msg_net, target, body);
        }
    } else if (strcmp(line, "/query") == 0 || strcmp(line, "/q") == 0) {
        log_line(app, "/query requires a nick; use /query nick or /q nick");
    } else if (strncmp(line, "/query ", 7) == 0 && line[7]) {
        query_window(app, line + 7);
    } else if (strncmp(line, "/q ", 3) == 0 && line[3]) {
        query_window(app, line + 3);
    } else if (strncmp(line, "/me ", 4) == 0 && line[4]) {
        char *body = xasprintf("\001ACTION %s\001", line + 4);
        send_message(app, body);
        free(body);
    } else if (strncmp(line, "/disconnect", 11) == 0) {
        char *rest = line + 11;
        while (*rest == ' ') rest++;
        struct job job = { .kind = JOB_NETWORK_STATE };
        snprintf(job.arg1, sizeof(job.arg1), "parked");
        if (!*rest) {
            current_window_key(app, job.network, sizeof(job.network), NULL, 0);
            enqueue_job(app, job);
        }
        else {
            char *sp = strchr(rest, ' ');
            if (sp) { *sp = 0; snprintf(job.arg2, sizeof(job.arg2), "%s", sp + 1); }
            snprintf(job.network, sizeof(job.network), "%s", rest);
            enqueue_job(app, job);
        }
    } else if (strncmp(line, "/connect ", 9) == 0 && line[9]) {
        struct job job = { .kind = JOB_NETWORK_STATE };
        snprintf(job.network, sizeof(job.network), "%s", line + 9);
        snprintf(job.arg1, sizeof(job.arg1), "connected");
        enqueue_job(app, job);
    } else if (strncmp(line, "/away", 5) == 0) {
        char *rest = line + 5;
        while (*rest == ' ') rest++;
        char away_net[MAX_SLUG];
        current_window_key(app, away_net, sizeof(away_net), NULL, 0);
        char *net = json_escape(away_net);
        char *payload;
        if (*rest) {
            if (*rest == ':') rest++;
            char *reason = json_escape(rest);
            payload = xasprintf("{\"action\":\"set\",\"network\":\"%s\",\"reason\":\"%s\"}", net, reason);
            free(reason);
        } else {
            payload = xasprintf("{\"action\":\"unset\",\"network\":\"%s\"}", net);
        }
        ws_push_user(app, "away", payload);
        free(net);
        free(payload);
    } else if (strncmp(line, "/whois ", 7) == 0 && line[7]) {
        char *nick = json_escape(line + 7);
        char *payload = xasprintf("{\"network_id\":%d,\"nick\":\"%s\"}", current_network_id(app), nick);
        ws_push_user(app, "whois", payload);
        free(nick); free(payload);
    } else if (strncmp(line, "/whowas ", 8) == 0 && line[8]) {
        char *nick = json_escape(line + 8);
        char *payload = xasprintf("{\"network_id\":%d,\"nick\":\"%s\"}", current_network_id(app), nick);
        ws_push_user(app, "whowas", payload);
        free(nick); free(payload);
    } else if (strcmp(line, "/lusers") == 0) {
        char *payload = xasprintf("{\"network_id\":%d}", current_network_id(app));
        ws_push_user(app, "lusers", payload);
        free(payload);
    } else if (strncmp(line, "/who", 4) == 0) {
        char chan_now[MAX_CHANNEL];
        current_window_key(app, NULL, 0, chan_now, sizeof(chan_now));
        const char *target = line[4] && line[5] ? line + 5 : chan_now;
        char *chan = json_escape(*target ? target : chan_now);
        char *payload = xasprintf("{\"network_id\":%d,\"channel\":\"%s\"}", current_network_id(app), chan);
        ws_push_user(app, "who", payload);
        free(chan); free(payload);
    } else if (strncmp(line, "/names", 6) == 0) {
        char chan_now[MAX_CHANNEL];
        current_window_key(app, NULL, 0, chan_now, sizeof(chan_now));
        const char *target = line[6] && line[7] ? line + 7 : chan_now;
        char *chan = json_escape(*target ? target : chan_now);
        char *origin = json_escape(chan_now);
        char *payload = xasprintf("{\"network_id\":%d,\"channel\":\"%s\",\"origin_window\":\"%s\"}", current_network_id(app), chan, origin);
        ws_push_user(app, "names", payload);
        free(chan); free(origin); free(payload);
    } else if (strcmp(line, "/members") == 0 || strcmp(line, "/users") == 0) {
        struct job job = { .kind = JOB_MEMBERS };
        current_window_key(app, job.network, sizeof(job.network), job.channel, sizeof(job.channel));
        enqueue_job(app, job);
    } else if (strncmp(line, "/topic", 6) == 0) {
        const char *rest = line + 6;
        while (*rest == ' ') rest++;
        if (!*rest) {
            char chan_now[MAX_CHANNEL];
            current_window_key(app, NULL, 0, chan_now, sizeof(chan_now));
            char *chan = json_escape(chan_now);
            char *payload = xasprintf("{\"network_id\":%d,\"channel\":\"%s\",\"origin_window\":\"%s\"}", current_network_id(app), chan, chan);
            ws_push_user(app, "names", payload);
            free(chan); free(payload);
            log_line(app, "requested topic snapshot for %s", chan_now);
        } else {
            struct job job = { .kind = JOB_TOPIC };
            current_window_key(app, job.network, sizeof(job.network), job.channel, sizeof(job.channel));
            snprintf(job.arg1, sizeof(job.arg1), "%s", strcmp(rest, "-delete") == 0 ? " " : rest);
            enqueue_job(app, job);
        }
    } else if (strncmp(line, "/quote ", 7) == 0 && line[7]) {
        char *raw = json_escape(line + 7);
        char *payload = xasprintf("{\"network_id\":%d,\"line\":\"%s\"}", current_network_id(app), raw);
        ws_push_user(app, "raw", payload);
        free(raw); free(payload);
    } else if (strncmp(line, "/oper ", 6) == 0) {
        char *rest = line + 6;
        char *sp = strchr(rest, ' ');
        if (!sp) log_line(app, "/oper requires <name> <password>");
        else {
            *sp = 0;
            char *name = json_escape(rest);
            char *pw = json_escape(sp + 1);
            char *payload = xasprintf("{\"network_id\":%d,\"name\":\"%s\",\"password\":\"%s\"}", current_network_id(app), name, pw);
            ws_push_user(app, "oper", payload);
            free(name); free(pw); free(payload);
        }
    } else if (strncmp(line, "/op ", 4) == 0 || strncmp(line, "/deop ", 6) == 0 || strncmp(line, "/voice ", 7) == 0 || strncmp(line, "/devoice ", 9) == 0) {
        const char *event = line[1] == 'o' ? "op" : (line[1] == 'v' ? "voice" : (line[3] == 'p' ? "deop" : "devoice"));
        char *rest = strchr(line + 1, ' ');
        char *nicks = json_array_words(rest ? rest + 1 : "");
        char *extra = xasprintf("\"nicks\":%s", nicks);
        push_simple_channel_action(app, event, extra);
        free(nicks); free(extra);
    } else if (strncmp(line, "/kick ", 6) == 0) {
        char *rest = line + 6;
        char *sp = strchr(rest, ' ');
        if (sp) *sp = 0;
        char *nick = json_escape(rest);
        char *reason = json_escape(sp ? sp + 1 : "");
        char *extra = xasprintf("\"nick\":\"%s\",\"reason\":\"%s\"", nick, reason);
        push_simple_channel_action(app, "kick", extra);
        free(nick); free(reason); free(extra);
    } else if (strncmp(line, "/ban ", 5) == 0 || strncmp(line, "/unban ", 7) == 0) {
        bool unban = strncmp(line, "/unban ", 7) == 0;
        char *mask = json_escape(line + (unban ? 7 : 5));
        char *extra = xasprintf("\"mask\":\"%s\"", mask);
        push_simple_channel_action(app, unban ? "unban" : "ban", extra);
        free(mask); free(extra);
    } else if (strcmp(line, "/banlist") == 0) {
        push_simple_channel_action(app, "banlist", NULL);
    } else if (strncmp(line, "/invite ", 8) == 0) {
        char *nick = json_escape(line + 8);
        char *extra = xasprintf("\"nick\":\"%s\"", nick);
        push_simple_channel_action(app, "invite", extra);
        free(nick); free(extra);
    } else if (strncmp(line, "/umode ", 7) == 0) {
        char *modes = json_escape(line + 7);
        char *payload = xasprintf("{\"network_id\":%d,\"modes\":\"%s\"}", current_network_id(app), modes);
        ws_push_user(app, "umode", payload);
        free(modes); free(payload);
    } else if (strncmp(line, "/mode", 5) == 0 && (line[5] == ' ' || line[5] == '\0')) {
        /* The server has taken a structured `mode` verb since before this
         * client existed — {network_id, target, modes, params}. The old
         * body told the user to fall back to `/quote MODE`, which skipped
         * the server's validation and its channel_modes_changed
         * broadcast. Grammar mirrors cicchetto's:
         *   /mode                → show current channel's modes
         *   /mode +ns            → apply to the current channel
         *   /mode #chan +ns      → apply to a named channel
         *   /mode +k secret      → mode letters plus positional params
         */
        char *rest = line + 5;
        while (*rest == ' ') rest++;
        char target[MAX_CHANNEL];
        current_window_key(app, NULL, 0, target, sizeof(target));
        if (*rest == '#' || *rest == '&' || *rest == '+' || *rest == '!') {
            char *sp = strchr(rest, ' ');
            if (sp) {
                *sp = 0;
                snprintf(target, sizeof(target), "%s", rest);
                rest = sp + 1;
                while (*rest == ' ') rest++;
            } else {
                snprintf(target, sizeof(target), "%s", rest);
                rest += strlen(rest);
            }
        }
        if (!target[0] || is_server_window(target)) {
            log_line(app, "/mode needs a channel; use /mode #chan +modes from a server window");
        } else {
            /* Split "+k secret" into the mode string and its params. */
            char modes[128] = "";
            char *sp = strchr(rest, ' ');
            const char *params_src = "";
            if (sp) { *sp = 0; params_src = sp + 1; }
            snprintf(modes, sizeof(modes), "%s", rest);
            char *tgt = json_escape(target);
            char *mds = json_escape(modes);
            char *params = json_array_words(params_src);
            char *payload = xasprintf(
                "{\"network_id\":%d,\"target\":\"%s\",\"modes\":\"%s\",\"params\":%s}",
                current_network_id(app), tgt, mds, params);
            ws_push_user(app, "mode", payload);
            free(tgt); free(mds); free(params); free(payload);
        }
    } else if (strcmp(line, "/links") == 0) {
        char *payload = xasprintf("{\"network_id\":%d}", current_network_id(app));
        ws_push_user(app, "links", payload);
        free(payload);
    } else if (strcmp(line, "/motd") == 0 || strcmp(line, "/info") == 0 ||
               strcmp(line, "/version") == 0) {
        /* All three answer with a `server_reply` bundle discriminated by
         * source, so one arm covers them. */
        char *payload = xasprintf("{\"network_id\":%d}", current_network_id(app));
        ws_push_user(app, line + 1, payload);
        free(payload);
    } else if (strncmp(line, "/stats", 6) == 0 && (line[6] == ' ' || line[6] == '\0')) {
        /* STATS has no structured verb; it rides `raw`, as in cicchetto.
         * Trailing args are omitted rather than sent empty so the frame
         * stays positionally valid. */
        const char *rest = line + 6;
        while (*rest == ' ') rest++;
        char frame[MAX_LINE];
        if (*rest) snprintf(frame, sizeof(frame), "STATS %s", rest);
        else snprintf(frame, sizeof(frame), "STATS");
        char *raw = json_escape(frame);
        char *payload = xasprintf("{\"network_id\":%d,\"line\":\"%s\"}", current_network_id(app), raw);
        ws_push_user(app, "raw", payload);
        free(raw); free(payload);
    } else if (strncmp(line, "/rehash", 7) == 0 && (line[7] == ' ' || line[7] == '\0')) {
        const char *rest = line + 7;
        while (*rest == ' ') rest++;
        char frame[MAX_LINE];
        if (*rest) snprintf(frame, sizeof(frame), "REHASH %s", rest);
        else snprintf(frame, sizeof(frame), "REHASH");
        char *raw = json_escape(frame);
        char *payload = xasprintf("{\"network_id\":%d,\"line\":\"%s\"}", current_network_id(app), raw);
        ws_push_user(app, "raw", payload);
        free(raw); free(payload);
    } else if (strncmp(line, "/kb ", 4) == 0 || strncmp(line, "/kickban ", 9) == 0) {
        /* Kick + ban as one verb. Banning FIRST is deliberate: kick then
         * ban leaves a window in which the user can rejoin ahead of the
         * ban landing. */
        char *rest = strchr(line + 1, ' ');
        rest++;
        while (*rest == ' ') rest++;
        char *sp = strchr(rest, ' ');
        if (sp) *sp = 0;
        if (!*rest) {
            log_line(app, "/kb requires <nick> [reason]");
        } else {
            char mask[MAX_CHANNEL + 8];
            snprintf(mask, sizeof(mask), "%s!*@*", rest);
            char *emask = json_escape(mask);
            char *ban_extra = xasprintf("\"mask\":\"%s\"", emask);
            push_simple_channel_action(app, "ban", ban_extra);
            free(emask); free(ban_extra);
            char *nick = json_escape(rest);
            char *reason = json_escape(sp ? sp + 1 : "");
            char *kick_extra = xasprintf("\"nick\":\"%s\",\"reason\":\"%s\"", nick, reason);
            push_simple_channel_action(app, "kick", kick_extra);
            free(nick); free(reason); free(kick_extra);
        }
    } else if (strncmp(line, "/cs ", 4) == 0 || strncmp(line, "/ns ", 4) == 0 ||
               strncmp(line, "/ms ", 4) == 0 || strncmp(line, "/os ", 4) == 0 ||
               strncmp(line, "/hs ", 4) == 0 || strncmp(line, "/rs ", 4) == 0 ||
               strcmp(line, "/cs") == 0 || strcmp(line, "/ns") == 0 ||
               strcmp(line, "/ms") == 0 || strcmp(line, "/os") == 0 ||
               strcmp(line, "/hs") == 0 || strcmp(line, "/rs") == 0) {
        /* Services shortcuts: /<x>s <cmd> is a PRIVMSG to the service. A
         * BARE /<x>s sends HELP, which is what cicchetto's services modal
         * opens with. */
        const char *service = service_for_shortcut(line[1]);
        const char *rest = line[3] ? line + 4 : "";
        while (*rest == ' ') rest++;
        const char *body = *rest ? rest : "HELP";
        char svc_net[MAX_SLUG];
        if (!current_window_key(app, svc_net, sizeof(svc_net), NULL, 0)) return;
        query_window(app, service);
        add_pending_echo(app, svc_net, service, own_nick_for_network(app, svc_net), body);
        enqueue_send(app, svc_net, service, body);
    } else if (strncmp(line, "/notify", 7) == 0 && (line[7] == ' ' || line[7] == '\0')) {
        notify_command(app, line + 7);
    } else if (strncmp(line, "/hilight ", 9) == 0 || strncmp(line, "/dehilight ", 11) == 0) {
        /* Keyword highlights are a DIFFERENT list from /notify's presence
         * watch — same irssi naming, separate server stores. */
        bool remove = line[1] == 'd';
        const char *rest = strchr(line + 1, ' ') + 1;
        while (*rest == ' ') rest++;
        char *pat = json_escape(rest);
        char *payload = xasprintf("{\"action\":\"%s\",\"pattern\":\"%s\"}", remove ? "del" : "add", pat);
        ws_push_user(app, "watchlist", payload);
        free(pat); free(payload);
    } else if (strncmp(line, "/alias", 6) == 0 && (line[6] == ' ' || line[6] == '\0')) {
        alias_command(app, line + 6);
    } else if (strncmp(line, "/unalias ", 9) == 0) {
        alias_remove(app, line + 9);
    } else if (strncmp(line, "/upload ", 8) == 0) {
        upload_command(app, line + 8);
    } else if (strcmp(line, "/upload") == 0) {
        log_line(app, "/upload <path> — send a local file and post its link");
    } else if (strcmp(line, "/list") == 0 || strncmp(line, "/list ", 6) == 0) {
        directory_command(app, line[5] ? line + 6 : "");
    } else if (strncmp(line, "/watch ", 7) == 0 || strncmp(line, "/highlight ", 11) == 0) {
        char *rest = strchr(line + 1, ' ');
        char action[16] = "list";
        char pattern[MAX_LINE] = "";
        if (rest) sscanf(rest + 1, "%15s %1023[^\n]", action, pattern);
        char *pat = json_escape(pattern);
        char *payload = xasprintf("{\"action\":\"%s\",\"pattern\":\"%s\"}", action, pat);
        ws_push_user(app, "watchlist", payload);
        free(pat); free(payload);
    } else if (strncmp(line, "/window ", 8) == 0 || strncmp(line, "/win ", 5) == 0 || strncmp(line, "/w ", 3) == 0) {
        const char *arg = line[2] == 'w' && line[3] == ' ' ? line + 3 : (line[4] == ' ' ? line + 5 : line + 8);
        int n = atoi(arg);
        /* Focus moves under the lock, exactly as cycle_window does it:
         * app->current, the unread reset and the window it names are one
         * decision, and the socket thread is appending windows and
         * rewriting rosters the whole time. The identity is copied out
         * before the unlocked fetches use it. */
        char win_net[MAX_SLUG] = "", win_chan[MAX_CHANNEL] = "";
        bool moved = false;
        pthread_mutex_lock(&app->lock);
        if (n > 0 && (size_t)n <= app->window_count) {
            struct pane *p = focused_pane_locked(app);
            p->window = (size_t)n - 1;
            p->scroll_offset = 0;
            p->scroll_pinned = false;
            p->member_offset = 0;
            clear_current_unread_locked(app);
            snprintf(win_net, sizeof(win_net), "%s", app->windows[p->window].network);
            snprintf(win_chan, sizeof(win_chan), "%s", app->windows[p->window].channel);
            moved = true;
        }
        pthread_mutex_unlock(&app->lock);
        if (moved) {
            enqueue_fetch(app, win_net, win_chan);
            ensure_roster(app, win_net, win_chan);
        }
    } else {
        log_line(app, "unknown command: %.40s — /help lists every verb", line);
    }
}

static void handle_enter(struct app *app) {
    app->input[app->input_len] = 0;
    if (app->input_len == 0) return;
    char line[MAX_LINE];
    snprintf(line, sizeof(line), "%s", app->input);
    add_history(app, line);
    app->input_len = 0;
    app->input[0] = 0;
    if (line[0] == '/') handle_command(app, line);
    else {
        char send_net[MAX_SLUG], send_chan[MAX_CHANNEL];
        if (!current_window_key(app, send_net, sizeof(send_net), send_chan, sizeof(send_chan))) return;
        const char *network = send_net;
        const char *channel = send_chan;
        /* $server is read-only by server contract, so say so HERE rather
         * than firing a request that can only come back 400. The client
         * knows the rule; making the user decode an HTTP status to learn
         * it is the failure this replaces. Commands still work from a
         * $server window — only a bare PRIVMSG has nowhere to go. */
        if (is_server_window(channel)) {
            log_line(app, "[%s/$server] --- the server window is read-only — "
                          "switch to a channel, or use /msg <nick> <text> or /join #chan",
                     network);
        } else {
            add_pending_echo(app, network, channel, own_nick_for_network(app, network), line);
            enqueue_send(app, network, channel, line);
        }
    }
}

/* Topmost recorded media region containing screen cell (x, y), or NULL.
 * Caller holds app->lock. */
static const struct link_region *region_at(struct app *app, int x, int y) {
    for (size_t i = 0; i < app->link_region_count; i++) {
        const struct link_region *r = &app->link_regions[i];
        if (y >= r->y0 && y <= r->y1 && x >= r->x0 && x <= r->x1) return r;
    }
    return NULL;
}

/* Map a mouse event to a link region: motion updates the hover hint, a
 * left button press over a region acts on the link — a picture previews
 * in place, anything else opens in the browser. */
static void handle_mouse(struct app *app) {
    MEVENT ev;
    if (getmouse(&ev) != OK) return;
    bool click = ev.bstate & (BUTTON1_PRESSED | BUTTON1_CLICKED);
    bool right = false;
#ifdef BUTTON3_PRESSED
    right = (ev.bstate & (BUTTON3_PRESSED | BUTTON3_CLICKED)) != 0;
#endif

    /* An open overlay takes the click: on an item it acts, anywhere else
     * it closes. A modal that ignores clicks outside itself is a modal
     * you have to guess your way out of. */
    pthread_mutex_lock(&app->lock);
    bool overlay_open = app->overlay.kind != OVERLAY_NONE;
    pthread_mutex_unlock(&app->lock);
    if (overlay_open) {
        if (!click && !right) return;
        struct overlay_item items[64];
        bool hit = false;
        pthread_mutex_lock(&app->lock);
        size_t n = overlay_items(app, items, sizeof(items) / sizeof(items[0]));
        /* A picker spends its first row on the filter, and its list may
         * be scrolled — so the row under the pointer is an offset from
         * `top`, not from the head of the list. */
        bool picker = app->overlay.kind == OVERLAY_REPLY || app->overlay.kind == OVERLAY_MEDIA;
        int first = picker ? app->overlay.y + 1 : app->overlay.y;
        size_t idx = ev.y >= first ? app->overlay.top + (size_t)(ev.y - first) : 0;
        if (ev.y >= first && idx < n) {
            app->overlay.sel = idx;
            hit = true;
        }
        pthread_mutex_unlock(&app->lock);
        if (hit) overlay_activate(app);
        else overlay_close(app);
        return;
    }

    if (right) {
        /* Right-click names the message under the pointer. */
        pthread_mutex_lock(&app->lock);
        for (size_t i = 0; i < app->msg_region_count; i++) {
            const struct msg_region *r = &app->msg_regions[i];
            if (ev.y < r->y0 || ev.y > r->y1 || ev.x < r->x0 || ev.x > r->x1) continue;
            app->overlay.kind = OVERLAY_MENU;
            app->overlay.sel = 0;
            app->overlay.x = ev.x;
            app->overlay.y = ev.y + 1;
            snprintf(app->overlay.nick, sizeof(app->overlay.nick), "%s", r->nick);
            snprintf(app->overlay.body, sizeof(app->overlay.body), "%s", r->body);
            break;
        }
        pthread_mutex_unlock(&app->lock);
        return;
    }

    /* Wheel over a member pane scrolls the roster. Which column that is
     * depends on the terminal width, so ask the same question the draw
     * path asks: wide terminals put it on the right, narrow ones in the
     * sidebar under the window list. */
    bool wheel_up = false, wheel_down = false;
#ifdef BUTTON4_PRESSED
    wheel_up = (ev.bstate & BUTTON4_PRESSED) != 0;
#endif
#ifdef BUTTON5_PRESSED
    wheel_down = (ev.bstate & BUTTON5_PRESSED) != 0;
#endif
    if (wheel_up || wheel_down) {
        int cols = getmaxx(stdscr);
        int side = cols > 118 ? 22 : (cols > 90 ? 18 : 14);
        int members = cols > 118 ? 24 : 0;
        bool over_roster = members ? ev.x >= cols - members : ev.x < side;
        if (over_roster) {
            scroll_members(app, wheel_up ? -3 : 3);
            return;
        }
        /* Otherwise the chat — the pane under the POINTER, which with a
         * split is not always the focused one, and the pointer is what
         * the user was pointing at. Scrolling the chat with the wheel is
         * what every other client does; leaving it to the roster alone
         * made the wheel feel broken everywhere else on screen. */
        pthread_mutex_lock(&app->lock);
        size_t index = app->focus;
        for (size_t i = 0; i < app->pane_region_count; i++) {
            const struct pane_region *pr = &app->pane_regions[i];
            if (ev.y >= pr->y0 && ev.y <= pr->y1 && ev.x >= pr->x0 && ev.x <= pr->x1)
                index = pr->pane;
        }
        pthread_mutex_unlock(&app->lock);
        scroll_pane(app, index, wheel_up ? 3 : -3);
        return;
    }

    pthread_mutex_lock(&app->lock);
    /* Resting the pointer on the topic band pauses its marquee — the
     * thing a reader does when they want to finish a sentence. Every
     * mouse event answers it, motion included, so it is as live as the
     * hover hint below. */
    app->topic_hover = false;
    for (size_t i = 0; i < app->topic_region_count; i++) {
        const struct topic_region *tr = &app->topic_regions[i];
        if (ev.y >= tr->y0 && ev.y <= tr->y1 && ev.x >= tr->x0 && ev.x <= tr->x1)
            app->topic_hover = true;
    }
    const struct link_region *r = region_at(app, ev.x, ev.y);
    char url[MAX_LINE];
    bool is_video = false;
    enum media_kind kind = MEDIA_NONE;
    bool hit = r != NULL;
    if (r) {
        snprintf(url, sizeof(url), "%s", r->url);
        is_video = r->is_video;
        kind = r->kind;
        snprintf(app->hover_url, sizeof(app->hover_url), "%s", r->url);
    } else {
        app->hover_url[0] = 0;
    }
    pthread_mutex_unlock(&app->lock);

    if (click && hit) {
        if (kind == MEDIA_NONE) {
            /* Not a picture: hand it to the browser, the same door /open
             * uses. A link that cannot be opened from where it is read is
             * a link the user has to retype. */
            open_external_url(app, url);
        } else {
            /* Clicking a media link previews it, using the terminal's
             * graphics protocol when there is one and character art when
             * there is not — the same path as /preview. */
            request_preview(app, url, is_video, false);
        }
        pthread_mutex_lock(&app->lock);
        app->hover_url[0] = 0;
        pthread_mutex_unlock(&app->lock);
    }
}


/* ── Pane keys ─────────────────────────────────────────────────────────
 *
 * Terminals disagree about what Ctrl-Alt even sends, so both dialects
 * are accepted rather than betting on one:
 *
 *   1. The CSI forms (xterm/vte/kitty/alacritty): Ctrl-Alt-Up is
 *      "\033[1;7A", and with modifyOtherKeys on, Ctrl-Alt-+ is
 *      "\033[27;7;43~". These are taught to ncurses with define_key()
 *      so getch() returns one code instead of a burst of bytes.
 *   2. The ESC-prefix dialect, which is what most terminals actually
 *      send for Alt-<key>: ESC then the key. Handled by peeking after an
 *      ESC — if something follows immediately it was a modified key, and
 *      if nothing does it was a real Escape.
 *
 * Ctrl-Alt-Tab is registered but many terminals send NOTHING for it (and
 * a desktop usually eats Alt-Tab first) — Ctrl-Alt-Up/Down is the one to
 * rely on. `/keys` prints what your terminal actually sends, so a
 * binding that does not fire is a bug report with a number in it rather
 * than a guess. */
enum {
    KEY_PANE_NEXT = KEY_MAX + 1,
    KEY_PANE_PREV,
    KEY_PANE_GROW,
    KEY_PANE_SHRINK,
    KEY_PANE_CYCLE,
    KEY_ROSTER_UP,
    KEY_ROSTER_DOWN,
    KEY_CHAT_UP,
    KEY_CHAT_DOWN
};

static void define_pane_keys(void) {
    static const struct {
        const char *seq;
        int code;
    } bindings[] = {
        {"\033[1;7A", KEY_PANE_PREV},    /* Ctrl-Alt-Up */
        {"\033[1;7B", KEY_PANE_NEXT},    /* Ctrl-Alt-Down */
        {"\033[1;3A", KEY_PANE_PREV},    /* Alt-Up, for terminals with no ctrl form */
        {"\033[1;3B", KEY_PANE_NEXT},    /* Alt-Down */
        {"\033[27;7;43~", KEY_PANE_GROW},   /* Ctrl-Alt-+ */
        {"\033[27;7;61~", KEY_PANE_GROW},   /* Ctrl-Alt-= (same key, unshifted) */
        {"\033[27;7;45~", KEY_PANE_SHRINK}, /* Ctrl-Alt-- */
        {"\033[27;7;9~", KEY_PANE_CYCLE},   /* Ctrl-Alt-Tab */
        {"\033[27;3;43~", KEY_PANE_GROW},
        {"\033[27;3;45~", KEY_PANE_SHRINK},
        /* The member list. Shift+PgUp/PgDn was bound through terminfo's
         * kPRV/kNXT alone, which plenty of terminfo entries simply do not
         * define — the key then arrives as an undecoded escape burst and
         * the roster never moves, which is exactly what happened. Binding
         * the sequences directly is what makes the promise true, and
         * Ctrl-Shift-Up/Down is bound alongside because arrows are what a
         * list wants. */
        {"\033[5;2~", KEY_ROSTER_UP},   /* Shift-PgUp */
        {"\033[6;2~", KEY_ROSTER_DOWN}, /* Shift-PgDn */
        {"\033[1;6A", KEY_ROSTER_UP},   /* Ctrl-Shift-Up */
        {"\033[1;6B", KEY_ROSTER_DOWN}, /* Ctrl-Shift-Down */
        {"\033[1;2A", KEY_ROSTER_UP},   /* Shift-Up, where ctrl is eaten */
        {"\033[1;2B", KEY_ROSTER_DOWN}, /* Shift-Down */
        /* Ctrl-Up/Down scrolls the chat a line at a time. Bound because
         * it is one of the few modified arrows terminals both send and
         * do not keep for themselves. */
        {"\033[1;5A", KEY_CHAT_UP},
        {"\033[1;5B", KEY_CHAT_DOWN},
    };
    for (size_t i = 0; i < sizeof(bindings) / sizeof(bindings[0]); i++)
        define_key(bindings[i].seq, bindings[i].code);
}

/* Decode a CSI sequence ncurses did not.
 *
 * keypad(TRUE) recognises exactly what terminfo describes, and many
 * entries — screen-256color among them — describe no modified arrows at
 * all. Those bytes then arrive raw, and with only the ESC consumed the
 * remainder is typed into the input line as "1;5A". Reading the sequence
 * through to its final byte costs nothing on a terminal that never sends
 * one, and is the difference between a key that does nothing and a key
 * that types rubbish. Returns a key code, or 27 for a sequence we have
 * no meaning for — having consumed the whole sequence either way. */
static int resolve_csi(void) {
    char buf[24];
    size_t n = 0;
    int c;
    timeout(0);
    while ((c = getch()) != ERR) {
        if (c < 0x20 || c > 0x7e) break; /* not part of a CSI: give up */
        if (n < sizeof(buf) - 1) buf[n++] = (char)c;
        if (c >= 0x40) break;            /* final byte */
    }
    timeout(50);
    if (n == 0) return 27;
    char final = buf[n - 1];
    buf[n - 1] = 0;
    /* "1;6" for an arrow, "5;2" for a page key: the first parameter says
     * WHICH key for the ~ forms, the second is the xterm modifier set,
     * biased by one (2 = shift, 3 = alt, 5 = ctrl, 6 = ctrl+shift). */
    int first = atoi(buf);
    const char *semi = strchr(buf, ';');
    int mod = semi ? atoi(semi + 1) : 0;
    if (final == 'A' || final == 'B') {
        bool up = final == 'A';
        switch (mod) {
        case 2:
        case 6: return up ? KEY_ROSTER_UP : KEY_ROSTER_DOWN;
        case 3:
        case 7: return up ? KEY_PANE_PREV : KEY_PANE_NEXT;
        case 5: return up ? KEY_CHAT_UP : KEY_CHAT_DOWN;
        default: return up ? KEY_UP : KEY_DOWN;
        }
    }
    if (final == '~' && mod == 2) {
        if (first == 5) return KEY_ROSTER_UP;  /* Shift-PgUp */
        if (first == 6) return KEY_ROSTER_DOWN;
    }
    return 27;
}

/* Resolve an ESC into either a modified key or a real Escape. Called
 * with the 27 already consumed; peeks without blocking, because a lone
 * Escape must not wait for a key that is never coming. */
static int resolve_escape(void) {
    timeout(0);
    int next = getch();
    timeout(50);
    if (next == ERR) return 27; /* a real Escape */
    switch (next) {
    case '+':
    case '=': return KEY_PANE_GROW;
    case '-': return KEY_PANE_SHRINK;
    case '\t': return KEY_PANE_CYCLE;
    case KEY_UP: return KEY_PANE_PREV;
    case KEY_DOWN: return KEY_PANE_NEXT;
    case '[': return resolve_csi();
    default: return 27;
    }
}

/* Set by the signal handler in headless mode: a bridge has no /exit to
 * type, so Ctrl-C and SIGTERM are how it stops. */
static volatile sig_atomic_t ircd_signalled;

static void ircd_signal_handler(int sig) {
    (void)sig;
    ircd_signalled = 1;
}

static bool ircd_is_channel(const char *name) {
    return name && (name[0] == '#' || name[0] == '&' || name[0] == '+' || name[0] == '!');
}

/* ── Output ────────────────────────────────────────────────────────────
 * Every send appends a whole line to the client's buffer under the
 * bridge lock, so lines from the tee and lines from a command reply can
 * interleave but never tear. */

static void ircd_queue_locked(struct ircd_client *c, const char *line, size_t len) {
    if (c->fd < 0 || c->closing) return;
    size_t need = c->out_len + len + 2;
    if (need > IRCD_OUT_MAX) {
        c->closing = true; /* SendQ exceeded: the client stopped reading */
        return;
    }
    if (need > c->out_cap) {
        size_t cap = c->out_cap ? c->out_cap : 8192;
        while (cap < need) cap *= 2;
        char *bigger = realloc(c->out, cap);
        if (!bigger) {
            c->closing = true;
            return;
        }
        c->out = bigger;
        c->out_cap = cap;
    }
    memcpy(c->out + c->out_len, line, len);
    c->out_len += len;
    c->out[c->out_len++] = '\r';
    c->out[c->out_len++] = '\n';
}

static void ircd_vsend_locked(struct ircd_client *c, const char *fmt, va_list ap) {
    char line[IRCD_LINE_MAX + 256];
    int n = vsnprintf(line, sizeof(line), fmt, ap);
    if (n < 0) return;
    if ((size_t)n >= sizeof(line)) n = (int)sizeof(line) - 1;
    /* The backstop. Bodies are sanitised where they enter, but ONE stray
     * newline reaching a client is a command injected into that client's
     * session by whoever wrote the message. */
    for (int i = 0; i < n; i++)
        if (line[i] == '\r' || line[i] == '\n') line[i] = ' ';
    ircd_queue_locked(c, line, (size_t)n);
}

static void ircd_send_locked(struct ircd_client *c, const char *fmt, ...)
    __attribute__((format(printf, 2, 3)));
static void ircd_send_locked(struct ircd_client *c, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    ircd_vsend_locked(c, fmt, ap);
    va_end(ap);
}

static void ircd_send(struct app *app, struct ircd_client *c, const char *fmt, ...)
    __attribute__((format(printf, 3, 4)));
static void ircd_send(struct app *app, struct ircd_client *c, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    pthread_mutex_lock(&app->ircd.lock);
    ircd_vsend_locked(c, fmt, ap);
    pthread_mutex_unlock(&app->ircd.lock);
    va_end(ap);
}

static void ircd_numeric(struct app *app, struct ircd_client *c, int num, const char *fmt, ...)
    __attribute__((format(printf, 4, 5)));
static void ircd_numeric(struct app *app, struct ircd_client *c, int num, const char *fmt, ...) {
    char rest[IRCD_LINE_MAX];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(rest, sizeof(rest), fmt, ap);
    va_end(ap);
    ircd_send(app, c, ":%s %03d %s %s", IRCD_SERVER, num, c->nick[0] ? c->nick : "*", rest);
}

static void ircd_notice(struct app *app, struct ircd_client *c, const char *fmt, ...)
    __attribute__((format(printf, 3, 4)));
static void ircd_notice(struct app *app, struct ircd_client *c, const char *fmt, ...) {
    char text[IRCD_LINE_MAX];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(text, sizeof(text), fmt, ap);
    va_end(ap);
    ircd_send(app, c, ":%s NOTICE %s :%s", IRCD_SERVER, c->nick[0] ? c->nick : "*", text);
}

/* Push whatever is buffered. Non-blocking: a partial write leaves the
 * rest for the next pass. Caller holds the bridge lock. */
static void ircd_flush_locked(struct ircd_client *c) {
    while (c->out_len > 0 && c->fd >= 0) {
        ssize_t n = send(c->fd, c->out, c->out_len, MSG_NOSIGNAL);
        if (n > 0) {
            memmove(c->out, c->out + n, c->out_len - (size_t)n);
            c->out_len -= (size_t)n;
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
        c->closing = true;
        return;
    }
}

static void ircd_drop_locked(struct ircd_client *c) {
    if (c->fd >= 0) close(c->fd);
    free(c->out);
    memset(c, 0, sizeof(*c));
    c->fd = -1;
}

/* ── Grappa side ───────────────────────────────────────────────────────
 * Everything the bridge asks of grappa goes through the same paths the
 * terminal UI uses: jobs for anything that blocks, the raw verb for what
 * the client asked in IRC's own words. */

static int ircd_network_id(struct app *app, const char *slug) {
    int id = 0;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->network_count; i++)
        if (irc_name_eq(app->networks[i].slug, slug)) id = app->networks[i].id;
    pthread_mutex_unlock(&app->lock);
    return id;
}

/* Hand a line to the real ircd upstream, verbatim. This is what makes
 * the bridge useful beyond the commands it implements: a client can send
 * anything its user knows how to type, and grappa forwards it. Replies
 * come back as grappa events, and the ones that map onto a numeric are
 * translated below; the rest reach the user in shottino's other clients,
 * which the NOTICE says. */
static void ircd_forward_raw(struct app *app, struct ircd_client *c, const char *line) {
    int id = ircd_network_id(app, c->network);
    if (!id) return;
    char *raw = json_escape(line);
    char *payload = xasprintf("{\"network_id\":%d,\"line\":\"%s\"}", id, raw);
    ws_push_user(app, "raw", payload);
    free(raw);
    free(payload);
}

/* ── Downstream state, from app state ──────────────────────────────── */

/* Copy the channels this client's network has open. Takes app->lock, so
 * it must NOT be called with the bridge lock held. */
static size_t ircd_channels_of(struct app *app, const char *network, char out[][MAX_CHANNEL],
                               size_t max) {
    size_t n = 0;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count && n < max; i++) {
        if (!irc_name_eq(app->windows[i].network, network)) continue;
        if (!ircd_is_channel(app->windows[i].channel)) continue;
        snprintf(out[n], MAX_CHANNEL, "%s", app->windows[i].channel);
        n++;
    }
    pthread_mutex_unlock(&app->lock);
    return n;
}

static void ircd_own_nick(struct app *app, const char *network, char *out, size_t out_sz) {
    pthread_mutex_lock(&app->lock);
    const char *nick = own_nick_for_network(app, network);
    snprintf(out, out_sz, "%s", nick ? nick : "grappa");
    pthread_mutex_unlock(&app->lock);
}

/* RPL_NAMREPLY + RPL_ENDOFNAMES for one channel, from the roster the
 * client already keeps up to date. */
static void ircd_send_names(struct app *app, struct ircd_client *c, const char *channel) {
    char line[IRCD_LINE_MAX];
    size_t used = 0;
    line[0] = '\0';

    pthread_mutex_lock(&app->lock);
    const char *sigils = NULL;
    network_prefixes_locked(app, c->network, NULL, &sigils);
    struct window *w = NULL;
    for (size_t i = 0; i < app->window_count; i++)
        if (strcmp(app->windows[i].network, c->network) == 0 &&
            ircd_name_equal(app->windows[i].channel, channel))
            w = &app->windows[i];
    /* Copied out under the lock: the send below must not hold it. */
    static char names[512][MAX_CHANNEL + 8];
    size_t count = 0;
    if (w) {
        for (size_t i = 0; i < w->member_count && count < 512; i++) {
            char sig[8];
            ircd_member_sigils(w->members[i].modes, sigils ? sigils : "", c->cap_multi_prefix, sig,
                               sizeof(sig));
            snprintf(names[count], sizeof(names[0]), "%s%s", sig, w->members[i].nick);
            count++;
        }
    }
    pthread_mutex_unlock(&app->lock);

    for (size_t i = 0; i < count; i++) {
        size_t len = strlen(names[i]);
        if (used + len + 2 > 400) {
            ircd_numeric(app, c, 353, "= %s :%s", channel, line);
            line[0] = '\0';
            used = 0;
        }
        if (used) {
            line[used++] = ' ';
            line[used] = '\0';
        }
        memcpy(line + used, names[i], len + 1);
        used += len;
    }
    if (used) ircd_numeric(app, c, 353, "= %s :%s", channel, line);
    ircd_numeric(app, c, 366, "%s :End of /NAMES list", channel);
}

static void ircd_send_topic(struct app *app, struct ircd_client *c, const char *channel) {
    char topic[MAX_TOPIC];
    topic[0] = '\0';
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++)
        if (strcmp(app->windows[i].network, c->network) == 0 &&
            ircd_name_equal(app->windows[i].channel, channel))
            snprintf(topic, sizeof(topic), "%s", app->windows[i].topic);
    pthread_mutex_unlock(&app->lock);
    char clean[MAX_TOPIC];
    ircd_sanitize(topic, clean, sizeof(clean));
    if (clean[0]) ircd_numeric(app, c, 332, "%s :%s", channel, clean);
    else ircd_numeric(app, c, 331, "%s :No topic is set", channel);
}

/* Show the client a channel it is in: the JOIN it would have seen, the
 * topic, and who is there. Used both when a client registers (for the
 * channels grappa already holds open) and when it asks to join one that
 * is already open. */
static void ircd_present_channel(struct app *app, struct ircd_client *c, const char *channel) {
    char prefix[192];
    ircd_sender_prefix(c->nick, prefix, sizeof(prefix));
    ircd_send(app, c, ":%s JOIN %s", prefix, channel);
    ircd_send_topic(app, c, channel);
    ircd_send_names(app, c, channel);
}

/* ── The tee ───────────────────────────────────────────────────────────
 *
 * render_message() is the ONE place every message reaches, live push and
 * fetched scrollback alike, already deduplicated by id and already
 * carrying network, channel, sender, kind and server_time. Hooking the
 * bridge there rather than at the socket means history and live traffic
 * take the same path — and that presence rows (join, part, quit, nick,
 * mode, kick, topic) come along, because grappa delivers those as
 * messages too. */

static void ircd_history_add_locked(struct app *app, const struct wire_scrollback_message *m,
                                    const char *channel) {
    struct ircd_hist *h = &app->ircd.hist[app->ircd.hist_next];
    memset(h, 0, sizeof(*h));
    h->id = m->id;
    h->server_time = m->server_time;
    h->kind = m->kind;
    snprintf(h->network, sizeof(h->network), "%s", m->network);
    snprintf(h->channel, sizeof(h->channel), "%s", channel);
    snprintf(h->sender, sizeof(h->sender), "%s", m->sender ? m->sender : "");
    snprintf(h->body, sizeof(h->body), "%s", m->body ? m->body : "");
    app->ircd.hist_next = (app->ircd.hist_next + 1) % IRCD_HISTORY;
    if (app->ircd.hist_count < IRCD_HISTORY) app->ircd.hist_count++;
}

/* One message, as the IRC line a client expects. `own` is our nick on
 * that network, which decides who a DM is addressed to: a message from
 * someone else is addressed to US, and our own message in that window is
 * addressed to THEM. */
static void ircd_message_line(const struct ircd_hist *h, const char *own, bool time_tag,
                              bool tags, const char *batch_ref, char *out, size_t out_sz) {
    char prefix[192];
    ircd_sender_prefix(h->sender[0] ? h->sender : IRCD_SERVER, prefix, sizeof(prefix));
    /* Bounded well under the line buffer rather than at MAX_LINE: a
     * grappa body can be longer than an IRC line may be, and the
     * arithmetic has to leave room for the prefix, the target and the
     * tag. Truncating here is what stops a long message from silently
     * losing its last parameter instead of its last words. */
    char body[768];
    ircd_sanitize(h->body, body, sizeof(body));
    char tag[128];
    ircd_tags(h->server_time, time_tag, h->id, tags, batch_ref, tag, sizeof(tag));

    const char *target = h->channel;
    if (!ircd_is_channel(h->channel) && !ircd_name_equal(h->sender, own)) target = own;

    switch (h->kind) {
    case MSG_PRIVMSG:
        snprintf(out, out_sz, "%s:%s PRIVMSG %.64s :%s", tag, prefix, target, body);
        break;
    case MSG_NOTICE:
        snprintf(out, out_sz, "%s:%s NOTICE %.64s :%s", tag, prefix, target, body);
        break;
    case MSG_ACTION:
        /* grappa classifies the kind; whether the CTCP wrapper survived
         * in the body depends on where the row came from, so it is put
         * back only when it is not already there. */
        if (body[0] == '\001') snprintf(out, out_sz, "%s:%s PRIVMSG %.64s :%s", tag, prefix, target, body);
        else snprintf(out, out_sz, "%s:%s PRIVMSG %.64s :\001ACTION %s\001", tag, prefix, target, body);
        break;
    case MSG_JOIN:
        snprintf(out, out_sz, "%s:%s JOIN %.64s", tag, prefix, h->channel);
        break;
    case MSG_PART:
        snprintf(out, out_sz, "%s:%s PART %.64s :%s", tag, prefix, h->channel, body);
        break;
    case MSG_QUIT:
        snprintf(out, out_sz, "%s:%s QUIT :%s", tag, prefix, body);
        break;
    case MSG_NICK_CHANGE:
        snprintf(out, out_sz, "%s:%s NICK :%s", tag, prefix, body);
        break;
    case MSG_MODE:
        snprintf(out, out_sz, "%s:%s MODE %.64s %s", tag, prefix, h->channel, body);
        break;
    case MSG_TOPIC:
        snprintf(out, out_sz, "%s:%s TOPIC %.64s :%s", tag, prefix, h->channel, body);
        break;
    case MSG_KICK:
        /* grappa carries the victim in the body and the kicker in the
         * sender; there is no reason field on the wire. */
        snprintf(out, out_sz, "%s:%s KICK %.64s %.64s :kicked", tag, prefix, h->channel, body);
        break;
    case MSG_SERVER_EVENT:
        snprintf(out, out_sz, "%s:%s NOTICE %.64s :%s", tag, IRCD_SERVER,
                 ircd_is_channel(h->channel) ? h->channel : own, body);
        break;
    }
}

/* Called from render_message on whichever thread delivered the row. */
static void ircd_publish(struct app *app, const struct wire_scrollback_message *m,
                         const char *display_channel) {
    if (!app->ircd.enabled) return;
    char own[MAX_CHANNEL];
    ircd_own_nick(app, m->network, own, sizeof(own)); /* takes app->lock — before ours */

    pthread_mutex_lock(&app->ircd.lock);
    ircd_history_add_locked(app, m, display_channel);
    const struct ircd_hist *h = &app->ircd.hist[(app->ircd.hist_next + IRCD_HISTORY - 1) % IRCD_HISTORY];
    for (size_t i = 0; i < IRCD_MAX_CLIENTS; i++) {
        struct ircd_client *c = &app->ircd.clients[i];
        if (c->fd < 0 || !c->registered) continue;
        if (strcmp(c->network, m->network) != 0) continue;
        bool conversational = h->kind == MSG_PRIVMSG || h->kind == MSG_NOTICE || h->kind == MSG_ACTION;
        /* A client displays its own messages the moment it sends them,
         * so echoing them back doubles every line — unless it asked for
         * echo-message, which exists precisely to move that decision to
         * the server. The cost of not echoing is that a message sent
         * from cicchetto or shottino's own UI does not appear here;
         * echo-message is how a client opts into seeing those. */
        if (conversational && !c->cap_echo && ircd_name_equal(h->sender, own)) continue;
        char line[IRCD_LINE_MAX + 256];
        ircd_message_line(h, own, c->cap_server_time, c->cap_tags, NULL, line, sizeof(line));
        if (line[0]) ircd_send_locked(c, "%s", line);
    }
    pthread_mutex_unlock(&app->ircd.lock);
}

/* Everything in the ring for this client's network, oldest first. The
 * ring is small enough that "all of it" is the right answer: a client
 * reconnecting wants the conversation, and picking a per-channel cap
 * would reorder it. */
static void ircd_replay(struct app *app, struct ircd_client *c) {
    char own[MAX_CHANNEL];
    ircd_own_nick(app, c->network, own, sizeof(own));
    pthread_mutex_lock(&app->ircd.lock);
    size_t start = app->ircd.hist_count == IRCD_HISTORY ? app->ircd.hist_next : 0;
    for (size_t k = 0; k < app->ircd.hist_count; k++) {
        const struct ircd_hist *h = &app->ircd.hist[(start + k) % IRCD_HISTORY];
        if (strcmp(h->network, c->network) != 0) continue;
        /* Presence rows are noise in a replay: a JOIN from an hour ago
         * tells a client someone is arriving now. Conversation is what
         * was missed. */
        if (h->kind != MSG_PRIVMSG && h->kind != MSG_NOTICE && h->kind != MSG_ACTION) continue;
        char line[IRCD_LINE_MAX + 256];
        ircd_message_line(h, own, c->cap_server_time, c->cap_tags, NULL, line, sizeof(line));
        if (line[0]) ircd_send_locked(c, "%s", line);
    }
    pthread_mutex_unlock(&app->ircd.lock);
}

/* ── CHATHISTORY ───────────────────────────────────────────────────────
 *
 * The IRCv3 way for a client to ask for what it missed, instead of being
 * told at connect time and never again. It is answered from the bridge's
 * own ring, which is filled by the tee — so it holds the scrollback
 * shottino fetched from grappa at startup and on join, plus everything
 * live since. That is a SESSION's worth of conversation, not the whole
 * archive: a request that reaches past it gets what there is rather than
 * an error, and the honest place for that limit is the README.
 *
 * (Fetching further back from grappa on demand would mean routing REST
 * results to ONE client. Every fetch today goes through render_message,
 * which publishes to all of them as live traffic — the very thing that
 * fills this ring. Splitting that path is the next step, not this one.) */

/* Messages for `target` on this client's network, oldest first. Caller
 * holds the bridge lock. */
static size_t ircd_history_for(struct app *app, const char *network, const char *target,
                               const struct ircd_hist **out, size_t max) {
    size_t n = 0;
    size_t start = app->ircd.hist_count == IRCD_HISTORY ? app->ircd.hist_next : 0;
    for (size_t k = 0; k < app->ircd.hist_count && n < max; k++) {
        const struct ircd_hist *h = &app->ircd.hist[(start + k) % IRCD_HISTORY];
        if (strcmp(h->network, network) != 0) continue;
        if (h->kind != MSG_PRIVMSG && h->kind != MSG_NOTICE && h->kind != MSG_ACTION) continue;
        if (target && !ircd_name_equal(h->channel, target)) continue;
        out[n++] = h;
    }
    return n;
}

/* Is this message before / after the point a selector names? A selector
 * that names nothing (`*`) bounds nothing, which is what LATEST uses. */
static bool ircd_hist_before(const struct ircd_hist *h, const struct ircd_selector *sel) {
    switch (sel->kind) {
    case IRCD_SEL_TIME: return h->server_time < sel->time_ms;
    case IRCD_SEL_MSGID: return h->id > 0 && h->id < sel->msgid;
    case IRCD_SEL_STAR:
    case IRCD_SEL_NONE: return true;
    }
    return true;
}

static bool ircd_hist_after(const struct ircd_hist *h, const struct ircd_selector *sel) {
    switch (sel->kind) {
    case IRCD_SEL_TIME: return h->server_time > sel->time_ms;
    case IRCD_SEL_MSGID: return h->id > sel->msgid;
    case IRCD_SEL_STAR:
    case IRCD_SEL_NONE: return true;
    }
    return true;
}

#define IRCD_CHATHISTORY_MAX 200

static void ircd_send_batch(struct app *app, struct ircd_client *c, const char *target,
                            const struct ircd_hist **rows, size_t count) {
    char own[MAX_CHANNEL];
    ircd_own_nick(app, c->network, own, sizeof(own));
    char ref[32] = "";
    /* A batch is what tells the client these are OLD messages rather than
     * a burst of new ones. Without the capability they are sent anyway,
     * because a client that asked for history and got nothing would be
     * worse off than one that gets it unlabelled. */
    if (c->cap_batch) {
        snprintf(ref, sizeof(ref), "sh%u", ++c->batch_seq);
        ircd_send(app, c, ":%s BATCH +%s chathistory %s", IRCD_SERVER, ref, target);
    }
    for (size_t i = 0; i < count; i++) {
        char line[IRCD_LINE_MAX + 256];
        ircd_message_line(rows[i], own, c->cap_server_time, c->cap_tags, ref[0] ? ref : NULL, line,
                          sizeof(line));
        if (line[0]) ircd_send(app, c, "%s", line);
    }
    if (ref[0]) ircd_send(app, c, ":%s BATCH -%s", IRCD_SERVER, ref);
}

static void ircd_cmd_chathistory(struct app *app, struct ircd_client *c,
                                 const struct ircd_msg *m) {
    if (m->param_count < 2) {
        ircd_send(app, c, "FAIL CHATHISTORY NEED_MORE_PARAMS :Missing parameters");
        return;
    }
    const char *sub = m->params[0];

    /* TARGETS answers "who have I been talking to", which is how a
     * client decides what to ask about next. */
    if (strcasecmp(sub, "TARGETS") == 0) {
        char seen[32][MAX_CHANNEL];
        long latest[32];
        size_t count = 0;
        pthread_mutex_lock(&app->ircd.lock);
        const struct ircd_hist *rows[IRCD_HISTORY];
        size_t n = ircd_history_for(app, c->network, NULL, rows, IRCD_HISTORY);
        for (size_t i = 0; i < n; i++) {
            size_t at = count;
            for (size_t j = 0; j < count; j++)
                if (ircd_name_equal(seen[j], rows[i]->channel)) at = j;
            if (at == count && count < 32) {
                snprintf(seen[count], MAX_CHANNEL, "%s", rows[i]->channel);
                latest[count] = rows[i]->server_time;
                count++;
            } else if (at < count) {
                latest[at] = rows[i]->server_time;
            }
        }
        pthread_mutex_unlock(&app->ircd.lock);
        char ref[32] = "";
        if (c->cap_batch) {
            snprintf(ref, sizeof(ref), "sh%u", ++c->batch_seq);
            ircd_send(app, c, ":%s BATCH +%s draft/chathistory-targets", IRCD_SERVER, ref);
        }
        char batch_tag[48] = "";
        if (ref[0]) snprintf(batch_tag, sizeof(batch_tag), "@batch=%s ", ref);
        for (size_t i = 0; i < count; i++) {
            char stamp[64];
            ircd_time_tag(latest[i], true, stamp, sizeof(stamp));
            /* ircd_time_tag writes "@time=… " and here the value alone is
             * wanted, as a parameter rather than as a tag. */
            char value[48] = "";
            if (strlen(stamp) > 7) snprintf(value, sizeof(value), "%.*s", (int)strlen(stamp) - 7,
                                            stamp + 6);
            ircd_send(app, c, "%s:%s CHATHISTORY TARGETS %s %s", batch_tag, IRCD_SERVER,
                      seen[i], value);
        }
        if (ref[0]) ircd_send(app, c, ":%s BATCH -%s", IRCD_SERVER, ref);
        return;
    }

    if (m->param_count < 3) {
        ircd_send(app, c, "FAIL CHATHISTORY NEED_MORE_PARAMS :Missing parameters");
        return;
    }
    const char *target = m->params[1];
    bool between = strcasecmp(sub, "BETWEEN") == 0;
    struct ircd_selector a, b;
    if (!ircd_parse_selector(m->params[2], &a)) {
        ircd_send(app, c, "FAIL CHATHISTORY INVALID_PARAMS %s :Invalid selector", sub);
        return;
    }
    memset(&b, 0, sizeof(b));
    if (between) {
        if (m->param_count < 4 || !ircd_parse_selector(m->params[3], &b)) {
            ircd_send(app, c, "FAIL CHATHISTORY INVALID_PARAMS %s :Invalid selector", sub);
            return;
        }
    }
    const char *limit_str = m->params[m->param_count - 1];
    long limit = strtol(limit_str, NULL, 10);
    if (limit <= 0) limit = 50;
    if (limit > IRCD_CHATHISTORY_MAX) limit = IRCD_CHATHISTORY_MAX;

    const struct ircd_hist *rows[IRCD_HISTORY];
    const struct ircd_hist *picked[IRCD_CHATHISTORY_MAX];
    size_t count = 0;
    pthread_mutex_lock(&app->ircd.lock);
    size_t n = ircd_history_for(app, c->network, target, rows, IRCD_HISTORY);
    if (strcasecmp(sub, "LATEST") == 0 || strcasecmp(sub, "BEFORE") == 0) {
        /* The most recent `limit` of what qualifies: walking BACKWARDS is
         * what makes "the last twenty" mean the last twenty rather than
         * the first twenty of everything that qualifies. */
        for (size_t i = n; i > 0 && count < (size_t)limit; i--) {
            const struct ircd_hist *h = rows[i - 1];
            bool ok = strcasecmp(sub, "LATEST") == 0 ? (a.kind == IRCD_SEL_STAR || ircd_hist_after(h, &a))
                                                     : ircd_hist_before(h, &a);
            if (ok) picked[count++] = h;
        }
        /* Collected newest-first, delivered oldest-first, because that
         * is the order a client renders them in. */
        for (size_t i = 0; i < count / 2; i++) {
            const struct ircd_hist *tmp = picked[i];
            picked[i] = picked[count - 1 - i];
            picked[count - 1 - i] = tmp;
        }
    } else if (strcasecmp(sub, "AFTER") == 0) {
        for (size_t i = 0; i < n && count < (size_t)limit; i++)
            if (ircd_hist_after(rows[i], &a)) picked[count++] = rows[i];
    } else if (between) {
        for (size_t i = 0; i < n && count < (size_t)limit; i++)
            if (ircd_hist_after(rows[i], &a) && ircd_hist_before(rows[i], &b))
                picked[count++] = rows[i];
    } else if (strcasecmp(sub, "AROUND") == 0) {
        /* Half either side of the point, in order: the last `half`
         * before it, then everything from there up to the limit. Said in
         * two passes because saying it in one needs a lookahead nobody
         * can read six months later. */
        size_t half = (size_t)limit / 2;
        if (half == 0) half = 1;
        size_t before_total = 0;
        for (size_t i = 0; i < n; i++)
            if (ircd_hist_before(rows[i], &a)) before_total++;
        size_t skip = before_total > half ? before_total - half : 0;
        size_t seen_before = 0;
        for (size_t i = 0; i < n && count < (size_t)limit; i++) {
            if (ircd_hist_before(rows[i], &a) && seen_before++ < skip) continue;
            picked[count++] = rows[i];
        }
    } else {
        pthread_mutex_unlock(&app->ircd.lock);
        ircd_send(app, c, "FAIL CHATHISTORY INVALID_PARAMS %s :Unknown subcommand", sub);
        return;
    }
    /* The id a `timestamp=` selector points at, if the ring spans that
     * moment: grappa pages on message ids, and this is the only place
     * that can translate. Computed while the lock is still held. */
    long anchor_before = 0, anchor_after = 0;
    for (size_t i = 0; i < n; i++) {
        if (a.kind != IRCD_SEL_TIME) break;
        if (!anchor_before && rows[i]->server_time >= a.time_ms) anchor_before = rows[i]->id;
        if (rows[i]->server_time <= a.time_ms) anchor_after = rows[i]->id;
    }
    pthread_mutex_unlock(&app->ircd.lock);

    /* One rule, so a client can predict where an answer comes from: the
     * ring answers when it can answer FULLY, and anything short of that
     * goes to grappa when --ircd-archive says it may. Merging the two
     * would mean stitching two orderings together for rows the archive
     * query returns anyway. */
    if (app->ircd.archive && count < (size_t)limit) {
        const char *cursor = "";
        long cursor_id = 0;
        long after_ms = 0, before_ms = 0, after_id = 0, before_id = 0;
        if (strcasecmp(sub, "BEFORE") == 0) {
            cursor = "before";
            cursor_id = a.kind == IRCD_SEL_MSGID ? a.msgid : anchor_before;
            if (a.kind == IRCD_SEL_TIME && !cursor_id) before_ms = a.time_ms;
        } else if (strcasecmp(sub, "AFTER") == 0) {
            cursor = "after";
            cursor_id = a.kind == IRCD_SEL_MSGID ? a.msgid : anchor_after;
            if (a.kind == IRCD_SEL_TIME && !cursor_id) after_ms = a.time_ms;
        } else if (strcasecmp(sub, "AROUND") == 0) {
            cursor = "around";
            cursor_id = a.kind == IRCD_SEL_MSGID ? a.msgid : anchor_after;
            if (a.kind == IRCD_SEL_TIME && !cursor_id) after_ms = a.time_ms;
        } else if (between) {
            /* Two ends, one cursor: anchor on the earlier one and drop
             * what falls past the later one on the way out. */
            cursor = "after";
            cursor_id = a.kind == IRCD_SEL_MSGID ? a.msgid : anchor_after;
            if (b.kind == IRCD_SEL_MSGID) before_id = b.msgid;
            else if (b.kind == IRCD_SEL_TIME) before_ms = b.time_ms;
            if (a.kind == IRCD_SEL_TIME && !cursor_id) after_ms = a.time_ms;
        } else if (a.kind == IRCD_SEL_MSGID) { /* LATEST after a point */
            cursor = "after";
            cursor_id = a.msgid;
        }
        struct job job = {.kind = JOB_CHATHISTORY};
        snprintf(job.network, sizeof(job.network), "%s", c->network);
        snprintf(job.channel, sizeof(job.channel), "%.*s", (int)sizeof(job.channel) - 1, target);
        snprintf(job.arg1, sizeof(job.arg1), "%lu %ld %s %ld", c->id, limit,
                 cursor_id > 0 ? cursor : "-", cursor_id);
        snprintf(job.arg2, sizeof(job.arg2), "%ld %ld %ld %ld", after_ms, before_ms, after_id,
                 before_id);
        if (enqueue_job(app, job)) return;
        /* The queue is full: the ring's answer is better than none. */
    }
    ircd_send_batch(app, c, target, picked, count);
}

/* ── CHATHISTORY against grappa's archive ──────────────────────────────
 *
 * The ring holds a session's worth of conversation. `--ircd-archive`
 * lets a request reach past it, into what grappa has stored, by asking
 * the same REST endpoint the client's own scrollback comes from.
 *
 * It is OPTIONAL because it is not free: one HTTP round trip per
 * request, on a scrollback table that can be very large, driven by
 * whatever a downstream client decides to ask for while the user scrolls.
 * The ring costs nothing and answers the common case — what did I miss —
 * so the archive is the deeper question you opt into.
 *
 * The cursors line up almost exactly: grappa pages on integer message
 * ids with ?before=, ?after=, ?around= and ?limit=, and a CHATHISTORY
 * msgid selector IS that id. A `timestamp=` selector has no server-side
 * equivalent, so it is resolved through the nearest id the ring knows
 * and the page is filtered by time afterwards — exact when the bridge
 * has seen that part of the conversation, approximate when it has not,
 * which is stated in the README rather than implied by silence. */

struct archive_reply {
    struct wire_scrollback_message rows[IRCD_CHATHISTORY_MAX];
    char bodies[IRCD_CHATHISTORY_MAX][MAX_LINE];
    char senders[IRCD_CHATHISTORY_MAX][MAX_CHANNEL];
    struct ircd_hist hist[IRCD_CHATHISTORY_MAX];
    size_t count;
    /* Bounds the server could not express, applied after the fetch:
     * grappa pages on ONE cursor, and BETWEEN has two ends. */
    long before_ms, after_ms;
    long before_id, after_id;
};

static void archive_collect(struct app *app, const struct wire_scrollback_message *m, void *ctx) {
    (void)app;
    struct archive_reply *out = ctx;
    if (out->count >= IRCD_CHATHISTORY_MAX) return;
    /* Conversation only: a JOIN from last week tells a client someone is
     * arriving now, which is the same reason the replay drops them. */
    if (m->kind != MSG_PRIVMSG && m->kind != MSG_NOTICE && m->kind != MSG_ACTION) return;
    if (out->after_ms && m->server_time <= out->after_ms) return;
    if (out->before_ms && m->server_time >= out->before_ms) return;
    if (out->after_id && m->id <= out->after_id) return;
    if (out->before_id && m->id >= out->before_id) return;
    struct ircd_hist *h = &out->hist[out->count];
    memset(h, 0, sizeof(*h));
    h->id = m->id;
    h->server_time = m->server_time;
    h->kind = m->kind;
    snprintf(h->network, sizeof(h->network), "%s", m->network);
    snprintf(h->channel, sizeof(h->channel), "%s", m->channel);
    snprintf(h->sender, sizeof(h->sender), "%s", m->sender ? m->sender : "");
    snprintf(h->body, sizeof(h->body), "%s", m->body ? m->body : "");
    out->count++;
}

/* Worker side: fetch the page, then hand it to the client that asked —
 * if that client is still the one holding the slot. */
static void ircd_archive_job(struct app *app, const struct job *job) {
    char network[MAX_SLUG], target[MAX_CHANNEL];
    snprintf(network, sizeof(network), "%s", job->network);
    snprintf(target, sizeof(target), "%s", job->channel);
    /* arg1: "<client_id> <limit> <cursor_param> <cursor_id>"
     * arg2: "<after_ms> <before_ms>" — the time window, when the client
     * asked in timestamps rather than ids. */
    unsigned long client_id = 0;
    long limit = 50, cursor_id = 0, after_ms = 0, before_ms = 0;
    char cursor[16] = "";
    sscanf(job->arg1, "%lu %ld %15s %ld", &client_id, &limit, cursor, &cursor_id);
    long after_id = 0, before_id = 0;
    sscanf(job->arg2, "%ld %ld %ld %ld", &after_ms, &before_ms, &after_id, &before_id);

    struct archive_reply *reply = calloc(1, sizeof(*reply));
    if (!reply) return;
    reply->after_ms = after_ms;
    reply->before_ms = before_ms;
    reply->after_id = after_id;
    reply->before_id = before_id;

    char *net = url_encode(network);
    char *chan = url_encode(target);
    char *path;
    if (cursor[0] && cursor_id > 0)
        path = xasprintf("/networks/%s/channels/%s/messages?%s=%ld&limit=%ld", net, chan, cursor,
                         cursor_id, limit);
    else
        path = xasprintf("/networks/%s/channels/%s/messages?limit=%ld", net, chan, limit);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "GET", path, NULL);
    free(path);
    if (r.status >= 200 && r.status < 300)
        parse_messages_into(app, r.body, r.body_len, archive_collect, reply);
    else
        log_line(app, "chathistory: GET messages failed HTTP %d", r.status);
    free(r.body);

    const struct ircd_hist *rows[IRCD_CHATHISTORY_MAX];
    for (size_t i = 0; i < reply->count; i++) rows[i] = &reply->hist[i];

    pthread_mutex_lock(&app->ircd.lock);
    struct ircd_client *c = NULL;
    for (size_t i = 0; i < IRCD_MAX_CLIENTS; i++)
        if (app->ircd.clients[i].fd >= 0 && app->ircd.clients[i].id == client_id)
            c = &app->ircd.clients[i];
    pthread_mutex_unlock(&app->ircd.lock);
    /* Gone, or the slot belongs to somebody else now: the answer is
     * dropped rather than delivered into a session that never asked. */
    if (c) ircd_send_batch(app, c, target, rows, reply->count);
    free(reply);
}

/* ── Registration ──────────────────────────────────────────────────── */

/* Which grappa network this client asked for. Returns false when it
 * named one that does not exist — answered with the list, because a
 * typo'd network name is the most likely first-connection mistake. */
static bool ircd_resolve_network(struct app *app, const char *want, char *out, size_t out_sz,
                                 char *known, size_t known_sz) {
    bool found = false;
    size_t used = 0;
    known[0] = '\0';
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->network_count; i++) {
        const char *slug = app->networks[i].slug;
        used += (size_t)snprintf(known + used, used < known_sz ? known_sz - used : 0, "%s%s",
                                 used ? " " : "", slug);
        if (!found && (!want[0] || strcasecmp(want, slug) == 0)) {
            snprintf(out, out_sz, "%s", slug);
            found = true;
        }
    }
    pthread_mutex_unlock(&app->lock);
    return found;
}

static void ircd_register(struct app *app, struct ircd_client *c) {
    char want[MAX_SLUG] = "";
    char secret[128] = "";
    ircd_split_pass(c->pass, want, sizeof(want), secret, sizeof(secret));

    char network[MAX_SLUG] = "";
    char known[512];
    /* With no colon, PASS is either a network name or a password and
     * nothing in the string says which — so it is tried as a network
     * name first, and if that is not one, it was a password. */
    if (!ircd_resolve_network(app, want, network, sizeof(network), known, sizeof(known))) {
        if (strcmp(want, secret) == 0) {
            want[0] = '\0';
            if (!ircd_resolve_network(app, "", network, sizeof(network), known, sizeof(known))) {
                ircd_send(app, c, "ERROR :grappa has no networks bound yet");
                c->closing = true;
                return;
            }
        } else {
            ircd_send(app, c, "ERROR :no such network %s — this account has: %s", want, known);
            c->closing = true;
            return;
        }
    }
    if (strcmp(want, secret) == 0 && want[0] && strcasecmp(want, network) == 0) secret[0] = '\0';

    if (app->ircd.secret_required && strcmp(secret, app->ircd.secret) != 0) {
        ircd_numeric(app, c, 464, ":Password incorrect");
        ircd_send(app, c, "ERROR :bad password");
        c->closing = true;
        return;
    }
    snprintf(c->network, sizeof(c->network), "%s", network);

    /* The nick is grappa's, not the client's: a bouncer speaks as the
     * account it is bridging, and a client that guessed differently is
     * told so with the NICK it would have got from a real server. */
    char own[MAX_CHANNEL];
    ircd_own_nick(app, network, own, sizeof(own));
    if (own[0] && !ircd_name_equal(own, c->nick)) {
        char prefix[192];
        ircd_sender_prefix(c->nick, prefix, sizeof(prefix));
        ircd_send(app, c, ":%s NICK :%s", prefix, own);
        snprintf(c->nick, sizeof(c->nick), "%s", own);
    }
    c->registered = true;

    ircd_numeric(app, c, 1, ":Welcome to grappa via shottino, %s", c->nick);
    ircd_numeric(app, c, 2, ":Your host is %s, running shottino %s", IRCD_SERVER, SHOTTINO_VERSION);
    ircd_numeric(app, c, 3, ":This bridge speaks for network %s", network);
    ircd_numeric(app, c, 4, "%s shottino-%s o o", IRCD_SERVER, SHOTTINO_VERSION);

    const char *sigils = NULL;
    const char *letters = NULL;
    pthread_mutex_lock(&app->lock);
    network_prefixes_locked(app, network, &letters, &sigils);
    char pfx[64];
    snprintf(pfx, sizeof(pfx), "(%s)%s", letters ? letters : "ohv", sigils ? sigils : "@%+");
    pthread_mutex_unlock(&app->lock);
    ircd_numeric(app, c, 5,
                 "CHANTYPES=#&+! PREFIX=%s NETWORK=%s CASEMAPPING=rfc1459 NICKLEN=32 "
                 "CHANNELLEN=64 :are supported by this server",
                 pfx, network);

    ircd_numeric(app, c, 375, ":- %s message of the day -", IRCD_SERVER);
    ircd_numeric(app, c, 372, ":- shottino is bridging this connection to grappa.");
    ircd_numeric(app, c, 372, ":- Network: %s. Your session, channels and history are grappa's;", network);
    ircd_numeric(app, c, 372, ":- this connection is only a view of them.");
    ircd_numeric(app, c, 372, ":- Commands shottino does not implement are forwarded to the real");
    ircd_numeric(app, c, 372, ":- server verbatim, so anything you can type still works.");
    ircd_numeric(app, c, 376, ":End of /MOTD command.");

    /* The channels grappa already holds open ARE this session — a
     * bouncer shows them without being asked, or the client comes up
     * empty and the user rejoins channels they never left. */
    static char channels[MAX_WINDOWS][MAX_CHANNEL];
    size_t n = ircd_channels_of(app, network, channels, MAX_WINDOWS);
    for (size_t i = 0; i < n; i++) ircd_present_channel(app, c, channels[i]);
    ircd_replay(app, c);
    startup("ircd: %s registered on %s (%zu channels)", c->nick, network, n);
}

static void ircd_maybe_register(struct app *app, struct ircd_client *c) {
    if (c->registered || c->cap_negotiating) return;
    if (!c->got_nick || !c->got_user) return;
    ircd_register(app, c);
}

/* ── Commands from the client ──────────────────────────────────────── */

static void ircd_cmd_cap(struct app *app, struct ircd_client *c, const struct ircd_msg *m) {
    const char *sub = m->param_count > 0 ? m->params[0] : "";
    if (strcasecmp(sub, "LS") == 0 || strcasecmp(sub, "LIST") == 0) {
        c->cap_negotiating = true;
        ircd_send(app, c,
                  ":%s CAP %s LS :server-time multi-prefix echo-message message-tags batch "
                  "draft/chathistory",
                  IRCD_SERVER, c->nick[0] ? c->nick : "*");
        return;
    }
    if (strcasecmp(sub, "REQ") == 0) {
        const char *want = m->param_count > 1 ? m->params[1] : "";
        char acked[128] = "";
        size_t used = 0;
        bool all = true;
        char copy[IRCD_PARAM_MAX];
        snprintf(copy, sizeof(copy), "%s", want);
        for (char *tok = strtok(copy, " "); tok; tok = strtok(NULL, " ")) {
            bool ok = true;
            if (strcmp(tok, "server-time") == 0) c->cap_server_time = true;
            else if (strcmp(tok, "multi-prefix") == 0) c->cap_multi_prefix = true;
            else if (strcmp(tok, "echo-message") == 0) c->cap_echo = true;
            else if (strcmp(tok, "message-tags") == 0) c->cap_tags = true;
            else if (strcmp(tok, "batch") == 0) c->cap_batch = true;
            else if (strcmp(tok, "draft/chathistory") == 0) c->cap_chathistory = true;
            else ok = false;
            if (!ok) {
                all = false;
                continue;
            }
            used += (size_t)snprintf(acked + used, sizeof(acked) - used, "%s%s", used ? " " : "",
                                     tok);
        }
        ircd_send(app, c, ":%s CAP %s %s :%s", IRCD_SERVER, c->nick[0] ? c->nick : "*",
                  all ? "ACK" : "NAK", all ? acked : want);
        return;
    }
    if (strcasecmp(sub, "END") == 0) {
        c->cap_negotiating = false;
        ircd_maybe_register(app, c);
    }
}

static void ircd_cmd_join(struct app *app, struct ircd_client *c, const char *targets) {
    char copy[IRCD_PARAM_MAX];
    snprintf(copy, sizeof(copy), "%s", targets);
    for (char *tok = strtok(copy, ","); tok; tok = strtok(NULL, ",")) {
        if (!ircd_is_channel(tok)) continue;
        bool known = false;
        pthread_mutex_lock(&app->lock);
        for (size_t i = 0; i < app->window_count; i++)
            if (strcmp(app->windows[i].network, c->network) == 0 &&
                ircd_name_equal(app->windows[i].channel, tok))
                known = true;
        pthread_mutex_unlock(&app->lock);
        if (known) {
            /* Already in it: show the client where it is rather than
             * asking grappa to join a channel it is already in. */
            ircd_present_channel(app, c, tok);
            continue;
        }
        struct job job = {.kind = JOB_JOIN};
        snprintf(job.network, sizeof(job.network), "%s", c->network);
        snprintf(job.channel, sizeof(job.channel), "%s", tok);
        enqueue_job(app, job);
        /* The JOIN the client is waiting for arrives when the SERVER
         * says so, which is a round trip away. Saying that out loud is
         * the difference between "slow" and "broken". */
        ircd_notice(app, c, "asking %s to join %s", c->network, tok);
    }
}

static void ircd_cmd_part(struct app *app, struct ircd_client *c, const char *targets) {
    char copy[IRCD_PARAM_MAX];
    snprintf(copy, sizeof(copy), "%s", targets);
    for (char *tok = strtok(copy, ","); tok; tok = strtok(NULL, ",")) {
        struct job job = {.kind = JOB_PART};
        snprintf(job.network, sizeof(job.network), "%s", c->network);
        snprintf(job.channel, sizeof(job.channel), "%s", tok);
        enqueue_job(app, job);
        /* The client is told immediately: grappa confirms by removing
         * the window, which produces no message of its own. */
        char prefix[192];
        ircd_sender_prefix(c->nick, prefix, sizeof(prefix));
        ircd_send(app, c, ":%s PART %s", prefix, tok);
    }
}

static void ircd_cmd_privmsg(struct app *app, struct ircd_client *c, const struct ircd_msg *m,
                             bool notice) {
    if (m->param_count < 2) {
        ircd_numeric(app, c, 411, ":No recipient given");
        return;
    }
    const char *target = m->params[0];
    const char *text = m->params[1];
    if (notice) {
        /* grappa's message API posts a PRIVMSG; a NOTICE has to go
         * upstream in IRC's own words. */
        char line[IRCD_LINE_MAX];
        snprintf(line, sizeof(line), "NOTICE %.64s :%.700s", target, text);
        ircd_forward_raw(app, c, line);
        return;
    }
    struct job job = {.kind = JOB_SEND};
    snprintf(job.network, sizeof(job.network), "%s", c->network);
    snprintf(job.channel, sizeof(job.channel), "%.*s", (int)sizeof(job.channel) - 1, target);
    snprintf(job.arg1, sizeof(job.arg1), "%.*s", (int)sizeof(job.arg1) - 1, text);
    enqueue_job(app, job);
}

static void ircd_cmd_who(struct app *app, struct ircd_client *c, const char *mask) {
    char nicks[512][MAX_CHANNEL];
    char modes[512][8];
    size_t count = 0;
    pthread_mutex_lock(&app->lock);
    const char *sigils = NULL;
    network_prefixes_locked(app, c->network, NULL, &sigils);
    for (size_t i = 0; i < app->window_count && !count; i++) {
        if (strcmp(app->windows[i].network, c->network) != 0) continue;
        if (!ircd_name_equal(app->windows[i].channel, mask)) continue;
        struct window *w = &app->windows[i];
        for (size_t k = 0; k < w->member_count && count < 512; k++) {
            snprintf(nicks[count], MAX_CHANNEL, "%s", w->members[k].nick);
            ircd_member_sigils(w->members[k].modes, sigils ? sigils : "", false, modes[count],
                               sizeof(modes[0]));
            count++;
        }
    }
    pthread_mutex_unlock(&app->lock);
    for (size_t i = 0; i < count; i++)
        ircd_numeric(app, c, 352, "%s %s grappa %s %s H%s :0 %s", mask, nicks[i], IRCD_SERVER,
                     nicks[i], modes[i], nicks[i]);
    ircd_numeric(app, c, 315, "%s :End of /WHO list", mask);
}

/* WHOIS is answered from what the bridge knows — which channels of this
 * network the nick is in — and the query is NOT forwarded: a real WHOIS
 * reply arrives as a grappa event with no client to attribute it to, and
 * answering twice with different information is worse than answering
 * once with less. */
static void ircd_cmd_whois(struct app *app, struct ircd_client *c, const char *nick) {
    char shared[IRCD_LINE_MAX] = "";
    size_t used = 0;
    bool seen = false;
    pthread_mutex_lock(&app->lock);
    const char *sigils = NULL;
    network_prefixes_locked(app, c->network, NULL, &sigils);
    for (size_t i = 0; i < app->window_count; i++) {
        if (strcmp(app->windows[i].network, c->network) != 0) continue;
        struct window *w = &app->windows[i];
        if (!ircd_is_channel(w->channel)) continue;
        for (size_t k = 0; k < w->member_count; k++) {
            if (!ircd_name_equal(w->members[k].nick, nick)) continue;
            seen = true;
            char sig[8];
            ircd_member_sigils(w->members[k].modes, sigils ? sigils : "", false, sig, sizeof(sig));
            used += (size_t)snprintf(shared + used, sizeof(shared) - used, "%s%s%s",
                                     used ? " " : "", sig, w->channel);
        }
    }
    pthread_mutex_unlock(&app->lock);
    if (!seen) {
        ircd_numeric(app, c, 401, "%s :No such nick (not in any channel here)", nick);
        ircd_numeric(app, c, 318, "%s :End of /WHOIS list", nick);
        return;
    }
    ircd_numeric(app, c, 311, "%s %s grappa * :%s", nick, nick, nick);
    if (used) ircd_numeric(app, c, 319, "%s :%s", nick, shared);
    ircd_numeric(app, c, 312, "%s %s :bridged by shottino", nick, IRCD_SERVER);
    ircd_numeric(app, c, 318, "%s :End of /WHOIS list", nick);
}

static void ircd_dispatch(struct app *app, struct ircd_client *c, const char *raw) {
    struct ircd_msg m;
    if (!ircd_parse_line(raw, &m)) return;

    if (ircd_command_is(&m, "CAP")) {
        ircd_cmd_cap(app, c, &m);
        return;
    }
    if (ircd_command_is(&m, "PASS")) {
        if (m.param_count > 0) snprintf(c->pass, sizeof(c->pass), "%.*s", (int)sizeof(c->pass) - 1, m.params[0]);
        return;
    }
    if (ircd_command_is(&m, "USER")) {
        if (m.param_count > 0) snprintf(c->user, sizeof(c->user), "%.*s", (int)sizeof(c->user) - 1, m.params[0]);
        c->got_user = true;
        ircd_maybe_register(app, c);
        return;
    }
    if (ircd_command_is(&m, "PING")) {
        ircd_send(app, c, ":%s PONG %s :%s", IRCD_SERVER, IRCD_SERVER,
                  m.param_count > 0 ? m.params[0] : IRCD_SERVER);
        return;
    }
    if (ircd_command_is(&m, "PONG")) return;
    if (ircd_command_is(&m, "QUIT")) {
        ircd_send(app, c, "ERROR :Closing link");
        c->closing = true;
        return;
    }
    if (ircd_command_is(&m, "NICK")) {
        if (m.param_count == 0) return;
        if (!c->registered) {
            snprintf(c->nick, sizeof(c->nick), "%.*s", (int)sizeof(c->nick) - 1, m.params[0]);
            c->got_nick = true;
            ircd_maybe_register(app, c);
            return;
        }
        /* After registration a NICK is a real request against the
         * network: grappa answers with a nick_change that comes back
         * through the tee, so nothing is echoed here. */
        char line[IRCD_LINE_MAX];
        snprintf(line, sizeof(line), "NICK %s", m.params[0]);
        ircd_forward_raw(app, c, line);
        return;
    }

    if (!c->registered) {
        ircd_numeric(app, c, 451, ":You have not registered");
        return;
    }

    if (ircd_command_is(&m, "JOIN")) {
        if (m.param_count > 0) ircd_cmd_join(app, c, m.params[0]);
        return;
    }
    if (ircd_command_is(&m, "PART")) {
        if (m.param_count > 0) ircd_cmd_part(app, c, m.params[0]);
        return;
    }
    if (ircd_command_is(&m, "PRIVMSG") || ircd_command_is(&m, "NOTICE")) {
        ircd_cmd_privmsg(app, c, &m, ircd_command_is(&m, "NOTICE"));
        return;
    }
    if (ircd_command_is(&m, "NAMES")) {
        if (m.param_count > 0) ircd_send_names(app, c, m.params[0]);
        return;
    }
    if (ircd_command_is(&m, "WHO")) {
        if (m.param_count > 0) ircd_cmd_who(app, c, m.params[0]);
        return;
    }
    if (ircd_command_is(&m, "WHOIS")) {
        if (m.param_count > 0) ircd_cmd_whois(app, c, m.params[m.param_count - 1]);
        return;
    }
    if (ircd_command_is(&m, "TOPIC") && m.param_count == 1) {
        ircd_send_topic(app, c, m.params[0]);
        return;
    }
    if (ircd_command_is(&m, "CHATHISTORY")) {
        ircd_cmd_chathistory(app, c, &m);
        return;
    }

    /* Everything else — MODE, TOPIC with a new topic, AWAY, LIST,
     * INVITE, KICK, OPER, and whatever this server knows that this
     * bridge does not — goes upstream in the words the client used. That
     * is the difference between a bridge and a reimplementation. */
    char line[IRCD_LINE_MAX];
    size_t used = (size_t)snprintf(line, sizeof(line), "%s", m.command);
    for (size_t i = 0; i < m.param_count && used < sizeof(line); i++) {
        bool last = i + 1 == m.param_count;
        used += (size_t)snprintf(line + used, sizeof(line) - used, " %s%s",
                                 last && ircd_needs_trailing(m.params[i]) ? ":" : "", m.params[i]);
    }
    ircd_forward_raw(app, c, line);
}

/* ── Sockets ───────────────────────────────────────────────────────── */

static bool ircd_listen(struct app *app) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE | AI_NUMERICSERV;
    struct addrinfo *res = NULL;
    int err = getaddrinfo(app->ircd.host, app->ircd.port, &hints, &res);
    if (err != 0) {
        startup("ircd: cannot resolve %s:%s — %s", app->ircd.host, app->ircd.port,
                gai_strerror(err));
        return false;
    }
    /* A name can resolve to both stacks (localhost is the usual one), so
     * every address is bound rather than only the first: a client that
     * connects over ::1 must not find the door shut because v4 answered
     * first. */
    for (struct addrinfo *ai = res; ai && app->ircd.listen_count < IRCD_LISTEN_MAX; ai = ai->ai_next) {
        int fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        int on = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
#ifdef IPV6_V6ONLY
        /* Bind the two families SEPARATELY rather than relying on a
         * v4-mapped v6 socket, which is off by default on some systems
         * and on by default on others — the same spec producing a
         * different set of reachable addresses per OS is not a bridge
         * anyone can reason about. */
        if (ai->ai_family == AF_INET6) setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &on, sizeof(on));
#endif
        if (bind(fd, ai->ai_addr, ai->ai_addrlen) != 0 || listen(fd, 8) != 0) {
            startup("ircd: cannot listen on %s:%s — %s", app->ircd.host, app->ircd.port,
                    strerror(errno));
            close(fd);
            continue;
        }
        fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
        app->ircd.listen_fd[app->ircd.listen_count++] = fd;
    }
    freeaddrinfo(res);
    return app->ircd.listen_count > 0;
}

static void ircd_accept(struct app *app, int listen_fd) {
    for (;;) {
        int fd = accept(listen_fd, NULL, NULL);
        if (fd < 0) return;
        fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
        pthread_mutex_lock(&app->ircd.lock);
        struct ircd_client *slot = NULL;
        for (size_t i = 0; i < IRCD_MAX_CLIENTS && !slot; i++)
            if (app->ircd.clients[i].fd < 0) slot = &app->ircd.clients[i];
        if (slot) {
            memset(slot, 0, sizeof(*slot));
            slot->fd = fd;
            slot->id = ++app->ircd.next_client_id;
        }
        pthread_mutex_unlock(&app->ircd.lock);
        if (!slot) {
            const char *full = "ERROR :too many connections to this bridge\r\n";
            ssize_t w = send(fd, full, strlen(full), MSG_NOSIGNAL);
            (void)w;
            close(fd);
            startup("ircd: refused a connection — all %d slots are in use", IRCD_MAX_CLIENTS);
            continue;
        }
        startup("ircd: client connected");
    }
}

/* Read whatever arrived and dispatch the complete lines in it. The
 * dispatch runs WITHOUT the bridge lock — it calls into app state and
 * enqueues jobs — so the lines are copied out first. */
static void ircd_read(struct app *app, struct ircd_client *c) {
    char lines[32][IRCD_LINE_MAX];
    size_t count = 0;
    bool gone = false;

    pthread_mutex_lock(&app->ircd.lock);
    for (;;) {
        if (c->in_len >= sizeof(c->in) - 1) {
            /* A line longer than the buffer is not a line. */
            c->in_len = 0;
            break;
        }
        ssize_t n = recv(c->fd, c->in + c->in_len, sizeof(c->in) - 1 - c->in_len, 0);
        if (n > 0) {
            c->in_len += (size_t)n;
            continue;
        }
        if (n == 0) gone = true;
        else if (errno != EAGAIN && errno != EWOULDBLOCK) gone = true;
        break;
    }
    size_t start = 0;
    for (size_t i = 0; i < c->in_len; i++) {
        if (c->in[i] != '\n') continue;
        size_t len = i - start;
        if (len && c->in[start + len - 1] == '\r') len--;
        if (len && count < 32) {
            if (len >= IRCD_LINE_MAX) len = IRCD_LINE_MAX - 1;
            memcpy(lines[count], c->in + start, len);
            lines[count][len] = '\0';
            count++;
        }
        start = i + 1;
    }
    if (start) {
        memmove(c->in, c->in + start, c->in_len - start);
        c->in_len -= start;
    }
    if (gone) c->closing = true;
    pthread_mutex_unlock(&app->ircd.lock);

    for (size_t i = 0; i < count && !c->closing; i++) ircd_dispatch(app, c, lines[i]);
}

static bool ircd_start(struct app *app, const char *spec) {
    memset(&app->ircd, 0, sizeof(app->ircd));
    pthread_mutex_init(&app->ircd.lock, NULL);
    for (size_t i = 0; i < IRCD_MAX_CLIENTS; i++) app->ircd.clients[i].fd = -1;

    if (!ircd_parse_bind(spec, app->ircd.host, sizeof(app->ircd.host), app->ircd.port,
                         sizeof(app->ircd.port))) {
        startup("ircd: cannot read '%s' as a port, an address, or address:port", spec);
        return false;
    }
    const char *secret = getenv("SHOTTINO_IRCD_PASS");
    if (secret && *secret) snprintf(app->ircd.secret, sizeof(app->ircd.secret), "%s", secret);
    bool loopback = ircd_bind_is_loopback(app->ircd.host);
    app->ircd.secret_required = app->ircd.secret[0] != '\0' || !loopback;
    if (!loopback && !app->ircd.secret[0]) {
        /* Refusing is the whole point: anyone who reaches this port owns
         * the user's IRC session, and a bridge that came up anyway would
         * be discovered only by someone else using it. */
        startup("ircd: %s is reachable from other machines and SHOTTINO_IRCD_PASS is not set —"
                " refusing to listen",
                app->ircd.host);
        startup("ircd: set SHOTTINO_IRCD_PASS, or bind a loopback address (the default)");
        return false;
    }
    if (!ircd_listen(app)) return false;
    app->ircd.enabled = true;
    app->ircd.archive = app->ircd_archive_wanted;
    startup("ircd: listening on %s:%s (%s, password %s)", app->ircd.host, app->ircd.port,
            loopback ? "loopback only" : "REACHABLE FROM OTHER MACHINES",
            app->ircd.secret_required ? "required" : "not set");
    startup("ircd: connect an IRC client there; PASS <network>:<password> chooses the network");
    startup("ircd: CHATHISTORY reads %s", app->ircd.archive
                                              ? "this session, then grappa's stored scrollback"
                                              : "this session only (--ircd-archive reads further back)");
    return true;
}

static void ircd_stop(struct app *app) {
    pthread_mutex_lock(&app->ircd.lock);
    for (size_t i = 0; i < IRCD_MAX_CLIENTS; i++)
        if (app->ircd.clients[i].fd >= 0) ircd_drop_locked(&app->ircd.clients[i]);
    pthread_mutex_unlock(&app->ircd.lock);
    for (size_t i = 0; i < app->ircd.listen_count; i++) close(app->ircd.listen_fd[i]);
    app->ircd.listen_count = 0;
    app->ircd.enabled = false;
    pthread_mutex_destroy(&app->ircd.lock);
}

/* Where a detached bridge writes what it would have printed. Beside the
 * cached tokens, because that is already the directory this client owns
 * on the machine. */
static void ircd_log_path(char *out, size_t out_sz) {
    const char *home = getenv("HOME");
    if (!home || !*home) home = ".";
    char dir[PATH_MAX - 16];
    snprintf(dir, sizeof(dir), "%s/.local/share/shottino", home);
    mkdir(dir, 0700);
    snprintf(out, out_sz, "%s/ircd.log", dir);
}

/* Detach into the background.
 *
 * Called at ONE point and no earlier: after the login, after the
 * scrollback, after the websocket, and after the listener is bound. Every
 * one of those can fail for a reason the user needs to read — a bad
 * password, a port already in use — and a daemon that forks first
 * reports them into a log file nobody knew to look at, having already
 * returned 0 to the shell. Backgrounding is the last thing that happens,
 * so exit status still means "did it start".
 *
 * And BEFORE the worker thread exists: fork() carries over only the
 * calling thread, so a mutex another thread happened to hold would stay
 * locked forever in the child. That ordering is not a preference.
 *
 * The parent leaves with _exit() rather than returning: it shares the
 * websocket and the TLS session with the child, and an orderly exit
 * would send OpenSSL's close_notify down a connection the child is still
 * using. */
static bool ircd_daemonize(struct app *app) {
    char log[PATH_MAX];
    ircd_log_path(log, sizeof(log));
    int fd = open(log, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd < 0) {
        startup("ircd: cannot open %s — staying in the foreground", log);
        return false;
    }
    fflush(stdout);
    fflush(stderr);
    pid_t pid = fork();
    if (pid < 0) {
        startup("ircd: cannot fork — staying in the foreground");
        close(fd);
        return false;
    }
    if (pid > 0) {
        /* Say where it went and what to look at BEFORE leaving: a
         * background process with no pid and no log path is a process
         * the user can only find with pgrep. */
        fprintf(stderr, "shottino: ircd running in the background (pid %ld)\n", (long)pid);
        fprintf(stderr, "shottino: log: %s\n", log);
        fprintf(stderr, "shottino: stop it with: kill %ld\n", (long)pid);
        fflush(stderr);
        _exit(0);
    }
    /* Its own session, so it survives the terminal closing and no longer
     * takes Ctrl-C meant for whatever the user runs next. */
    if (setsid() < 0) startup("ircd: setsid failed — the bridge will still run");
    int null_fd = open("/dev/null", O_RDONLY);
    if (null_fd >= 0) {
        dup2(null_fd, STDIN_FILENO);
        if (null_fd > STDERR_FILENO) close(null_fd);
    }
    dup2(fd, STDOUT_FILENO);
    dup2(fd, STDERR_FILENO);
    if (fd > STDERR_FILENO) close(fd);
    /* The cwd is deliberately kept: a relative path the user gave on the
     * command line has to keep meaning what it meant when they typed it. */
    startup("ircd: detached (pid %ld), listening on %s:%s", (long)getpid(), app->ircd.host,
            app->ircd.port);
    return true;
}

/* The headless event loop: the websocket keeps app state current, and
 * poll() waits on the listeners and the connected clients. No terminal
 * is opened at all, which is why --ircd works over ssh, in a service
 * unit, or in a container with no tty. */
/* One pass over the listeners and the clients: accept, read, dispatch,
 * flush, reap. Split out from the loop so the suite can drive the bridge
 * over a real socket without a websocket or a grappa behind it — the
 * test then exercises THIS code rather than a copy of it. */
static void ircd_poll_once(struct app *app, int timeout_ms) {
    {
        struct pollfd fds[IRCD_LISTEN_MAX + IRCD_MAX_CLIENTS];
        struct ircd_client *owner[IRCD_LISTEN_MAX + IRCD_MAX_CLIENTS];
        nfds_t n = 0;
        for (size_t i = 0; i < app->ircd.listen_count; i++) {
            fds[n].fd = app->ircd.listen_fd[i];
            fds[n].events = POLLIN;
            fds[n].revents = 0;
            owner[n] = NULL;
            n++;
        }
        pthread_mutex_lock(&app->ircd.lock);
        for (size_t i = 0; i < IRCD_MAX_CLIENTS; i++) {
            struct ircd_client *c = &app->ircd.clients[i];
            if (c->fd < 0) continue;
            fds[n].fd = c->fd;
            fds[n].events = POLLIN | (c->out_len ? POLLOUT : 0);
            fds[n].revents = 0;
            owner[n] = c;
            n++;
        }
        pthread_mutex_unlock(&app->ircd.lock);

        int ready = poll(fds, n, timeout_ms);
        if (ready < 0 && errno != EINTR) return;

        for (nfds_t i = 0; i < n; i++) {
            if (!fds[i].revents) continue;
            if (!owner[i]) {
                ircd_accept(app, fds[i].fd);
                continue;
            }
            if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) ircd_read(app, owner[i]);
        }

        pthread_mutex_lock(&app->ircd.lock);
        for (size_t i = 0; i < IRCD_MAX_CLIENTS; i++) {
            struct ircd_client *c = &app->ircd.clients[i];
            if (c->fd < 0) continue;
            ircd_flush_locked(c);
            /* Dropped last, after the flush, so a client that asked to
             * QUIT still receives the ERROR that says why. */
            if (c->closing && c->out_len == 0) {
                ircd_drop_locked(c);
                startup("ircd: client disconnected");
            }
        }
        pthread_mutex_unlock(&app->ircd.lock);
    }
}

static void ircd_loop(struct app *app) {
    signal(SIGINT, ircd_signal_handler);
    signal(SIGTERM, ircd_signal_handler);
    app->running = true;
    while (app->running) {
        ws_pump(app);
        if (ircd_signalled) {
            startup("ircd: signal received, shutting down");
            app->running = false;
            break;
        }
        /* 50ms is the websocket's own cadence: the loop is awake often
         * enough that a message pushed by grappa reaches the client in
         * the tick it arrived. */
        ircd_poll_once(app, 50);
    }
    ircd_stop(app);
}

static void event_loop(struct app *app) {
    setlocale(LC_ALL, "");
    initscr();
    init_theme();
    /* After init_theme: the mIRC pair pool sits above the theme's fixed
     * pairs and needs COLORS/COLOR_PAIRS, which start_color() populates. */
    mirc_colors_init();
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    define_pane_keys();
    timeout(50);
    mouse_apply(app);
    app->running = true;
    while (app->running) {
        ws_pump(app);
        /* A requested preview displays as soon as the worker finishes.
         * Until then the client keeps running normally — that is the
         * whole point of splitting decode from display. */
        pthread_mutex_lock(&app->lock);
        bool preview_ready =
            app->preview_pending &&
            (app->preview.state == IM_READY || app->preview.state == IM_FAILED);
        pthread_mutex_unlock(&app->lock);
        if (preview_ready) show_preview(app);
        draw(app);
        int ch = getch();
        if (ch == ERR) continue;
        if (app->key_echo && ch != KEY_MOUSE) {
            const char *name = keyname(ch);
            log_line(app, "key: code=%d name=%s", ch, name ? name : "?");
        }
        if (ch == 27) ch = resolve_escape();
        if (overlay_key(app, ch)) continue;
        if (roster_key(app, ch)) continue;
        if (ch == 18) { /* Ctrl-R */
            open_reply_picker(app);
        } else if (ch == '\n' || ch == '\r') {
            handle_enter(app);
        } else if (ch == KEY_PANE_NEXT || ch == KEY_PANE_CYCLE) {
            focus_pane(app, 1);
        } else if (ch == KEY_PANE_PREV) {
            focus_pane(app, -1);
        } else if (ch == KEY_PANE_GROW) {
            resize_pane(app, 1);
        } else if (ch == KEY_PANE_SHRINK) {
            resize_pane(app, -1);
        } else if (ch == 27) {
            pthread_mutex_lock(&app->lock);
            app->panel = PANEL_CHAT;
            pthread_mutex_unlock(&app->lock);
        } else if (ch == KEY_MOUSE) {
            handle_mouse(app);
        } else if (ch == 14) {
            cycle_window(app, 1);
        } else if (ch == 16) {
            cycle_window(app, -1);
#ifdef KEY_CTAB
        } else if (ch == KEY_CTAB) {
            cycle_window(app, 1);
#endif
        } else if (ch == KEY_PPAGE) {
            scroll_chat(app, 10);
        } else if (ch == KEY_NPAGE) {
            scroll_chat(app, -10);
        } else if (ch == KEY_ROSTER_UP
#ifdef KEY_SPREVIOUS
                   || ch == KEY_SPREVIOUS
#endif
#ifdef KEY_SR
                   || ch == KEY_SR
#endif
        ) {
            scroll_members(app, -3);
        } else if (ch == KEY_ROSTER_DOWN
#ifdef KEY_SNEXT
                   || ch == KEY_SNEXT
#endif
#ifdef KEY_SF
                   || ch == KEY_SF
#endif
        ) {
            scroll_members(app, 3);
        } else if (ch == KEY_CHAT_UP) {
            scroll_chat(app, 1);
        } else if (ch == KEY_CHAT_DOWN) {
            scroll_chat(app, -1);
        } else if (ch == KEY_HOME) {
            scroll_chat(app, 1000000);
        } else if (ch == KEY_END) {
            scroll_bottom(app);
        } else if (ch == '\t' || ch == KEY_BTAB) {
            complete_input(app);
        } else if (ch == KEY_UP) {
            history_prev(app);
        } else if (ch == KEY_DOWN) {
            history_next(app);
        } else if (ch == KEY_BACKSPACE || ch == 127 || ch == 8) {
            if (app->input_len > 0) app->input[--app->input_len] = 0;
        } else if (isprint(ch) && app->input_len + 1 < sizeof(app->input)) {
            app->input[app->input_len++] = (char)ch;
            app->input[app->input_len] = 0;
        }
    }
    mouse_reporting(false);
    endwin();
}

/* Usage text, written to `out` so `--help` can go to stdout and exit 0
 * while a usage ERROR goes to stderr and exits 2 — the distinction every
 * other CLI makes, and the one that lets a packaging smoke test tell
 * "the binary runs" apart from "the binary is broken". */
static void print_usage(FILE *out, const char *prog) {
    fprintf(out, "usage: %s [--auto|--user|--visitor] https://grappa.example.net IDENTIFIER PASSWORD\n", prog);
    fprintf(out, "       %s --user --login-email user@example.net https://grappa.example.net PASSWORD\n", prog);
    fprintf(out, "       %s --share https://grappa.example.net/share/<token>\n", prog);
    fprintf(out, "\n");
    fprintf(out, "  --auto           let the server classify the identifier (default)\n");
    fprintf(out, "  --user           registered-user login; a plain account name becomes\n");
    fprintf(out, "                   name@shottino.local\n");
    fprintf(out, "  --visitor        visitor nick flow\n");
    fprintf(out, "  --login-email E  use E as the grappa login identifier; the IRC nick comes\n");
    fprintf(out, "                   from the network credential, not from the email\n");
    fprintf(out, "  --share URL      consume a visitor session-share link (mint one with /share);\n");
    fprintf(out, "                   both host and token are read from the URL\n");
    fprintf(out, "  --ircd[=ADDR]    run headless and listen as an IRC SERVER, bridging a normal\n");
    fprintf(out, "                   IRC client to grappa. ADDR is a port, an address, or\n");
    fprintf(out, "                   address:port, v4 or v6 (default 127.0.0.1:6667; write a v6\n");
    fprintf(out, "                   address with a port as [::1]:6667). One connection is one\n");
    fprintf(out, "                   network: the client picks it with PASS <network>:<password>.\n");
    fprintf(out, "                   Off loopback, SHOTTINO_IRCD_PASS is required.\n");
    fprintf(out, "  --ircd-archive   let a client's CHATHISTORY reach past this session into\n");
    fprintf(out, "                   grappa's stored scrollback. One REST query per request that\n");
    fprintf(out, "                   the session's own history cannot answer, so it is opt-in.\n");
    fprintf(out, "  --foreground     with --ircd, stay in the foreground instead of detaching.\n");
    fprintf(out, "                   What a service manager wants: it supervises the process it\n");
    fprintf(out, "                   started, and a daemon that forks away looks like a crash.\n");
    fprintf(out, "  --help, -h       show this help and exit\n");
    fprintf(out, "\n");
    fprintf(out, "examples:\n");
    fprintf(out, "  shottino https://grappa.example.net vjt hunter2\n");
    fprintf(out, "  shottino --user --login-email vjt@example.net https://grappa.example.net hunter2\n");
    fprintf(out, "  shottino --ircd=6668 https://grappa.example.net vjt hunter2   # then: /connect localhost 6668\n");
    fprintf(out, "\n");
    fprintf(out, "environment:\n");
    fprintf(out, "  SHOTTINO_IRCD_PASS   password downstream IRC clients must send with --ircd.\n");
    fprintf(out, "                       REQUIRED to bind anything but a loopback address, since a\n");
    fprintf(out, "                       bridge hands over the whole IRC session to whoever connects.\n");
    fprintf(out, "  SHOTTINO_GRAPHICS    1 forces the terminal-graphics path when it cannot be\n");
    fprintf(out, "                       probed (sixel); kitty|iterm2|sixel forces one protocol.\n");
    fprintf(out, "  SHOTTINO_LAYOUT_LOG  file to dump the chat area's per-row measure-vs-draw\n");
    fprintf(out, "                       numbers into, for reporting a missing or clipped line.\n");
    fprintf(out, "  TMPDIR               where /view downloads land (removed when shottino exits).\n");
    fprintf(out, "\n");
    fprintf(out, "files:\n");
    fprintf(out, "  ~/.local/share/shottino/   cached session tokens, one per (server, identity)\n");
    fprintf(out, "\n");
    fprintf(out, "requires ffmpeg for inline pictures and clips; without it they stay off and\n");
    fprintf(out, "links remain clickable. Inline media is otherwise ON FOR EVERY HOST, which means\n");
    fprintf(out, "an image linked in a channel is fetched when you scroll to it, so that host\n");
    fprintf(out, "learns your IP — /media first-party limits it to your own deployment's uploads.\n");
    fprintf(out, "\nOnce connected, /help lists every command.\n");
}

/* #451/#324 — retain the deployment's HTTP host aliases at boot from the
 * same /api/server-settings payload cic reads (ServerSettings.public_view
 * → http_host_aliases). Used with app->url.host to classify first-party
 * /uploads/ links for inline auto-render. On any failure the set stays
 * empty, which is the restrictive fallback: only the connect host is
 * first-party. Fetched BEFORE the first scrollback render so seeded rows
 * classify correctly. */
static void load_http_host_aliases(struct app *app) {
    app->http_host_alias_count = 0;
    struct http_response r = http_request(app, "GET", "/api/server-settings", NULL);
    if (r.status >= 200 && r.status < 300 && r.body) {
        json_doc *doc = json_parse(r.body, r.body_len, NULL, 0);
        if (doc) {
            const json_value *list = json_get(json_root(doc), "http_host_aliases");
            if (list)
                for (size_t i = 0; i < json_len(list) &&
                                   app->http_host_alias_count < MAX_HTTP_ALIASES;
                     i++) {
                    const char *h = json_string(json_at(list, i));
                    if (h && h[0])
                        snprintf(app->http_host_aliases[app->http_host_alias_count++],
                                 sizeof(app->http_host_aliases[0]), "%s", h);
                }
            json_free(doc);
        }
    }
    free(r.body);
}

int main(int argc, char **argv) {
    const char *mode = "auto";
    const char *login_override = NULL;
    bool ircd_enabled = false;
    bool ircd_archive = false;
    bool foreground = false;
    const char *ircd_spec = "";
    /* Checked before the option loop so --help works from any position and
     * never requires the other arguments to be present. */
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(stdout, argv[0]);
            return 0;
        }
    }
    /* Options are accepted ANYWHERE, not only before the first positional.
     *
     * The old loop stopped at the first non-option argument, so
     * `shottino https://host --user name pass` silently ignored --user:
     * the client fell back to auto mode and the server classified the
     * name as a VISITOR nick. Nothing said so — the run looked
     * successful, just as the wrong kind of session, with different
     * persistence and a different subject key.
     *
     * A flag that is read in one position and ignored in another is worse
     * than one that is rejected: the failure is silent and the result is
     * plausible. Positionals are collected separately so order stops
     * mattering. */
    const char *positional[8];
    int positional_count = 0;
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (strncmp(a, "--", 2) != 0) {
            if (positional_count < (int)(sizeof(positional) / sizeof(positional[0])))
                positional[positional_count++] = a;
            continue;
        }
        if (strcmp(a, "--ircd") == 0) {
            ircd_enabled = true;
            ircd_spec = "";
        } else if (strncmp(a, "--ircd=", 7) == 0) {
            /* Only the =SPEC form. `--ircd 6667` would be indistinguishable
             * from a positional — and the positional it would eat is the
             * password. A loud usage error beats guessing. */
            ircd_enabled = true;
            ircd_spec = a + 7;
        } else if (strcmp(a, "--ircd-archive") == 0) {
            ircd_archive = true;
        } else if (strcmp(a, "--foreground") == 0) {
            foreground = true;
        } else if (strcmp(a, "--user") == 0) mode = "user";
        else if (strcmp(a, "--visitor") == 0) mode = "visitor";
        else if (strcmp(a, "--share") == 0) mode = "share";
        else if (strcmp(a, "--auto") == 0) mode = "auto";
        else if (strcmp(a, "--login-email") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "--login-email requires an email-like identifier\n");
                return 2;
            }
            mode = "user";
            login_override = argv[++i];
        } else if (strncmp(a, "--login-email=", 14) == 0) {
            mode = "user";
            login_override = a + 14;
        } else {
            fprintf(stderr, "unknown option: %s\n", a);
            return 2;
        }
    }
    bool share_mode = strcmp(mode, "share") == 0;
    int expected = share_mode ? 1 : (login_override ? 2 : 3);
    if (positional_count != expected) {
        /* Usage ERROR: stderr + exit 2. One definition of the text,
         * shared with --help, so the two cannot drift. */
        print_usage(stderr, argv[0]);
        return 2;
    }

    /* A write to a socket whose peer has gone raises SIGPIPE, whose
     * default action is to kill the process. That is true of the
     * websocket as well as of a downstream bridge client — the terminal
     * UI simply had not met the failure yet. Errors come back from
     * send()/write() instead. */
    signal(SIGPIPE, SIG_IGN);
    startup("starting (%s mode)", mode);
    SSL_library_init();
    SSL_load_error_strings();
    struct app *app = calloc(1, sizeof(*app));
    if (!app) die("out of memory");
    pthread_mutex_init(&app->lock, NULL);
    pthread_mutex_init(&app->jobs_lock, NULL);
    pthread_cond_init(&app->jobs_cond, NULL);
    app->ws.fd = -1;
    /* Mouse tracking ON by default.
     *
     * It costs the terminal's own click-drag selection, which is a real
     * cost and the reason it used to be off — but Shift-drag overrides
     * tracking in every terminal that matters (xterm, vte, konsole,
     * kitty, alacritty, iTerm2), while a right-click menu, a clickable
     * link and a scrollable roster are unreachable without it. A feature
     * nobody discovers is a feature nobody has; a selection that needs
     * Shift is a selection that still works. Announced at startup rather
     * than left to be noticed, and /mouse off restores the old
     * behaviour. */
    app->mouse_enabled = true;
    /* Inline media, for ALL hosts, when there is something to decode
     * with. Every picture and clip goes through ffmpeg, so without it
     * the setting would promise pictures and deliver "[image could not
     * be decoded]" on every row — the honest default is the one the
     * machine can keep. */
    bool have_ffmpeg = media_tool_available("ffmpeg");
    app->inline_media_enabled = have_ffmpeg;
    app->inline_media_peers = have_ffmpeg;
    app->animate_media = have_ffmpeg;
    char *share_base = NULL, *share_token = NULL;
    const char *server_url;
    if (share_mode) {
        if (!split_share_url(positional[0], &share_base, &share_token))
            die("invalid share URL; expected https://host/share/<token>");
        server_url = share_base;
    } else {
        server_url = positional[0];
    }
    startup("parsing server URL %s", server_url);
    if (!parse_url(server_url, &app->url)) die("invalid base URL: %s", server_url);
    startup("initializing TLS context");
    app->ssl_ctx = SSL_CTX_new(TLS_client_method());
    if (!app->ssl_ctx) die("failed to create TLS context");
    SSL_CTX_set_default_verify_paths(app->ssl_ctx);
    SSL_CTX_set_verify(app->ssl_ctx, SSL_VERIFY_PEER, NULL);

    bool authed;
    if (share_mode) {
        startup("consuming share link");
        authed = attach_or_consume(app, app->url.base, share_token);
        free(share_base);
        free(share_token);
    } else {
        const char *identifier = login_override ? login_override : positional[1];
        const char *password = login_override ? positional[1] : positional[2];
        if (!login_override && strchr(identifier, '@') == NULL) snprintf(app->login_nick, sizeof(app->login_nick), "%s", identifier);
        char *login_id = login_identifier_for_mode(mode, identifier);
        startup("authenticating as %s", login_id);
        authed = attach_or_login(app, login_id, password);
        free(login_id);
    }
    if (!authed) {
        pthread_cond_destroy(&app->jobs_cond);
        pthread_mutex_destroy(&app->jobs_lock);
        pthread_mutex_destroy(&app->lock);
        SSL_CTX_free(app->ssl_ctx);
        free(app);
        return 1;
    }
    startup("authenticated as %s", app->subject);
    startup("loading networks and channels");
    /* Probe BEFORE the first scrollback fetch. Detection has to precede
     * ncurses anyway (the sixel DA1 query needs the raw tty), and it has
     * to precede parsing too: rows parsed while the protocol is unknown
     * and the feature still off get no image attached, which is why the
     * first screenful used to come up pictureless. */
    app->headless = ircd_enabled;
    if (app->headless) {
        /* Nothing draws, so nothing decodes: the probe wants a raw tty
         * that a service unit does not have, and an inline picture has
         * no cell grid to land on. */
        app->inline_media_enabled = false;
        startup("headless: no terminal, no inline media");
    } else {
        app->proto = media_detect(STDIN_FILENO, 120);
        startup("terminal graphics: %s", media_protocol_name(app->proto));
    }
    /* Retain the deployment's upload host set BEFORE any scrollback
     * renders, so first-party /uploads/ links classify from frame one. */
    load_http_host_aliases(app);
    startup("first-party upload hosts: %s + %zu alias(es)", app->url.host,
            app->http_host_alias_count);
    if (!app->headless) {
        if (have_ffmpeg) {
            /* Said out loud, every start. The exposure #451 identified is
             * unchanged by being the default — what changes is who chose
             * it, so the choice has to be visible rather than discovered
             * by someone reading the source. */
            log_line(app, "inline media ON for ALL hosts: an image or clip linked in a channel is");
            log_line(app, "  fetched when its row scrolls into view, so that host learns your IP and");
            log_line(app, "  when you read. /media first-party limits this to %s uploads; /media off",
                     app->url.host);
            log_line(app, "  turns pictures off entirely.");
        } else {
            log_line(app, "ffmpeg not found — inline media is off (it decodes every picture and clip)."
                          " Install it, then /media on");
        }
        log_line(app, "mouse tracking ON — click links, right-click a message, wheel over the "
                      "userlist; hold Shift to select text as usual, or /mouse off");
    }
    seed_state(app);
    startup("loading initial scrollback for %zu windows", app->window_count);
    for (size_t i = 0; i < app->window_count; i++) fetch_scrollback(app, &app->windows[i]);
    startup("connecting websocket");
    if (ws_connect(app)) {
        startup("joining websocket topics");
        ws_join_topics(app);
        log_line(app, "websocket connected");
    } else {
        /* Arm the retry timer rather than settling permanently into
         * REST-only mode: a server still coming up is the common cause of
         * a failed first connect, and it will be ready in seconds. */
        ws_schedule_retry(app);
        startup("websocket unavailable; will retry");
        log_line(app, "websocket unavailable; retrying in %ds (REST send/fetch still works)",
                 (int)(app->ws_retry_at - time(NULL)));
    }
    /* The listener is bound, and the process detaches, BEFORE the worker
     * thread is created: fork() takes only the calling thread with it,
     * and a lock held by another one would never be released in the
     * child. Binding first also means a port already in use is still a
     * foreground failure with a non-zero exit. */
    if (ircd_enabled) {
        app->ircd_archive_wanted = ircd_archive;
        if (!ircd_start(app, ircd_spec)) {
            /* The listener is the whole point of the mode: coming up
             * without one would look like it worked. */
            if (app->ws_connected) conn_close(&app->ws);
            SSL_CTX_free(app->ssl_ctx);
            free(app);
            return 1;
        }
        if (!foreground) ircd_daemonize(app);
    }
    startup("starting background worker");
    pthread_create(&app->worker, NULL, worker_main, app);
    if (ircd_enabled) {
        ircd_loop(app);
    } else {
        startup("entering terminal UI");
        event_loop(app);
    }
    pthread_mutex_lock(&app->jobs_lock);
    app->worker_stop = true;
    pthread_cond_signal(&app->jobs_cond);
    pthread_mutex_unlock(&app->jobs_lock);
    pthread_join(app->worker, NULL);
    if (app->ws_connected) conn_close(&app->ws);
    /* After the worker is joined, so nothing is still writing into it. */
    view_dir_cleanup(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_cond_destroy(&app->jobs_cond);
    pthread_mutex_destroy(&app->jobs_lock);
    pthread_mutex_destroy(&app->lock);
    SSL_CTX_free(app->ssl_ctx);
    free(app);
    return 0;
}
