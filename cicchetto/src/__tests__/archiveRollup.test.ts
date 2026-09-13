import { describe, expect, it } from "vitest";
import type { ArchiveSuppression } from "../lib/archive";
import {
  type ArchiveNetworkFacts,
  rollupArchivedUnread,
  rollupArchivedUnreadBySlug,
} from "../lib/archiveRollup";
import { type ChannelKey, channelKey } from "../lib/channelKey";
import { DEFAULT_CHANTYPES } from "../lib/chantypes";
import { normalizeNick } from "../lib/nickEquals";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";

// issue 2096 — the archive launcher's rollup badge.
//
// The whole point of the derivation is that the numbers are ALREADY on the
// client: `/me`'s `unread_counts` seed carries every window with a read
// cursor, ARCHIVED ONES INCLUDED (measured on the artefact — see
// DESIGN_NOTES 2026-09-12). What cic lacks is not the counts but the
// membership, and membership is `seed − active`, which cic also already
// holds. So this fn answers "of the windows I have unread for, which ones
// have no surface in the nav?" and sums those.
//
// Pure, on the model of `orderUnreadWindows` (lib/activeWindows.ts): plain
// data in, plain data out, so the subtraction is testable without a
// reactive context. The `archivedUnread` memo feeds it the live signals.
//
// The invariant every case below defends: the rollup must equal the sum of
// the badges `ArchiveModal` draws behind the launcher. A badge that counts
// a window the modal does not list is a number the operator cannot chase.

const ck = channelKey;

const suppression = (
  parts: Partial<{ channels: string[]; queries: string[]; pseudo: string[] }>,
): ArchiveSuppression => ({
  // The production builder folds with `normalizeNick`; so does the test, or
  // the compare would be testing the test's own spelling.
  channels: new Set((parts.channels ?? []).map((n) => normalizeNick(n, "ascii"))),
  queries: new Set((parts.queries ?? []).map((n) => normalizeNick(n, "ascii"))),
  pseudo: new Set((parts.pseudo ?? []).map((n) => normalizeNick(n, "ascii"))),
});

const facts = (sup: ArchiveSuppression | null): ArchiveNetworkFacts => ({
  casemapping: "ascii",
  chantypes: DEFAULT_CHANTYPES,
  suppression: sup,
});

// One network ("net") unless a case says otherwise.
const oneNetwork =
  (sup: ArchiveSuppression | null) =>
  (slug: string): ArchiveNetworkFacts | null =>
    slug === "net" ? facts(sup) : null;

const counts = (pairs: Array<[string, number]>): Record<ChannelKey, number> => {
  const out: Record<ChannelKey, number> = {};
  for (const [name, n] of pairs) out[ck("net", name)] = n;
  return out;
};

