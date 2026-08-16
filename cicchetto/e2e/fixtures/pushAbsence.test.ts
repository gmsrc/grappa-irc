// #1336 — the absence assertion is the instrument seven push specs are judged
// by, so it has to be able to FAIL for the right reason. Runs under the cic
// vitest project (same reason, same shape as `scrollGesture.test.ts` and
// `whoisWait.test.ts`): the logic is deliberately free of `fetch`, so it is
// provable without a testnet.
//
// The case that matters is the one MEASURED on #1152: the peer's DM never
// reached grappa at all (0 occurrences of the peer nick in a 240 MB
// `grappa-test.log` that carried 135 902 message INSERTs, so the instrument
// was sound). On the POSITIVE spec that event was a loud 5 s timeout. On an
// absence assertion the very same event is a silent PASS — the suppression
// under test is never exercised, and nobody finds out.

import { describe, expect, it } from "vitest";
import { assertNoPushAfterStimulus, type PushAbsenceProbes } from "./pushAbsence";

const SPEC = { id: "964-device-row", stimulus: "<n964-dmer> hi → s0ddba11", pollMs: 1 };

// A catcher whose delivery count walks the given script, one entry per read.
// The last entry repeats, so a script models "…and stays that way".
function fakeProbes(
  counts: readonly number[],
  opts: { stimulus?: () => Promise<void> } = {},
): { calls: string[]; probes: PushAbsenceProbes } {
  const calls: string[] = [];
  let reads = 0;
  return {
    calls,
    probes: {
      stimulusDelivered: async () => {
        calls.push("stimulus");
        if (opts.stimulus) await opts.stimulus();
      },
      deliveryCount: async () => {
        const value = counts[Math.min(reads, counts.length - 1)] ?? 0;
        reads += 1;
        calls.push(`count:${value}`);
        return value;
      },
    },
  };
}

async function failureOf(assertion: Promise<unknown>): Promise<string> {
  try {
    await assertion;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the assertion to reject, but it resolved");
}

describe("#1336 — assertNoPushAfterStimulus", () => {
  it("proves the stimulus reached grappa BEFORE it opens the absence window", async () => {
    const { calls, probes } = fakeProbes([0]);
    await assertNoPushAfterStimulus(probes, { ...SPEC, windowMs: 5 });
    // `calls[0]`, deliberately not `indexOf("stimulus") < indexOf("count:")`.
    // The first draft of this witness SURVIVED the mutant that deletes the
    // proof outright: `indexOf` answers -1 for a call that never happened, and
    // -1 is less than 0, so "never asked" read as "asked first". A witness
    // satisfied by the absence of the thing it witnesses is the very defect
    // this module exists to refuse.
    expect(calls[0]).toBe("stimulus");
  });

  it("REJECTS when the stimulus never reached grappa — the silence would prove nothing", async () => {
    const { probes } = fakeProbes([0], {
      stimulus: () => Promise.reject(new Error("assertMessagePersisted: timeout after 5000ms")),
    });
    expect(await failureOf(assertNoPushAfterStimulus(probes, { ...SPEC, windowMs: 5 }))).toContain(
      "never reached grappa",
    );
  });

  it("fails on a delivery that lands LATE inside the window", async () => {
    // Two, so an off-by-one `> 1` guard cannot be what catches this one.
    const { probes } = fakeProbes([0, 0, 0, 2]);
    expect(
      await failureOf(assertNoPushAfterStimulus(probes, { ...SPEC, windowMs: 200 })),
    ).toContain("saw 2");
  });

  it("fails on a SINGLE delivery", async () => {
    const { probes } = fakeProbes([1]);
    expect(await failureOf(assertNoPushAfterStimulus(probes, { ...SPEC, windowMs: 5 }))).toContain(
      "saw 1",
    );
  });

  it("resolves when the stimulus landed and nothing was pushed", async () => {
    const { probes } = fakeProbes([0]);
    await expect(
      assertNoPushAfterStimulus(probes, { ...SPEC, windowMs: 5 }),
    ).resolves.toBeUndefined();
  });
});
