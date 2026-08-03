import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ruleBody } from "./helpers/themeCss";

// #734 — the TOTP enrolment QR rendered into a class with NO rule behind it.
//
// Two guard flavours here, deliberately:
//   * A SOURCE-LEVEL CSS guard. jsdom applies no stylesheet, so the QR's real
//     appearance is NOT observable in this suite — only the presence of the
//     rule that sizes and lightens it. Scannability still needs a real camera.
//   * A DOM guard for what jsdom CAN see: which class the container asks for.

const api = vi.hoisted(() => ({
  getPasskeyStatus: vi.fn(),
  getTotpStatus: vi.fn(),
  startTotpEnrollment: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  confirmTotpEnrollment: vi.fn(),
  deletePasskey: vi.fn(),
  disableTotp: vi.fn(),
  finishPasskeyModeChange: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  getPasskeyStatus: api.getPasskeyStatus,
  getTotpStatus: api.getTotpStatus,
  preparePasswordless: vi.fn(),
  startPasskeyModeChange: vi.fn(),
  startPasskeyRegistration: vi.fn(),
  startPasswordlessActivation: vi.fn(),
  startTotpEnrollment: api.startTotpEnrollment,
}));

vi.mock("../lib/auth", () => ({ token: () => "test-token" }));

vi.mock("../lib/passkeys", () => ({
  createPasskey: vi.fn(),
  getPasskey: vi.fn(),
}));

import TotpSettings from "../TotpSettings";

describe("#734 TOTP enrolment QR sits in a sized, light-framed box", () => {
  it("the QR frame rule supplies a fixed box and a white background", () => {
    // The #734 defect exactly: `.share-qr` was a data-testid, not a class,
    // so the container had no rule — ruleBody throws when the rule is gone.
    const body = ruleBody(".qr-frame");
    expect(body).toMatch(/width:\s*12rem/);
    expect(body).toMatch(/height:\s*12rem/);
    expect(body).toMatch(/background:\s*#fff/);
  });

  it("the QR frame sizes the injected svg to fill it", () => {
    // lib/qr.ts emits a viewBox-scaled svg with no intrinsic px size, so
    // without this rule the code renders at the UA's replaced-element default.
    const body = ruleBody(".qr-frame svg");
    expect(body).toMatch(/width:\s*100%/);
    expect(body).toMatch(/height:\s*100%/);
  });

  it("the enrolment QR container asks for the sized frame class", async () => {
    api.getTotpStatus.mockResolvedValue({ enabled: false });
    api.getPasskeyStatus.mockResolvedValue({ mode: "disabled", passkeys: [] });
    api.startTotpEnrollment.mockResolvedValue({
      enrollment_token: "enrol-token",
      provisioning_uri: "otpauth://totp/grappa:vjt?secret=ABCD",
      secret: "ABCD",
    });

    render(() => <TotpSettings onBack={() => {}} />);
    await fireEvent.click(await screen.findByRole("button", { name: "enable TOTP" }));

    const form = await screen.findByTestId("totp-enrollment-form");
    expect(form.querySelector(".qr-frame")).not.toBeNull();
  });
});
