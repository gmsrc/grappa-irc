import { describe, expect, it } from "vitest";

// Guards the setupTests conforming-`error` contract (#1700), the media sibling
// of inert-websocket.test.ts.
//
// jsdom implements no `error` on HTMLMediaElement — measured, it reads
// `undefined`, where the DOM contract types it `MediaError | null` and a real
// browser answers `null` on a healthy element. That gap is a TRAP and not a
// missing feature: the type-exact predicate for "did playback fail" is
// `el.error !== null`, so under raw jsdom a pristine element reads as ERRORED,
// and a test meaning "this source is healthy" silently exercises the failure
// branch and reports green about the wrong path.
//
// `AudioMiniPlayer`'s resume rule (#1700 — re-fetch when the element cannot
// continue from where it is) is the first predicate in cic to read this
// property. Without the default below its "a paused FILE resumes in place"
// case passes for the wrong reason; with it, that case measures what it names.
describe("HTMLMediaElement.error default", () => {
  it("a pristine media element reports NO error, as a browser does", () => {
    expect(document.createElement("audio").error).toBeNull();
    expect(document.createElement("video").error).toBeNull();
  });

  it("stays null across a source assignment — a src is not a failure", () => {
    const el = document.createElement("audio");
    el.src = "https://ice.somafm.com/groovesalad-128-mp3";

    expect(el.error).toBeNull();
  });

  it("an instance-level definition still shadows it, so a test can inject failure", () => {
    // This is the seam the #1700 tests use to model a dropped stream. If the
    // prototype default were installed as a non-configurable own property, or
    // as a value rather than a getter, that seam would break and every
    // failure-path test would quietly become a healthy-path test.
    const el = document.createElement("audio");
    Object.defineProperty(el, "error", {
      configurable: true,
      value: { code: 2, message: "network" },
    });

    expect(el.error).not.toBeNull();
    expect(el.error?.code).toBe(2);
    // …and the shadow is per-instance: the next element is healthy again.
    expect(document.createElement("audio").error).toBeNull();
  });
});
