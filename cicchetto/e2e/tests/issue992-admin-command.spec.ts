// #992 — /admin [<target>] (RFC 2812 §3.4.4), the fourth member of the #127
// server-reply family (/info, /version, /motd). The reply is buffered
// server-side and drained as ONE typed `server_reply` event with source
// "admin", rendered as the shared ServerReplyModal — never dumped into
// scrollback.
//
// WHY this e2e exists and what only it can see. Every claim in #992's design
// was read out of the bahamut C source (`m_admin`, `src/s_serv.c:2676`) — the
// four-terminator set (256-259 / 423 / 402 / 447) was DERIVED, never observed.
// Until this spec ran, not one real ADMIN numeric had ever crossed a socket in
// this repo. The unit tests pin the wiring against synthesised messages; this
// pins it against an ircd that actually answers.
//
// The two asserts that discriminate, rather than mirror:
//
//   1. The 259 line is PRESENT in the modal. RPL_ADMINEMAIL is NOT the
//      RPL_ENDOFMOTD-shaped pure terminator it is often mistaken for: its
//      format is `":%s 259 %s :%s"` fed `aconf->name` (`s_err.c:297`), the
//      contact address — the single most useful line of the reply. A design
//      that treated 259 as a bare terminator would still show a modal, still
//      show lines, and still pass a "modal appeared" test — while silently
//      dropping the address. Asserting the testnet's A-line email
//      (`root@leaf4.azzurra.chat`, `infra/bahamut/conf.leaf4.tmpl` field 3 →
//      `aconf->name`) is what tells the two designs apart.
//
//   2. `/admin <unknown-server>` surfaces a 402. A BARE `ADMIN` can only ever
//      yield 256-259 or 423 — it can NEVER produce ERR_NOSUCHSERVER, which
//      comes from `hunt_server()` on a target grappa had to put on the wire.
//      So a surfaced 402 is unforgeable proof the target argument survived
//      cic's parser, the channel door, and `Client.send_admin/2`. It also
//      exercises the shared 402 owner clause (`@server_reply_402_owners`):
//      with only `admin_pending` armed, the error must surface as "admin".
//
// NOT covered here, and deliberately so: 423 ERR_NOADMININFO needs a leaf with
// NO A: line, and 447 ERR_RESTRICTED needs a restricted-class user. Neither is
// reachable without reshaping the shared testnet, so both stay unit-tested
// against synthesised numerics in test/grappa/session/event_router_test.exs.
//
// Server-side threading (client wire, channel target validation, EventRouter
// accumulate + drain, 402 ownership) is unit-tested in
// test/grappa/irc/client_test.exs, test/grappa_web/channels/grappa_channel_test.exs
// and test/grappa/session/event_router_test.exs. The parser + compose plumbing
// is unit-tested in cicchetto/src/__tests__/{slashCommands,compose}.test.ts.

import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The leaf `bahamut-test` resolves to (compose.yaml aliases leaf-v4 as both
// `bahamut-test` and `leaf4.azzurra.chat`), and its A: line, rendered by
// infra/bahamut/conf.leaf4.tmpl into `aconf->{host,passwd,name}` — the exact
// payloads of 257, 258 and 259 respectively (s_conf.c:1469-1479).
const LEAF = "leaf4.azzurra.chat";
const ADMIN_LOC1 = "Azzurra testnet leaf v4";
const ADMIN_LOC2 = "testnet admin";
const ADMIN_EMAIL = `root@${LEAF}`;

// A dotted name matching no server on the testnet → bahamut's hunt_server
// answers 402. No wildcards, so it can never accidentally match a leaf.
const BOGUS_SERVER = "no.such.admin.grappa.test";

test("#992 — /admin renders the four-numeric reply in the modal, 259's contact address included", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, "/admin");

  const modal = page.getByTestId("server-reply-modal");
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await expect(modal).toHaveAttribute("data-source", "admin");
  await expect(modal.locator("#server-reply-modal-title")).toContainText("Server Administrator");

  // find_admin() hit → exactly four lines, in wire order: 256 (the "about
  // <server>" header), then the three A: line fields. Three lines would mean
  // 259 was drained as a pure terminator without folding its own body.
  const lines = modal.locator('[data-testid="server-reply-modal-line"]');
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(0)).toContainText(`Administrative info about ${LEAF}`);
  await expect(lines.nth(1)).toContainText(ADMIN_LOC1);
  await expect(lines.nth(2)).toContainText(ADMIN_LOC2);
  await expect(lines.nth(3)).toContainText(ADMIN_EMAIL);

  // Never swallowed into scrollback — the drain persists nothing (mirror #127).
  await expect(scrollbackLine(page, "notice", ADMIN_EMAIL)).toHaveCount(0);

  // × dismisses the modal.
  await modal.getByLabel("close").click();
  await expect(modal).toBeHidden({ timeout: 2_000 });
});

test("#992 — /admin <unknown-server> surfaces the 402 under the admin source (target reached the wire)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, `/admin ${BOGUS_SERVER}`);

  const modal = page.getByTestId("server-reply-modal");
  await expect(modal).toBeVisible({ timeout: 10_000 });

  // Only admin_pending is armed (motd_pending is primed by an explicit /motd
  // only — the connect-time MOTD burst leaves it nil), so the shared 402
  // clause must surface the error as "admin", not as #374's "motd".
  await expect(modal).toHaveAttribute("data-source", "admin");
  await expect(modal.locator("#server-reply-modal-title")).toContainText("Server Administrator");

  // The surfaced line is the 402 trailing. A bare ADMIN never yields one.
  const lines = modal.locator('[data-testid="server-reply-modal-line"]');
  await expect(lines.filter({ hasText: /no such server/i }).first()).toBeVisible();

  // The error did NOT get swallowed into a wrong-server admin reply: the
  // real leaf's contact address must be absent.
  await expect(lines.filter({ hasText: ADMIN_EMAIL })).toHaveCount(0);

  // Never persisted to scrollback.
  await expect(scrollbackLine(page, "notice", "No such server")).toHaveCount(0);

  await modal.getByLabel("close").click();
  await expect(modal).toBeHidden({ timeout: 2_000 });
});
