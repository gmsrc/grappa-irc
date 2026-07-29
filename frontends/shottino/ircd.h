/* ircd.h — the parts of shottino's downstream IRC server that are pure.
 *
 * `--ircd` turns shottino into a local IRC server that a normal client
 * (irssi, hexchat, weechat) connects to, bridging that client to grappa.
 * The socket work, the app state and the grappa calls live in shottino.c
 * where the app lives; what is here is everything that is bytes-in,
 * bytes-out: the bind spec, the client line grammar, the sender prefix,
 * the server-time tag, and the sanitising that keeps a hostile message
 * body from becoming a second protocol line.
 *
 * That split is not tidiness. A bridge speaks a protocol to a socket it
 * does not control, in both directions, which is exactly the shape of
 * the code this project keeps in leaf modules so it can be exercised
 * under ASan without a server, a terminal or a network — the same reason
 * wire.c and http.c exist.
 */
#ifndef SHOTTINO_IRCD_H
#define SHOTTINO_IRCD_H

#include <stdbool.h>
#include <stddef.h>

/* RFC 1459 allows 15 parameters, the last of which may be a trailing
 * ":rest of the line". */
#define IRCD_MAX_PARAMS 15
#define IRCD_PARAM_MAX 512
#define IRCD_LINE_MAX 1024

struct ircd_msg {
    char prefix[128];  /* without the leading ':'; usually empty from a client */
    char command[32];  /* upper-cased, so the caller compares one way */
    char params[IRCD_MAX_PARAMS][IRCD_PARAM_MAX];
    size_t param_count;
};

/* Parse one line from a downstream client. Returns false for a line with
 * no command at all; everything else is best-effort, because a client
 * that sends something odd should get an error reply rather than a
 * dropped connection. CR/LF must already be stripped. */
bool ircd_parse_line(const char *line, struct ircd_msg *out);

/* Case-insensitive command compare — IRC commands are case-insensitive
 * and clients differ about which case they send. */
bool ircd_command_is(const struct ircd_msg *m, const char *name);

/* `--ircd[=SPEC]`, where SPEC is a port, an address, or an address and
 * port, in v4 or v6:
 *
 *     (empty)              127.0.0.1  6667
 *     6668                 127.0.0.1  6668
 *     10.0.0.2             10.0.0.2   6667
 *     10.0.0.2:6668        10.0.0.2   6668
 *     ::1                  ::1        6667      (bare v6: colons, no brackets)
 *     [::1]:6668           ::1        6668
 *     [::]:6667            ::         6667
 *
 * A bare IPv6 literal is told apart from host:port by counting colons,
 * which is why the bracket form exists at all. Returns false on a spec
 * that cannot be read as any of these. */
bool ircd_parse_bind(const char *spec, char *host, size_t host_sz, char *port, size_t port_sz);

/* Is this bind address reachable only from this machine? Decides whether
 * a password is REQUIRED: a bridge on a public address hands the user's
 * whole IRC session to anyone who connects. */
bool ircd_bind_is_loopback(const char *host);

/* Split a downstream PASS into an optional network and a secret, the
 * convention bouncers already use and clients already support because it
 * is only a password string:
 *
 *     "secret"              network ""        secret "secret"
 *     "azzurra:secret"      network "azzurra" secret "secret"
 *     "azzurra:"            network "azzurra" secret ""
 *     "azzurra"             network "azzurra" secret "azzurra"
 *
 * The last line is the ambiguity worth knowing about: with no colon we
 * cannot tell a network name from a password, so the caller tries both —
 * it matches a network name, or it is a password. */
void ircd_split_pass(const char *pass, char *network, size_t network_sz, char *secret,
                     size_t secret_sz);

/* "nick!user@host" for a message we attribute to `nick`. The host part
 * names this bridge so that a client's ignore/highlight rules have
 * something stable to match. */
void ircd_sender_prefix(const char *nick, char *out, size_t out_sz);

/* An IRCv3 `@time=` tag for a grappa server_time in milliseconds, with
 * its trailing space, or "" when the client did not ask for server-time
 * (or the timestamp is unusable). History replayed without it is history
 * a client stamps with the moment it reconnected. */
void ircd_time_tag(long server_time_ms, bool wanted, char *out, size_t out_sz);

/* Copy `in` into `out`, dropping anything that would end the line early
 * or start a new one. A message body arrives from IRC, through grappa,
 * and back out to a client: without this, a body containing CRLF would
 * let anyone who can speak in a channel inject commands into someone
 * else's client session. */
void ircd_sanitize(const char *in, char *out, size_t out_sz);

/* Does `text` need to be sent as the trailing parameter? True when it is
 * empty or contains a space or starts with ':' — the cases where a
 * middle parameter would not survive the round trip. */
bool ircd_needs_trailing(const char *text);

/* Fold a nick or channel name under rfc1459, the CASEMAPPING this
 * bridge advertises and the one azzurra's ircd (bahamut) actually uses:
 * besides A-Z it maps [ ] \ ~ to { } | ^. Downstream input has to be
 * folded because a client sends the name however the user typed it,
 * while grappa stores it canonically — without this, joining "#Chan"
 * asks grappa to join a channel you are already in.
 *
 * ASCII only, deliberately: "#CAFE\u0301" and "#caf\u00e9" are DISTINCT
 * channels on that ircd, and folding them here would merge two rooms.
 * Same rule as the server's Grappa.IRC.Identifier. */
void ircd_fold(const char *in, char *out, size_t out_sz);

/* Are these the same name under that fold? */
bool ircd_name_equal(const char *a, const char *b);

/* The sigil for a member's modes, given the network's PREFIX sigils in
 * precedence order. With `multi_prefix` the client asked for ALL of them
 * (IRCv3 multi-prefix), which is what lets a client show that someone is
 * both op and voiced. */
void ircd_member_sigils(const char *modes, const char *sigils, bool multi_prefix, char *out,
                        size_t out_sz);

#endif /* SHOTTINO_IRCD_H */
