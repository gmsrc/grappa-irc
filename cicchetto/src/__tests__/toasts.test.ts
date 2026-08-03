// #775 — the generic toast queue extracted out of #247's presence store.
//
// The property that matters here is INDEPENDENCE: each producer owns its own
// queue instance and its own payload type. That is what lets the presence
// queue live inside `identityScopedStore` (cleared on an account switch) while
// the bundle-update queue does not, without either of them growing a variant
// belonging to the other domain.
import { describe, expect, it } from "vitest";
import { _setScheduleExpiryForTest, createToastQueue, TOAST_MS } from "../lib/toasts";

interface Payload {
  text: string;
}

describe("createToastQueue", () => {
  it("queues a payload with an id and dismisses by that id", () => {
    _setScheduleExpiryForTest(() => {});
    const q = createToastQueue<Payload>();

    q.queue({ text: "hello" });
    const [toast] = q.toasts();

    expect(q.toasts()).toHaveLength(1);
    expect(toast?.text).toBe("hello");

    q.dismiss(toast!.id);
    expect(q.toasts()).toEqual([]);
  });

  it("gives every toast a distinct id, so dismissing one leaves the rest", () => {
    _setScheduleExpiryForTest(() => {});
    const q = createToastQueue<Payload>();

    q.queue({ text: "first" });
    q.queue({ text: "second" });
    const ids = q.toasts().map((t) => t.id);

    expect(new Set(ids).size).toBe(2);

    q.dismiss(ids[0]!);
    expect(q.toasts().map((t) => t.text)).toEqual(["second"]);
  });

  it("self-expires each toast at TOAST_MS through the injected scheduler", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    _setScheduleExpiryForTest((fn, ms) => {
      scheduled.push({ fn, ms });
    });
    const q = createToastQueue<Payload>();

    q.queue({ text: "transient" });
    expect(scheduled[0]?.ms).toBe(TOAST_MS);

    scheduled[0]!.fn();
    expect(q.toasts()).toEqual([]);
  });

  it("clears its own queue and nobody else's — the whole reason there are two", () => {
    _setScheduleExpiryForTest(() => {});
    const scoped = createToastQueue<Payload>();
    const unscoped = createToastQueue<Payload>();

    scoped.queue({ text: "presence" });
    unscoped.queue({ text: "update" });

    scoped.clear();

    expect(scoped.toasts()).toEqual([]);
    expect(unscoped.toasts().map((t) => t.text)).toEqual(["update"]);
  });

  it("ids do not collide across queues, so one queue's dismiss cannot hit another's row", () => {
    _setScheduleExpiryForTest(() => {});
    const a = createToastQueue<Payload>();
    const b = createToastQueue<Payload>();

    a.queue({ text: "a" });
    b.queue({ text: "b" });

    const idA = a.toasts()[0]!.id;
    b.dismiss(idA);

    expect(b.toasts().map((t) => t.text)).toEqual(["b"]);
  });
});
