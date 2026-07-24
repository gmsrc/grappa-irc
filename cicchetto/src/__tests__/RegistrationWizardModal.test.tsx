import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #349 — RegistrationWizardModal reactive regression guard.
//
// The send-steps (4 REGISTER / 6 verify) auto-fire their services command
// ONCE on step entry via `createEffect(on(step, …))`. The trap: Solid's
// `on` does NOT value-dedupe — it re-invokes its callback on EVERY change
// to a tracked signal — and reading `st().step` tracks the WHOLE wizard
// state. `runSendStep` patches that state (pending / stepSince / error), so
// without a memoized step the effect re-fires runSendStep on its own
// patches: a runaway loop that floods NickServ with hundreds of identical
// REGISTER commands and wedges the step transition. This test drives the
// real store + modal to step 4 and asserts EXACTLY ONE send — it hangs /
// over-counts if the loop ever comes back.
//
// Boundaries mocked: the wire send (`sendBodyLines` — the spy under test),
// the reactive stores it reads (networks / umodes / scrollback), the
// overlay lock, and MircBody (the NOTICE renderer). registrationTemplates
// and the registrationWizard store stay REAL — the send body + step machine
// are exactly what we're guarding.

const sendBodyLinesMock = vi.fn<
  (slug: string, target: string, body: string, notice: boolean) => Promise<void>
>(() => Promise.resolve());
const umodesForNetworkMock = vi.fn<(id: number) => string[]>(() => []);

vi.mock("../lib/compose", () => ({
  sendBodyLines: (slug: string, target: string, body: string, notice: boolean) =>
    sendBodyLinesMock(slug, target, body, notice),
}));

// networkBySlug feeds both flavorForSlug (real registrationTemplates) and
// the modal's ownNick; networkIdBySlug feeds the +r umode lookup.
vi.mock("../lib/networks", () => ({
  networkBySlug: (slug: string) => ({ slug, nick: "wiz-reg-nick", services_flavor: "azzurra" }),
  networkIdBySlug: () => 7,
}));

vi.mock("../lib/umodes", () => ({
  umodesForNetwork: (id: number) => umodesForNetworkMock(id),
}));

// Empty $server scrollback — the NOTICE mirror stays in its waiting state
// and setStepSince high-waters to 0. (Real scrollback store not needed.)
vi.mock("../lib/scrollback", () => ({
  scrollbackByChannel: () => ({}),
}));

vi.mock("../lib/overlayScrollLock", () => ({
  createOverlayLock: () => {},
}));

vi.mock("../MircText", () => ({
  MircBody: () => null,
}));

import { closeRegistrationWizard, openRegistrationWizard } from "../lib/registrationWizard";
import RegistrationWizardModal from "../RegistrationWizardModal";

const REG_EMAIL = "wiz-test@example.com";
const REG_PASSWORD = "wizregpw1";

describe("RegistrationWizardModal", () => {
  beforeEach(() => {
    sendBodyLinesMock.mockClear();
    umodesForNetworkMock.mockReturnValue([]);
  });

  afterEach(() => {
    closeRegistrationWizard();
  });

  it("auto-sends the REGISTER command exactly once on step 4 (no reactive re-fire loop)", async () => {
    render(() => <RegistrationWizardModal />);
    openRegistrationWizard("azzurra-reg");

    const dialog = await screen.findByTestId("registration-wizard");
    expect(dialog).toHaveAttribute("data-step", "1");

    // 1 → 2 (email).
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    fireEvent.input(screen.getByTestId("registration-wizard-email"), {
      target: { value: REG_EMAIL },
    });
    // 2 → 3 (password).
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    fireEvent.input(screen.getByTestId("registration-wizard-password"), {
      target: { value: REG_PASSWORD },
    });
    // 3 → 4 — REGISTER auto-sends on entry.
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    await waitFor(() => expect(dialog).toHaveAttribute("data-step", "4"));

    // The regression: ONE send, with the source-verified body — not the
    // hundreds a self-feeding effect produced.
    expect(sendBodyLinesMock).toHaveBeenCalledTimes(1);
    expect(sendBodyLinesMock).toHaveBeenCalledWith(
      "azzurra-reg",
      "NickServ",
      `REGISTER ${REG_PASSWORD} ${REG_EMAIL}`,
      false,
    );

    // …and the loop no longer starves the user-advance: 4 → 5 works, and
    // step 5 (not a send-step) fires nothing further.
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    await waitFor(() => expect(dialog).toHaveAttribute("data-step", "5"));
    expect(sendBodyLinesMock).toHaveBeenCalledTimes(1);
  });
});
