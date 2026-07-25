import { type Component, For, Show } from "solid-js";
import { banlistCardBySlug, dismissBanlistCard } from "./lib/banlistCard";

// #376 — BANLIST card. Renders a channel's ban list inline at the top of
// the active window's scrollback pane (mirror of WhowasCard). It is ONE
// surface (the channel's ban list = one logical entity) that CONTAINS
// multiple ROWS (mask · set-by · set-time) — the card-holds-rows case of
// `feedback_card_vs_scrollback_ux`, since the entity is "this channel's
// banlist". Ephemeral — lives in `banlistCardBySlug` until replaced by
// the next /banlist on the same network OR explicitly dismissed.
//
// #376 core: each row shows the banmask + setter + a formatted set-time.
// The server NEVER emits a bare set-timestamp (that was the bug); cic
// formats `set_ts` (the raw upstream unix-epoch string) to the viewer's
// locale. IRC-text-only invariant: masks/setters are plain text, no
// linkify.
//
// `setter`/`set_ts` are nullable (older ircds / solanum send only the
// mask); a row then shows just the mask.

// Mirror of channelTopic.ts's `formatTopicSetAt` (NaN-guard + toLocaleString
// + raw fallback), adapted for a unix-epoch STRING input (333 topic set_at
// arrives ISO; 367 ban set_ts arrives as raw epoch seconds).
function formatBanSetAt(setTs: string | null): string | null {
  if (setTs === null) return null;
  const epoch = Number.parseInt(setTs, 10);
  if (Number.isNaN(epoch)) return setTs; // defensive: non-numeric → show raw
  return new Date(epoch * 1000).toLocaleString();
}

export type Props = {
  networkSlug: string;
};

const BanlistCard: Component<Props> = (props) => {
  const bundle = () => banlistCardBySlug()[props.networkSlug];

  return (
    <Show when={bundle()}>
      {(b) => (
        <div class="banlist-card" data-testid="banlist-card">
          <div class="banlist-card-header">
            <span class="banlist-card-title">/banlist</span>
            <span class="banlist-card-channel">{b().channel}</span>
            <span class="banlist-card-count muted">
              {b().entries.length} {b().entries.length === 1 ? "ban" : "bans"}
            </span>
            <button
              type="button"
              class="banlist-card-close"
              aria-label="Dismiss ban list"
              onClick={() => dismissBanlistCard(props.networkSlug)}
            >
              ×
            </button>
          </div>
          <Show
            when={b().entries.length > 0}
            fallback={<p class="banlist-card-empty muted">no bans set on {b().channel}</p>}
          >
            <ul class="banlist-card-rows">
              <For each={b().entries}>
                {(entry) => (
                  <li class="banlist-card-row">
                    <span class="banlist-card-mask">{entry.mask}</span>
                    <Show when={entry.setter}>
                      <span class="banlist-card-setter muted">set by {entry.setter}</span>
                    </Show>
                    <Show when={formatBanSetAt(entry.set_ts)}>
                      {(t) => <span class="banlist-card-time muted">{t()}</span>}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      )}
    </Show>
  );
};

export default BanlistCard;
