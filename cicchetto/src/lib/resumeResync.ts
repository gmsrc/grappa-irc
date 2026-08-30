import { type Accessor, createEffect, on } from "solid-js";

// #1873 — the THIRD door onto the network/channel tree: app resume.
//
// A channel joined on another device was missing from an Android PWA that had
// merely been resumed, and appeared only after a kill-and-reopen. Before this
// module `channelsBySlug` had exactly two refresh doors, and a frozen process
// walks through neither:
//
//   * the live `channels_changed` broadcast — fanned out best-effort, with no
//     live subscriber to receive it while the process is suspended;
//   * `subscribe.ts`'s defensive resync, gated on the socket transitioning
//     INTO "open" from a non-open state.
//
// The second one is the interesting miss, and the reason this is not "add a
// listener": `socketHealth` is a RECORD of the last phoenix callback, written
// only by `onOpen` / `onError` / `onClose`. Nothing polls, so a suspended
// process cannot write it and the state necessarily reads whatever it read
// when it went under. Two regimes follow, and the cure differs:
//
//   * the socket survived the absence — no callback ever fires, no edge ever
//     arrives, and the defensive resync NEVER runs. Here this door is the
//     whole cure.
//   * the socket died — the tear is observed on the thaw (or forced by #254's
//     visibilitychange kick, which gates on the LIVE readyState rather than
//     on `socketHealth`), the state leaves "open", the reconnect lands, and
//     the edge fires. Here this door is a FLOOR: it puts the HTTP fetch on
//     the wire immediately instead of after a WS round trip, and HTTP does
//     not wait for the socket.
//
// WHY A MODULE AND NOT A LISTENER IN `subscribe.ts`. The resume seam already
// exists and has two consumers with this exact shape — `installStaleResumeReload`
// (#695/#674) and `installResumeProbe` (#697): the visibility SSOT
// (`documentVisibility.ts`, one set of listeners for visibilitychange AND
// window focus/blur) injected as a signal, plus `pageshow` for the restore
// the signal cannot see, both mounted from `main.tsx`. A raw
// `document.addEventListener("visibilitychange")` inside `subscribe.ts` would
// be a parallel registration of a signal that already exists — the thing #192
// removed when it made presence read the SSOT instead of its own listener.
//
// ONE RESYNC PER RESUME. A resume can deliver a visibility transition AND a
// `pageshow`; the second must not put a second identical request on the wire.
// The guard is a single flag meaning "a resume is owed a resync", raised when
// the document leaves and cleared by the resync itself — derived from the
// transition rather than tracked in parallel with it, and never a latch that
// could disable the door for the document's remaining life.
//
// ⚠️ KNOWN LIMITATION, same one `resumeProbe` records: a platform that thaws a
// document with NEITHER a visibility transition NOR a `pageshow` is not
// covered, because there is nothing to observe. An absent resync then is that
// gap, not evidence that the door is shut.

/**
 * The bfcache seam, taken as a PAIR. `pagehide` is what makes `pageshow`
 * unambiguous: the initial load fires `pageshow` with no `pagehide` before
 * it, so gating the return on a departure this document actually observed
 * costs nothing at boot and needs no `persisted` flag to tell them apart.
 */
export interface ResumeWindowLike {
  addEventListener(event: "pagehide" | "pageshow", handler: () => void): void;
}

export interface ResumeResyncDeps {
  /**
   * The visibility SSOT (`documentVisibility.ts` — visibilitychange AND
   * window focus/blur). Consumed as a signal rather than re-registering
   * parallel listeners.
   */
  isVisible: Accessor<boolean>;
  /**
   * Re-derive the tree from the server. `refetchNetworks` + `refetchChannels`
   * in production — the same pair `subscribe.ts`'s socket-edge arm runs,
   * injected so this module stays free of the resource singletons.
   */
  resync: () => void;
  win: ResumeWindowLike;
}

/**
 * Arm the resume resync: one `deps.resync()` per resume, none at boot.
 *
 * No uninstall path, like its two siblings — a real listener outlives its
 * test, so unit tests pass a fake window rather than the real one.
 */
export function installResumeResync(deps: ResumeResyncDeps): void {
  // "A resume is owed a resync." Raised when the document leaves, cleared by
  // the resync, so overlapping triggers collapse to one and the next absence
  // re-arms without a timer or a stamp.
  let owed = false;

  const resumed = (): void => {
    if (!owed) return;
    owed = false;
    deps.resync();
  };

  // The bfcache pair, symmetric with the two visibility directions above and
  // below: a departure raises the debt, a return settles it. Both pairs write
  // ONE flag on purpose — a restore that also moved the visibility signal
  // raises the same debt twice and pays it once, which is what keeps a resume
  // that delivers three events from putting three requests on the wire.
  //
  // Registered rather than derived from `persisted`, because a document
  // restored WITHOUT a visibility transition (the case this pair exists for)
  // is invisible to the signal, and one restored WITH one must not resync
  // twice. The departure the document itself observed answers both.
  deps.win.addEventListener("pagehide", () => {
    owed = true;
  });
  deps.win.addEventListener("pageshow", resumed);

  createEffect(
    on(deps.isVisible, (visible) => {
      // The first run is the mount, where `visible` is true and nothing is
      // owed — so boot resolves to a no-op without a `prev === undefined`
      // special case.
      if (visible) resumed();
      else owed = true;
    }),
  );
}
