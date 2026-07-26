/* wire.h — typed narrowing for grappa's Phoenix event surface.
 *
 * This is the C twin of cicchetto's `lib/wireNarrow.ts` (per-channel topic)
 * and `lib/userTopic.ts`'s `narrowUserEvent` (user topic). Same contract,
 * same strictness, deliberately the same field-by-field order so the two
 * can be diffed by eye when the server grows an arm.
 *
 * Why narrow at all, in C, when we could just read fields at the point of
 * use? Because the wire is a boundary. A malformed push — kind valid but a
 * required field missing or wrong-typed — must be DROPPED as a unit, not
 * half-applied to app state. Reading fields lazily at the use site means a
 * payload can pass three checks, mutate three pieces of state, then fail
 * the fourth and leave the window list describing a session that never
 * happened. `wire_narrow` either yields a fully-valid event or false.
 *
 * ## Ownership
 *
 * Narrowing BORROWS from the `json_doc` it was parsed out of: every
 * `const char *` and every `const json_value *` in `struct wire_event`
 * points into that document's arena. The event is valid exactly as long as
 * the document. Callers copy what they need into app state before freeing.
 * Nothing here allocates, so nothing here can leak or need a destructor.
 *
 * ## Arrays
 *
 * Variable-length payloads (members, whois channels, banlist entries)
 * stay as `const json_value *` plus a count, with a typed per-element
 * accessor. `wire_narrow` has ALREADY validated every element before
 * returning true — the accessors cannot fail on a narrowed event. This
 * keeps the strict "one malformed element drops the whole payload"
 * semantics of the cic narrowers without allocating a parallel array.
 *
 * ## Nullability
 *
 * The wire distinguishes "absent/null" from "present". Nullable strings
 * are `const char *` that may be NULL. Nullable numbers are a `long` plus
 * a `has_` flag, because 0 is a legitimate value for every count here.
 */
#ifndef SHOTTINO_WIRE_H
#define SHOTTINO_WIRE_H

#include <stdbool.h>
#include <stddef.h>

#include "json.h"

/* ── Closed sets ───────────────────────────────────────────────────────
 * Mirrors of server-side typespecs. An unknown value is a narrowing
 * failure, never a silently-tolerated string — same rule as the project's
 * "atoms or literal unions, never untyped strings" standard. */

typedef enum {
    MSG_PRIVMSG,
    MSG_NOTICE,
    MSG_ACTION,
    MSG_JOIN,
    MSG_PART,
    MSG_QUIT,
    MSG_NICK_CHANGE,
    MSG_MODE,
    MSG_TOPIC,
    MSG_KICK,
    MSG_SERVER_EVENT
} wire_message_kind;

typedef enum { CONN_CONNECTED, CONN_PARKED, CONN_FAILED } wire_connection_state;

typedef enum { PRESENCE_ONLINE, PRESENCE_OFFLINE, PRESENCE_UNKNOWN } wire_presence;

/* Mirror of `Grappa.WindowCounts.severity/0` — high to low. Singular
 * names, matching the server atoms (`:mention`, not `:mentions`). */
typedef enum {
    COUNTS_MENTION,
    COUNTS_MESSAGE,
    COUNTS_EVENT,
    COUNTS_NONE
} wire_counts_severity;

typedef enum { REPLY_INFO, REPLY_VERSION, REPLY_MOTD } wire_reply_source;

const char *wire_message_kind_name(wire_message_kind k);
const char *wire_connection_state_name(wire_connection_state s);

/* ── Event kinds ─────────────────────────────────────────────────────── */