describe("rollupArchivedUnread", () => {
  it("is zero when there is no unread at all", () => {
    expect(
      rollupArchivedUnread({
        messages: {},
        events: {},
        factsForSlug: oneNetwork(suppression({})),
      }),
    ).toEqual({ messages: 0, events: 0 });
  });

  it("sums messages and events over windows the nav does not draw", () => {
    expect(
      rollupArchivedUnread({
        messages: counts([
          ["#gone", 3],
          ["oldpeer", 4],
        ]),
        events: counts([["#gone", 2]]),
        factsForSlug: oneNetwork(suppression({})),
      }),
    ).toEqual({ messages: 7, events: 2 });
  });

  it("keeps messages and events on SEPARATE totals", () => {
    // #532's rule, carried up to the rollup: presence churn is its own tier
    // and must not inflate the message number.
    expect(
      rollupArchivedUnread({
        messages: counts([["#gone", 1]]),
        events: counts([["#gone", 90]]),
        factsForSlug: oneNetwork(suppression({})),
      }),
    ).toEqual({ messages: 1, events: 90 });
  });

  it("subtracts a channel the operator is still in", () => {
    expect(
      rollupArchivedUnread({
        messages: counts([
          ["#live", 5],
          ["#gone", 1],
        ]),
        events: {},
        factsForSlug: oneNetwork(suppression({ channels: ["#live"] })),
      }),
    ).toEqual({ messages: 1, events: 0 });
  });

  it("subtracts a query window that is open", () => {
    expect(
      rollupArchivedUnread({
        messages: counts([
          ["livepeer", 5],
          ["oldpeer", 1],
        ]),
        events: {},
        factsForSlug: oneNetwork(suppression({ queries: ["livepeer"] })),
      }),
    ).toEqual({ messages: 1, events: 0 });
  });

  it("subtracts a pseudo-row window (failed / kicked / pending / parked)", () => {
    expect(
      rollupArchivedUnread({
        messages: counts([
          ["#kicked", 5],
          ["#gone", 1],
        ]),
        events: {},
        factsForSlug: oneNetwork(suppression({ pseudo: ["#kicked"] })),
      }),
    ).toEqual({ messages: 1, events: 0 });
  });

  it("checks a channel against the channel set and a nick against the query set", () => {
    // The two sets are NOT interchangeable: a nick listed among live
    // channels must not silence the DM of the same spelling, or the
    // subtraction would be a bare union pretending to be kind-aware.
    expect(
      rollupArchivedUnread({
        messages: counts([["oldpeer", 6]]),
        events: {},
        factsForSlug: oneNetwork(suppression({ channels: ["oldpeer"] })),
      }),
    ).toEqual({ messages: 6, events: 0 });
  });

  it("folds the compare, so casing cannot leak an archived window back in", () => {
    // #372/#1861 — the live row carries DISPLAY casing, the key is folded.
    expect(
      rollupArchivedUnread({
        messages: counts([["#Foo", 9]]),
        events: {},
        factsForSlug: oneNetwork(suppression({ channels: ["#FOO"] })),
      }),
    ).toEqual({ messages: 0, events: 0 });
  });

  it("never counts the $server pseudo-channel", () => {
    // `Scrollback.list_archive/3` excludes it unconditionally, so the modal
    // never draws a row for it and the rollup must not out-count the modal.
    expect(
      rollupArchivedUnread({
        messages: counts([
          [SERVER_WINDOW_NAME, 40],
          ["#gone", 1],
        ]),
        events: counts([[SERVER_WINDOW_NAME, 40]]),
        factsForSlug: oneNetwork(suppression({})),
      }),
    ).toEqual({ messages: 1, events: 0 });
  });

  it("skips a slug cic knows no network for", () => {
    // GH #105 — an unbound-but-retained network still seeds `unread_counts`,
    // but `ArchiveModal` iterates `networks()` and draws no group for it. No
    // group, no row, no contribution.
    expect(
      rollupArchivedUnread({
        messages: counts([["#gone", 3]]),
        events: {},
        factsForSlug: () => null,
      }),
    ).toEqual({ messages: 0, events: 0 });
  });

  it("counts EVERYTHING on a network whose nav draws no row at all", () => {
    // issue 1985 — a parked network is dropped by the desktop Sidebar's ONE
    // `<For>`, so the correct subtraction is the empty set even for windows
    // `channelsBySlug` still lists. `visibleArchiveForNetwork` returns the
    // entries untouched there; the rollup has to agree or the badge and the
    // modal disagree on the very network the archive is the only door to.
    expect(
      rollupArchivedUnread({
        messages: counts([
          ["#autojoin-but-parked", 2],
          ["#gone", 1],
        ]),
        events: {},
        factsForSlug: oneNetwork(null),
      }),
    ).toEqual({ messages: 3, events: 0 });
  });

  it("rolls up across networks", () => {
    const messages: Record<ChannelKey, number> = {
      [ck("alpha", "#a")]: 2,
      [ck("beta", "#b")]: 5,
    };
    expect(
      rollupArchivedUnread({
        messages,
        events: {},
        factsForSlug: (slug) =>
          slug === "alpha" || slug === "beta" ? facts(suppression({})) : null,
      }),
    ).toEqual({ messages: 7, events: 0 });
  });

  it("counts a window present only in the events map", () => {
    // The two maps are independent projections of the same seed; a window
    // whose entire unread is presence churn appears in one and not the other.
    expect(
      rollupArchivedUnread({
        messages: {},
        events: counts([["#gone", 4]]),
        factsForSlug: oneNetwork(suppression({})),
      }),
    ).toEqual({ messages: 0, events: 4 });
  });
});

