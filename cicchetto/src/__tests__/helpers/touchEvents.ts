// Synthetic touch events for jsdom. jsdom ships no TouchEvent constructor, so
// we shape a cancelable Event carrying the `.touches` / `.changedTouches` the
// gesture code reads — which exercises the REAL listener path rather than
// calling the pure geometry helpers directly. Returns the event so callers can
// assert `defaultPrevented` (the claim signal).
//
// Bubbling is deliberate and load-bearing for the call-site tests: the edge
// listener sits on `.shell-mobile`, and a touch that starts on a drawer
// backdrop reaches it by bubbling, exactly as it does in a browser.

export type TouchPoint = { clientX: number; clientY: number };

export function fireTouch(el: HTMLElement, type: string, ...points: TouchPoint[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const list = points as unknown as TouchList;
  Object.defineProperty(ev, "touches", {
    value: type === "touchend" ? ([] as unknown as TouchList) : list,
  });
  Object.defineProperty(ev, "changedTouches", { value: list });
  el.dispatchEvent(ev);
  return ev;
}

// Same, with a chosen `timeStamp` — for gestures whose decision reads the clock
// (#1438's velocity gate). It has to be its own function rather than a caller
// stamping the returned event: `fireTouch` DISPATCHES before it returns, so a
// `defineProperty` afterwards lands too late and every listener still sees
// jsdom's 0. A gesture graded on velocity would then read every drag as
// instantaneous, and its "slow drag does nothing" arm would pass against an
// implementation with no velocity gate at all.
export function fireTouchAt(
  el: HTMLElement,
  type: string,
  timeStamp: number,
  ...points: TouchPoint[]
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const list = points as unknown as TouchList;
  Object.defineProperty(ev, "touches", {
    value: type === "touchend" ? ([] as unknown as TouchList) : list,
  });
  Object.defineProperty(ev, "changedTouches", { value: list });
  Object.defineProperty(ev, "timeStamp", { value: timeStamp });
  el.dispatchEvent(ev);
  return ev;
}

// One full edge swipe: start → two moves → end. The intermediate moves are what
// let the directive claim mid-drag (it claims late, never on touchstart).
export function swipeHorizontally(el: HTMLElement, fromX: number, toX: number, y: number): void {
  fireTouch(el, "touchstart", { clientX: fromX, clientY: y });
  fireTouch(el, "touchmove", { clientX: fromX + (toX - fromX) / 3, clientY: y + 5 });
  fireTouch(el, "touchmove", { clientX: fromX + ((toX - fromX) * 2) / 3, clientY: y + 8 });
  fireTouch(el, "touchend", { clientX: toX, clientY: y + 10 });
}
