import { catchError, createRoot } from "solid-js";

// #717 — THE door for a module-lifetime reactive root.
//
// A root created with a bare `createRoot` has no error handler. Any computation
// inside one that throws — most importantly the `createMemo(source)` Solid
// compiles for `createResource(user, …)`, or any module-level memo that reads a
// resource — propagates out of `runUpdates`, which sets `Effects = null;
// Updates = null` before rehandling. **The queued render effects are
// discarded**, so the error surfaces as an unhandled rejection that no
// `<ErrorBoundary/>` in the render tree ever sees, and the DOM keeps whatever
// frame it last painted. On a cold boot that frame is the CRT splash, which is
// the #717 symptom: hung forever, no recovery but force-killing the app.
//
// The error context therefore belongs to root CREATION, not to whichever module
// happens to read a failing resource next. The first cut of #717 gave the
// context to `identityScopedStore` alone and left the other roots bare;
// `activeWindows.ts` — a module-level memo reading `channelsBySlug()` and
// `networks()`, subscribed before the first render — then swallowed the
// `listNetworks`/`listChannels` failures exactly as before, because it runs
// EARLIER in the Updates queue than the store's own memo and aborts the cycle
// before the store's handler is reached. Two patterns, and the boot froze
// through the gap between them. Hence one door, and
// `__tests__/moduleRootGuard.test.ts` fails the build if a bare `createRoot`
// comes back.
//
// "Module" means module-LIFETIME, not lexical position: these roots are
// singletons that are never disposed. A root created inside a boot-time
// installer belongs here too.
//
// NOT a silent swallow. This handler owns the DIAGNOSTIC; the render-tree
// `BootErrorBoundary` owns the USER-FACING state and the retry. Neither alone
// is enough — a boundary cannot catch what never reaches it, and a console line
// is not a recovery affordance.

/**
 * Run `build` under an error context, in the CURRENT owner.
 *
 * Returns what `build` returned. Throws — with the original error as `cause` —
 * if `build` itself threw, because there is no store to hand back and a
 * half-built singleton would be dereferenced by every caller. Throws from
 * computations created inside `build` are caught later and logged.
 *
 * Exported for `identityScopedStore`, which needs the context around `build`
 * only, with its reset wiring deliberately left OUTSIDE.
 */
export function withErrorContext<T>(build: () => T): T {
  // Boxed rather than read off `catchError`'s return: that helper reports a
  // caught throw as `undefined`, which is indistinguishable from a build whose
  // T genuinely IS void (the side-effect-only roots).
  let built: { value: T } | undefined;
  // Boxed for the same reason — `undefined` is a legitimate thrown value.
  let buildError: { error: unknown } | undefined;

  catchError(
    () => {
      // A synchronous build failure is caught HERE rather than left to the
      // handler below. Inside a `createRoot`, `catchError`'s handler does not
      // necessarily run before `catchError` returns — measured: it does not —
      // so reading the error off the handler produced a rethrow with an empty
      // `cause`, losing the stack on the one failure that most needs it.
      try {
        built = { value: build() };
      } catch (error) {
        buildError = { error };
      }
    },
    (error) => {
      console.error("[grappa] module root: computation threw", error);
    },
  );

  if (buildError !== undefined) {
    throw new Error("moduleRoot: build threw before the root was created", {
      cause: buildError.error,
    });
  }
  // Assigned on every path the try did not catch, which is every path that
  // reaches here.
  return (built as { value: T }).value;
}

/** Open a module-lifetime reactive root whose computations have an error context. */
export function moduleRoot<T>(build: () => T): T {
  return createRoot(() => withErrorContext(build));
}
