import { type Component, createSignal, onCleanup } from "solid-js";

// #1896 — WHERE the docked player's chrome belongs, held apart from WHERE the
// player is MOUNTED, because on this shell the two cannot be the same place.
//
// The mobile/desktop split is a JSX branch (`<Show when={isMobile()}>` in
// Shell), not a CSS toggle, and rotating a phone whose landscape CSS width
// clears 768px crosses it. Solid destroys one subtree and builds the other, so
// anything mounted inside a branch is a NEW object on the far side of a
// rotation. For `<audio>` that means a new element, an open effect running as a
// first tune, and — for a STREAM, where `mustRefetch()` is true — a fresh HTTP
// connection to the station: the audible gap the report describes, with the
// autoplay behind it.
//
// So the player is mounted ONCE, above the branch, and each branch renders one
// of these in its place: an empty marker that says "the bar goes here". The
// player portals its chrome into whichever marker is live. The element never
// moves; only the chrome does, and the chrome holds no transport state.
//
// WHY A SIGNAL AND NOT A PROP. Shell could thread a setter down, but the two
// docks sit in different arms of the same `<Show>` and each would have to
// repeat the register/retract pair inline — the copy-paste-with-tweaks this
// module exists to avoid. The dock is also a fact about the DOM, not about the
// identity: unlike the audio store it is deliberately NOT identity-scoped, so
// it does not belong in `lib/audioPlayer.ts` beside the source.
//
// Two docks never coexist: they are in the two arms of one `<Show>`, and inside
// each arm in the single `<Match>` that renders a chat window. The retraction
// is nevertheless CONDITIONAL — a dock clears the signal only if it is still
// the one registered — so the pair of writes a flip produces cannot end with
// the outgoing branch erasing the incoming branch's registration, whichever
// order Solid disposes and builds in. That is one comparison, and it makes the
// contract independent of a scheduling detail rather than dependent on today's.

const [dockEl, setDockEl] = createSignal<HTMLElement | undefined>(undefined);

/**
 * The live dock element, or `undefined` on a window kind that renders none
 * (home / list / mentions / admin, which have no compose column to dock to).
 */
export const audioDock = dockEl;

/** The slot the player's chrome is portalled into. Renders nothing of its own. */
const AudioDock: Component = () => (
  <div
    class="audio-dock"
    data-testid="audio-dock"
    ref={(el) => {
      setDockEl(el);
      onCleanup(() => setDockEl((current) => (current === el ? undefined : current)));
    }}
  />
);

export default AudioDock;
