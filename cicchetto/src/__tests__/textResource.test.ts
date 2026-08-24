import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTextResource, splitLines, TEXT_VIEW_MAX_BYTES } from "../lib/textResource";

// #1764 — the fetch half of the .txt/.md source viewer.
//
// Two things are under test and they are separate on purpose: `splitLines`
// decides what a LINE is (the gutter and the source pane are rendered from the
// SAME array, so a disagreement here is a gutter that lies), and
// `fetchTextResource` decides how many BYTES ever reach the DOM.
//
// The cap is enforced by US, from the response stream — not by the server
// honouring the `Range` header we send. That is the whole point of reading the
// body through a reader instead of `res.text()`: a proxy that strips `Range`,
// or a future non-grappa admitted host, would otherwise hand a naive viewer the
// entire file. The header stays as a courtesy so the server does not push bytes
// we are going to discard.

const HREF = "https://grappa.example/uploads/abcdefghijklmnopqrstuvwxyz.txt";

// A Response-shaped stub whose body streams the given chunks. Hand-rolled
// rather than `new Response(...)`: the contract this module depends on is
// `res.body.getReader()`, and stubbing it explicitly is what lets a test hand
// over MORE bytes than the cap without allocating them for real.
function stubFetch(opts: { status?: number; chunks: Uint8Array[] }): {
  calls: { href: string; init: RequestInit | undefined }[];
  cancelled: () => boolean;
} {
  const calls: { href: string; init: RequestInit | undefined }[] = [];
  let cancelled = false;
  vi.stubGlobal("fetch", (href: string, init?: RequestInit) => {
    calls.push({ href, init });
    let at = 0;
    const status = opts.status ?? 206;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      body: {
        getReader: () => ({
          read: () =>
            Promise.resolve(
              at < opts.chunks.length
                ? { done: false, value: opts.chunks[at++] }
                : { done: true, value: undefined },
            ),
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
        }),
      },
    });
  });
  return { calls, cancelled: () => cancelled };
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitLines", () => {
  it("splits on LF", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("splits on CRLF without leaving the CR in the line", () => {
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
  });

  it("a trailing newline does NOT add a phantom last line", () => {
    // Every editor agrees a file ending in \n has as many lines as it has
    // newlines. Rendering the phantom would put a number in the gutter with
    // nothing beside it.
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("keeps interior blank lines — only the trailing one is dropped", () => {
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("empty input is one empty line, not zero lines", () => {
    expect(splitLines("")).toEqual([""]);
  });
});

describe("fetchTextResource", () => {
  it("returns the body split into lines, untruncated, for a small file", async () => {
    stubFetch({ chunks: [bytes("first\nsecond\nthird\n")] });
    await expect(fetchTextResource(HREF, new AbortController().signal)).resolves.toEqual({
      lines: ["first", "second", "third"],
      truncated: false,
    });
  });

  it("asks the server for at most the cap, so it does not push bytes we discard", async () => {
    const { calls } = stubFetch({ chunks: [bytes("hi")] });
    await fetchTextResource(HREF, new AbortController().signal);
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    // One PAST the cap: the extra byte is what makes "is there more?"
    // answerable without a second request.
    expect(headers?.range).toBe(`bytes=0-${TEXT_VIEW_MAX_BYTES}`);
  });

  it("stops at the cap and says so when the stream keeps going", async () => {
    // Three chunks that together overrun the cap. A server that ignored the
    // Range header would do exactly this.
    const chunk = new Uint8Array(TEXT_VIEW_MAX_BYTES / 2).fill(0x61); // 'a'
    const probe = stubFetch({ status: 200, chunks: [chunk, chunk, chunk] });
    const res = await fetchTextResource(HREF, new AbortController().signal);
    expect(res.truncated).toBe(true);
    expect(res.lines.join("\n").length).toBe(TEXT_VIEW_MAX_BYTES);
    // …and we hung up rather than draining the rest.
    expect(probe.cancelled()).toBe(true);
  });

  it("a file EXACTLY the cap is not reported as truncated", async () => {
    // The off-by-one that would make the honest signal dishonest: reading
    // `cap` bytes and stopping cannot tell "the file ended here" from "we did".
    stubFetch({ chunks: [new Uint8Array(TEXT_VIEW_MAX_BYTES).fill(0x62)] });
    const res = await fetchTextResource(HREF, new AbortController().signal);
    expect(res.truncated).toBe(false);
  });

  it("one byte past the cap IS truncated", async () => {
    stubFetch({ chunks: [new Uint8Array(TEXT_VIEW_MAX_BYTES + 1).fill(0x62)] });
    const res = await fetchTextResource(HREF, new AbortController().signal);
    expect(res.truncated).toBe(true);
  });

  it("rejects on a non-ok response so the modal shows its failure state", async () => {
    stubFetch({ status: 404, chunks: [] });
    await expect(fetchTextResource(HREF, new AbortController().signal)).rejects.toThrow();
  });

  it("forwards the abort signal so closing the viewer cancels an in-flight read", async () => {
    const { calls } = stubFetch({ chunks: [bytes("x")] });
    const controller = new AbortController();
    await fetchTextResource(HREF, controller.signal);
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });
});
