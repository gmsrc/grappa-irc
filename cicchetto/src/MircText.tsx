import { type Component, For, type JSX } from "solid-js";
import { playAudio } from "./lib/audioPlayer";
import { splitEmphasis } from "./lib/emphasisMarkers";
import { linkify } from "./lib/linkify";
import { classifyMediaLink, sameHostHref } from "./lib/mediaLink";
import { openMediaViewer } from "./lib/mediaViewer";
import { mircPlainRuns, parseMircFormat, type Run } from "./lib/mircFormat";
import { maybeEscapePwaClick } from "./lib/platform";
import { replyQuoteHeadLength } from "./lib/quotableBody";
import { serverSettings } from "./lib/serverSettings";
import { getStripFormatting } from "./lib/stripFormatting";

// Shared mIRC-formatting renderer. Extracted from ScrollbackPane (#125) so
// the channel-directory topic reuses the SAME typed-formatting render path
// as scrollback message bodies — the one-parser invariant (cic never parses
// IRC framing itself; `parseMircFormat` expands the server-supplied wire
// bytes into typed runs, this module styles them). The single module that
// styles `parseMircFormat` runs for display, consumed by ScrollbackPane
// (message bodies, wallops, globops, server errors, actions) and
// DirectoryPane (topics).

// #220 — per-surface link-vs-surface event routing. A linkified anchor
// (real <a target=_blank>) that lives INSIDE a tappable surface would
// otherwise double-fire: the anchor click bubbles to the surface's
// onClick, so a single tap both browses the link AND performs the
// surface action. The two surfaces that wrap MircBody want OPPOSITE
// policies, so this is a closed-set knob on the shared renderer — the
// MECHANISM (anchor event routing) is shared, the POLICY is per-surface.
//
//  * "navigate"     — plain scrollback / cards (the overwhelming
//                     majority). The anchor navigates; the click is free
//                     to bubble. This is the pre-#220 behavior and the
//                     genuine config default (correct production behavior
//                     for every non-tappable-surface site — closed-set
//                     default precedent, cf. timeFormat.ts).
//  * "link-wins"    — /list directory rows. Tapping a LINK just browses;
//                     it must NOT trigger the row's join. The anchor
//                     stops propagation so the wrapping row handler never
//                     fires, then browses via the normal path.
//  * "surface-wins" — the topic bar. The bar ALWAYS opens the topic
//                     modal first; a tap NEVER navigates a link directly.
//                     The anchor suppresses its own navigation and lets
//                     the click bubble to the bar. Link handling is
//                     deferred to the modal (which renders MircBody at
//                     the default "navigate").
export type LinkPolicy = "navigate" | "link-wins" | "surface-wins";

// #455 — the textual-emphasis layer. Runs over a single linkify TEXT
// segment (never a URL — so `_`/`/` inside a link are structurally out of
// reach) and splits it into emphasis sub-runs, keeping the marker chars
// visible. The emphasis attributes OR onto the run's own mIRC attributes:
// an emphasis span reuses the SAME `.scrollback-mirc-*` classes, so a
// bold/italic/underline that lands inside an already-formatted run is
// simply absorbed (wire formatting stays authoritative). An unstyled
// sub-run renders as a bare text node — no wrapper span, no DOM churn on
// the common no-marker path, and the concatenated text content stays
// byte-identical to the source (copy-paste fidelity).
//
// GATED per surface (#455 vjt ruling): this layer is OPT-IN, off by
// default. IRC carries no human-vs-bot signal (a bot PRIVMSG is
// byte-identical to a person's and grappa reads no `bot` message tag), so
// "human-authored" cannot be a per-message test — it is a per-SURFACE
// gate. `MircBody` callers that render user-typed text pass `emphasis`;
// server/service-generated surfaces (whois cards, /list, server-reply and
// service modals, /links, our own wizard copy) leave it off, which also
// removes the surfaces where paths/`snake_case`/URL-junk actually
// concentrate BEFORE the tokenizer runs. The wire-formatting layer
// (\x02/\x1D/\x1F) is unaffected and stays on everywhere.
const renderEmphasis = (text: string): JSX.Element => (
  <For each={splitEmphasis(text)}>
    {(span) => {
      if (!span.bold && !span.italic && !span.underline) return span.text;
      return (
        <span
          classList={{
            "scrollback-mirc-bold": span.bold,
            "scrollback-mirc-italic": span.italic,
            "scrollback-mirc-underline": span.underline,
          }}
        >
          {span.text}
        </span>
      );
    }}
  </For>
);

