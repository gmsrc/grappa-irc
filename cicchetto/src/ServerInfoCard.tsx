import { type Component, Show } from "solid-js";
import type { Network } from "./lib/api";
import { connectionStateEmoji } from "./lib/connectionStateEmoji";
import { formatDurationSince } from "./lib/duration";
import { MircBody } from "./MircText";

// #474 — the per-network "server info" card that fills the right rail on a
// SERVER window. Pure presentational: it renders ONLY facts already in the
// store (the `Network` resource), passed in by the RailContext container
// along with an injected `now` (epoch ms) so the uptime is deterministic +
// testable and the container owns the ~60s ticker.
//
// Facts-only, sourced from existing session/network state:
//   * slug   — the network label (there is no separate human name)
//   * status — DB-canonical connection_state glyph + word + reason
//   * uptime — connected-since, ONLY while genuinely connected (honesty:
//              a duration next to a parked/failed state would lie)
//   * nick   — own IRC nick on this network
//   * services — which NickServ software (omitted when "unknown")
//
// Deliberately absent (NOT in the user-facing wire — admin-only): the
// dialled server address, TLS yes/no, and live registered/identified
// state. #474's rule is "prefer leaving it out over showing a stale value
// confidently"; those graft in later behind an additive wire field, and
// this card inherits them for free when they arrive.
//
// No close button: unlike the ephemeral scrollback cards (whois/whowas/
// lusers), this is the rail's persistent per-kind context surface — it is
// present for as long as the server window is focused.

type Props = {
  network: Network;
  /** Epoch ms, injected by the container (ticked ~60s) so the rendered
      uptime stays fresh AND is deterministic under test. */
  now: number;
};

const ServerInfoCard: Component<Props> = (props) => {
  const state = () => connectionStateEmoji(props.network.connection_state);
  // Uptime ONLY while connected — connection_state_changed_at is "time of
  // last state transition", which IS the connect instant for a live link,
  // but next to a parked/failed state it would read as a lie.
  const uptime = () =>
    props.network.connection_state === "connected"
      ? formatDurationSince(props.network.connection_state_changed_at, props.now)
      : null;
  const services = () => {
    const flavor = props.network.services_flavor;
    return flavor && flavor !== "unknown" ? flavor : null;
  };

  return (
    <div class="rail-server-info" data-testid="rail-server-info">
      <div class="rail-server-info-header">
        <span class="rail-server-info-title">{props.network.slug}</span>
      </div>
      <dl class="rail-server-info-fields">
        <dt>status</dt>
        <dd>
          <span
            class="rail-server-info-glyph"
            role="img"
            title={state().label}
            aria-label={state().label}
          >
            {state().glyph}
          </span>{" "}
          {state().label}
          <Show when={props.network.connection_state_reason}>
            {(reason) => (
              <>
                {" — "}
                <MircBody body={reason()} />
              </>
            )}
          </Show>
        </dd>
        <Show when={uptime()}>
          {(up) => (
            <>
              <dt>connected</dt>
              <dd>{up()}</dd>
            </>
          )}
        </Show>
        <dt>nick</dt>
        <dd>{props.network.nick}</dd>
        <Show when={services()}>
          {(flavor) => (
            <>
              <dt>services</dt>
              <dd>{flavor()}</dd>
            </>
          )}
        </Show>
      </dl>
    </div>
  );
};

export default ServerInfoCard;
