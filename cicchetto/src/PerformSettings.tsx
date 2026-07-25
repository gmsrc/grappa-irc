import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { getPerform, type Network, putPerform } from "./lib/api";
import { token } from "./lib/auth";
import { friendlyError } from "./lib/friendlyError";
import { networks } from "./lib/networks";

// #189 — per-network ON-CONNECT PERFORM LIST sub-page. One block per network
// (mirrors WatchlistsSettings' PresenceNetworkBlock), each loading + saving
// its own list via GET/PUT /networks/:slug/perform.
//
// The list is RAW IRC lines, run SERVER-side at 001 BEFORE the built-in
// NickServ identify and before autojoin — NOT cic slash-commands and NOT
// #385 aliases (the server has no slash interpreter; that's #288, out of
// scope). The help blurb states this plainly so the honesty is in the UI,
// not just the issue. `$nickserv_pass` / `$oper_pass` keep secrets out of
// the text. The oper password is WRITE-ONLY: the server returns only whether
// it is set, never the value; the input is leave-blank-to-keep, exactly like
// a password field (mirrors AdminCredentialsTab's edit form).

const PerformNetworkBlock: Component<{ net: Network }> = (props) => {
  const [listDraft, setListDraft] = createSignal("");
  const [operDraft, setOperDraft] = createSignal("");
  const [operSet, setOperSet] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // No server broadcast for the perform list — load it on open.
  onMount(() => {
    const t = token();
    if (!t) return;
    void getPerform(t, props.net.slug)
      .then((view) => {
        setListDraft(view.perform_list ?? "");
        setOperSet(view.oper_pass_set);
      })
      .catch((err) => setError(friendlyError(err)));
  });

  const onSave = async (e: Event) => {
    e.preventDefault();
    const t = token();
    if (!t || busy()) return;
    setError(null);
    setBusy(true);
    try {
      const body: { perform_list?: string; oper_pass?: string } = {
        perform_list: listDraft(),
      };
      // Leave-blank-to-keep: only send oper_pass when the user typed one, so
      // saving the list alone never disturbs the stored secret.
      const oper = operDraft();
      if (oper !== "") body.oper_pass = oper;

      const view = await putPerform(t, props.net.slug, body);
      setListDraft(view.perform_list ?? "");
      setOperSet(view.oper_pass_set);
      setOperDraft("");
      setSaved(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="watchlists-network" data-testid={`perform-net-${props.net.slug}`}>
      <h5 class="watchlists-network-slug">{props.net.slug}</h5>
      <form onSubmit={(e) => void onSave(e)}>
        <textarea
          class="perform-textarea"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          placeholder={"# raw IRC lines, one per line\nPRIVMSG NickServ :IDENTIFY $nickserv_pass"}
          value={listDraft()}
          data-testid={`perform-list-${props.net.slug}`}
          onInput={(e) => {
            setListDraft(e.currentTarget.value);
            setSaved(false);
          }}
        />
        <div class="perform-oper">
          <input
            type="password"
            class="perform-oper-input"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            placeholder="new oper password (leave blank to keep)"
            value={operDraft()}
            data-testid={`perform-oper-${props.net.slug}`}
            onInput={(e) => {
              setOperDraft(e.currentTarget.value);
              setSaved(false);
            }}
          />
          <span class="perform-oper-status" data-testid={`perform-oper-status-${props.net.slug}`}>
            {operSet() ? "oper pass: set" : "oper pass: not set"}
          </span>
        </div>
        <button
          type="submit"
          class="watchlists-add-btn perform-save"
          disabled={busy()}
          data-testid={`perform-save-${props.net.slug}`}
        >
          save
        </button>
      </form>
      <Show when={saved()}>
        <p class="perform-oper-status" data-testid={`perform-saved-${props.net.slug}`}>
          saved
        </p>
      </Show>
      <Show when={error()}>
        {(msg) => (
          <p class="watchlists-error" data-testid={`perform-error-${props.net.slug}`}>
            {msg()}
          </p>
        )}
      </Show>
    </div>
  );
};

const PerformSettings: Component<{ onBack: () => void }> = (props) => {
  return (
    <section class="settings-subpage perform-subpage" data-testid="perform-subpage">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="perform-back"
          aria-label="back to settings"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>on-connect commands</h3>
      </header>

      <div class="settings-section" data-testid="perform-section">
        <p class="settings-section-blurb">
          Commands run automatically each time you connect, one <strong>raw IRC line</strong> per
          line, BEFORE channels are joined. These are <strong>not</strong> slash-commands or aliases
          — <code>/msg</code>, <code>/join</code> and <code>/alias</code> expansions do NOT work
          here. Write the wire command itself:{" "}
          <code>PRIVMSG NickServ :IDENTIFY $nickserv_pass</code>,{" "}
          <code>OPER myname $oper_pass</code>, <code>MODE mynick +x</code>. Use{" "}
          <code>$nickserv_pass</code> and <code>$oper_pass</code> so passwords stay out of the text.
          Lines starting with <code>#</code> are comments.
        </p>
        <Show
          when={(networks() ?? []).length > 0}
          fallback={<p class="watchlists-empty">no networks yet.</p>}
        >
          <For each={networks() ?? []}>{(net) => <PerformNetworkBlock net={net} />}</For>
        </Show>
      </div>
    </section>
  );
};

export default PerformSettings;
