import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { closeMediaViewer, type MediaViewerState, mediaViewerState } from "./lib/mediaViewer";
import { bindDismissGesture, type DismissDirections } from "./lib/mediaViewerGesture";
import { createOverlayLock } from "./lib/overlayScrollLock";
import {
  applyPinch,
  distance,
  midpoint,
  MIN_SCALE,
  type Point,
  rescaleScroll,
  type Size,
  toggleZoom,
} from "./lib/pinchZoom";
import { maybeEscapePwaClick } from "./lib/platform";
import { fetchTextResource, TEXT_VIEW_MAX_BYTES } from "./lib/textResource";

// In-app media viewer modal — media-link cluster (2026-06-11).
//
// Why: own upload URLs are same-origin and therefore in-PWA-scope; iOS
// standalone navigates in-scope links IN PLACE (raw media document,
// zero browser chrome, no back control; returning reloads cic). The
// modal keeps the operator inside cic. On-CLICK only — no on-arrival
// rendering, per the CLAUDE.md "IRC stays text only" rule (vjt-approved
// spec 2026-06-10; the spec bans lightbox-on-arrival, not click-to-view).
//
// Driven entirely by `mediaViewerState()` (lib/mediaViewer.ts);
// `MircText`'s link handler calls `openMediaViewer` for links that
// `classifyMediaLink` accepts. Mounted at Shell root in both branches
// (PrivacyModal pattern).
//
// "Open in browser" keeps the plain href + target=_blank (desktop,
// Android, iOS browser tabs: a real new tab; long-press → Copy Link
// yields the live URL). iOS STANDALONE cannot leave the PWA via a
// same-origin anchor at all (in-scope navigation ignores target — the
// same root cause this modal exists for; dogfood caught the first
// shipped version navigating the PWA), so plain clicks delegate to the
// shared maybeEscapePwaClick intercept, which hands the URL to real
// Safari via the x-safari-https:// scheme (iOS 17+; inert tap on 16 —
// acceptable degrade). The media element's sources ARE CSP-governed:
// `'self'` covers the same-origin case, and the cross-host links the
// classifier admits (#607 audio, #1240 image + video) need the `https:`
// token in `media-src` / `img-src` — without it this modal opens EMPTY.
// The widening rides in the same change as each admission; the plug
// moduledoc (GrappaWeb.Plugs.SecurityHeaders) is the SSOT.
//
// #1764 adds a FOURTH kind, `text`, and it is the one that does not hang off
// an element: `.txt`/`.md` are FETCHED and put in the DOM as source, so they
// answer to `connect-src`, which is NOT widened to `https:`. That is why
// `classifyMediaLink` admits text from an admitted host only — this modal
// never sees a cross-host text href, and must not be made to.
//
// #232 — Escape routes through the shared overlay ESC stack
// (createOverlayLock's onEscape → the single keybindings keydown listener →
// runTopmostOverlayEscape), NOT a private document listener: focus stays
// wherever the operator clicked (scrollback, compose box), and there is only
// ONE global keydown listener app-wide. Backdrop is a <button>
// (UserContextMenu pattern) so close-on-outside needs no a11y lint suppressions.

type MediaLoadStatus = "loading" | "ready" | "failed";

// Max gap (ms, event-timeStamp domain) between two single-finger taps for a
// double-tap zoom toggle. 300ms is the platform double-tap convention.
const DOUBLE_TAP_MS = 300;

const touchPoint = (t: Touch): Point => ({ x: t.clientX, y: t.clientY });

