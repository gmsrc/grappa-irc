import { beforeEach, describe, expect, it, vi } from "vitest";

// #1379 — the URL cic actually dials, composed by the REAL phoenix.js.
//
// This is a whole FILE because `socket.test.ts` replaces the `phoenix` export
// with a hand-written MockSocket, and `vi.mock` is file-scoped: every
// assertion over there stops at the string handed to the constructor and can
// say nothing about what phoenix does with it. That seam is not cosmetic.
// `Socket`'s constructor glues the transport on with
// `this.endPoint = \`${endPoint}/websocket\`` BEFORE `endPointURL()` appends
// any params, so a query string baked into the endpoint argument lands on the
// wrong side of the join: the path stops being `/socket/websocket` and
// `/websocket` is swallowed into a param VALUE. The endpoint mount is
// `socket "/socket"` in `endpoint.ex`, so that URL reaches no WS route at all
// and every session in the app dies while the REST surface keeps passing.
//
// Only the real class can witness this, so this file mocks phoenix by
// EXTENDING it: production builds its own Socket with its own arguments, and
// the test reads `endPointURL()` off the genuine instance. `connect()` is the
// one override — jsdom would otherwise dial a real WebSocket.
const h = vi.hoisted(() => ({ instances: [] as { endPointURL(): string }[] }));

vi.mock("phoenix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("phoenix")>();
  class RecordingSocket extends actual.Socket {
    constructor(endpoint: string, opts: object) {
      super(endpoint, opts);
      h.instances.push(this);
    }
    connect(): void {}
  }
  return { ...actual, Socket: RecordingSocket };
});

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  h.instances.length = 0;
});

async function dialledUrl(): Promise<URL> {
  localStorage.setItem("grappa-token", "tok-url");
  await import("../lib/socket");
  const socket = h.instances[0];
  if (!socket) throw new Error("production never constructed a Socket");
  // jsdom serves the doc from http://localhost:3000, so the endpoint is the
  // ws:// absolute form; `URL` needs an http scheme to parse path + query.
  return new URL(socket.endPointURL().replace(/^ws/, "http"));
}

describe("the WS URL cic dials, composed by the real phoenix.js (#1379)", () => {
  it('keeps the transport on the PATH, where the `socket "/socket"` mount serves it', async () => {
    expect((await dialledUrl()).pathname).toBe("/socket/websocket");
  });

  it("declares the protocol version as its own param value, not fused with the transport", async () => {
    // `dialledUrl` first: it is what imports the module WITH a token, and a
    // second import would only return the cached instance.
    const url = await dialledUrl();
    const { CLIENT_PROTOCOL_VERSION } = await import("../lib/socket");
    expect(url.searchParams.get("client_proto")).toBe(String(CLIENT_PROTOCOL_VERSION));
  });
});
