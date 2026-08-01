import { afterEach, describe, expect, it } from "vitest";
import type { WireUserEvent } from "../lib/api";
import {
  applyRecoverProgress,
  applyRecoverResult,
  dismissRecover,
  recoverState,
} from "../lib/recoverProgress";

// #581 — "recover my identity" progress store. Transient (createRoot)
// singleton holding `{networkSlug, steps, outcome, reason} | null`. The server
// drives: the FIRST recover_progress OPENS the modal, subsequent ones
// accumulate/update the step list, recover_result concludes it — and a result
// on a CLOSED store is dropped (the patch guard, so a dismissed modal is never
// resurrected). cic NEVER originates recovery state.

const SLUG = "azzurra";

type RecoverStep = "identify" | "register" | "nick" | "recover" | "release";
type RecoverStatus = "running" | "ok" | "failed";

const progress = (
  step: RecoverStep,
  status: RecoverStatus,
  reason: string | null = null,
): Extract<WireUserEvent, { kind: "recover_progress" }> => ({
  kind: "recover_progress",
  network: SLUG,
  step,
  status,
  reason,
});

const result = (
  outcome: "succeeded" | "failed",
  reason: string | null = null,
): Extract<WireUserEvent, { kind: "recover_result" }> => ({
  kind: "recover_result",
  network: SLUG,
  outcome,
  reason,
});

describe("recoverProgress store (#581)", () => {
  afterEach(() => dismissRecover());

  it("opens on the first recover_progress event (server drives; cic never originates)", () => {
    expect(recoverState()).toBeNull();
    applyRecoverProgress(progress("identify", "running"));
    expect(recoverState()).toMatchObject({ networkSlug: SLUG, outcome: null, reason: null });
    expect(recoverState()?.steps).toEqual([{ step: "identify", status: "running", reason: null }]);
  });

  it("accumulates new steps and updates an existing step in place", () => {
    applyRecoverProgress(progress("identify", "running"));
    applyRecoverProgress(progress("identify", "ok")); // same step → update in place
    applyRecoverProgress(progress("recover", "running")); // new step → append
    expect(recoverState()?.steps).toEqual([
      { step: "identify", status: "ok", reason: null },
      { step: "recover", status: "running", reason: null },
    ]);
  });

  it("carries a per-step failure reason", () => {
    applyRecoverProgress(progress("identify", "failed", "wrong_password"));
    expect(recoverState()?.steps).toEqual([
      { step: "identify", status: "failed", reason: "wrong_password" },
    ]);
  });

  it("sets the terminal success outcome on recover_result", () => {
    applyRecoverProgress(progress("identify", "ok"));
    applyRecoverResult(result("succeeded"));
    expect(recoverState()?.outcome).toBe("succeeded");
    expect(recoverState()?.reason).toBeNull();
  });

  it("sets the terminal failure outcome + reason on recover_result", () => {
    applyRecoverProgress(progress("identify", "ok"));
    applyRecoverResult(result("failed", "services_declined"));
    expect(recoverState()?.outcome).toBe("failed");
    expect(recoverState()?.reason).toBe("services_declined");
  });

  it("dismiss clears the state to null", () => {
    applyRecoverProgress(progress("identify", "running"));
    dismissRecover();
    expect(recoverState()).toBeNull();
  });

  it("recover_result no-ops when closed (patch guard — never resurrects a dismissed modal)", () => {
    // Closed from the start: a terminal result with no open modal is dropped.
    applyRecoverResult(result("failed", "wrong_password"));
    expect(recoverState()).toBeNull();

    // Dismissed mid-flight: a late result must not reopen it.
    applyRecoverProgress(progress("identify", "running"));
    dismissRecover();
    applyRecoverResult(result("succeeded"));
    expect(recoverState()).toBeNull();
  });

  it("ignores a progress event for a DIFFERENT network than the open modal (review-#3)", () => {
    applyRecoverProgress(progress("identify", "running")); // opens for SLUG
    applyRecoverProgress({ ...progress("recover", "running"), network: "other-net" });
    // The stray other-network step is NOT mixed into SLUG's modal.
    expect(recoverState()?.networkSlug).toBe(SLUG);
    expect(recoverState()?.steps).toEqual([{ step: "identify", status: "running", reason: null }]);
  });

  it("ignores a recover_result for a different network (review-#3)", () => {
    applyRecoverProgress(progress("identify", "ok")); // opens for SLUG
    applyRecoverResult({ ...result("succeeded"), network: "other-net" });
    // The other-network terminal does NOT conclude SLUG's in-flight modal.
    expect(recoverState()?.outcome).toBeNull();
  });
});
