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

export function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
