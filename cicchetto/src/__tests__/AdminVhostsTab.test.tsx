import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminVhost, AdminVhostGrant, AdminVhostsResponse } from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListVhosts: vi.fn(),
    adminCreateVhost: vi.fn(),
    adminDeleteVhost: vi.fn(),
    adminGrantVhost: vi.fn(),
    adminPatchVhost: vi.fn(),
    adminRevokeVhostGrant: vi.fn(),
  };
});

import AdminVhostsTab, {
  effectiveGenerallyAvailable,
  generallyAvailableLocked,
} from "../AdminVhostsTab";

// #256 — in_pool ⟹ generally available. The server ORs the two at the
// availability read boundary (Grappa.Vhosts.allowed_vhosts/1); this tab
// MIRRORS that invariant in the UI: ticking in_pool shows
// generally_available checked + disabled (you can't set an in-pool vhost
// as not-generally-available). Display-only enforce-forward — the server
// read-side OR is the authority; cic never originates state, never stores
// the derived value.

const vhost = (over: Partial<AdminVhost> & { id: number }): AdminVhost => ({
  address: `2001:db8::${over.id}`,
  in_pool: false,
  generally_available: false,
  inserted_at: "2026-07-15T00:00:00Z",
  updated_at: "2026-07-15T00:00:00Z",
  ...over,
});

const response = (vhosts: AdminVhost[], grants: AdminVhostGrant[] = []): AdminVhostsResponse => ({
  vhosts,
  grants,
  host_candidates: [],
});

const GRANT_UUID = "0f2a7c1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

const grant = (over: Partial<AdminVhostGrant>): AdminVhostGrant => ({
  id: 1,
  vhost_id: 1,
  subject_type: "user",
  subject_id: GRANT_UUID,
  subject_label: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("effectiveGenerallyAvailable — in_pool ⟹ generally available (#256)", () => {
  it("is true when in_pool is on, regardless of the stored flag", () => {
    expect(effectiveGenerallyAvailable(true, false)).toBe(true);
    expect(effectiveGenerallyAvailable(true, true)).toBe(true);
  });

  it("passes the stored flag through when in_pool is off", () => {
    expect(effectiveGenerallyAvailable(false, false)).toBe(false);
    expect(effectiveGenerallyAvailable(false, true)).toBe(true);
  });
});

describe("generallyAvailableLocked — in_pool disables the control (#256)", () => {
  it("locks when in_pool is on", () => {
    expect(generallyAvailableLocked(true)).toBe(true);
  });

  it("unlocks when in_pool is off", () => {
    expect(generallyAvailableLocked(false)).toBe(false);
  });
});

describe("AdminVhostsTab — in_pool auto-sets + disables generally_available (#256)", () => {
  it("an in_pool row shows generally_available checked + disabled even when the stored flag is false", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVhosts).mockResolvedValue(
      response([vhost({ id: 1, in_pool: true, generally_available: false })]),
    );

    render(() => <AdminVhostsTab />);

    const ga = await screen.findByTestId("vhost-generally-available-toggle-1");
    expect(ga).toBeChecked();
    expect(ga).toBeDisabled();
  });

  it("a not-in_pool row leaves generally_available independently editable", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVhosts).mockResolvedValue(
      response([vhost({ id: 2, in_pool: false, generally_available: false })]),
    );

    render(() => <AdminVhostsTab />);

    const ga = await screen.findByTestId("vhost-generally-available-toggle-2");
    expect(ga).not.toBeChecked();
    expect(ga).toBeEnabled();
  });

  it("the create-form generally_available control locks + shows checked while in_pool is ticked, re-enables on untick", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVhosts).mockResolvedValue(response([]));

    render(() => <AdminVhostsTab />);
    await screen.findByTestId("admin-vhosts-create-form");

    const inPool = screen.getByTestId("vhost-create-in-pool");
    const ga = screen.getByTestId("vhost-create-generally-available");
    expect(ga).toBeEnabled();
    expect(ga).not.toBeChecked();

    fireEvent.click(inPool);
    expect(ga).toBeChecked();
    expect(ga).toBeDisabled();

    fireEvent.click(inPool);
    expect(ga).toBeEnabled();
    expect(ga).not.toBeChecked();
  });

  it("preserves a manually-set generally_available through an in_pool tick/untick (no reset-on-untick)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVhosts).mockResolvedValue(response([]));

    render(() => <AdminVhostsTab />);
    await screen.findByTestId("admin-vhosts-create-form");

    const inPool = screen.getByTestId("vhost-create-in-pool");
    const ga = screen.getByTestId("vhost-create-generally-available");

    // Operator explicitly ticks generally_available first.
    fireEvent.click(ga);
    expect(ga).toBeChecked();
    expect(ga).toBeEnabled();

    // Ticking in_pool locks it (still checked, now disabled) — display
    // derive, no write to the underlying signal.
    fireEvent.click(inPool);
    expect(ga).toBeChecked();
    expect(ga).toBeDisabled();

    // Un-ticking in_pool must re-reveal the HONEST manually-set value
    // (still checked), not reset it to false.
    fireEvent.click(inPool);
    expect(ga).toBeChecked();
    expect(ga).toBeEnabled();
  });
});

// #1140 — the grants table printed the bare subject UUID while the
// add-grant autocomplete searched BY NAME, so after the post-grant refresh
// the operator could not tell which of their users held the grant. The
// server now resolves the name (`subject_label`); the uuid stays the
// stable key and is demoted to the cell's `title`.
describe("grants table subject cell (#1140)", () => {
  it("renders the resolved subject label instead of the uuid", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVhosts).mockResolvedValue(
      response(
        [vhost({ id: 1 })],
        [grant({ id: 11, vhost_id: 1, subject_type: "user", subject_label: "vjt" })],
      ),
    );

    render(() => <AdminVhostsTab />);

    const cell = await screen.findByTestId("admin-vhost-grant-subject-11");
    expect(cell).toHaveTextContent("vjt");
    expect(cell).not.toHaveTextContent(GRANT_UUID);
  });

  it("keeps the uuid reachable as the cell title — it stays the stable key", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVhosts).mockResolvedValue(
      response(
        [vhost({ id: 1 })],
        [grant({ id: 12, vhost_id: 1, subject_type: "visitor", subject_label: "guest" })],
      ),
    );

    render(() => <AdminVhostsTab />);

    const cell = await screen.findByTestId("admin-vhost-grant-subject-12");
    expect(cell).toHaveAttribute("title", GRANT_UUID);
  });

  it("falls back to the uuid when the server could not resolve a name", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVhosts).mockResolvedValue(
      response([vhost({ id: 1 })], [grant({ id: 13, vhost_id: 1, subject_label: null })]),
    );

    render(() => <AdminVhostsTab />);

    // `subject_label: null` is the server's honesty signal (the subject row
    // is gone / holds no nick). Show the key we DO have rather than an
    // invented placeholder.
    const cell = await screen.findByTestId("admin-vhost-grant-subject-13");
    expect(cell).toHaveTextContent(GRANT_UUID);
  });
});
