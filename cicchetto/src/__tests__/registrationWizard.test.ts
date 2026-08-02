import { afterEach, describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import {
  closeRegistrationWizard,
  openRegistrationWizard,
  registrationWizardState,
  setStepSince,
} from "../lib/registrationWizard";
import { appendToScrollback } from "../lib/scrollback";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";

// #349 store — `stepSinceId` is the structural bound the wizard's NOTICE
// mirror renders against: replies to THIS send-step are the rows above it.
// #661 — the bound (like the ServiceModal mirror it shares `serviceMirrorRows`
// with) spans BOTH windows a services reply can land in, because the server
// (#400) re-keys the reply to the service's own query window whenever the
// operator has one open. A `$server`-only high-water would sit BELOW that
// window's pre-open history and dump it into the wizard as if it were this
// step's reply.

const notice = (
  slug: string,
  id: number,
  sender: string,
  channel: string,
  body: string,
): ScrollbackMessage => ({
  id,
  network: slug,
  channel,
  server_time: id,
  kind: "notice",
  sender,
  body,
  meta: {},
});

describe("registrationWizard store — setStepSince (#349/#661)", () => {
  afterEach(() => closeRegistrationWizard());

  it("high-waters across $server AND the services nick's open query window", () => {
    const slug = "wiz-hw-open-query";
    appendToScrollback(
      channelKey(slug, SERVER_WINDOW_NAME),
      notice(slug, 3, "NickServ", SERVER_WINDOW_NAME, "stale $server line"),
    );
    appendToScrollback(
      channelKey(slug, "NickServ"),
      notice(slug, 9, "NickServ", "NickServ", "stale line in the open query"),
    );

    openRegistrationWizard(slug);
    setStepSince("NickServ");

    expect(registrationWizardState()?.stepSinceId).toBe(9);
  });

  it("high-waters to 0 on a network with no history in either window", () => {
    openRegistrationWizard("wiz-hw-empty");
    setStepSince("NickServ");

    expect(registrationWizardState()?.stepSinceId).toBe(0);
  });

  it("is a no-op once the wizard is closed (a late setter never resurrects it)", () => {
    openRegistrationWizard("wiz-hw-closed");
    closeRegistrationWizard();
    setStepSince("NickServ");

    expect(registrationWizardState()).toBeNull();
  });
});