// issue 2109 — the SAME subtraction, split by network slug.
//
// `ArchiveModal` renders one collapsible `<details>` per network and the
// group header carried nothing but the slug, so the operator had to expand
// every group one by one to find which network was holding the unread the
// launcher had just announced. The middle of the chain was missing.
//
// The split is not a second summation: `rollupArchivedUnread` is now the
// FOLD of this function's output, so "the launcher equals the sum of the
// groups" holds by construction rather than by agreement between two
// traversals that could drift. The cases below pin the half that does NOT
// come for free — that each group keeps every exclusion the total had.
describe("rollupArchivedUnreadBySlug", () => {
  const twoNetworks = (slug: string): ArchiveNetworkFacts | null =>
    slug === "alpha" || slug === "beta" ? facts(suppression({})) : null;

  it("attributes each window's unread to its own network", () => {
    expect(
      rollupArchivedUnreadBySlug({
        messages: {
          [ck("alpha", "#a")]: 2,
          [ck("beta", "#b")]: 5,
        },
        events: { [ck("beta", "#b")]: 1 },
        factsForSlug: twoNetworks,
      }),
    ).toEqual({
      alpha: { messages: 2, events: 0 },
      beta: { messages: 5, events: 1 },
    });
  });

  it("omits a slug holding no archived unread rather than seeding a zero", () => {
    // The group badge renders on `> 0`, so an explicit zero entry would buy
    // nothing and would make "which networks are holding something" a
    // filter at every call site instead of a key test.
    expect(
      rollupArchivedUnreadBySlug({
        messages: { [ck("alpha", "#a")]: 2, [ck("beta", "#quiet")]: 0 },
        events: {},
        factsForSlug: twoNetworks,
      }),
    ).toEqual({ alpha: { messages: 2, events: 0 } });
  });

  it("the launcher total IS the sum of the group totals", () => {
    // The invariant the issue puts above the feature: three numbers that
    // contradict each other are worse than the missing badge. Asserted on
    // one input that exercises every exclusion at once — a live channel, a
    // $server row, an unknown slug — so the two answers are compared where
    // they have the most room to disagree.
    const input = {
      messages: {
        [ck("alpha", "#a")]: 2,
        [ck("alpha", "#live")]: 7,
        [ck("alpha", SERVER_WINDOW_NAME)]: 40,
        [ck("beta", "#b")]: 5,
        [ck("nosuch", "#orphan")]: 99,
      },
      events: { [ck("beta", "#b")]: 3 },
      factsForSlug: (slug: string): ArchiveNetworkFacts | null =>
        slug === "alpha"
          ? facts(suppression({ channels: ["#live"] }))
          : slug === "beta"
            ? facts(suppression({}))
            : null,
    };
    const bySlug = rollupArchivedUnreadBySlug(input);
    const summed = Object.values(bySlug).reduce(
      (acc, r) => ({ messages: acc.messages + r.messages, events: acc.events + r.events }),
      { messages: 0, events: 0 },
    );
    expect(summed).toEqual(rollupArchivedUnread(input));
    // …and the value itself, so a bug that zeroed BOTH sides still fails.
    expect(summed).toEqual({ messages: 7, events: 3 });
  });

  it("keeps every exclusion per group: $server, a live surface, an unknown slug", () => {
    expect(
      rollupArchivedUnreadBySlug({
        messages: {
          [ck("alpha", SERVER_WINDOW_NAME)]: 40,
          [ck("alpha", "#live")]: 7,
          [ck("alpha", "livepeer")]: 6,
          [ck("alpha", "#kicked")]: 4,
          [ck("alpha", "#gone")]: 1,
          [ck("nosuch", "#orphan")]: 99,
        },
        events: {},
        factsForSlug: (slug) =>
          slug === "alpha"
            ? facts(
                suppression({ channels: ["#live"], queries: ["livepeer"], pseudo: ["#kicked"] }),
              )
            : null,
      }),
    ).toEqual({ alpha: { messages: 1, events: 0 } });
  });

  it("counts EVERYTHING on a network whose nav draws no row at all", () => {
    // issue 1985, per group: the modal DOES render a group for a parked
    // network, and `visibleArchiveForNetwork` hands it every entry, so the
    // group badge has to count them or the badge and the rows it sits above
    // disagree on the one network the archive is the only door to.
    expect(
      rollupArchivedUnreadBySlug({
        messages: counts([
          ["#autojoin-but-parked", 2],
          ["#gone", 1],
        ]),
        events: {},
        factsForSlug: oneNetwork(null),
      }),
    ).toEqual({ net: { messages: 3, events: 0 } });
  });
});
