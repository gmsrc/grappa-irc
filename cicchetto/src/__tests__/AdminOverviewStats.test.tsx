import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import AdminOverviewStats from "../AdminOverviewStats";

// #1073 — the admin bar's left group. Pure presentation: it is handed the
// numbers and decides how they read. Two of its rules are correctness, not
// taste, and both come from what #1075 measured on the server side:
//
//   1. the loadavg is the HOST's, because a jail shares the host kernel
//      (`sysctl vm.loadavg` reads identically inside and out) — an unlabelled
//      number is read as "grappa is busy", which is a different claim;
//   2. an unavailable sampler arrives as `null`, and `null` is NOT zero. The
//      server refuses to fabricate a 0.0 for "cannot measure"; the bar must
//      not undo that by rendering the two the same.

const full = () => ({
  sessions: 3,
  visitors: { total: 5, live: 2 },
  hostname: "m42",
  loadavg: 0.42,
  version: "0.15.0",
});

describe("AdminOverviewStats", () => {
  it("renders every stat the bar carries", () => {
    const { container } = render(() => <AdminOverviewStats overview={full()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("3");
    expect(text).toContain("m42");
    expect(text).toContain("0.15.0");
  });

  it("shows visitors as live-over-total, not one number", () => {
    // The DB/live pair is the whole point of the server sending two numbers:
    // "2 of 5 visitors are connected" is a diagnostic, "5 visitors" is not.
    const { getByTestId } = render(() => <AdminOverviewStats overview={full()} />);
    expect(getByTestId("admin-overview-visitors").textContent).toContain("2/5");
  });

  describe("the loadavg is the HOST's", () => {
    it("labels it as the host's, never as a bare load", () => {
      const { getByTestId } = render(() => <AdminOverviewStats overview={full()} />);
      const el = getByTestId("admin-overview-loadavg");
      // Either the visible text or the accessible description must say whose
      // load this is; a bare "0.42" is the reading we are preventing.
      const described = `${el.textContent ?? ""} ${el.getAttribute("title") ?? ""}`;
      expect(described.toLowerCase()).toContain("host");
    });

    it("still shows the number", () => {
      const { getByTestId } = render(() => <AdminOverviewStats overview={full()} />);
      expect(getByTestId("admin-overview-loadavg").textContent).toContain("0.42");
    });
  });

  describe("an unavailable sampler is not a calm machine", () => {
    it("renders null distinctly from zero", () => {
      const { getByTestId: getUnknown } = render(() => (
        <AdminOverviewStats overview={{ ...full(), loadavg: null }} />
      ));
      const { getByTestId: getZero } = render(() => (
        <AdminOverviewStats overview={{ ...full(), loadavg: 0 }} />
      ));

      const unknown = getUnknown("admin-overview-loadavg").textContent ?? "";
      const zero = getZero("admin-overview-loadavg").textContent ?? "";

      expect(unknown).not.toBe(zero);
    });

    it("a null loadavg shows no digit at all", () => {
      // The failure mode this guards is rendering `null` through a formatter
      // that coerces it — `Number(null)` is 0, and `(null).toFixed` throwing
      // would at least be loud. A quiet "0.00" would tell the operator the box
      // is idle when the truth is that we cannot see it.
      const { getByTestId } = render(() => (
        <AdminOverviewStats overview={{ ...full(), loadavg: null }} />
      ));
      expect(getByTestId("admin-overview-loadavg").textContent ?? "").not.toMatch(/\d/);
    });

    it("says WHY it is blank, not just that it is", () => {
      const { getByTestId } = render(() => (
        <AdminOverviewStats overview={{ ...full(), loadavg: null }} />
      ));
      const title = getByTestId("admin-overview-loadavg").getAttribute("title") ?? "";
      expect(title.toLowerCase()).toContain("unavailable");
    });

    it("a measured zero is shown as a number, not as unknown", () => {
      const { getByTestId } = render(() => (
        <AdminOverviewStats overview={{ ...full(), loadavg: 0 }} />
      ));
      expect(getByTestId("admin-overview-loadavg").textContent ?? "").toMatch(/0/);
    });
  });

  it("renders nothing at all before the first push has landed", () => {
    // The bar mounts with the console; the join push follows. Rendering
    // placeholder zeroes in that window would be the same lie as coercing a
    // null loadavg — briefly, but on every open.
    const { container } = render(() => <AdminOverviewStats overview={null} />);
    expect(container.querySelector(".admin-overview-stats")).toBeNull();
  });
});
