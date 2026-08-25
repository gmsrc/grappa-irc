import { createSignal } from "solid-js";

// #1765 — imperative "run the far-behind bar's jump-back gesture on the
// active scrollback pane" command. The exact shape of #243's
// `scrollToBottomCommand`, and here for the exact same reason: the caller
// owns the GESTURE, ScrollbackPane owns the machinery.
//
// The machinery in question is the #168 marker-activation latch. The bar's
// jump-back arms it synchronously BEFORE the swap (so it is set when the
// awaited rows land) and stands it back down if the fetch failed — a
// pane-local signal, like the `markerCursorId` re-latch the × needs. A
// caller that reached `scrollback.jumpToUnread` directly would swap the rows
// and leave the pane parked wherever it was, which is the half a caller
// forgets. So the caller bumps this nonce and the single mounted pane runs
// its own `jumpToUnreadGesture` — one gesture, two doors, no second scroll
// authority.
//
// Not state: a monotonic nonce is a transient EDGE, for the same reasons
// spelled out in `scrollToBottomCommand` — a counter rather than a boolean so
// back-to-back requests each fire a distinct transition, and a plain
// module-singleton because a value carried across an identity rotation just
// means "no new request" (the subscriber's `{ defer: true }` skips the value
// it reads at mount).
const [jumpToUnreadRequest, setJumpToUnreadRequest] = createSignal(0);

export { jumpToUnreadRequest };

export const requestJumpToUnread = (): void => {
  setJumpToUnreadRequest((n) => n + 1);
};