// Pinch-to-zoom for the modal image (#213), panned by the browser's own
// scroller (#1805).
//
// The PINCH is still synthesized: the browser's native one is dead app-wide
// (iOS-1 viewport lock — maximum-scale=1, user-scalable=no; no per-element
// opt-out), so it is applied as a CSS `transform` to THIS <img> alone.
//
// The PAN is not, any more. That lock governs page zoom and says nothing about
// element scrolling, so an `overflow: auto` box scrolls natively underneath it
// — measured through chromium's real touch pipeline at iPhone-15 metrics, 112px
// of scroll with the lock against 128px without. Handing the pan back buys
// momentum, rubber-band, a scrollbar and exact bounds that no synthesized
// version had. It costs the blanket `preventDefault` that used to sit on every
// touchmove: only the TWO-FINGER branch is ours now, because a one-finger drag
// preventDefault'd is a one-finger drag the browser will not scroll with
// (measured: claiming it while zoomed pins the scroll at 0).
//
// A transform does not change layout, so a scaled image creates no overflow and
// there would be nothing to scroll. `.media-viewer-zoom-sizer` is what grows —
// an absolutely-positioned box at `fit × scale`. Absolute so it stays out of
// the scroller's intrinsic size: the <img> keeps sizing the container at fit,
// its `max-width: 100%` keeps resolving against a box that does not move, and
// the CSS remains the owner of the fit — this component only MIRRORS the fit it
// measures, it never recomputes `object-fit: contain` in JS.
//
// Touch listeners are bound element-level via a ref + addEventListener with
// touchmove `{ passive: false }` (bindSwipe precedent, ComposeBox): Solid
// DELEGATES touch events to a passive document listener, so a JSX onTouchMove's
// preventDefault would silently no-op (DESIGN_NOTES 2026-06-24 / 2026-07-12).
// The pure geometry lives in lib/pinchZoom.ts; this owns only the DOM wiring +
// gesture state.
//
// #1438 — the zoom level is PUBLISHED upward (`onScale`) instead of the
// transform being lifted into the modal. The dismiss gesture needs one bit
// ("is this image zoomed?") to stand down, and the transform is deliberately
// element-scoped: hoisting it would put the image's zoom geometry in a
// component that also owns a <video>. Published synchronously with every
// mutation rather than through an effect, because the reader is a touchstart
// handler and a frame of lag there is a dismiss that fires on a pan.
const ZoomableImage: Component<{
  href: string;
  onLoad: () => void;
  onError: () => void;
  onScale: (scale: number) => void;
}> = (props) => {
  let scroller: HTMLDivElement | undefined;
  let sizer: HTMLDivElement | undefined;
  let image: HTMLImageElement | undefined;

  // Plain mutables, not signals: nothing RENDERS from either. Both are painted
  // imperatively for an ORDERING reason, not a style one — the sizer has to be
  // its new size BEFORE a scroll offset is assigned, or the assignment clamps
  // against the old bounds and the zoom lands somewhere else. Same device as
  // `paint` in MediaViewerDialog below.
  let scale = MIN_SCALE;
  let fit: Size = { width: 0, height: 0 }; // the CSS-computed fit box, mirrored

  // Non-reactive gesture state, mutated across the touchstart→move→end span.
  let gestureStartScale = MIN_SCALE; // scale when the current pinch began
  let startDistance = 0; // two-finger pinch baseline (0 = not pinching)
  let lastTapAt = 0; // event-timeStamp of the previous single-finger tap

  // At fit there must be NOTHING to scroll. Not an optimisation: at fit the
  // swipe-to-dismiss owns the single-finger drag, and it only keeps it while
  // the browser has no pan to start. `fit` is read from `clientWidth`, which is
  // rounded to an integer, so `fit × 1` can exceed the real box by a sub-pixel
  // — enough overflow for the browser to claim the drag and take the dismiss
  // away. Zero is the only value that cannot do that.
  const sizerSize = (): Size =>
    scale > MIN_SCALE
      ? { width: fit.width * scale, height: fit.height * scale }
      : { width: 0, height: 0 };

  const paint = (): void => {
    if (image !== undefined) image.style.transform = `scale(${scale})`;
    if (sizer !== undefined) {
      const size = sizerSize();
      sizer.style.width = `${size.width}px`;
      sizer.style.height = `${size.height}px`;
    }
  };

  // Screen coordinates → the scroller's own viewport coordinates, which is the
  // frame `rescaleScroll` is written in.
  const focusIn = (p: Point): Point => {
    const box = scroller?.getBoundingClientRect();
    if (box === undefined) return { x: 0, y: 0 };
    return { x: p.x - box.left, y: p.y - box.top };
  };

  // The ONE writer. Publication, paint and scroll compensation cannot drift
  // apart if there is no other way to move the scale.
  const applyScale = (next: number, focus: Point): void => {
    const previous = scale;
    if (next === previous) return;
    scale = next;
    props.onScale(scale);
    paint();
    if (scroller === undefined) return;
    const to = rescaleScroll(
      { left: scroller.scrollLeft, top: scroller.scrollTop },
      focus,
      previous,
      scale,
    );
    scroller.scrollLeft = to.left;
    scroller.scrollTop = to.top;
  };

  // The fit box is whatever the stylesheet's max-width/max-height resolve to.
  // It changes on load, on rotation, and on a --viewport-height write (the
  // software keyboard), and a ResizeObserver catches all three where a load
  // handler catches one. `clientWidth` and not `getBoundingClientRect`: the
  // rect is the TRANSFORMED box, so it would report `fit × scale` and feed the
  // sizer its own output.
  const measureFit = (): void => {
    if (image === undefined) return;
    const next: Size = { width: image.clientWidth, height: image.clientHeight };
    if (next.width === fit.width && next.height === fit.height) return;
    fit = next;
    paint();
  };

  const onTouchStart = (e: TouchEvent): void => {
    gestureStartScale = scale;
    if (e.touches.length >= 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      if (a && b) startDistance = distance(touchPoint(a), touchPoint(b));
      return;
    }
    const t0 = e.touches[0];
    if (!t0) return;
    startDistance = 0;
    // Double-tap toggles fit⇄2x, around the tapped point rather than the
    // centre: the same `rescaleScroll` the pinch uses, so there is one answer
    // to "where does the picture land" and not two.
    if (e.timeStamp - lastTapAt < DOUBLE_TAP_MS) {
      applyScale(toggleZoom(scale), focusIn(touchPoint(t0)));
      lastTapAt = 0;
      return;
    }
    lastTapAt = e.timeStamp;
  };

  const onTouchMove = (e: TouchEvent): void => {
    // ONE finger is the browser's: no claim, no preventDefault, no JS geometry.
    // Returning early is the whole of #1805 at this layer.
    if (e.touches.length < 2 || startDistance <= 0) return;
    const a = e.touches[0];
    const b = e.touches[1];
    if (!a || !b) return;
    // Two fingers ARE ours — the native pinch this replaces does not exist, and
    // an unclaimed two-finger move is a page gesture we do not want.
    if (e.cancelable) e.preventDefault();
    const pa = touchPoint(a);
    const pb = touchPoint(b);
    applyScale(
      applyPinch(gestureStartScale, startDistance, distance(pa, pb)),
      focusIn(midpoint(pa, pb)),
    );
  };

  const onTouchEnd = (e: TouchEvent): void => {
    // Below two fingers there is no pinch left to continue; whatever remains on
    // the glass is a pan, and a pan is the browser's. Re-baselining the scale
    // here is what makes a second pinch compound on the first.
    if (e.touches.length < 2) startDistance = 0;
    gestureStartScale = scale;
  };

  const bindScroller = (el: HTMLDivElement): void => {
    scroller = el;
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    onCleanup(() => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      scroller = undefined;
    });
  };

  const bindImage = (el: HTMLImageElement): void => {
    image = el;
    // Guarded for jsdom, which ships no ResizeObserver (the #285 precedent in
    // ScrollbackPane): the load handler still measures once there.
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measureFit);
    observer?.observe(el);
    onCleanup(() => {
      observer?.disconnect();
      image = undefined;
    });
  };

  return (
    <div ref={bindScroller} class="media-viewer-zoom-scroller">
      {/* Purely geometric: it carries the scrollable area a transform cannot
          create. aria-hidden + pointer-events:none so it is neither read nor
          tapped. */}
      <div ref={sizer} class="media-viewer-zoom-sizer" aria-hidden="true" />
      <img
        ref={bindImage}
        class="media-viewer-media media-viewer-media--zoomable"
        src={props.href}
        alt={props.href}
        onLoad={() => {
          measureFit();
          props.onLoad();
        }}
        onError={props.onError}
      />
    </div>
  );
};