typedef enum {
    WIRE_UNKNOWN = 0,
    /* per-channel topic */
    WIRE_MESSAGE,
    WIRE_TOPIC_CHANGED,
    WIRE_CHANNEL_MODES_CHANGED,
    WIRE_CHANNEL_CREATED,
    WIRE_MEMBERS_SEEDED,
    WIRE_READ_CURSOR_SET,
    WIRE_WINDOW_COUNTS,
    /* dual-topic */
    WIRE_ISUPPORT_CHANGED,
    WIRE_JOINED,
    WIRE_JOIN_FAILED,
    WIRE_KICKED,
    /* user topic */
    WIRE_CHANNELS_CHANGED,
    WIRE_QUERY_WINDOWS_LIST,
    WIRE_MENTIONS_BUNDLE,
    WIRE_AWAY_CONFIRMED,
    WIRE_CONNECTION_PROGRESS,
    WIRE_NOTIFY_LIST,
    WIRE_PRESENCE_CHANGED,
    WIRE_PRESENCE_ERROR,
    WIRE_PRESENCE_SNAPSHOT,
    WIRE_OWN_NICK_CHANGED,
    WIRE_UMODE_CHANGED,
    WIRE_SUPPORTED_UMODES_CHANGED,
    WIRE_WINDOW_PENDING,
    WIRE_WINDOW_INVITED,
    WIRE_CONNECTION_STATE_CHANGED,
    WIRE_WHOIS_BUNDLE,
    WIRE_NAMES_REPLY,
    WIRE_WHO_REPLY,
    WIRE_SERVER_REPLY,
    WIRE_INVITE_ACK,
    WIRE_BUNDLE_HASH,
    WIRE_SERVER_SETTINGS_CHANGED,
    WIRE_PEER_AWAY,
    WIRE_LUSERS_BUNDLE,
    WIRE_WHOWAS_BUNDLE,
    WIRE_BANLIST_BUNDLE,
    WIRE_LINKS_BUNDLE,
    WIRE_ARCHIVE_CHANGED,
    WIRE_ARCHIVE_PURGED,
    WIRE_DIRECTORY_PROGRESS,
    WIRE_DIRECTORY_COMPLETE,
    WIRE_DIRECTORY_FAILED
} wire_kind;

const char *wire_kind_name(wire_kind k);

/* ── Element shapes (borrowed, per-element accessors) ────────────────── */

struct wire_member {
    const char *nick;
    const json_value *modes; /* array of mode letters, possibly empty */
    size_t mode_count;
};

struct wire_who_user {
    const char *nick;
    const char *user;
    const char *host;
    const char *server;
    const char *modes; /* raw WHO flags STRING, not a prefix list */
    const char *channel;
    long hops;
    bool has_hops;
    const char *realname; /* nullable */
};

struct wire_banlist_entry {
    const char *mask;
    const char *setter; /* nullable */
    const char *set_ts; /* nullable */
};

struct wire_links_entry {
    const char *server;
    const char *linked_to; /* nullable */
    long hopcount;
    bool has_hopcount;
    const char *description; /* nullable */
};

struct wire_whois_extra {
    long numeric;
    const char *text;
};

struct wire_mention {
    long server_time;
    const char *channel;
    const char *sender;
    const char *body; /* nullable */
    wire_message_kind kind;
};

struct wire_scrollback_message {
    long id;
    const char *network;
    const char *channel;
    long server_time;
    wire_message_kind kind;
    const char *sender;
    const char *body;         /* nullable */
    const json_value *meta;   /* object; opaque bag, read per call site */
};

/* ── The event ───────────────────────────────────────────────────────── */

struct wire_event {
    wire_kind kind;
    union {
        struct wire_scrollback_message message;

        struct {
            const char *network;
            const char *channel;
            const char *text;   /* nullable */
            const char *set_by; /* nullable */
            const char *set_at; /* nullable */
        } topic_changed;

        struct {
            const char *network;
            const char *channel;
            const json_value *modes; /* array of strings */
            size_t mode_count;
            const json_value *params; /* object: mode letter -> arg|null */
        } channel_modes;

        struct {
            const char *network;
            const char *channel;
            const char *created_at;
        } channel_created;

        struct {
            const char *network;
            const char *channel;
            const json_value *members; /* array; use wire_member_at */
            size_t member_count;
        } members_seeded;

        struct {
            long last_read_message_id;
            long badge_count;
        } read_cursor;

        struct {
            const char *channel;
            long messages;
            long mentions;
            long events;
            wire_counts_severity severity;
        } window_counts;

        struct {
            long network_id;
            const json_value *chanmodes_a;
            const json_value *chanmodes_b;
            const json_value *chanmodes_c;
            const json_value *chanmodes_d;
            const json_value *prefix; /* object: mode letter -> sigil */
        } isupport;