// #648 — a linkify `channel` segment (`#sniffo`) renders as a click-to-join
// affordance, but ONLY on surfaces that wire `onChannelClick` (scrollback
// message bodies). Everywhere else (topic bar, whois cards, /list, service
// modals) it degrades to plain text — the identical posture a url segment
// takes on a non-tappable surface. A channel is ALWAYS exempt from the
// textual-emphasis pass (like a url), so `#foo_bar_baz` never has its
// underscores eaten, on ANY surface. Rendered as a <button> — not a styled
// span — so it inherits keyboard focus + activation for free, mirroring the
// `.nick-clickable` sender affordance (ScrollbackPane #354) and satisfying
// biome's a11y rules without a manual keydown handler.
const renderChannel = (
  channel: string,
  onChannelClick: ((channel: string) => void) | undefined,
): JSX.Element => {
  if (!onChannelClick) return channel;
  return (
    <button
      type="button"
      class="scrollback-inline-button channel-clickable"
      onClick={() => onChannelClick(channel)}
    >
      {channel}
    </button>
  );
};

// issue 2086 — a run, plus whether it falls inside the quoted head of a reply.
// The flag is the ONLY thing this layer adds to `Run`: `mircFormat` decodes the
// wire and knows nothing about what cic's Reply verb emits, and keeping the
// classification here is what stops the wire parser from growing a second job.
type QuotedRun = Run & { quoted: boolean };

// issue 2086 — split the runs at the end of the quoted head, so the head can be
// dimmed and the answer cannot. vjt (#it-opers, 2026-09-11): "facciamo sì che
// il colore della parte quotata sia più muted, cosi si vede di più il messaggio
// inviato".
//
// The boundary comes from `replyQuoteHeadLength` — the SAME `PREVIOUS_QUOTE`
// predicate a re-reply strips with — measured against the run texts joined
// back, which IS the plain projection (`mircPlainText` is literally that
// concatenation). So the dimmed region and the stripped region are one region
// by construction: no second detector, and nothing to keep in step.
//
// `trimStart` because the requote path matches a `.trim()`ed body while the
// renderer must keep every character it was given. Two lines to keep the two
// answers identical on a body with leading whitespace; without them the render
// would silently decline to dim a head the requote would still cut.
//
// The cut can land INSIDE a run (the common case: one plain run for the whole
// body), so that run is split in two — which is also why this returns runs and
// not an index. Emphasis and linkify then run per half; neither can span the
// `<< ` boundary, because a space sits there.
const splitReplyQuote = (runs: Run[]): QuotedRun[] => {
  const plain = runs.map((run) => run.text).join("");
  const lead = plain.length - plain.trimStart().length;
  const head = replyQuoteHeadLength(plain.slice(lead));
  if (head === 0) return runs.map((run) => ({ ...run, quoted: false }));
  const cut = lead + head;
  const out: QuotedRun[] = [];
  let seen = 0;
  for (const run of runs) {
    const end = seen + run.text.length;
    if (end <= cut) out.push({ ...run, quoted: true });
    else if (seen >= cut) out.push({ ...run, quoted: false });
    else {
      out.push({ ...run, text: run.text.slice(0, cut - seen), quoted: true });
      out.push({ ...run, text: run.text.slice(cut - seen), quoted: false });
    }
    seen = end;
  }
  return out;
};

