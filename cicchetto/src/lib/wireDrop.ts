import { type Accessor, createSignal } from "solid-js";

// #1393d — the latch behind the "cic is discarding data" banner.
//
// ## What it reports, and what it deliberately does not
//
// Three handlers narrow an inbound WS payload and drop it when the narrower
// returns null — the user topic, the per-channel topic and the DM listener.
// Each has always answered a drop with a `console.warn` and nothing else,
// which is a signal only for whoever happens to have devtools open. Nobody
// running this as a PWA on a phone ever has.
//
// That was tolerable while a drop meant "a proxy mangled a frame" — rare,
// and nothing cic could do about it. #1393d makes it routine and
// systematic: cic now rejects payloads an older BEAM sends perfectly
// happily, so a `--cic`-only deploy turns a whole event kind into silence.
// The `console.warn` was the only trace, and silence is exactly the failure
// mode the strict ruling traded for.
//
// So this latches the FACT of a drop and lets `errorBanners.ts` say it out
// loud. It does NOT try to say WHY: a mangling proxy and a stale BEAM
// produce the identical observation here, and inventing an attribution
// would be the same sin the narrowers just stopped committing. The honest
// statement is the one both causes share — cic received something it could
// not read and threw it away.
//
// `serverProtocol.ts` is the one that can name a cause, because it reads a
// number the server stated about itself. The two are separate on purpose:
// this one is the SYMPTOM, that one is the DIAGNOSIS, and a symptom with no
// diagnosis is still worth showing.
//
// ## Why a plain module signal, and why a latch
//
// Same posture as `floodSever.ts` and `bundleHash.ts`: a plain module-level
// signal, not an `identityScopedStore`. A drop is a fact about the BUNDLE
// meeting a SERVER, not about a subject, and it must survive a token
// transition — the reconnect after a rotation re-delivers the same
// unreadable payloads.
//
// A latch rather than a counter: the count would be a number nobody can act
// on, and it would make the banner text change under the reader's eyes
// while they are trying to read it. What is actionable is the kind — the
// first one is kept for the message, and the rest are the same story.

const [droppedKindSignal, setDroppedKindInternal] = createSignal<string | null>(null);

export const droppedKind: Accessor<string | null> = droppedKindSignal;

/**
 * Latch that a narrower rejected a payload. `raw` is the unnarrowed frame:
 * its `kind`, when it has a readable one, is the only part safe to surface —
 * everything else in a payload that failed narrowing is by definition not
 * something we have established the shape of.
 *
 * Idempotent after the first call: the latch records THAT it happened, so a
 * flood of drops from one stale BEAM is one banner and not a churn.
 */
export function noteWireDrop(raw: unknown): void {
  if (droppedKindSignal() !== null) return;
  const kind =
    typeof raw === "object" && raw !== null && typeof (raw as { kind?: unknown }).kind === "string"
      ? (raw as { kind: string }).kind
      : null;
  setDroppedKindInternal(kind ?? "unknown");
}

// Test seam only. There is deliberately no production re-arm: the drop
// already happened and nothing later un-drops it, so the banner is STICKY and
// the × is the reader saying they have seen it — the same posture as
// `sw-registration`, which also has no auto-clear event.
export function __resetWireDropForTests(): void {
  setDroppedKindInternal(null);
}

export function shouldShowWireDropBanner(): boolean {
  return droppedKindSignal() !== null;
}

export function wireDropMessage(): string {
  return `This client could not read a "${droppedKind()}" update from the server and discarded it — some panes may be out of date.`;
}
