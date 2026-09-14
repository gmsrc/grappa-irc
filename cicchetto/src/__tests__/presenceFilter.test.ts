import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// #222 — hide join/part/quit/nick-change signalling on large channels by
// default, with a per-channel opt-in to re-show. Client-side only: grappa
// still delivers the events over the wire (no wire change), cic decides
// whether to RENDER them. Mirrors the #217 timeFormat precedent — closed-set
// keys (CLAUDE.md "atoms/literals, never untyped strings for closed sets"),
// localStorage-persisted, backed by a module-singleton Solid signal so open
// scrollback panes re-filter live on toggle.
//
// The "tough" part the issue flagged: an automatic size-based default and a
// manual per-channel override need a clear precedence — explicit choice WINS
// over the size default. That precedence is the pure `resolvePresenceVisible`
// truth table tested here — and ONLY here: the size default is not reachable
// from the e2e at any threshold value (spawning LARGE_CHANNEL_THRESHOLD real
// peers trips the bahamut same-host autokill, and the harness exposes no
// member-count seam), so these cases are the sole gate on the cutoff. Every
// count is derived from the constant, never a literal: a literal keeps passing
// on the OPPOSITE branch after a tune (#915 raised 50 → 200).

describe("presenceFilter module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  const key = () => channelKey("bahamut-test", "#bofh");

  describe("resolvePresenceVisible() — pure precedence truth table", () => {
    it("unset pref: visible below the LARGE_CHANNEL_THRESHOLD", async () => {
      const { resolvePresenceVisible, LARGE_CHANNEL_THRESHOLD } = await import(
        "../lib/presenceFilter"
      );
      // Well below the cutoff, not the boundary (that pair has its own case).
      expect(resolvePresenceVisible(undefined, Math.floor(LARGE_CHANNEL_THRESHOLD / 2))).toBe(true);
    });

    it("unset pref: hidden at-or-above the LARGE_CHANNEL_THRESHOLD", async () => {
      const { resolvePresenceVisible, LARGE_CHANNEL_THRESHOLD } = await import(
        "../lib/presenceFilter"
      );
      expect(resolvePresenceVisible(undefined, LARGE_CHANNEL_THRESHOLD)).toBe(false);
      expect(resolvePresenceVisible(undefined, LARGE_CHANNEL_THRESHOLD * 10)).toBe(false);
    });

    it("boundary is exactly LARGE_CHANNEL_THRESHOLD: one below shown, at it hidden", async () => {
      const { resolvePresenceVisible, LARGE_CHANNEL_THRESHOLD } = await import(
        "../lib/presenceFilter"
      );
      expect(resolvePresenceVisible(undefined, LARGE_CHANNEL_THRESHOLD - 1)).toBe(true);
      expect(resolvePresenceVisible(undefined, LARGE_CHANNEL_THRESHOLD)).toBe(false);
    });

    it("explicit 'show' overrides the size default even on a huge channel", async () => {
      const { resolvePresenceVisible, LARGE_CHANNEL_THRESHOLD } = await import(
        "../lib/presenceFilter"
      );
      // Counts must sit ABOVE the threshold or the case degenerates: an unset
      // pref would return true too and the override would go unconstrained.
      expect(resolvePresenceVisible("show", LARGE_CHANNEL_THRESHOLD)).toBe(true);
      expect(resolvePresenceVisible("show", LARGE_CHANNEL_THRESHOLD * 25)).toBe(true);
    });

    it("explicit 'hide' overrides the size default even on a tiny channel", async () => {
      const { resolvePresenceVisible } = await import("../lib/presenceFilter");
      expect(resolvePresenceVisible("hide", 2)).toBe(false);
      expect(resolvePresenceVisible("hide", 0)).toBe(false);
    });
  });

  describe("SUPPRESSED_PRESENCE_KINDS — the noise set", () => {
    it("suppresses exactly join/part/quit/nick_change/mode", async () => {
      const { SUPPRESSED_PRESENCE_KINDS } = await import("../lib/presenceFilter");
      expect(SUPPRESSED_PRESENCE_KINDS.has("join")).toBe(true);
      expect(SUPPRESSED_PRESENCE_KINDS.has("part")).toBe(true);
      expect(SUPPRESSED_PRESENCE_KINDS.has("quit")).toBe(true);
      expect(SUPPRESSED_PRESENCE_KINDS.has("nick_change")).toBe(true);
      expect(SUPPRESSED_PRESENCE_KINDS.has("mode")).toBe(true);
    });

    // #1262 — `mode` moved INTO the set when vjt withdrew #458's
    // "mode carries operator-relevant signal" carve-out. The server twin
    // (`Grappa.Scrollback.Message.suppressed_presence_kinds/0`) must agree,
    // and `presence_filter_test.exs` parses this file to enforce it.
    it("does NOT suppress topic/kick/server_event (still not churn)", async () => {
      const { SUPPRESSED_PRESENCE_KINDS } = await import("../lib/presenceFilter");
      expect(SUPPRESSED_PRESENCE_KINDS.has("topic")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("kick")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("server_event")).toBe(false);
    });

    it("does NOT suppress content kinds (privmsg/notice/action)", async () => {
      const { SUPPRESSED_PRESENCE_KINDS } = await import("../lib/presenceFilter");
      expect(SUPPRESSED_PRESENCE_KINDS.has("privmsg")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("notice")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("action")).toBe(false);
    });
  });

  describe("getChannelPresencePref() / setChannelPresencePref()", () => {
    it("returns undefined (follow-size-default) when nothing is stored", async () => {
      const { getChannelPresencePref } = await import("../lib/presenceFilter");
      expect(getChannelPresencePref(key())).toBeUndefined();
    });

    it("returns the stored pref for the channel", async () => {
      const { getChannelPresencePref, setChannelPresencePref } = await import(
        "../lib/presenceFilter"
      );
      setChannelPresencePref(key(), "hide");
      expect(getChannelPresencePref(key())).toBe("hide");
    });

    it("persists the pref to localStorage keyed under the channelKey", async () => {
      const { setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      const raw = localStorage.getItem("cicchetto.presenceFilter");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw ?? "{}");
      expect(parsed[key()]).toBe("hide");
    });

    it("survives a module reload (re-seeds the signal from localStorage)", async () => {
      const first = await import("../lib/presenceFilter");
      first.setChannelPresencePref(key(), "show");
      vi.resetModules();
      const second = await import("../lib/presenceFilter");
      expect(second.getChannelPresencePref(key())).toBe("show");
    });

    it("ignores a corrupt localStorage value and defaults to follow-size", async () => {
      localStorage.setItem("cicchetto.presenceFilter", "not-json{");
      const { getChannelPresencePref } = await import("../lib/presenceFilter");
      expect(getChannelPresencePref(key())).toBeUndefined();
    });

    it("keys are case-folded via channelKey — #Bofh and #bofh share one pref", async () => {
      const { getChannelPresencePref, setChannelPresencePref } = await import(
        "../lib/presenceFilter"
      );
      setChannelPresencePref(channelKey("bahamut-test", "#BOFH"), "hide");
      expect(getChannelPresencePref(channelKey("bahamut-test", "#bofh"))).toBe("hide");
    });
  });

  describe("clearChannelPresencePref() — back to follow-size-default", () => {
    it("removes the explicit pref so the channel follows the size default again", async () => {
      const { getChannelPresencePref, setChannelPresencePref, clearChannelPresencePref } =
        await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      expect(getChannelPresencePref(key())).toBe("hide");
      clearChannelPresencePref(key());
      expect(getChannelPresencePref(key())).toBeUndefined();
    });
  });

  describe("channelPresenceVisible() — reactive wrapper reading the signal", () => {
    it("follows the size default when the pref is unset", async () => {
      const { channelPresenceVisible, LARGE_CHANNEL_THRESHOLD } = await import(
        "../lib/presenceFilter"
      );
      expect(channelPresenceVisible(key(), LARGE_CHANNEL_THRESHOLD - 1)).toBe(true);
      expect(channelPresenceVisible(key(), LARGE_CHANNEL_THRESHOLD)).toBe(false);
    });

    it("reflects an explicit pin regardless of member count", async () => {
      const { channelPresenceVisible, setChannelPresencePref, LARGE_CHANNEL_THRESHOLD } =
        await import("../lib/presenceFilter");
      // Both counts are chosen so the SIZE DEFAULT would answer the opposite —
      // otherwise the pin would be indistinguishable from the default.
      setChannelPresencePref(key(), "hide");
      expect(channelPresenceVisible(key(), 3)).toBe(false);
      setChannelPresencePref(key(), "show");
      expect(channelPresenceVisible(key(), LARGE_CHANNEL_THRESHOLD)).toBe(true);
    });
  });

  // #239 — the ONE shared "is this row visible under the channel's presence
  // filter?" predicate. BOTH the render filter (ScrollbackPane.rows) AND the
  // unread-count derivation (selection.ts perChannelUnread) route through it,
  // so a hidden control row can never inflate a badge the operator cannot
  // clear. Reconcile-to-one-predicate — no forked filter.
  describe("presenceRowVisible() — the shared visible predicate (#239)", () => {
    it("content kinds are always visible, even when the channel hides presence", async () => {
      const { presenceRowVisible, setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      expect(presenceRowVisible(key(), 999, { kind: "privmsg" })).toBe(true);
      expect(presenceRowVisible(key(), 999, { kind: "notice" })).toBe(true);
      expect(presenceRowVisible(key(), 999, { kind: "action" })).toBe(true);
    });

    it("non-suppressed event kinds (topic/kick/server_event) stay visible when hiding", async () => {
      const { presenceRowVisible, setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      expect(presenceRowVisible(key(), 999, { kind: "topic" })).toBe(true);
      expect(presenceRowVisible(key(), 999, { kind: "kick" })).toBe(true);
      expect(presenceRowVisible(key(), 999, { kind: "server_event" })).toBe(true);
    });

    // #1262 — the behavioural half of the ruling: a channel MODE row is folded
    // with join/part/quit while the channel is denoised. Own-nick mode rows are
    // NOT affected here — they live on the `$server` window, whose unknowable
    // member count resolves to SHOW server-side (see the Resolver test).
    it("mode is hidden when the channel hides presence, visible otherwise", async () => {
      const { presenceRowVisible, setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      expect(presenceRowVisible(key(), 999, { kind: "mode" })).toBe(false);
      setChannelPresencePref(key(), "show");
      expect(presenceRowVisible(key(), 999, { kind: "mode" })).toBe(true);
    });

    // issue 2176 — the split. The reported defect: on a denoised channel a
    // `+b` was folded with the `+o` churn, so one operator could not see a ban
    // their colleague (same version, channel on `show`) could.
    it("a mode row TAGGED structural renders even while the channel hides presence", async () => {
      const { presenceRowVisible, setChannelPresencePref, STRUCTURAL_META_KEY } = await import(
        "../lib/presenceFilter"
      );
      setChannelPresencePref(key(), "hide");
      expect(
        presenceRowVisible(key(), 999, { kind: "mode", meta: { [STRUCTURAL_META_KEY]: true } }),
      ).toBe(true);
    });

    it("an UNTAGGED mode row still folds — absence is what the old rows and the +o churn carry", async () => {
      const { presenceRowVisible, setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      // The `+o` shape the server writes today...
      expect(presenceRowVisible(key(), 999, { kind: "mode", meta: { modes: "+o" } })).toBe(false);
      // ...and a row from before the tag existed, which is not backfilled.
      expect(presenceRowVisible(key(), 999, { kind: "mode", meta: {} })).toBe(false);
      expect(presenceRowVisible(key(), 999, { kind: "mode" })).toBe(false);
    });

    it("the tag is read STRICTLY — a truthy non-true value does not exempt", async () => {
      // `meta` values are `unknown` on the generated wire type, so a truthy
      // check would let any stray string turn every mode row permanently
      // visible. The server writes the boolean `true` and nothing else.
      const { presenceRowVisible, setChannelPresencePref, STRUCTURAL_META_KEY } = await import(
        "../lib/presenceFilter"
      );
      setChannelPresencePref(key(), "hide");
      expect(
        presenceRowVisible(key(), 999, { kind: "mode", meta: { [STRUCTURAL_META_KEY]: "yes" } }),
      ).toBe(false);
      expect(
        presenceRowVisible(key(), 999, { kind: "mode", meta: { [STRUCTURAL_META_KEY]: 1 } }),
      ).toBe(false);
      expect(
        presenceRowVisible(key(), 999, { kind: "mode", meta: { [STRUCTURAL_META_KEY]: false } }),
      ).toBe(false);
    });

    it("the tag does not resurrect a join/part/quit the operator asked to fold", async () => {
      // Only the channel-MODE writer tags, so this shape does not occur; the
      // assertion that matters is the inverse — an UNTAGGED join still folds,
      // i.e. the new disjunct did not widen the predicate for everything else.
      const { presenceRowVisible, setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      expect(presenceRowVisible(key(), 999, { kind: "join", meta: {} })).toBe(false);
      expect(presenceRowVisible(key(), 999, { kind: "nick_change", meta: {} })).toBe(false);
    });

    it("suppressed kinds hidden when the channel hides presence, visible otherwise", async () => {
      const {
        presenceRowVisible,
        setChannelPresencePref,
        clearChannelPresencePref,
        LARGE_CHANNEL_THRESHOLD,
      } = await import("../lib/presenceFilter");
      // Small channel, pref unset → follow-size default → visible.
      expect(presenceRowVisible(key(), 3, { kind: "join" })).toBe(true);
      // Large channel, pref unset → hidden by the size default.
      expect(presenceRowVisible(key(), LARGE_CHANNEL_THRESHOLD, { kind: "join" })).toBe(false);
      // Explicit hide on a tiny channel → hidden (unset would SHOW here, so
      // the override is what the assertion pins).
      setChannelPresencePref(key(), "hide");
      expect(presenceRowVisible(key(), 3, { kind: "part" })).toBe(false);
      // Explicit show on a huge channel → visible (unset would HIDE here).
      setChannelPresencePref(key(), "show");
      expect(presenceRowVisible(key(), LARGE_CHANNEL_THRESHOLD, { kind: "quit" })).toBe(true);
      clearChannelPresencePref(key());
    });
  });

  // #239 — the read-cursor advance target that skips the TRAILING run of
  // hidden control messages on window display WITHOUT marking any visible
  // unread read. Pure (predicate injected) so it is unit-testable without
  // DOM/timers; the ScrollbackPane effect injects `presenceRowVisible`.
  describe("trailingHiddenAdvanceTarget() — skip the trailing hidden run (#239)", () => {
    type Row = { id: number; kind: ScrollbackMessage["kind"] };
    const hidden = new Set<ScrollbackMessage["kind"]>(["join", "part", "quit", "nick_change"]);
    const isVisible = (row: { kind: ScrollbackMessage["kind"] }): boolean => !hidden.has(row.kind);

    it("returns the cursor unchanged when nothing is past it", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 1, kind: "privmsg" },
        { id: 2, kind: "join" },
      ];
      expect(trailingHiddenAdvanceTarget(rows, 2, isVisible)).toBe(2);
    });

    it("advances to the tail when the whole post-cursor tail is hidden", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 1, kind: "privmsg" },
        { id: 2, kind: "join" },
        { id: 3, kind: "part" },
      ];
      // cursor at 1 — id2/id3 are a hidden trailing run → advance to 3.
      expect(trailingHiddenAdvanceTarget(rows, 1, isVisible)).toBe(3);
    });

    it("stops before the first visible unread (never marks it read)", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 10, kind: "join" }, // hidden, past cursor
        { id: 11, kind: "privmsg" }, // first visible unread
        { id: 12, kind: "part" }, // trailing hidden AFTER the visible unread
      ];
      // cursor 9: skip the hidden id10, STOP before the visible id11.
      expect(trailingHiddenAdvanceTarget(rows, 9, isVisible)).toBe(10);
    });

    it("does not advance when the first row past the cursor is visible", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 5, kind: "privmsg" },
        { id: 6, kind: "join" },
      ];
      expect(trailingHiddenAdvanceTarget(rows, 4, isVisible)).toBe(4);
    });

    it("is forward-only in effect — a stale row below the cursor is ignored", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 1, kind: "join" }, // below cursor — skipped by the id guard
        { id: 2, kind: "part" }, // below cursor — skipped
        { id: 3, kind: "join" }, // hidden, past cursor
      ];
      expect(trailingHiddenAdvanceTarget(rows, 2, isVisible)).toBe(3);
    });

    // issue 2176 — the auto-advance skips the trailing run of HIDDEN rows, and
    // a structural mode row is not hidden. Injecting the REAL predicate here
    // (not the synthetic one above) is the point: this is the seam where the
    // cursor could silently mark a ban read that the operator never saw.
    it("a structural mode row is a CEILING — the cursor never advances past a visible ban", async () => {
      const {
        trailingHiddenAdvanceTarget,
        presenceRowVisible,
        setChannelPresencePref,
        STRUCTURAL_META_KEY,
      } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");

      const rows = [
        { id: 10, kind: "join" as const },
        { id: 11, kind: "mode" as const, meta: { [STRUCTURAL_META_KEY]: true } },
        { id: 12, kind: "part" as const },
      ];

      expect(
        trailingHiddenAdvanceTarget(rows, 9, (row) => presenceRowVisible(key(), 999, row)),
      ).toBe(10);
    });

    it("is order-independent — never advances past a visible unread even when array order diverges from id order", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      // The store sorts by [server_time asc, id asc], so a visible privmsg with
      // an EARLIER server_time but a LOWER id can appear AFTER a hidden row with
      // a HIGHER id in the array. Advancing to the hidden id (10) would mark the
      // visible unread (id 5) read though the operator never saw it. The target
      // must respect id order, not array order → stop below the LOWEST visible
      // unread id (5) → nothing hidden below it → no advance.
      const rows: Row[] = [
        { id: 10, kind: "join" }, // hidden, appears first (earlier server_time)
        { id: 5, kind: "privmsg" }, // visible unread, LOWER id, appears later
      ];
      expect(trailingHiddenAdvanceTarget(rows, 4, isVisible)).toBe(4);
    });
  });
});