// CP13 S10: render an IRC body string with mIRC formatting expanded into
// per-run <span> elements. Plain text (no control chars) collapses into a
// single Run and renders as one <span>; the no-formatting fast path is
// the common case so this stays cheap. Each Run gets a class for each
// active toggle attribute + inline style for fg/bg colors (the palette is
// 16 fixed values — we don't generate per-color CSS classes).
const renderRun = (
  run: QuotedRun,
  linkPolicy: LinkPolicy,
  emphasis: boolean,
  onChannelClick: ((channel: string) => void) | undefined,
): JSX.Element => {
  const style: Record<string, string> = {};
  // Reverse swaps fg/bg. mIRC reverses the rendered colors AND falls back
  // to the terminal default when fg/bg aren't set, but in a web context
  // we don't have a "terminal default" — fall back to plain text colors
  // and let the .scrollback-mirc-reverse class style the swap (CSS owns
  // the visual). Inline style still applies the explicit fg/bg if set.
  // fg/bg are already resolved CSS color strings (the parser owns palette +
  // \x04 hex resolution — no lookup leaks here). Reverse swaps which slot
  // each color lands in.
  if (run.fg !== undefined) {
    style[run.reverse ? "background-color" : "color"] = run.fg;
  }
  if (run.bg !== undefined) {
    style[run.reverse ? "color" : "background-color"] = run.bg;
  }
  // No-silent-drops bucket 4 (2026-05-14): linkify the run text so URLs
  // render as <a href target="_blank" rel="noopener noreferrer">. Done
  // INSIDE the formatting <span> so URL links inherit the run's bold /
  // color / etc. attributes (mIRC formatting + linkification compose
  // cleanly). Plain-text runs go through linkify too -- the cost is
  // one regex scan per run; if no URL matches the result is a single
  // text segment which renders identically to the pre-linkify path.
  const segments = linkify(run.text);
  return (
    <span
      classList={{
        "scrollback-mirc-bold": run.bold,
        "scrollback-mirc-italic": run.italic,
        "scrollback-mirc-underline": run.underline,
        "scrollback-mirc-strikethrough": run.strikethrough,
        "scrollback-mirc-monospace": run.monospace,
        "scrollback-mirc-reverse": run.reverse && run.fg === undefined && run.bg === undefined,
        // issue 2086 — the quoted head, dimmed by the stylesheet; issue 2112
        // moved that grey off `--muted` and onto the one the presence rows read
        // as on screen. This layer only MARKS the region — the colour, and why
        // it is a `color-mix` and not an `opacity`, live on the rule in
        // `themes/default.css`.
        //
        // Withheld from a run that carries an EXPLICIT colour, on the same
        // fg/bg test the reverse line above uses. The dimming must LOSE to a
        // `\x03` the sender chose: a colour opened inside the quote keeps
        // applying past `<< `, so the head is already part-coloured, and a dim
        // that fought it would repaint characters the sender coloured on
        // purpose. The inline `style` would win the cascade anyway on a plain
        // fg run — stating it here also covers `reverse`, where fg lands on
        // `background-color` and leaves `color` free for the class to take,
        // and keeps the DOM from claiming "muted" where nothing is muted.
        "scrollback-reply-quote": run.quoted && run.fg === undefined && run.bg === undefined,
      }}
      style={style}
    >
      <For each={segments}>
        {(seg, i) => {
          if (seg.type === "text") return emphasis ? renderEmphasis(seg.value) : seg.value;
          // #648 — channel segment: click-to-join affordance (scrollback) or
          // plain text (elsewhere). Structurally exempt from emphasis, like url.
          if (seg.type === "channel") return renderChannel(seg.value, onChannelClick);
          // Media-link cluster (2026-06-11): same-origin media URLs get
          // a click intercept → in-app viewer modal (lib/mediaViewer),
          // because in-PWA-scope links navigate the iOS standalone
          // window IN PLACE (raw media doc, no chrome, return reloads
          // cic). The preceding text segment carries the 📸/🎬 type
          // signal for own upload URLs (slug has no extension). The
          // anchor + href stay — copy-link / middle-click / long-press
          // keep working; only plain click is intercepted.
          //
          // Review fix (2026-06-11): the navigate-in-place bug class
          // covers EVERY same-host link, not just modal-viewable media
          // — 📄 docs (classifyMediaLink deliberately rejects them; the
          // modal can't render PDFs) and emoji-split-run fallbacks.
          // Those plain clicks delegate to the shared
          // maybeEscapePwaClick handler (x-safari handoff on iOS
          // standalone, no-op everywhere else). Cross-host links stay
          // untouched: out-of-scope already opens correctly in the iOS
          // Safari view.
          const prev = segments[i() - 1];
          // #324 — the deployment's server-provided HTTP host aliases:
          // an upload link on ANY of them opens the in-app viewer, not
          // just one on the page origin (aliases share the /uploads
          // store). Read from the reactive serverSettings() store; []
          // before the after-join snapshot (page origin only, pre-#324).
          // Injected into the classifier so mediaLink.ts stays pure +
          // table-testable (no store import there).
          const aliasHosts = serverSettings()?.httpHostAliases ?? [];
          const media = classifyMediaLink(
            seg.href,
            prev?.type === "text" ? prev.value : "",
            window.location.origin,
            aliasHosts,
          );
          const escapeHref =
            media === null ? sameHostHref(seg.href, window.location.origin, aliasHosts) : null;
          // #220 — compose the per-surface policy with the existing
          // media/escape in-app handling. The click handler is only
          // BUILT and attached when there's something to do; the pure
          // "navigate" plain-link case stays a bare anchor with no
          // listener and no closure allocated (pre-#220 behavior).
          const needsHandler = linkPolicy !== "navigate" || media !== null || escapeHref !== null;
          return (
            <a
              href={seg.href}
              target="_blank"
              rel="noopener noreferrer"
              class="scrollback-link"
              classList={{ "scrollback-media-link": media !== null }}
              onClick={
                needsHandler
                  ? (e) => {
                      // "surface-wins" (topic bar): the wrapping surface
                      // ALWAYS wins. Suppress the anchor's own navigation
                      // AND any in-app media/escape handling — links are
                      // deferred to the surface (the topic modal). Let the
                      // click bubble so the surface handler fires.
                      if (linkPolicy === "surface-wins") {
                        e.preventDefault();
                        return;
                      }
                      // Media / escape in-app handling (pre-#220) for the
                      // "navigate" and "link-wins" policies.
                      if (media !== null) {
                        // Modifier/aux clicks keep browser-native
                        // semantics (new tab / new window) — only the
                        // plain primary click opens the viewer.
                        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) {
                          e.preventDefault();
                          // media.href is re-rooted on the page origin —
                          // historical prod bodies carry http:// hrefs
                          // (mixed content if loaded as-is on https).
                          //
                          // Audio routes to the docked, non-modal
                          // mini-player (GH #115) so scrollback stays
                          // readable while it plays; image/video keep the
                          // full-screen viewer.
                          if (media.kind === "audio") {
                            // No label (#682): a pasted media link carries no
                            // title on the wire — cic sees a slug-only href —
                            // so there is nothing honest to caption it with.
                            playAudio(media.href, null);
                          } else {
                            openMediaViewer(media.href, media.kind);
                          }
                        }
                      } else if (escapeHref !== null) {
                        // escapeHref is origin-rooted for the same
                        // mixed-content reason as media.href.
                        maybeEscapePwaClick(e, escapeHref);
                      }
                      // "link-wins" (/list rows, mentions): the link
                      // browses but must NOT trigger the surface's action.
                      // Stop the click from reaching the wrapping handler
                      // — after the media/escape side effects, and
                      // regardless of modifier clicks (a cmd-click still
                      // opens a tab, still no surface action).
                      if (linkPolicy === "link-wins") {
                        e.stopPropagation();
                      }
                    }
                  : undefined
              }
            >
              {seg.value}
            </a>
          );
        }}
      </For>
    </span>
  );
};

