import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { addAlias, aliases, delAlias, refreshAliases } from "./lib/aliasList";
import { friendlyError } from "./lib/friendlyError";

// #385 — user-defined command aliases settings SUB-PAGE. Mirrors the #356
// watch-lists sub-page structure (reuses the shared settings-* + list/add
// idiom rather than inventing a second one). One section: the alias list
// (/<name> → expansion, × to remove) + a two-field add form (name +
// expansion — an alias is a pair, unlike the single-field keyword list).
// Self-contained: reads the aliasList store directly (like WatchlistsSettings),
// only the ‹ back prop is threaded.
//
// The alias list has no server broadcast (server user_settings), so refresh on
// open; add/del mirror the authoritative {aliases} the store returns. A 422
// (bad name/expansion, builtin collision, cap) surfaces via friendlyError,
// which renders the per-field message from the envelope.

const AliasSettings: Component<{ onBack: () => void }> = (props) => {
  const [nameDraft, setNameDraft] = createSignal("");
  const [expansionDraft, setExpansionDraft] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // No broadcast — refresh the store on open so the list reflects the current
  // server user_settings.
  onMount(() => {
    void refreshAliases().catch((err) => setError(friendlyError(err)));
  });

  const names = () => Object.keys(aliases()).sort();

  const onAdd = async (e: Event) => {
    e.preventDefault();
    const name = nameDraft().trim();
    const expansion = expansionDraft().trim();
    if (name === "" || expansion === "" || busy()) return;
    setError(null);
    setBusy(true);
    try {
      await addAlias(name, expansion);
      setNameDraft("");
      setExpansionDraft("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (name: string) => {
    setError(null);
    try {
      await delAlias(name);
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <section class="settings-subpage aliases-subpage" data-testid="aliases-subpage">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="aliases-back"
          aria-label="back to settings"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>aliases</h3>
      </header>

      <div class="settings-section" data-testid="aliases-section">
        <p class="settings-section-blurb">
          define your own slash-commands. use <code>$1</code>..<code>$9</code> for arguments and{" "}
          <code>$*</code> for all of them; with no placeholder the rest is appended (e.g.{" "}
          <code>/alias wii whois $1 $1</code>).
        </p>
        <ul class="watchlists-list" data-testid="aliases-list">
          <Show
            when={names().length > 0}
            fallback={<li class="watchlists-empty">no aliases yet.</li>}
          >
            <For each={names()}>
              {(name) => (
                <li class="watchlists-item aliases-item" data-testid={`aliases-item-${name}`}>
                  <span class="aliases-name">/{name}</span>
                  <span class="aliases-arrow" aria-hidden="true">
                    →
                  </span>
                  <span class="aliases-expansion">{aliases()[name]}</span>
                  <button
                    type="button"
                    class="watchlists-remove"
                    aria-label={`Remove alias ${name}`}
                    onClick={() => void onRemove(name)}
                  >
                    ×
                  </button>
                </li>
              )}
            </For>
          </Show>
        </ul>
        <form class="watchlists-add aliases-add" onSubmit={(e) => void onAdd(e)}>
          <input
            type="text"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            placeholder="name"
            value={nameDraft()}
            data-testid="aliases-name-add"
            onInput={(e) => setNameDraft(e.currentTarget.value)}
          />
          <input
            type="text"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            placeholder="expansion (e.g. whois $1 $1)"
            value={expansionDraft()}
            data-testid="aliases-expansion-add"
            onInput={(e) => setExpansionDraft(e.currentTarget.value)}
          />
          <button type="submit" class="watchlists-add-btn" disabled={busy()}>
            add
          </button>
        </form>
        <Show when={error()}>
          {(msg) => (
            <p class="watchlists-error" data-testid="aliases-error">
              {msg()}
            </p>
          )}
        </Show>
      </div>
    </section>
  );
};

export default AliasSettings;
