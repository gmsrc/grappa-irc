import {
  type Component,
  createEffect,
  createSignal,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { networkBySlug } from "./lib/networks";
import { railWhoisFor, requestRailWhois } from "./lib/railWhois";
import { selectedChannel } from "./lib/selection";
import ServerInfoCard from "./ServerInfoCard";
import WhoisCard from "./WhoisCard";

// #474 — the rail's GENERIC per-window-kind context surface. Mounted as a
// sibling of the RailActions drawer inside `.shell-members` in BOTH Shell
// rail branches (desktop + mobile). It reads the active window's kind and
// grafts the matching context content:
//   * server → ServerInfoCard (connection facts already in the store)
//   * query  → the query context (#606, the deferred half of #474): a
//              heading + a WHOIS card for the conversation partner,
//              auto-fetched on select. The card REUSES the same `WhoisCard`
//              presentation as the scrollback overlay but is fed by the
//              per-nick `railWhois` cache (NOT the single-slot `whoisCard`
//              store the user-issued /whois owns) and carries no × affordance
//              (persistent, like the server card).
// It renders NOTHING for kinds with no context content (channel already has
// the MembersPane above; home/admin/list/mentions have none). Built as a
// container, not a hardcoded server card, so the rail is the per-kind
// context surface the RailActions moduledoc (#473) always earmarked.

const TICK_MS = 60_000;

const RailContext: Component = () => {
  // Coarse clock so a live "connected for Xh Ym" stays fresh. `.shell-members`
  // is a permanent column (#71 INC-2), so this ticker runs for the whole
  // authenticated session, not just while a server window is focused — off a
  // server window nothing reads `now()`, so those 60s ticks are harmless
  // no-op re-renders. Kept in the container (not ServerInfoCard) so the card
  // takes an injected `now` and stays deterministic under test; 60s
  // granularity is plenty for a duration read, torn down with the shell.
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), TICK_MS);
  onCleanup(() => clearInterval(timer));

  const sel = () => selectedChannel();

  // #606 — fetch-on-select. When a query window is (re)focused, ask the rail
  // WHOIS cache for its partner; the store decides whether that costs an
  // upstream command (it does not, for a nick already known). Keyed on the
  // composed (slug, nick) string so the effect fires ONLY when the focused
  // query's identity actually changes, not on every unrelated selection
  // churn. A nick cannot contain a space, so the separator is unambiguous.
  //
  // A #373 rename DOES fire this effect — `followQueryNick` swaps the
  // selection — but it must NOT cost a WHOIS: `subscribe.ts` migrates the
  // rail cache old→new BEFORE that swap, so this lands on a hit. Solid
  // flushes effects at the end of the write, so the ordering there is what
  // holds this true; reverse it and every rename asks the ircd again.
  createEffect(
    on(
      () => {
        const s = sel();
        return s?.kind === "query" ? `${s.networkSlug} ${s.channelName}` : null;
      },
      (key) => {
        if (key === null) return;
        const sep = key.indexOf(" ");
        requestRailWhois(key.slice(0, sep), key.slice(sep + 1));
      },
    ),
  );

  return (
    <Switch>
      <Match when={sel()?.kind === "server"}>
        <Show when={networkBySlug(sel()?.networkSlug ?? "")}>
          {(net) => <ServerInfoCard network={net()} now={now()} />}
        </Show>
      </Match>
      <Match when={sel()?.kind === "query"}>
        <div class="rail-query-context" data-testid="rail-query-context">
          {/* Mirrors the MembersPane `<h3>members (n)</h3>` slot (uppercased
              by CSS). The nick reads live off selectedChannel, so a NICK while
              the query is open re-labels the heading — #373 swaps
              selectedChannel in place on a rename. */}
          <h3 class="rail-query-heading">private conversation with {sel()?.channelName}</h3>
          <WhoisCard bundle={railWhoisFor(sel()?.networkSlug ?? "", sel()?.channelName ?? "")} />
        </div>
      </Match>
    </Switch>
  );
};

export default RailContext;
