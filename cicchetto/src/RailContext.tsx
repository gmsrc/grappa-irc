import { type Component, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { networkBySlug } from "./lib/networks";
import { selectedChannel } from "./lib/selection";
import ServerInfoCard from "./ServerInfoCard";

// #474 — the rail's GENERIC per-window-kind context surface. Mounted as a
// sibling of the RailActions drawer inside `.shell-members` in BOTH Shell
// rail branches (desktop + mobile). It reads the active window's kind and
// grafts the matching context content:
//   * server → ServerInfoCard (connection facts already in the store)
//   * query  → a /whois card is the deferred other half of this design
//              (issue #474 "follow-on, not scope here") — add a <Match>
//              here when it lands, NOT a second Shell edit.
// It renders NOTHING for kinds with no context content (channel already has
// the MembersPane above; home/admin/list/mentions have none). Built as a
// container, not a hardcoded server card, so the rail becomes the per-kind
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

  return (
    <Switch>
      <Match when={sel()?.kind === "server"}>
        <Show when={networkBySlug(sel()?.networkSlug ?? "")}>
          {(net) => <ServerInfoCard network={net()} now={now()} />}
        </Show>
      </Match>
    </Switch>
  );
};

export default RailContext;
