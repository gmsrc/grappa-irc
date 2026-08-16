import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, onMount, Show } from "solid-js";
import { consumeShareToken } from "./lib/api";
import { installSharedSession } from "./lib/auth";

// Session-sharing — landing route for `/share`, path-mode, mounted in
// `main.tsx`. Auto-consumes on mount:
//   1. Read the token from the FRAGMENT and scrub it (see below), then
//      POST /auth/share/consume with it.
//   2. On 200, installSharedSession({token, subject}) writes the bearer
//      + subject into localStorage and the existing RequireAuth
//      createEffect navigates the user into the Shell.
//   3. On error, render the wire-shape error string so the operator can
//      tell "expired" / "already used" / "not found" apart.
//
// Error wire-shape mapping (server → user):
//   share_token_expired   → link expired (TTL elapsed)
//   share_token_consumed  → already used on another device
//   not_found             → the shared identity no longer exists
//   unauthorized          → tampered / unsigned token
//   bad_request           → malformed
//
// One code is decided locally and never leaves the browser:
//   missing_token         → the URL carries no fragment (or a reload
//                           after the fragment was scrubbed)
//
// Auto-consume on mount because the link IS the auth credential — any
// additional "click here to log in" intermediary defeats the
// one-tap-to-second-device flow. Whoever opened the link already chose
// to; we just complete the loop.
//
// #1404 — the token arrives in the FRAGMENT, not a path segment. The
// link IS a credential, so it travels in the one part of a URL the
// browser keeps to itself: a fragment is not transmitted with the
// request and is not carried in `Referer`. Same move `socket.ts` made
// when the WS bearer went to a subprotocol.

// Read the token out of the fragment and remove it from the address bar
// and from history in the same breath, BEFORE the network call — so the
// credential is present for the length of a mount rather than for the
// lifetime of the tab, on every link alike and not only on the ones that
// redeem successfully. The trade, taken deliberately: a reload after a
// failed consume no longer re-attempts with the real code, it reports
// `missing_token`. A one-shot credential is not worth keeping around to
// improve the wording of an error the page has already rendered.
const takeTokenFromFragment = (): string => {
  const raw = window.location.hash.replace(/^#/, "");
  if (raw !== "") {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape is a corrupted link, not a token.
    return "";
  }
};

const ShareConsume: Component = () => {
  const navigate = useNavigate();
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(true);

  onMount(() => {
    void consume();
  });

  const consume = async () => {
    setBusy(true);
    setError(null);
    const shareToken = takeTokenFromFragment();
    // An empty fragment never reaches the server: posting "" would spend a
    // round trip to be told `bad_request`, and the honest local answer is
    // that this URL carries no credential at all.
    if (shareToken === "") {
      setError("missing_token");
      setBusy(false);
      return;
    }
    try {
      const { token: bearer, subject } = await consumeShareToken(shareToken);
      installSharedSession(bearer, subject);
      navigate("/", { replace: true });
    } catch (err) {
      const code = err instanceof Error ? err.message : "consume_failed";
      setError(code);
    } finally {
      setBusy(false);
    }
  };

  const goToLogin = () => navigate("/login", { replace: true });

  return (
    <main class="share-consume" data-testid="share-consume">
      <h1>opening shared session…</h1>

      <Show when={busy()}>
        <p data-testid="share-consume-busy">contacting the server…</p>
      </Show>

      <Show when={error() !== null}>
        <p class="share-consume-error" role="alert" data-testid="share-consume-error">
          {error()}
        </p>
        <button
          type="button"
          class="share-consume-go-login"
          data-testid="share-consume-go-login"
          onClick={goToLogin}
        >
          go to login
        </button>
      </Show>
    </main>
  );
};

export default ShareConsume;
