// Admin redesign (2026-08-07 review) — render a wire timestamp for an
// admin table or log line.
//
// The server sends `2026-08-07T18:36:38.393734Z`: microsecond precision,
// a `T`, and a `Z`, 27 characters of which about ten carry meaning to an
// operator. In a table it was the widest column on the page and it was
// pushing everything else off a phone screen, for six digits of
// sub-second precision nobody reads.
//
// `YYYY-MM-DD HH:mm`, local time. Deliberately NOT `lib/timeFormat`'s
// `formatTimestamp`: that one is time-of-day only (it renders scrollback
// lines, where the day is implied by the surrounding conversation) and
// follows a user-facing hh:mm / hh:mm:ss preference. An admin row can be
// weeks old, so the date is the part that matters, and it should not
// move when someone changes a chat setting.
//
// An unparseable value is returned verbatim rather than rendered as
// "Invalid Date": if the server ever sends something unexpected, an
// operator should see what it actually sent.

const pad = (n: number): string => n.toString().padStart(2, "0");

function datePart(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD HH:mm` — for a table cell, where the row is a record. */
export function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${datePart(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `YYYY-MM-DD HH:mm:ss` — for a LOG line, where the row is an event.
 *
 * Seconds are load-bearing here and nowhere else: reading a log means
 * reading ORDER and spacing, and two events a few seconds apart are the
 * whole story of a reconnect loop. A table cell like `users.inserted_at`
 * has no such neighbour to be compared against, so it drops them.
 * (Sub-second is still dropped in both: the wire's six microsecond
 * digits made this the widest column on the page and no operator reads
 * them.)
 */
export function formatLogInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${datePart(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
