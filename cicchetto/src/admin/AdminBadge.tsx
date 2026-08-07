import type { Component, JSX } from "solid-js";

// Admin redesign Layer 2 — one badge idiom replacing `LiveBadge`×2 +
// `CircuitBadge` + the bare `.admin-badge` class + the raw ternary
// text in AdminCredentialsTab. `tone` maps 1:1 onto the `--adm-ok` /
// `--adm-warn` / `--adm-danger` / neutral tokens (Layer 1) so every
// badge follows the active theme instead of a hardcoded hex.
//
// `class` stays available so a call site can layer a legacy class
// (e.g. `dead`) that an existing test still queries via
// `classList.contains(...)` — migrating the markup shape must not
// silently rewrite what a pre-existing assertion targets.

export type Tone = "ok" | "warn" | "danger" | "neutral";

export type Props = {
  tone: Tone;
  children: JSX.Element;
  class?: string;
  testId?: string;
  ariaLabel?: string;
};

// `role="status"` is a literal, not `props.role` — biome's
// `useAriaPropsSupportedByRole` can't resolve a dynamic role
// expression and flags `aria-label` on a `<span>` with no statically
// known role. Every current badge use (LiveBadge, CircuitBadge) wants
// `status` semantics anyway, so there is no lost case in pinning it.
const AdminBadge: Component<Props> = (props) => (
  <span
    class={`adm-badge adm-badge--${props.tone} ${props.class ?? ""}`.trim()}
    data-testid={props.testId}
    role="status"
    aria-label={props.ariaLabel}
  >
    {props.children}
  </span>
);

export default AdminBadge;