// #1764 — `.txt` / `.md` read inline as SOURCE. vjt, #sbiffo 2026-08-24,
// verbatim: "nono nessun rendering di gesu, assolutamente solo il sorgente txt
// e md". Monospace, line numbers, and nothing interpreted — not now and not as
// a later toggle. That is not only a taste call: cic has no sanitisation
// surface anywhere today, and a markdown renderer would be the reason it grew
// one, on a page that holds the bearer token.
//
// TWO text nodes, not one row per line. A gutter <pre> and a source <pre> side
// by side keep the DOM node count constant whatever the file size, and they
// are rendered from the SAME `lines` array so number N is beside line N by
// construction rather than by two agreeing loops. The stylesheet does the rest
// of the alignment (`font: inherit` on both — see mediaViewerTouchAction.test).
//
// Mounted only from inside the keyed <Show>, so the fetch fires on OPEN. A
// createResource at MediaViewerModal scope would fire at Shell BOOT, because
// the component body runs whether or not the modal is showing (the
// ThemeEditor/#294 failure).
const TextPane: Component<{
  href: string;
  onLoad: () => void;
  onError: () => void;
  // Published upward so the dismiss gesture can ask whether the pane is at its
  // top. Not a signal: the reader is a touchstart handler, and the element
  // identity never changes for the life of the mount.
  paneRef: (el: HTMLDivElement | undefined) => void;
}> = (props) => {
  const abort = new AbortController();
  onCleanup(() => {
    abort.abort();
    props.paneRef(undefined);
  });

  const [source] = createResource(
    () => props.href,
    (href) => fetchTextResource(href, abort.signal),
  );

  // The viewer's shared spinner/failure machinery is driven by element events
  // for every other kind; here the same two outcomes come off the resource, so
  // the modal keeps ONE load-state model instead of a second one for text.
  //
  // Both the effect and the render below go through `source.state` and never
  // through a bare `source()`: reading an ERRORED resource RETHROWS, which
  // takes the component down before it can show the failure the reader is
  // owed — a fetch 404 rendered as a crash and a forever-spinner.
  createEffect(() => {
    if (source.state === "errored") props.onError();
    else if (source.state === "ready") props.onLoad();
  });

  const settled = (): ReturnType<typeof source> | undefined =>
    source.state === "ready" ? source() : undefined;

  const gutter = (count: number): string =>
    Array.from({ length: count }, (_, i) => String(i + 1)).join("\n");

  return (
    <Show when={settled()}>
      {(loaded) => (
        <>
          <Show when={loaded().truncated}>
            {/* Above the pane, not below it: a reader must know they are
                holding a slice BEFORE they start reading, not discover it at
                a bottom they may never scroll to. */}
            <p class="muted media-viewer-text-truncated">
              showing the first {TEXT_VIEW_MAX_BYTES / 1024} KiB of this file — "open in browser"
              for the whole thing
            </p>
          </Show>
          <div class="media-viewer-text" ref={props.paneRef}>
            <pre
              class="media-viewer-text-gutter"
              data-testid="media-viewer-text-gutter"
              aria-hidden="true"
            >
              {gutter(loaded().lines.length)}
            </pre>
            <pre class="media-viewer-text-source" data-testid="media-viewer-text-source">
              {loaded().lines.join("\n")}
            </pre>
          </div>
        </>
      )}
    </Show>
  );
};

