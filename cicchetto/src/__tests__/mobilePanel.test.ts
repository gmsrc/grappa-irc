import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/archive", () => ({
  setArchiveModalOpen: vi.fn(),
}));

import { setArchiveModalOpen } from "../lib/archive";
import {
  openAdminPanel,
  openArchivePanel,
  openHomePanel,
  openMembersPanel,
  openMentionsPanel,
  openSettingsPanel,
  toggleMembersPanel,
} from "../lib/mobilePanel";

// UX-5 bucket BM (2026-05-20) — mobile chrome panel mutex helpers.
// Pre-bucket the three signals (membersOpen, settingsOpen, the archive
// modal flag) were independent. The helpers below enforce
// `members | settings | archive | none` by closing siblings before
// opening self. KISS: no new signal, just thin wrappers. Tests assert the
// mutex OUTCOME, not call order.
//
// #473 — the archive signal is now a boolean open/closed flag
// (`setArchiveModalOpen`), not a per-network slug: the grouped
// ArchiveModal shows every network at once, so closing it is
// `setArchiveModalOpen(false)` and the archive launcher opens it with
// `setArchiveModalOpen(true)` (no slug).
//
// #1582 — this module's API used to be PARTITIONED across two test files:
// toggle/settings/archive/admin here, home/members/mentions in a second file
// under `src/lib/__tests__/`. Disjoint verbs, zero overlap, and the two most
// recent edits landed on opposite sides (#986 on one, #473 on the other), so
// neither file could answer "is this verb covered?". They are one file now,
// on ONE mock of `../lib/archive`: the two halves stubbed it differently (a
// factory `vi.fn()` read through a dynamic import, versus a closure-captured
// spy behind a wrapper), and a single module path admits a single factory.
// The surviving shape is the one both halves can read directly — if the mock
// ever stops intercepting, `toHaveBeenCalledWith` fails loudly on a
// non-spy rather than passing vacuously.

beforeEach(() => {
  vi.clearAllMocks();
});

// `membersOpen` is the only input that varies between the launchers' cases —
// a toggle branches on it, an open-gesture must ignore it — so it is a
// required parameter rather than a default baked into the helper.
function setters(membersOpen: boolean) {
  return {
    membersOpen: () => membersOpen,
    setMembersOpen: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
}

describe("toggleMembersPanel", () => {
  it("opens members when closed; closes sibling panels", () => {
    const s = setters(false);
    toggleMembersPanel(s);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(s.setMembersOpen).toHaveBeenCalledWith(true);
  });

  it("closes members when already open; leaves siblings untouched (idempotent close)", () => {
    const s = setters(true);
    toggleMembersPanel(s);
    expect(s.setMembersOpen).toHaveBeenCalledWith(false);
    expect(s.setSettingsOpen).not.toHaveBeenCalled();
    expect(setArchiveModalOpen).not.toHaveBeenCalled();
  });
});

describe("openSettingsPanel", () => {
  it("opens settings + closes members + closes archive", () => {
    const s = setters(true);
    openSettingsPanel(s);
    expect(s.setMembersOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(true);
  });
});

describe("openArchivePanel (#473)", () => {
  it("opens the grouped archive modal + closes members + closes settings (no slug)", () => {
    const s = setters(true);
    openArchivePanel(s);
    expect(s.setMembersOpen).toHaveBeenCalledWith(false);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(true);
  });
});

// UX-6 bucket C (2026-05-21) — admin launcher mutex helper. Selection
// dispatch lives in the caller (Shell.tsx setSelectedChannel with
// $admin/$admin/admin); helper's job is the SAME shape as
// openSettingsPanel / openArchivePanel — close members + settings +
// archive — then invoke the caller-supplied navigate thunk.
describe("openAdminPanel", () => {
  it("closes members + settings + archive then calls navigate", () => {
    const s = setters(true);
    const navigate = vi.fn();
    openAdminPanel(s, navigate);
    expect(s.setMembersOpen).toHaveBeenCalledWith(false);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("openHomePanel (#291)", () => {
  it("closes members, settings and archive then navigates home", () => {
    const s = setters(true);
    const navigate = vi.fn();
    openHomePanel(s, navigate);
    expect(s.setMembersOpen).toHaveBeenCalledWith(false);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("openMembersPanel (#308 edge-swipe)", () => {
  it("opens members and closes settings + archive, idempotently", () => {
    const s = setters(true); // membersOpen() === true
    openMembersPanel(s);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(s.setMembersOpen).toHaveBeenCalledWith(true);
    // Unlike toggleMembersPanel, an OPEN gesture never closes an open drawer.
    expect(s.setMembersOpen).not.toHaveBeenCalledWith(false);
  });
});

describe("openMentionsPanel (#986)", () => {
  it("closes members, settings and archive then navigates to the bundle", () => {
    // #986 — the @ re-open door left `.shell-chrome` for the rail, so it must
    // take the SAME nav mutex the other window launchers take. It is a nav
    // launcher, not an own-signal one: opening it while the members drawer is
    // still up would leave the bundle behind a drawer on mobile.
    const s = setters(true);
    const navigate = vi.fn();
    openMentionsPanel(s, navigate);
    expect(s.setMembersOpen).toHaveBeenCalledWith(false);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
