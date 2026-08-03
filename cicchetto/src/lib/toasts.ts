import { type Accessor, createSignal } from "solid-js";

// #775 — the toast MECHANICS, shared by every producer.
//
// Extracted from #247's presence store, which built the whole thing —
// monotonic ids, a self-expiry timer, click-to-dismiss removal — inside its own
// module. The auto-refresh notice needed the same mechanics and none of the
// same data, and CLAUDE.md rules that case: reuse the verbs, not the nouns.
//
// So this is a FACTORY, not a shared queue. Each producer gets its own instance
// and keeps its own payload type; nothing here knows what a toast is about.
// That separation is load-bearing rather than tidy: #247's queue lives inside
// `identityScopedStore` and is wiped on an account switch, which is right for
// presence and wrong for an update notice. A single queue with a `kind` field
// would have forced one lifetime on both — the shared-data-model-with-a-
// type-flag boundary violation CLAUDE.md names.

/**
 * How long a toast stays up.
 *
 * ONE number for every producer, deliberately: a toast that outlives its
 * neighbours reads as a different, more important thing, and none of them are.
 * The durable signal always lives somewhere else (the Watched panel dot, the
 * version in Settings) — this surface is the glance.
 */
export const TOAST_MS = 6_000;

// Monotonic across every queue. Ids only ever travel with the queue that
// issued them, but a global counter makes a crossed wire (dismissing id 3 on
// the wrong queue) a no-op instead of a wrong removal.
let toastSeq = 0;

// Injectable for tests — window.setTimeout in production. Module-level rather
// than per-queue: an override must survive an identity switch rebuilding the
// scoped queues underneath it.
let scheduleExpiry: (fn: () => void, ms: number) => void = (fn, ms) => {
  setTimeout(fn, ms);
};

export function _setScheduleExpiryForTest(fn: typeof scheduleExpiry): void {
  scheduleExpiry = fn;
}

export interface ToastQueue<T extends object> {
  /** The live rows, oldest first. Append-and-remove only — rows never mutate. */
  toasts: Accessor<Array<T & { id: number }>>;
  /** Show `toast`, and schedule its own removal TOAST_MS later. */
  queue: (toast: T) => void;
  /** Remove one row early (the click-to-dismiss path). Unknown ids are a no-op. */
  dismiss: (id: number) => void;
  /** Drop every row — the identity-teardown verb for scoped producers. */
  clear: () => void;
}

/** A self-expiring, click-to-dismiss toast queue carrying payloads of type `T`. */
export function createToastQueue<T extends object>(): ToastQueue<T> {
  const [toasts, setToasts] = createSignal<Array<T & { id: number }>>([]);

  const dismiss = (id: number): void => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  };

  return {
    toasts,
    dismiss,
    queue: (toast: T): void => {
      const id = ++toastSeq;
      setToasts((ts) => [...ts, { ...toast, id }]);
      scheduleExpiry(() => dismiss(id), TOAST_MS);
    },
    clear: (): void => {
      setToasts([]);
    },
  };
}
