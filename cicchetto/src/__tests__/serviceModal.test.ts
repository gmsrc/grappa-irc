import { afterEach, describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { appendToScrollback } from "../lib/scrollback";
import { closeServiceModal, openServiceModal, serviceModalState } from "../lib/serviceModal";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";

// #290 — the services console modal store. Transient (createRoot) singleton
// holding `{networkSlug, service, sinceId} | null`. `sinceId` is the $server
// high-water mark captured at open, so the modal mirrors ONLY the service
// notices that arrive WHILE it's open (spec: "capturing only while open") —
// derived from the existing $server scrollback, no duplicated buffer.

const SLUG = "azzurra";

const queryNotice = (
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

const notice = (id: number, sender: string, body: string): ScrollbackMessage =>
  queryNotice(SLUG, id, sender, SERVER_WINDOW_NAME, body);

describe("serviceModal store (#290)", () => {
  afterEach(() => closeServiceModal());

  it("opens for a service, pinned to the network slug", () => {
    openServiceModal(SLUG, "NickServ");
    expect(serviceModalState()).toMatchObject({ networkSlug: SLUG, service: "NickServ" });
  });

  it("captures the $server high-water mark as sinceId (capture only while open)", () => {
    const key = channelKey(SLUG, SERVER_WINDOW_NAME);
    appendToScrollback(key, notice(41, "NickServ", "stale confirm from a past session"));
    appendToScrollback(key, notice(42, "NickServ", "another stale line"));

    openServiceModal(SLUG, "NickServ");

    expect(serviceModalState()?.sinceId).toBe(42);
  });

  // #661 — the server (#400) re-keys a services arrival to the service's OWN
  // query window when the operator has one open, so the high-water mark must
  // span BOTH windows. Taking only $server would leave the query window's
  // pre-open history above `sinceId` and leak it into the modal on open —
  // exactly the "capture only while open" rule this field guards.
  it("captures the high-water mark across $server AND the service's query window (#400 re-key)", () => {
    const slug = "svc-hw-open-query";
    appendToScrollback(
      channelKey(slug, SERVER_WINDOW_NAME),
      queryNotice(slug, 41, "NickServ", SERVER_WINDOW_NAME, "stale $server line"),
    );
    appendToScrollback(
      channelKey(slug, "NickServ"),
      queryNotice(slug, 55, "NickServ", "NickServ", "stale line in the open query"),
    );

    openServiceModal(slug, "NickServ");

    expect(serviceModalState()?.sinceId).toBe(55);
  });

  it("sinceId is 0 when the $server window is empty (fresh network)", () => {
    openServiceModal("emptynet", "ChanServ");
    expect(serviceModalState()?.sinceId).toBe(0);
  });

  it("close resets state to null", () => {
    openServiceModal(SLUG, "NickServ");
    closeServiceModal();
    expect(serviceModalState()).toBeNull();
  });
});
