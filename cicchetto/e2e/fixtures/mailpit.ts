// Mailpit e2e helper — GH #349 registration-wizard real-services flow.
//
// The registration wizard fires `PRIVMSG NickServ REGISTER <pw> <email>`
// at a REAL services daemon (Azzurra IRC Services / Atheme /
// oftc-ircservices). The daemon mails a confirmation to `<email>`; its
// sendmail shim is pointed at the mailpit sidecar's SMTP
// (`mailpit:1025`). This module is the spec-side REST client that polls
// mailpit's HTTP API for that mail and extracts the confirmation
// code/link, so the spec can complete verification PROGRAMMATICALLY —
// no manual step, self-contained in CI.
//
// Mirrors fixtures/push.ts's poll-with-timeout shape (awaitPushDelivery)
// against the push-catcher sidecar. Same boundary: this module owns
// mailpit glue only; window-state / scrollback assertions come from
// cicchettoPage.ts.
//
// Why filter recipient client-side rather than mailpit's `search` API:
// each spec registers a UNIQUE per-run nick+email (e.g.
// `wiz-<n>@grappa.test`), so a plain list + `To` filter is unambiguous
// and needs no query-string escaping. Mailpit keeps everything in
// memory (MP_MAX_MESSAGES=0, wiped on teardown).

const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://mailpit:8025";

type MailpitAddress = { Name: string; Address: string };

type MailpitSummary = {
  ID: string;
  To: MailpitAddress[];
  Subject: string;
  Snippet: string;
};

type MailpitMessage = {
  ID: string;
  To: MailpitAddress[];
  Subject: string;
  Text: string;
  HTML: string;
};

/**
 * Deletes every message in mailpit's store. Call in a spec's setup so a
 * prior run's confirmation mail can't be mistaken for this run's — even
 * though recipients are unique, a stale message with the same address
 * (re-run without teardown) would otherwise be picked up.
 */
export async function resetMailpit(): Promise<void> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`resetMailpit: ${res.status} ${await res.text()}`);
  }
}

/**
 * Polls mailpit until a message addressed to `to` arrives (or the
 * timeout elapses), then fetches + returns its full body. Services'
 * mail send is async relative to the REGISTER round-trip, so the spec
 * MUST poll rather than assume synchronous delivery.
 *
 * @param to           recipient address the REGISTER used (unique per run)
 * @param timeoutMs    ceiling (default 30s — a from-source services
 *                     daemon + sendmail shim + mailpit hop is slower than
 *                     the push sidecar's sub-100ms path)
 */
export async function awaitMail(
  to: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<MailpitMessage> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  const wanted = to.toLowerCase();

  while (Date.now() < deadline) {
    const listRes = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=100`);
    if (listRes.ok) {
      const body = (await listRes.json()) as { messages: MailpitSummary[] };
      const hit = (body.messages ?? []).find((m) =>
        (m.To ?? []).some((addr) => addr.Address?.toLowerCase() === wanted),
      );
      if (hit) {
        const msgRes = await fetch(`${MAILPIT_URL}/api/v1/message/${encodeURIComponent(hit.ID)}`);
        if (msgRes.ok) return (await msgRes.json()) as MailpitMessage;
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`awaitMail: timeout after ${timeoutMs}ms — no mail to ${to}`);
}

/**
 * Extracts the FIRST capture group of `re` from a message's text (falls
 * back to HTML if Text is empty). Throws with the body attached if no
 * match — a services email-format change surfaces loudly here, not as a
 * silent verification no-op.
 *
 * The per-flavor patterns live in the spec (verified against a REAL
 * captured email, never guessed — an email format is a daemon
 * implementation detail, not a documented contract):
 *   - Atheme:  VERIFY key  → `/VERIFY REGISTER \S+ (\w+)/`
 *   - Azzurra: AUTH code    → `/AUTH (\d+)/`
 *   - OFTC:    verify link  → `/(https?:\/\/\S+\/verify\/\S+)/`
 */
export function extractFromMail(msg: MailpitMessage, re: RegExp): string {
  const haystack = msg.Text && msg.Text.length > 0 ? msg.Text : msg.HTML;
  const m = haystack.match(re);
  if (!m || m[1] === undefined) {
    throw new Error(
      `extractFromMail: pattern ${re} did not match. Subject=${JSON.stringify(msg.Subject)} body=\n${haystack}`,
    );
  }
  return m[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