export const MircBody: Component<{
  body: string;
  linkPolicy?: LinkPolicy;
  // #455 — opt in to the textual-emphasis layer (default off). Only the
  // surfaces that render user-typed text (scrollback messages/actions,
  // the mentions window, the topic bar) pass this; server/service-
  // generated surfaces leave it off. Like linkPolicy, a per-surface flag
  // is inherently static — pass a stable literal, not a reactive signal.
  emphasis?: boolean;
  // #648 — opt in to the click-to-join channel affordance. ONLY the
  // scrollback message-body surfaces (privmsg / notice / action) pass this;
  // when absent, `#channel` segments render as plain text (see
  // renderChannel). The handler receives the RAW, display-cased channel
  // (`#Sniffo`); the callee folds for keys. Same stable-value contract as
  // linkPolicy / emphasis — a per-surface handler, not a reactive signal.
  onChannelClick?: (channel: string) => void;
}> = (props) => {
  // #2029 — THE chokepoint. `parseMircFormat` has exactly one production
  // render caller (this line), and colour resolution never leaves
  // `mircFormat.ts`, so every mIRC-formatted surface in cic — 39 `<MircBody>`
  // call sites across 12 files, nine of which the issue never names — honours
  // the strip preference by funnelling through here. Per-surface opt-in was
  // never on the table: "if a surface renders colour, it must honour the
  // strip", and enumerating them is how such a list rots.
  //
  // A TRACKED read of the signal, inside the same accessor that already
  // re-runs on `props.body`: toggling re-renders every open pane with no
  // reconnect and no refetch, because the raw body is untouched and only its
  // projection changed. That is the issue's own contract, not a nicety.
  //
  // issue 2086 rides the same chokepoint, and for the reason stated right
  // above: a reply reads the same way on every surface that renders a body,
  // and a per-surface opt-in list is the thing that rots. The classification
  // is by SHAPE, so a hand-typed quote dims too — acceptable by the issue's
  // own ruling, because it looks like a quote precisely because it is one.
  const runs = (): QuotedRun[] =>
    splitReplyQuote(getStripFormatting() ? mircPlainRuns(props.body) : parseMircFormat(props.body));
  // Default "navigate" is the genuine config default — correct
  // production behavior for every non-tappable-surface consumer.
  //
  // Constraint: `linkPolicy`/`emphasis` are read inside the <For> child,
  // which re-maps only when runs() (i.e. props.body) changes — so a caller
  // must pass them as STABLE values (literals, as all current callers do),
  // not reactive signals that change independently of body. A per-surface
  // policy is inherently static, so this is a non-issue in practice;
  // documented so a future reactive caller isn't surprised by a stale one.
  return (
    <For each={runs()}>
      {(run) =>
        renderRun(
          run,
          props.linkPolicy ?? "navigate",
          props.emphasis ?? false,
          props.onChannelClick,
        )
      }
    </For>
  );
};
