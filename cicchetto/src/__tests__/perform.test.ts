import { afterEach, describe, expect, it, vi } from "vitest";
import { getPerform, putPerform } from "../lib/api";

// #189 — per-network perform-list REST client. The client just faithfully
// builds the /networks/:slug/perform request and parses the
// {perform_list, oper_pass_set} view; the write-only "leave blank to keep the
// oper pass" decision lives in PerformSettings (covered by the e2e spec).

const TOKEN = "perform-tok";
const SLUG = "libera";

function mockFetch(response: Record<string, unknown>, status = 200) {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockResolvedValueOnce(new Response(JSON.stringify(response), { status }));
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("perform REST client — #189", () => {
  it("getPerform GETs /networks/:slug/perform and returns the view", async () => {
    const spy = mockFetch({
      perform_list: "MODE me +x",
      oper_pass_set: true,
      nickserv_pass_set: true,
    });

    const view = await getPerform(TOKEN, SLUG);
    expect(view).toEqual({
      perform_list: "MODE me +x",
      oper_pass_set: true,
      nickserv_pass_set: true,
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/networks/libera/perform");
    expect(init.method ?? "GET").toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("putPerform PUTs the given body verbatim (list + oper_pass + nickserv_pass)", async () => {
    const spy = mockFetch({
      perform_list: "OPER me $oper_pass",
      oper_pass_set: true,
      nickserv_pass_set: true,
    });

    const view = await putPerform(TOKEN, SLUG, {
      perform_list: "OPER me $oper_pass",
      oper_pass: "hunter2",
      nickserv_pass: "nspass",
    });
    expect(view.oper_pass_set).toBe(true);
    expect(view.nickserv_pass_set).toBe(true);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/networks/libera/perform");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      perform_list: "OPER me $oper_pass",
      oper_pass: "hunter2",
      nickserv_pass: "nspass",
    });
  });

  it("putPerform omits secrets when the caller does not pass them (leave-blank-to-keep)", async () => {
    const spy = mockFetch({
      perform_list: "MODE me +x",
      oper_pass_set: true,
      nickserv_pass_set: true,
    });

    await putPerform(TOKEN, SLUG, { perform_list: "MODE me +x" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ perform_list: "MODE me +x" });
    expect("oper_pass" in body).toBe(false);
    expect("nickserv_pass" in body).toBe(false);
  });

  it("URL-encodes the network slug", async () => {
    const spy = mockFetch({ perform_list: null, oper_pass_set: false, nickserv_pass_set: false });

    await getPerform(TOKEN, "a b");

    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/networks/a%20b/perform");
  });
});
