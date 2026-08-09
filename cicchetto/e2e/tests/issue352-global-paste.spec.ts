// #352 — global Ctrl/Cmd+V.
//
// A paste fired while focus is OFF the compose textarea (scrollback, body, a
// just-closed menu) used to drop on the floor — paste only worked with the
// textarea already focused. Now a boot-time document-level paste listener
// (lib/globalPaste) focuses the compose bar and routes the payload through the
// SAME shared router the textarea's own onPaste uses (lib/pasteRoute): text
// inserts at the caret, image/file uploads.
//
// vitest (globalPaste.test.ts + pasteRoute.test.ts) proves the guard matrix
// (editable-focus / overlay / no-surface bail) + the routing in jsdom; this
// spec is the real-browser proof that a paste with focus elsewhere ACTUALLY
// focuses the compose box and lands the text — the focus/render jsdom can't
// show. A real ClipboardEvent + DataTransfer (both constructible in chromium)
// dispatched on document.body drives the production listener deterministically,
// the same path a real Ctrl+V takes minus the OS-clipboard permission dance.

import type { Page } from "@playwright/test";
import { composeTextarea, confirmModal, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Blur whatever holds focus, then dispatch a real "paste" ClipboardEvent on
// document.body — a paste that lands on a non-editable surface, exactly the
// #352 scenario. bubbles:true so it reaches the document-level listener.
async function pasteWhileUnfocused(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.body.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);
}

test("#352 — paste while the compose bar is unfocused focuses it + lands the text", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();
  await expect(ta).toHaveValue("");

  // Paste at the document with focus OFF the compose bar (the helper blurs the
  // active element synchronously, in the same evaluate as the dispatch, so
  // activeElement is <body> — non-editable — when the listener reads it). A
  // single line is below the flood threshold, so it lands directly (no confirm
  // dialog) — the frictionless global-paste path.
  await pasteWhileUnfocused(page, "pasted while unfocused");

  // The visible outcome: the compose bar takes focus AND the text is in it,
  // ready to edit / send. Reverting the global listener reds this.
  await expect(ta).toBeFocused();
  await expect(ta).toHaveValue("pasted while unfocused");
  await expect(confirmModal(page)).toHaveCount(0);
});
