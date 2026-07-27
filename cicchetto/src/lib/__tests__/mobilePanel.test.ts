import { beforeEach, describe, expect, test, vi } from "vitest";

// mobilePanel — mobile chrome-panel mutex helpers. Every launcher closes
// the three sibling surfaces (members / settings / archive) before
// opening its own. Tests assert the mutex outcome, not call order.

const setArchiveModalOpen = vi.fn();
vi.mock("../archive", () => ({
  setArchiveModalOpen: (v: unknown) => setArchiveModalOpen(v),
}));

import { openHomePanel, openMembersPanel } from "../mobilePanel";

function setters() {
  return {
    membersOpen: () => true,
    setMembersOpen: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
}

describe("openHomePanel (#291)", () => {
  beforeEach(() => {
    setArchiveModalOpen.mockReset();
  });

  test("closes members, settings and archive then navigates home", () => {
    const s = setters();
    const navigate = vi.fn();
    openHomePanel(s, navigate);
    expect(s.setMembersOpen).toHaveBeenCalledWith(false);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("openMembersPanel (#308 edge-swipe)", () => {
  beforeEach(() => {
    setArchiveModalOpen.mockReset();
  });

  test("opens members and closes settings + archive, idempotently", () => {
    const s = setters(); // membersOpen() === true
    openMembersPanel(s);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
    expect(s.setMembersOpen).toHaveBeenCalledWith(true);
    // Unlike toggleMembersPanel, an OPEN gesture never closes an open drawer.
    expect(s.setMembersOpen).not.toHaveBeenCalledWith(false);
  });
});
