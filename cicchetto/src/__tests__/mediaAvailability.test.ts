import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMediaAvailability } from "../lib/mediaAvailability";

// issue 1889 — the probe that separates a GONE upload from a broken one.
//
// The asymmetry is the whole test suite: "gone" must be earned by a 404 that
// was actually read off the wire, while EVERY other outcome — including every
// way the probe itself can break — must collapse to "unknown" so the viewer
// keeps its generic text. Telling a reader "this upload is gone" because our
// own request failed is a worse lie than the message this change replaces.

const ORIGIN = "https://grappa.example";
const OWN_HREF = `${ORIGIN}/uploads/abcdefghijklmnopqrstuvwxyz.png`;

// Records every call so the cross-origin cases can assert the ABSENCE of a
// request, not merely the answer: the point there is that the CSP is never
// given a chance to refuse, and an answer alone cannot show that.
function stubFetch(respond: (href: string, init: RequestInit | undefined) => Promise<unknown>): {
  calls: { href: string; init: RequestInit | undefined }[];
} {
  const calls: { href: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", (href: string, init?: RequestInit) => {
    calls.push({ href, init });
    return respond(href, init);
  });
  return { calls };
}

const status = (code: number) => () => Promise.resolve({ status: code });

const live = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeMediaAvailability", () => {
  it("reads a 404 as gone", async () => {
    stubFetch(status(404));
    await expect(probeMediaAvailability(OWN_HREF, ORIGIN, live())).resolves.toBe("gone");
  });

  it("asks with HEAD, not GET — the bytes were already refused once", async () => {
    // The element that failed has no status to read, so the status has to be
    // asked for; asking with GET would re-download a body we are not going to
    // render, including in the 200-but-undecodable case this probe exists to
    // tell apart from a 404.
    const { calls } = stubFetch(status(404));
    await probeMediaAvailability(OWN_HREF, ORIGIN, live());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.href).toBe(OWN_HREF);
    expect(calls[0]?.init?.method).toBe("HEAD");
  });

  it("passes the caller's abort signal, so a closing viewer cancels the probe", async () => {
    const controller = new AbortController();
    const { calls } = stubFetch(status(404));
    await probeMediaAvailability(OWN_HREF, ORIGIN, controller.signal);

    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  // 🔴 The hard constraint. Every arm below is a way the probe can fail to
  // learn anything, and NONE of them may produce "gone".
  describe("never says gone without a 404 it actually read", () => {
    it("a 200 is unknown — the element failed for some other reason", async () => {
      stubFetch(status(200));
      await expect(probeMediaAvailability(OWN_HREF, ORIGIN, live())).resolves.toBe("unknown");
    });

    it("a 500 is unknown — the server is broken, not empty", async () => {
      stubFetch(status(500));
      await expect(probeMediaAvailability(OWN_HREF, ORIGIN, live())).resolves.toBe("unknown");
    });

    it("a 403 is unknown — refused is not absent", async () => {
      stubFetch(status(403));
      await expect(probeMediaAvailability(OWN_HREF, ORIGIN, live())).resolves.toBe("unknown");
    });

    it("a rejected fetch is unknown — a dead network must not read as a deleted upload", async () => {
      stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
      await expect(probeMediaAvailability(OWN_HREF, ORIGIN, live())).resolves.toBe("unknown");
    });

    it("an abort is unknown — closing the viewer mid-probe answers nothing", async () => {
      const controller = new AbortController();
      stubFetch(() => Promise.reject(new DOMException("Aborted", "AbortError")));
      controller.abort();
      await expect(probeMediaAvailability(OWN_HREF, ORIGIN, controller.signal)).resolves.toBe(
        "unknown",
      );
    });
  });

  // Same-origin is a CSP gate, not an optimisation: `connect-src 'self'` is
  // deliberately not widened to `https:` (unlike img-src / media-src), so a
  // cross-host probe is refused by the policy AND raises a
  // securitypolicyviolation the e2e _cspGuard fixture fails specs on. The
  // absence of the request is therefore the contract, not just the answer.
  describe("never probes off the page origin", () => {
    it("a foreign host answers unknown without issuing a request", async () => {
      const { calls } = stubFetch(status(404));
      await expect(
        probeMediaAvailability("https://elsewhere.example/pic.png", ORIGIN, live()),
      ).resolves.toBe("unknown");
      expect(calls).toEqual([]);
    });

    it("the SAME host on a different scheme is still off-origin", async () => {
      // `mediaLink.sameHostHref` compares HOST and is scheme-agnostic on
      // purpose (legacy http:// upload links live forever in scrollback), but
      // `'self'` is scheme + host + port — reusing host equality here would
      // admit a probe the CSP then refuses.
      const { calls } = stubFetch(status(404));
      await expect(
        probeMediaAvailability("http://grappa.example/uploads/x.png", ORIGIN, live()),
      ).resolves.toBe("unknown");
      expect(calls).toEqual([]);
    });

    it("an unparseable href answers unknown without issuing a request", async () => {
      const { calls } = stubFetch(status(404));
      await expect(probeMediaAvailability("not a url", ORIGIN, live())).resolves.toBe("unknown");
      expect(calls).toEqual([]);
    });
  });
});
