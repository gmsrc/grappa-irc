import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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
// the reactive stores it reads (networks / identity / scrollback), the
// overlay lock, and MircBody (the NOTICE renderer). registrationTemplates
// and the registrationWizard store stay REAL — the send body + step machine
// are exactly what we're guarding.

const sendBodyLinesMock = vi.fn<
  (slug: string, target: string, body: string, notice: boolean) => Promise<void>
>(() => Promise.resolve());
// Reactive on purpose: the step-6 terminator is a `createMemo`, so a plain
// `mockReturnValue` would change the answer without ever waking the memo and
// the guard below could not distinguish "reads the wrong source" from "is not
// reactive at all".
const [identifiedSignal, setIdentifiedSignal] = createSignal(false);
const identifiedForNetworkMock = vi.fn<(id: number) => boolean>(() => identifiedSignal());

vi.mock("../lib/sendPipeline", () => ({
  sendBodyLines: (slug: string, target: string, body: string, notice: boolean) =>
    sendBodyLinesMock(slug, target, body, notice),
}));

// networkBySlug feeds both flavorForSlug (real registrationTemplates) and
// the modal's ownNick; networkIdBySlug feeds the identity lookup.
vi.mock("../lib/networks", () => ({
  networkBySlug: (slug: string) => ({ slug, nick: "wiz-reg-nick", services_flavor: "azzurra" }),
  networkIdBySlug: () => 7,
}));

// #388 — the step-6 terminator reads the server's NORMALIZED identity
// verdict. This mock used to stand in for `umodesForNetwork`, the
// bahamut-only `+r` spelling #388 exists to abolish: pinning the test to
// that module is what let the modal keep reading a mode letter while the
// rest of the migration moved on, with the whole unit suite green.
vi.mock("../lib/identity", () => ({
  identifiedForNetwork: (id: number) => identifiedForNetworkMock(id),
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
    setIdentifiedSignal(false);
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

  // #388 — step 6 completes on the server's normalized identity VERDICT,
  // with no umode anywhere in the stimulus.
  //
  // This is the arm that was missing, and its absence is why the migration
  // shipped half-done: the suite drove the wizard to step 5 and stopped, so
  // the terminator had no coverage at all while a mock of `umodesForNetwork`
  // sat in the file looking like it did.
  //
  // Flavour-agnosticism is the whole point of #388. On atheme there is no
  // registered umode to emit, so a terminator spelled `+r` can never fire
  // there — and this test cannot pass unless the modal reads the verdict.
  it("completes step 6 on the identity verdict alone (no umode in the stimulus)", async () => {
    render(() => <RegistrationWizardModal />);
    openRegistrationWizard("azzurra-reg");

    const dialog = await screen.findByTestId("registration-wizard");
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    fireEvent.input(screen.getByTestId("registration-wizard-email"), {
      target: { value: REG_EMAIL },
    });
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    fireEvent.input(screen.getByTestId("registration-wizard-password"), {
      target: { value: REG_PASSWORD },
    });
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    await waitFor(() => expect(dialog).toHaveAttribute("data-step", "4"));
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    await waitFor(() => expect(dialog).toHaveAttribute("data-step", "5"));
    fireEvent.input(screen.getByTestId("registration-wizard-code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByTestId("registration-wizard-next"));
    await waitFor(() => expect(dialog).toHaveAttribute("data-step", "6"));

    // Pre-state: the celebration is NOT already on screen, so the assertion
    // below witnesses the flip rather than a banner that was always there.
    expect(screen.queryByTestId("registration-wizard-success")).toBeNull();

    setIdentifiedSignal(true);

    await waitFor(() => expect(screen.queryByTestId("registration-wizard-success")).not.toBeNull());
  });
});