// Body subcomponent so the load status resets per open: the keyed
// <Show> remounts it for every new viewer state, giving each open a
// fresh signal — no manual reset effect to keep in sync. Spinner until
// the element reports readiness (img: load; video/audio:
// loadedmetadata — enough for duration/controls; loadeddata never
// fires under preload=metadata), explicit failure text on error so a
// 404 can't spin forever. The failed media element is unmounted —
// a broken <img> would render its alt text (the raw URL) under the
// failure line.
const MediaViewerBody: Component<{
  state: MediaViewerState;
  onScale: (scale: number) => void;
  onTextPaneRef: (el: HTMLDivElement | undefined) => void;
}> = (props) => {
  const [status, setStatus] = createSignal<MediaLoadStatus>("loading");
  // Transitions only leave "loading" (review fix): a transient
  // mid-playback error must not unmount a ready element, and a suspend
  // arriving after a failure must not resurrect a dead one.
  const settle = (next: MediaLoadStatus) => (): void => {
    if (status() === "loading") setStatus(next);
  };
  const ready = settle("ready");
  const failed = settle("failed");

  // video/audio readiness: loadedmetadata is the normal terminator
  // (duration + dimensions; loadeddata never fires under
  // preload=metadata). suspend is the iOS escape valve (review fix):
  // under Low Power Mode / Data Saver WebKit downgrades the preload
  // and fires NEITHER loadedmetadata NOR error before a play gesture —
  // suspend is what it fires when it defers, and without it the
  // spinner spins forever. The element is fully usable at that point.
  return (
    <div
      class="media-viewer-body"
      classList={{ "media-viewer-body--text": props.state.kind === "text" }}
    >
      <Show when={status() === "loading"}>
        <div role="status" aria-label="Loading media" class="media-viewer-spinner" />
      </Show>
      <Show
        when={status() === "failed"}
        fallback={
          <Switch>
            <Match when={props.state.kind === "image"}>
              <ZoomableImage
                href={props.state.href}
                onLoad={ready}
                onError={failed}
                onScale={props.onScale}
              />
            </Match>
            <Match when={props.state.kind === "video"}>
              {/* playsinline: without it iOS hands the element to the
                  native fullscreen player, defeating the in-app
                  viewer. preload=metadata: show duration without
                  pulling the whole file. */}
              {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded IRC media — no caption track exists or can be authored for it */}
              <video
                class="media-viewer-media"
                src={props.state.href}
                controls
                playsinline
                preload="metadata"
                onLoadedMetadata={ready}
                onSuspend={ready}
                onError={failed}
              />
            </Match>
            <Match when={props.state.kind === "audio"}>
              {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded IRC media — no caption track exists or can be authored for it */}
              <audio
                class="media-viewer-media"
                src={props.state.href}
                controls
                preload="metadata"
                onLoadedMetadata={ready}
                onSuspend={ready}
                onError={failed}
              />
            </Match>
            <Match when={props.state.kind === "text"}>
              <TextPane
                href={props.state.href}
                onLoad={ready}
                onError={failed}
                paneRef={props.onTextPaneRef}
              />
            </Match>
          </Switch>
        }
      >
        <p class="muted media-viewer-error">failed to load — try "open in browser"</p>
      </Show>
    </div>
  );
};

