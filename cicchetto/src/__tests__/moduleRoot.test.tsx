import { render, screen } from "@solidjs/testing-library";
import { createMemo, createSignal, ErrorBoundary } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleRoot } from "../lib/moduleRoot";

// #717 — the property this factory exists for is NOT "the handler ran". It is
// "the update cycle SURVIVED a module-root throw", because that is what decides
// whether a render-tree ErrorBoundary ever gets to render.
//
// The bug this pins is a real one that shipped in the first cut: the error
// context was given to `identityScopedStore` only, and `activeWindows.ts` — a
// bare root whose memo reads `channelsBySlug()` and `networks()` — kept
// aborting the cycle first, so a `listNetworks`/`listChannels` failure still
// froze the splash. A test that only asserted "the handler was called" would
// have stayed green through that.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("moduleRoot (#717 — a throw in a module root must not abort the cycle)", () => {
  it("returns what build returned", () => {
    const store = moduleRoot(() => ({ answer: 42 }));
    expect(store.answer).toBe(42);
  });

  it("rethrows a build-time failure with the original attached as cause", () => {
    const boom = new Error("build exploded");
    let thrown: unknown;
    try {
      moduleRoot(() => {
        throw boom;
      });
    } catch (e) {
      thrown = e;
    }

    // A module that cannot build its store is fatal — there is nothing to hand
    // back. But the cause must survive: this is the loudest case, and it was
    // the one left with no stack in the first cut.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(boom);
  });

  it("lets a render-tree ErrorBoundary run even when a module-root memo throws in the same cycle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [fail, setFail] = createSignal(false);

    // The activeWindows shape: a module-level memo, subscribed to the signal
    // before anything renders, that throws once the signal flips.
    moduleRoot(() =>
      createMemo(() => {
        if (fail()) throw new Error("module root boom");
        return 0;
      }),
    );

    const Child = () => {
      const view = createMemo(() => {
        if (fail()) throw new Error("render boom");
        return "ok";
      });
      return <div data-testid="ok">{view()}</div>;
    };

    render(() => (
      <ErrorBoundary fallback={() => <div data-testid="fallback">failed</div>}>
        <Child />
      </ErrorBoundary>
    ));

    expect(screen.getByTestId("ok")).toBeInTheDocument();

    setFail(true);

    // With a bare `createRoot`, the module-root memo throws with no error
    // context, `runUpdates` nulls the queued Effects, and this fallback never
    // renders — the DOM keeps the last frame forever.
    expect(await screen.findByTestId("fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("ok")).toBeNull();
  });

  it("reports the runtime throw rather than swallowing it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [fail, setFail] = createSignal(false);

    moduleRoot(() =>
      createMemo(() => {
        if (fail()) throw new Error("module root boom");
        return 0;
      }),
    );
    setFail(true);

    expect(spy).toHaveBeenCalled();
  });
});
