// #1438 — STUB. The behaviour lands in the next commit; this exists so the
// spec's red is per-assertion and readable by name rather than one
// module-not-found that exercises nothing.
import type { Point } from "./swipe";

export const DISMISS_COMMIT_FRACTION = 0.15;
export const DRAGGING_CLASS = "media-viewer-modal--dragging";

export type DismissGestureParams = {
  viewportHeight: () => number;
  canDismiss: () => boolean;
  onProgress: (dy: number) => void;
  onCommit: () => void;
  onRelease: () => void;
};

export type { Point };

export function bindDismissGesture(_el: HTMLElement, _params: DismissGestureParams): () => void {
  return () => {};
}