// #1438 — the modal is centered by a CSS `transform: translate(-50%, -50%)`,
// and an inline transform REPLACES that declaration wholesale. The drag offset
// therefore has to re-state the centering, or the modal jumps by half its own
// size the instant a finger claims it.
const draggedTransform = (dy: number): string => `translate(-50%, -50%) translateY(${dy}px)`;

// The backdrop thins out with the pull and is fully clear at one viewport of
// travel. Deliberately NOT keyed to DISMISS_COMMIT_FRACTION: a ramp that hit
// zero at the commit point would black-flash back to full on every drag that
// crosses the line and springs back anyway, and a second threshold is a second
// thing to keep in step.
const backdropOpacity = (dy: number, viewportHeight: number): number =>
  viewportHeight <= 0 ? 1 : Math.max(0, 1 - Math.abs(dy) / viewportHeight);

// Everything that must be FRESH per open lives here, not in the parent: the
// keyed <Show> remounts this subtree for every viewer state, which is what
// gives each open a zero zoom level and an untouched drag offset — the same
// reason MediaViewerBody is its own component.
const MediaViewerDialog: Component<{ state: MediaViewerState }> = (props) => {
  // Plain mutable, not a signal: nothing RENDERS from the zoom level. It is
  // read once per touchstart by a DOM callback, and a signal here would only
  // advertise a reactivity that does not exist.
  let scale = MIN_SCALE;
  let backdrop: HTMLButtonElement | undefined;
  // #1764 — the text arm's scroll container, once it has fetched. Same
  // plain-mutable reasoning as `scale`: nothing renders from it, and the only
  // reader is a touchstart handler.
  let textPane: HTMLDivElement | undefined;
  const isText = props.state.kind === "text";
  // #1805 — the image arm now has a scroller under it, and `.media-viewer-modal`
  // closes the touch stream with `touch-action: none`. Whether that closure
  // even reaches a descendant scroll container is engine-dependent and only
  // half-measurable here: chromium intersects touch-action from the hit element
  // up to the SCROLL CONTAINER and stops, so the modal's `none` is inert (arm C
  // of the #1805 bench, 105px of scroll through it); Playwright's WebKit
  // exposes no touch-drag drive at all, so the same question cannot be put to
  // the engine this issue is about. Re-opening on the modal — the #1764
  // precedent, one class along — is correct under BOTH readings, and measured
  // free under the one that can be measured: at fit the dismiss still received
  // 11 cancelable moves out of 11, exactly as it does under `none`.
  const isImage = props.state.kind === "image";

  const paint = (el: HTMLElement, dy: number): void => {
    el.style.transform = draggedTransform(dy);
    if (backdrop !== undefined) {
      backdrop.style.opacity = String(backdropOpacity(dy, window.innerHeight));
    }
  };

  const unpaint = (el: HTMLElement): void => {
    el.style.removeProperty("transform");
    backdrop?.style.removeProperty("opacity");
  };

  const bindDismiss = (el: HTMLDivElement): void => {
    const dispose = bindDismissGesture(el, {
      viewportHeight: () => window.innerHeight,
      // A zoomed image owns the one-finger drag as a PAN (#213), so the viewer
      // stands down until the image is back at fit. Video and audio never
      // publish a scale, which is exactly right: they are always dismissible.
      //
      // #1764 — a text pane owns the drag as a SCROLL for as long as it has
      // anywhere to scroll back to, so the dismiss is live only at its top.
      // Paired with `directions: "down"` below, the two gates split the axis
      // cleanly: scrolled → the pane keeps every vertical drag; at the top →
      // up still scrolls, and only down dismisses.
      canDismiss: () => (isText ? (textPane?.scrollTop ?? 0) <= 0 : scale <= MIN_SCALE),
      directions: (isText ? "down" : "both") satisfies DismissDirections,
      onProgress: (dy) => {
        paint(el, dy);
      },
      // Through the shared close verb, never a bare state poke: #1121 and #535
      // both closed on that path doing more than clearing the signal.
      onCommit: closeMediaViewer,
      onRelease: () => {
        unpaint(el);
      },
    });
    onCleanup(dispose);
  };

  return (
    <>
      <button
        type="button"
        ref={backdrop}
        class="media-viewer-backdrop"
        aria-label="Close media viewer backdrop"
        onClick={closeMediaViewer}
      />
      <div
        ref={bindDismiss}
        role="dialog"
        aria-modal="true"
        aria-label="Media viewer"
        class="media-viewer-modal"
        classList={{
          "media-viewer-modal--text": isText,
          "media-viewer-modal--zoomable": isImage,
        }}
      >
        <div class="media-viewer-header">
          <a
            href={props.state.href}
            target="_blank"
            rel="noopener noreferrer"
            class="media-viewer-open-external"
            onClick={(e) => {
              maybeEscapePwaClick(e, props.state.href);
            }}
          >
            open in browser
          </a>
          <button
            type="button"
            class="media-viewer-close"
            aria-label="Close media viewer"
            onClick={closeMediaViewer}
          >
            ✕
          </button>
        </div>
        <MediaViewerBody
          state={props.state}
          onScale={(next) => {
            scale = next;
          }}
          onTextPaneRef={(el) => {
            textPane = el;
          }}
        />
      </div>
    </>
  );
};

const MediaViewerModal: Component = () => {
  // UX-6 bucket A — refcounted overlay scroll-lock (shared
  // createOverlayLock wiring, extracted from the ArchiveModal/
  // PrivacyModal copies during this cluster's review). #232 — Escape now
  // routes through the same lock's shared ESC stack (topmost-first,
  // focus-independent) instead of a private document keydown listener.
  createOverlayLock(() => mediaViewerState() !== null, ".media-viewer-modal", closeMediaViewer);

  return (
    <Show when={mediaViewerState()} keyed>
      {(state) => <MediaViewerDialog state={state} />}
    </Show>
  );
};

export default MediaViewerModal;
