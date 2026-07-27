import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/archive", () => ({
  setArchiveModalOpen: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// UX-5 bucket BM (2026-05-20) — mobile chrome panel mutex helpers.
// Pre-bucket the three signals (membersOpen, settingsOpen, the archive
// modal flag) were independent. The helpers below enforce
// `members | settings | archive | none` by closing siblings before
// opening self. KISS: no new signal, just thin wrappers.
//
// #473 — the archive signal is now a boolean open/closed flag
// (`setArchiveModalOpen`), not a per-network slug: the grouped
// ArchiveModal shows every network at once, so closing it is
// `setArchiveModalOpen(false)` and the archive launcher opens it with
// `setArchiveModalOpen(true)` (no slug).

describe("toggleMembersPanel", () => {
  it("opens members when closed; closes sibling panels", async () => {
    const archive = await import("../lib/archive");
    const { toggleMembersPanel } = await import("../lib/mobilePanel");
    const setMembersOpen = vi.fn();
    const setSettingsOpen = vi.fn();
    toggleMembersPanel({
      membersOpen: () => false,
      setMembersOpen,
      setSettingsOpen,
    });
    expect(setSettingsOpen).toHaveBeenCalledWith(false);
    expect(archive.setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(setMembersOpen).toHaveBeenCalledWith(true);
  });

  it("closes members when already open; leaves siblings untouched (idempotent close)", async () => {
    const archive = await import("../lib/archive");
    const { toggleMembersPanel } = await import("../lib/mobilePanel");
    const setMembersOpen = vi.fn();
    const setSettingsOpen = vi.fn();
    toggleMembersPanel({
      membersOpen: () => true,
      setMembersOpen,
      setSettingsOpen,
    });
    expect(setMembersOpen).toHaveBeenCalledWith(false);
    expect(setSettingsOpen).not.toHaveBeenCalled();
    expect(archive.setArchiveModalOpen).not.toHaveBeenCalled();
  });
});

describe("openSettingsPanel", () => {
  it("opens settings + closes members + closes archive", async () => {
    const archive = await import("../lib/archive");
    const { openSettingsPanel } = await import("../lib/mobilePanel");
    const setMembersOpen = vi.fn();
    const setSettingsOpen = vi.fn();
    openSettingsPanel({
      membersOpen: () => true,
      setMembersOpen,
      setSettingsOpen,
    });
    expect(setMembersOpen).toHaveBeenCalledWith(false);
    expect(archive.setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
  });
});

describe("openArchivePanel (#473)", () => {
  it("opens the grouped archive modal + closes members + closes settings (no slug)", async () => {
    const archive = await import("../lib/archive");
    const { openArchivePanel } = await import("../lib/mobilePanel");
    const setMembersOpen = vi.fn();
    const setSettingsOpen = vi.fn();
    openArchivePanel({
      membersOpen: () => true,
      setMembersOpen,
      setSettingsOpen,
    });
    expect(setMembersOpen).toHaveBeenCalledWith(false);
    expect(setSettingsOpen).toHaveBeenCalledWith(false);
    expect(archive.setArchiveModalOpen).toHaveBeenCalledWith(true);
  });
});

// UX-6 bucket C (2026-05-21) — admin launcher mutex helper. Selection
// dispatch lives in the caller (Shell.tsx setSelectedChannel with
// $admin/$admin/admin); helper's job is the SAME shape as
// openSettingsPanel / openArchivePanel — close members + settings +
// archive — then invoke the caller-supplied navigate thunk.
describe("openAdminPanel", () => {
  it("closes members + settings + archive then calls navigate", async () => {
    const archive = await import("../lib/archive");
    const { openAdminPanel } = await import("../lib/mobilePanel");
    const setMembersOpen = vi.fn();
    const setSettingsOpen = vi.fn();
    const navigate = vi.fn();
    openAdminPanel(
      {
        membersOpen: () => true,
        setMembersOpen,
        setSettingsOpen,
      },
      navigate,
    );
    expect(setMembersOpen).toHaveBeenCalledWith(false);
    expect(setSettingsOpen).toHaveBeenCalledWith(false);
    expect(archive.setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
