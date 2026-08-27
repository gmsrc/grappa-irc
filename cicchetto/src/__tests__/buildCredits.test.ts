import { describe, expect, it } from "vitest";

import {
  type BuildCredits,
  buildCredits,
  coerceBuildCredits,
  EMPTY_BUILD_CREDITS,
} from "../lib/buildCredits";

// #1773 — the credit roll's git facts are baked at BUILD time (vite `define`,
// fed by infra/packaging/credits.sh through GRAPPA_CREDITS), because the
// browser has no git and the cic build container has no repo.
//
// These cases are about the READER, and deliberately not about the bake: the
// bake is proven end to end by the credits e2e, which compares what the modal
// paints against the exact payload the wrapper derived. A unit test here could
// only assert against a payload it wrote itself.
//
// The reader still earns its own cases because it has a real job: the define
// is ABSENT under vitest (vitest.config.ts is a separate config and carries no
// `define`), so the degrade path is not hypothetical — it is the path this
// whole suite runs on.

describe("coerceBuildCredits (#1773)", () => {
  it("passes a well-formed payload through unchanged", () => {
    const payload: BuildCredits = {
      sha: "a453325e",
      date: "2026-08-25T23:15:06+02:00",
      contributors: [
        { name: "Marcello Barnaba", commits: 5102 },
        { name: "Stefy Lanza", commits: 147 },
      ],
    };

    expect(coerceBuildCredits(JSON.stringify(payload))).toEqual(payload);
  });

  it("accepts the no-git payload as data, not as a fault", () => {
    // The AUR source tarball builds with no `.git`, and so does a plain
    // `docker build` of Dockerfile.release — the PUBLISHED image is fed the
    // payload as a build arg instead (#1834). credits.sh emits exactly this
    // for the ones that are not. It is a legitimate build, and the roll must
    // degrade to the version alone rather than read as corruption.
    const noGit = '{"sha":null,"date":null,"contributors":[]}';

    expect(coerceBuildCredits(noGit)).toEqual(EMPTY_BUILD_CREDITS);
  });

  it("keeps the git facts when the contributor list is unusable", () => {
    // Per-FIELD coercion, not all-or-nothing: a payload that names the commit
    // should still say which commit, even if the roll itself cannot be read.
    const partial = '{"sha":"deadbee","date":"2026-08-25T23:15:06+02:00","contributors":"nope"}';

    expect(coerceBuildCredits(partial)).toEqual({
      sha: "deadbee",
      date: "2026-08-25T23:15:06+02:00",
      contributors: [],
    });
  });

  it("drops a contributor entry that is not a name and a count", () => {
    const mixed = JSON.stringify({
      sha: null,
      date: null,
      contributors: [
        { name: "Ada Lovelace", commits: 3 },
        { name: "", commits: 9 },
        { name: "No Count" },
        { name: "Negative", commits: -1 },
        { name: "Fractional", commits: 1.5 },
        "not an object",
      ],
    });

    expect(coerceBuildCredits(mixed).contributors).toEqual([{ name: "Ada Lovelace", commits: 3 }]);
  });

  it("degrades to the empty payload on anything that is not a credits object", () => {
    // Each of these is a distinct way the define can be wrong — a bundle built
    // by something other than our vite config, a half-written env var, a value
    // that parsed but is not an object.
    for (const raw of ["", "not json at all", "null", "42", '"a string"', "[]", undefined]) {
      expect(coerceBuildCredits(raw)).toEqual(EMPTY_BUILD_CREDITS);
    }
  });

  it("does not treat an empty sha as a sha", () => {
    // `""` is what a half-derived payload looks like; `null` is what an
    // honestly repo-less build looks like. Both must render as "unknown", and
    // an empty string rendered verbatim is a blank line the reader cannot
    // interpret.
    expect(coerceBuildCredits('{"sha":"","date":"","contributors":[]}')).toEqual(
      EMPTY_BUILD_CREDITS,
    );
  });
});

describe("buildCredits() (#1773)", () => {
  it("is the empty payload when the build-time define is absent", () => {
    // vitest.config.ts carries no `define`, so this asserts the real degrade
    // path this suite runs on rather than a simulated one. In a browser bundle
    // the define is always present — that half is the e2e's job.
    expect(buildCredits()).toEqual(EMPTY_BUILD_CREDITS);
  });
});
