import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #386 — ban-management modal. Interactive `/banlist` surface: list rows,
// add a ban via the mask builder (on-demand userhost lookup, fail-closed),
// remove a ban, op-gate as a HINT (never a hard block — vjt decision #2).

const socketMock = vi.hoisted(() => ({
  resolveUserhost: vi.fn(),
  pushChannelBan: vi.fn().mockResolvedValue(undefined),
  pushChannelUnban: vi.fn().mockResolvedValue(undefined),
  pushChannelBanlist: vi.fn(),
}));
vi.mock("../lib/socket", () => socketMock);

// Overlay lock is a no-op in jsdom (no real scroller); stub it.
vi.mock("../lib/overlayScrollLock", () => ({ createOverlayLock: vi.fn() }));

// canEdit is controlled per-test — the op-gate HINT (decision #2), never a gate.
const editPermMock = vi.hoisted(() => ({ canEdit: true }));
vi.mock("../lib/channelEditPerm", () => ({
  ownHoldsChannelEditorSigil: () => editPermMock.canEdit,
}));

vi.mock("../lib/networks", () => ({
  networks: vi.fn(() => [
    { id: 1, slug: "bahamut", nick: "vjt", inserted_at: "x", updated_at: "y" },
  ]),
}));

import BanlistModal from "../BanlistModal";
import { setBanlistBundle } from "../lib/banlistCard";
import { closeBanlistModal, openBanlistModal } from "../lib/banlistModal";

const BUNDLE = {
  network: "bahamut",
  channel: "#bofh",
  entries: [
    { mask: "*!*@banned.host", setter: "op!u@h", set_ts: "1784572878" },
    { mask: "evil!*@spam.net", setter: null, set_ts: null },
  ],
};

describe("BanlistModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editPermMock.canEdit = true;
    closeBanlistModal();
  });

  it("renders nothing when closed", () => {
    const { container } = render(() => <BanlistModal />);
    expect(container.querySelector("[data-testid='banlist-modal']")).toBeNull();
  });

  it("lists the channel's bans (mask + setter) when open for that channel", () => {
    setBanlistBundle("bahamut", BUNDLE);
    openBanlistModal("bahamut", "#bofh");
    render(() => <BanlistModal />);
    const modal = screen.getByTestId("banlist-modal");
    expect(modal.textContent).toContain("#bofh");
    expect(modal.textContent).toContain("*!*@banned.host");
    expect(modal.textContent).toContain("evil!*@spam.net");
    expect(modal.textContent).toContain("op!u@h");
  });

  it("add-by-nick with host form → resolves userhost, bans *!*@host, re-queries", async () => {
    socketMock.resolveUserhost.mockResolvedValue({ user: "ident", host: "evil.host.net" });
    setBanlistBundle("bahamut", BUNDLE);
    openBanlistModal("bahamut", "#bofh");
    render(() => <BanlistModal />);

    fireEvent.input(screen.getByTestId("banlist-add-input"), { target: { value: "alice" } });
    // default form is "host"
    fireEvent.click(screen.getByTestId("banlist-add-btn"));

    await waitFor(() => expect(socketMock.pushChannelBan).toHaveBeenCalled());
    expect(socketMock.resolveUserhost).toHaveBeenCalledWith(1, "alice");
    expect(socketMock.pushChannelBan).toHaveBeenCalledWith(1, "#bofh", "*!*@evil.host.net");
    // re-query after a successful add
    expect(socketMock.pushChannelBanlist).toHaveBeenCalledWith(1, "#bofh");
  });

  it("add-by-nick host form with unknown host → fail-closed error, NO ban", async () => {
    socketMock.resolveUserhost.mockResolvedValue(null); // cache miss
    openBanlistModal("bahamut", "#bofh");
    render(() => <BanlistModal />);

    fireEvent.input(screen.getByTestId("banlist-add-input"), { target: { value: "ghost" } });
    fireEvent.click(screen.getByTestId("banlist-add-btn"));

    const err = await screen.findByTestId("banlist-modal-error");
    expect(err.textContent).toMatch(/host unknown/i);
    expect(err.textContent).toMatch(/whois/i);
    expect(socketMock.pushChannelBan).not.toHaveBeenCalled();
  });

  it("explicit mask input passes verbatim (no userhost lookup)", async () => {
    openBanlistModal("bahamut", "#bofh");
    render(() => <BanlistModal />);

    fireEvent.input(screen.getByTestId("banlist-add-input"), {
      target: { value: "*!*@typed.mask" },
    });
    fireEvent.click(screen.getByTestId("banlist-add-btn"));

    await waitFor(() => expect(socketMock.pushChannelBan).toHaveBeenCalled());
    expect(socketMock.resolveUserhost).not.toHaveBeenCalled();
    expect(socketMock.pushChannelBan).toHaveBeenCalledWith(1, "#bofh", "*!*@typed.mask");
  });

  it("remove button unbans the mask and re-queries", async () => {
    setBanlistBundle("bahamut", BUNDLE);
    openBanlistModal("bahamut", "#bofh");
    render(() => <BanlistModal />);

    const [firstRemove] = screen.getAllByTestId("banlist-remove-btn");
    if (!firstRemove) throw new Error("expected a remove button");
    fireEvent.click(firstRemove);

    await waitFor(() => expect(socketMock.pushChannelUnban).toHaveBeenCalled());
    expect(socketMock.pushChannelUnban).toHaveBeenCalledWith(1, "#bofh", "*!*@banned.host");
    expect(socketMock.pushChannelBanlist).toHaveBeenCalledWith(1, "#bofh");
  });

  it("op-gate is a HINT: non-op sees the note but the Add button stays clickable", async () => {
    editPermMock.canEdit = false;
    socketMock.resolveUserhost.mockResolvedValue({ user: "ident", host: "evil.host.net" });
    openBanlistModal("bahamut", "#bofh");
    render(() => <BanlistModal />);

    // the hint is shown
    expect(screen.getByTestId("banlist-modal").textContent).toMatch(/not opped/i);
    // …but the mutating action is NOT disabled and still fires (server decides via 482)
    const addBtn = screen.getByTestId("banlist-add-btn") as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
    fireEvent.input(screen.getByTestId("banlist-add-input"), { target: { value: "alice" } });
    fireEvent.click(addBtn);
    await waitFor(() => expect(socketMock.pushChannelBan).toHaveBeenCalled());
  });

  it("guards a stale prior-channel bundle (shows Loading until the right one arrives)", () => {
    // bundle is for #bofh; modal opened for #other → don't render #bofh's bans.
    setBanlistBundle("bahamut", BUNDLE);
    openBanlistModal("bahamut", "#other");
    render(() => <BanlistModal />);
    const modal = screen.getByTestId("banlist-modal");
    expect(modal.textContent).not.toContain("*!*@banned.host");
    expect(modal.textContent).toContain("Loading");
  });
});