        /* joined / join_failed / kicked share a head so the common
         * (network, channel) read needs no per-kind switch. */
        struct {
            const char *network;
            const char *channel;
            const char *reason; /* join_failed + kicked; nullable */
            const char *by;     /* kicked only; nullable */
            long numeric;       /* join_failed only */
            bool has_numeric;
        } window_state;

        struct {
            const json_value *windows; /* object: nick -> array of entries */
            size_t nick_count;
        } query_windows;

        struct {
            const char *network;
            const char *away_started_at;
            const char *away_ended_at;
            const char *away_reason; /* nullable */
            const json_value *messages;
            size_t message_count;
        } mentions_bundle;

        struct {
            const char *network;
            bool away; /* state: "away" | "present" */
        } away_confirmed;

        struct {
            const char *network;
            bool connected; /* state: "connected" | "connecting" */
        } connection_progress;

        struct {
            const json_value *networks; /* object: slug -> array of entries */
            size_t network_count;
        } notify_list;

        struct {
            long network_id;
            const char *nick;
            bool online;
            bool initial;
            bool from_monitor; /* source: "monitor" | "watch" */
            const char *ts;
        } presence_changed;

        struct {
            long network_id;
            const char *detail;
        } presence_error;

        struct {
            long network_id;
            const json_value *nicks; /* object: nick -> presence string */
            size_t nick_count;
        } presence_snapshot;

        struct {
            long network_id;
            const char *nick;
        } own_nick;

        struct {
            long network_id;
            const json_value *modes; /* array of letters */
            size_t mode_count;
        } umodes;

        struct {
            const char *network;
            const char *channel;
        } window_open; /* window_pending / window_invited */

        struct {
            long network_id;
            const char *network_slug;
            wire_connection_state from;
            wire_connection_state to;
            const char *reason; /* nullable */
            const char *at;     /* nullable */
            const char *nick;
            wire_connection_state state;
            const char *state_reason; /* nullable */
        } connection_state;

        struct {
            const char *network;
            const char *target;
            const char *user;
            const char *host;
            const char *realname;
            const char *server;
            const char *server_info;
            const char *oper_text;
            const char *umodes;
            const char *away_message;
            const char *actually_host;
            const char *actually_ip;
            const char *account;
            const char *secure_cipher;
            const char *certfp;
            long idle_seconds;
            bool has_idle;
            long signon;
            bool has_signon;
            bool is_operator;
            bool using_ssl;
            bool is_registered;
            bool is_admin;
            bool is_services_admin;
            bool is_helper;
            bool is_chanop;
            bool is_agent;
            bool is_java;
            bool secure;
            const json_value *channels; /* array of strings; may be absent */
            size_t channel_count;
            bool has_channels;
            const json_value *extra_lines; /* array of {numeric,text} */
            size_t extra_count;
        } whois;

        struct {
            const char *network;
            const char *channel;
            const json_value *members;
            size_t member_count;
        } names_reply;

        struct {
            const char *network;
            const char *target;
            const json_value *users;
            size_t user_count;
        } who_reply;

        struct {
            const char *network;
            wire_reply_source source;
            const json_value *lines;
            size_t line_count;
        } server_reply;

        struct {
            const char *network;
            const char *channel;
            const char *peer;
        } invite_ack;

        struct {
            const char *hash;
            const char *version; /* nullable */
        } bundle_hash;

        struct {
            const char *active_host;
            long image_cap;
            long video_cap;
            long document_cap;
            long audio_cap;
            long global_cap;
            const json_value *host_aliases; /* lenient: may be NULL */
            size_t alias_count;
        } server_settings;

        struct {
            const char *network;
            const char *peer;
            const char *message;
        } peer_away;

        struct {
            const char *network;
            /* Every count is optional; a garbled one renders "—" rather
             * than dropping the eleven good counts beside it. */
            long total_users, invisible, servers, operators, unknown_connections;
            long channels_formed, local_clients, local_servers;
            long current_local, max_local, current_global, max_global;
            bool has[12];
        } lusers;

        struct {
            const char *network;
            const char *target;
            const char *user;
            const char *host;
            const char *realname;
            const char *server;
            const char *logoff_time;
            bool not_found;
        } whowas;

        struct {
            const char *network;
            const char *channel;
            const json_value *entries;
            size_t entry_count;
        } banlist;

