import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  getAliases,
  getNotificationPrefs,
  getUploadTtlSeconds,
  putAliases,
  putNotificationPrefs,
  putUploadTtlSeconds,
} from "../lib/userSettings";

// User settings client — push-notifications cluster B3 (2026-05-14).
//
// Coverage: GET round-trip, PUT round-trip + body shape, error paths.
// fetch is stubbed; tests assert request shape + parsed response shape.

const TOKEN = "test-bearer";

// A COMPLETE prefs map: the PUT is full-body (no diff semantics) and the
// server's cast_bools requires every boolean key, so this must carry the
// #378 presence keys too. Spread from the exported default rather than
// restating it, so the next key added rides along.
const sample = {
  ...DEFAULT_NOTIFICATION_PREFS,
  channel_messages_only: ["#sbiffo"],
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("DEFAULT_NOTIFICATION_PREFS", () => {
  it("matches the documented default shape", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      channel_messages_all: false,
      channel_messages_only: [],
      channel_mentions: true,
      private_messages_all: true,
      private_messages_only: [],
      presence_online: false,
      presence_offline: false,
    });
  });

  // This literal is a readability aid, NOT the drift gate — it cannot
  // detect divergence from the server, because it never reads the server.
  // `src/lib/pushParity.test.ts` does that, against the same fixture
  // `test/grappa/push/push_parity_test.exs` asserts the server produces.
});

describe("getNotificationPrefs", () => {
  it("GETs /me/settings/notification-prefs with bearer", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ notification_prefs: sample }), { status: 200 }),
      );

    const result = await getNotificationPrefs(TOKEN);
    expect(result).toEqual(sample);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/notification-prefs");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws ApiError on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(getNotificationPrefs(TOKEN)).rejects.toThrow(/500/);
  });
});

describe("putNotificationPrefs", () => {
  it("PUTs prefs as JSON body and returns server-normalized shape", async () => {
    const normalized = { ...sample, channel_messages_only: ["#sbiffo", "#italia"] };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ notification_prefs: normalized }), { status: 200 }),
      );

    const result = await putNotificationPrefs(TOKEN, sample);
    expect(result).toEqual(normalized);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/notification-prefs");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual(sample);
  });

  it("throws ApiError carrying field_errors on 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation_failed",
          field_errors: { notification_prefs: ["at least one trigger must be enabled"] },
        }),
        { status: 422 },
      ),
    );

    await expect(putNotificationPrefs(TOKEN, sample)).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
    });
  });
});

// UX-4 bucket M (2026-05-19) — upload-TTL REST wrappers.
describe("getUploadTtlSeconds", () => {
  it("GETs /me/settings/upload-ttl-seconds with bearer", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ upload_ttl_seconds: 3600 }), { status: 200 }),
      );

    const result = await getUploadTtlSeconds(TOKEN);
    expect(result).toBe(3600);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/upload-ttl-seconds");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns null when the server has no preference set", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ upload_ttl_seconds: null }), { status: 200 }),
    );
    expect(await getUploadTtlSeconds(TOKEN)).toBeNull();
  });

  it("throws ApiError on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(getUploadTtlSeconds(TOKEN)).rejects.toThrow(/500/);
  });
});

describe("putUploadTtlSeconds", () => {
  it("PUTs integer seconds as JSON body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ upload_ttl_seconds: 43_200 }), { status: 200 }),
      );

    const result = await putUploadTtlSeconds(TOKEN, 43_200);
    expect(result).toBe(43_200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/upload-ttl-seconds");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ upload_ttl_seconds: 43_200 });
  });

  it("PUTs null to clear the preference", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ upload_ttl_seconds: null }), { status: 200 }),
      );

    const result = await putUploadTtlSeconds(TOKEN, null);
    expect(result).toBeNull();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ upload_ttl_seconds: null });
  });

  it("throws ApiError carrying field_errors on 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation_failed",
          field_errors: { upload_ttl_seconds: ["must be positive"] },
        }),
        { status: 422 },
      ),
    );

    await expect(putUploadTtlSeconds(TOKEN, -1)).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
    });
  });
});

// #385 — user-defined command aliases REST wrappers.
describe("getAliases", () => {
  it("GETs /me/settings/aliases with bearer and returns the map", async () => {
    const map = { wii: "whois $1 $1" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ aliases: map }), { status: 200 }));

    const result = await getAliases(TOKEN);
    expect(result).toEqual(map);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/aliases");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws ApiError on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(getAliases(TOKEN)).rejects.toThrow(/500/);
  });
});

describe("putAliases", () => {
  it("PUTs the map wrapped under `aliases` and returns the normalized shape", async () => {
    const normalized = { wii: "whois $1 $1" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ aliases: normalized }), { status: 200 }));

    const result = await putAliases(TOKEN, { WII: "whois $1 $1" });
    expect(result).toEqual(normalized);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/aliases");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ aliases: { WII: "whois $1 $1" } });
  });

  it("PUTs an empty map (clear all) wrapped under `aliases`", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ aliases: {} }), { status: 200 }));

    const result = await putAliases(TOKEN, {});
    expect(result).toEqual({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ aliases: {} });
  });

  it("throws ApiError carrying field_errors on 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation_failed",
          field_errors: { aliases: ["alias name must not contain whitespace"] },
        }),
        { status: 422 },
      ),
    );

    await expect(putAliases(TOKEN, { "wi i": "whois" })).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
    });
  });
});
