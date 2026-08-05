/* whip.h — WHIP/WHEP signalling for the shottino call helper.
 *
 * WHIP (RFC 9725) is the whole reason the signalling half of a terminal
 * call costs almost nothing:
 *
 *     POST <endpoint>            Content-Type: application/sdp
 *       body: the SDP offer
 *     → 201 Created
 *       Location: <resource>     (may be RELATIVE — see whip_resolve)
 *       body: the SDP answer
 *
 *     DELETE <resource>          hang up
 *
 * That is it. No XMPP, no Jingle, no room API, no vendor SDK — which is
 * why targeting the RFC costs a few hundred lines where targeting one
 * product's protocol costs a subsystem and a maintenance treadmill.
 *
 * The split in this header is deliberate: everything that PARSES is pure
 * (bytes in, struct out, no socket and no OpenSSL) and therefore lives
 * under the same ASan/UBSan gate as the rest of shottino's parsers, and
 * is exercised by tests/test_whip.c WITHOUT the vendored libdatachannel
 * being built. Only whip_request() touches a socket.
 *
 * The bytes being parsed arrive from a URL that came out of an IRC
 * message — i.e. from a stranger — so they are attacker-shaped in
 * exactly the way the websocket and HTTP paths in shottino.c already
 * assume theirs are.
 */
#ifndef SHOTTINO_WHIP_H
#define SHOTTINO_WHIP_H

#include <stdbool.h>
#include <stddef.h>

#define WHIP_MAX_URL 2048
#define WHIP_MAX_HOST 256

/* A URL split into the parts a request needs. `path` always begins with
 * '/' — an empty path in a URL means "/" and a request line without one
 * is malformed. */
struct whip_url {
    bool tls;
    char host[WHIP_MAX_HOST];
    int port;
    char path[WHIP_MAX_URL];
};

/* Split an absolute http/https URL.
 *
 * Refuses every other scheme rather than guessing: the URL reaches here
 * from a channel, and a helper that will happily open whatever scheme it
 * is handed is a different program than the one intended. Default ports
 * are filled in (80/443), an explicit port must be 1..65535, and an
 * IPv6 literal in brackets keeps its brackets out of `host`. */
bool whip_url_parse(const char *url, struct whip_url *out);

/* Resolve a Location header against the URL the request went to.
 *
 * WHIP servers are explicitly allowed to answer 201 with a RELATIVE
 * Location, and several do. Handles an absolute URL (returned as-is
 * after a scheme check), a rooted path ("/session/42") and a relative
 * one ("42") against the request path's directory. Writes an absolute
 * URL to `out`. */
bool whip_resolve(const struct whip_url *base, const char *location, char *out, size_t out_sz);

/* What a response boiled down to. `body` is owned by the caller and must
 * be freed; it is NUL-terminated and `body_len` excludes the NUL. */
struct whip_response {
    int status;
    char location[WHIP_MAX_URL];
    /* RFC 9725 §4.1: an OPTIONS to a WHIP endpoint advertises what it
     * will accept a POST of, and for WHIP that is `application/sdp`.
     * Captured because it is the one header that tells a WHIP endpoint
     * apart from any other URL that happens to answer — see
     * whip_endpoint_verdict. */
    char accept_post[128];
    char *body;
    size_t body_len;
};

/* Is what answered an OPTIONS actually a WHIP/WHEP endpoint?
 *
 * Pure, so the rule lives in one place and is tested without a socket.
 *
 * A 2xx alone proves nothing — a web server, a redirect target, a
 * captive portal and a 404 page all answer. What a WHIP endpoint owes,
 * and nothing else does, is `Accept-Post: application/sdp`. So both are
 * required, and the parameters an `Accept-Post` may legally carry
 * (`application/sdp; charset=utf-8`) are tolerated while a different
 * type is not.
 *
 * Fails CLOSED on every uncertainty. A verdict of "not an endpoint"
 * costs a link that stays an ordinary clickable link; a false yes costs
 * a ring, a call window and a camera for something that was never a
 * call. */
bool whip_endpoint_verdict(int status, const char *accept_post);

/* Parse a whole HTTP/1.1 response.
 *
 * Handles Content-Length and chunked (through shottino's already
 * hardened http_decode_chunked, rather than a second decoder that would
 * have to be hardened separately). Returns false on anything that is not
 * a well-formed response — a truncated header block included, because a
 * half-read answer that parses is worse than one that does not. */
bool whip_response_parse(const char *raw, size_t len, struct whip_response *out);

void whip_response_free(struct whip_response *r);

/* Perform one request. The only function here that touches a socket.
 *
 * `method` is "POST" or "DELETE"; `content_type` and `body` may be NULL
 * for a bodyless request. TLS is verified — peer chain AND hostname —
 * because the endpoint came from a message somebody else wrote.
 *
 * Returns false and fills `err` (when non-NULL) on any transport-level
 * failure; an HTTP error STATUS is a successful request that returned a
 * status, and is reported through `out->status` instead. */
bool whip_request(const struct whip_url *url, const char *method, const char *content_type,
                  const char *body, int timeout_ms, struct whip_response *out, char *err,
                  size_t err_sz);

#endif /* SHOTTINO_WHIP_H */