        struct {
            const char *network;
            const json_value *entries;
            size_t entry_count;
        } links;

        struct {
            const char *network_slug;
            const char *target; /* archive_purged only */
        } archive;

        struct {
            const char *network;
            long count;   /* progress: seen so far; complete: total */
            const char *reason; /* failed only */
        } directory;
    } u;
};

/* Index into `lusers.has[]` — one name per optional count, so a caller
 * cannot silently read the wrong flag. */
enum {
    LUSERS_TOTAL_USERS,
    LUSERS_INVISIBLE,
    LUSERS_SERVERS,
    LUSERS_OPERATORS,
    LUSERS_UNKNOWN_CONNECTIONS,
    LUSERS_CHANNELS_FORMED,
    LUSERS_LOCAL_CLIENTS,
    LUSERS_LOCAL_SERVERS,
    LUSERS_CURRENT_LOCAL,
    LUSERS_MAX_LOCAL,
    LUSERS_CURRENT_GLOBAL,
    LUSERS_MAX_GLOBAL
};

/* Resolve the PubSub subject key from an auth or profile response.
 *
 * Not a Phoenix event, but the same job as everything else here: server
 * JSON in, a typed value out — and it lives beside the narrowers so it is
 * testable without a terminal, which is what this function most needed.
 *
 * TWO wire shapes, and both must be read:
 *
 *   POST /auth/login          → {token, subject: {kind, id, name}}
 *   POST /auth/share/consume  → {token, subject: {kind, id, ...}}
 *   GET  /me                  → {kind, id, name, ...}   (subject FLAT)
 *
 * Login and share-consume are credential EXCHANGES, so they wrap the
 * subject in an envelope beside the token; `/me` IS the subject, so its
 * fields sit at the root. This prefers the nested object and falls back
 * to the root, covering all three without a per-call-site flag.
 *
 * Writes an empty string and returns false when the subject cannot be
 * resolved, so a caller reports "missing subject" rather than proceeding
 * with a half-formed key like "visitor:" that would become a topic. */
bool wire_subject_key(const json_value *root, char *out, size_t out_sz);

/* Narrow a bare scrollback row.
 *
 * The same row shape arrives two ways: nested under `message` in a WS
 * event, and as an element of the REST scrollback page. Exported so both
 * paths share ONE definition of what a scrollback row is, rather than the
 * REST side growing a second, drifting reader. */
bool wire_narrow_message(const json_value *row, struct wire_scrollback_message *out);

/* Narrow one event payload. Returns false (leaving `*ev` untouched) when
 * the payload is malformed OR the kind is one shottino does not consume —
 * the caller treats both as "drop", exactly like cic's default-null arm. */
bool wire_narrow(const json_value *payload, struct wire_event *ev);

/* ── Element accessors ─────────────────────────────────────────────────
 * Valid only on arrays reached from an event that `wire_narrow` accepted;
 * every element was validated during narrowing, so these cannot fail for
 * an in-range index. */
bool wire_member_at(const json_value *members, size_t i, struct wire_member *out);
bool wire_who_user_at(const json_value *users, size_t i, struct wire_who_user *out);
bool wire_banlist_entry_at(const json_value *entries, size_t i, struct wire_banlist_entry *out);
bool wire_links_entry_at(const json_value *entries, size_t i, struct wire_links_entry *out);
bool wire_whois_extra_at(const json_value *lines, size_t i, struct wire_whois_extra *out);
bool wire_mention_at(const json_value *messages, size_t i, struct wire_mention *out);
const char *wire_string_at(const json_value *arr, size_t i);

/* Presence value of a `presence_snapshot` entry, by position. */
bool wire_presence_at(const json_value *nicks, size_t i, const char **nick, wire_presence *out);

/* ── Phoenix framing ───────────────────────────────────────────────────
 * A v2 socket frame is `[join_ref, ref, topic, event, payload]`. Splits it
 * without assuming any field is non-null (join_ref and ref are null on
 * server-initiated pushes). Returns false if the frame is not a v2 array. */
struct wire_frame {
    const char *topic;
    const char *event;
    const json_value *payload;
    const char *ref; /* nullable */
};
bool wire_frame_split(const json_value *root, struct wire_frame *out);

#endif /* SHOTTINO_WIRE_H */
