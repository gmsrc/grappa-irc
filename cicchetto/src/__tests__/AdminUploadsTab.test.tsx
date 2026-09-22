import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUpload, AdminUploadsResponse } from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListUploads: vi.fn(),
    adminDeleteUpload: vi.fn(),
  };
});

import AdminUploadsTab, { budgetLabel, uploadIsLive } from "../AdminUploadsTab";

// issue 2288 — the admin uploads tab. `GET /admin/uploads` ships the whole
// registry INCLUDING soft-deleted rows (the operator's audit trail), so the
// tab has to render two row classes from one list: a LIVE row, which carries
// the destructive verb, and a MODERATED one, which must NOT — a second DELETE
// on an already-soft-deleted row answers 204 while doing nothing at all (the
// server's `get_by_id/1` does not filter deleted rows and `soft_delete/2`
// short-circuits), so the button would report success for work that cannot
// happen.

const upload = (over: Partial<AdminUpload> & { id: string }): AdminUpload => ({
  slug: "abcdefghijklmnopqrstuvwxyz",
  mime: "image/png",
  bytes: 2048,
  original_filename: "shot.png",
  subject_kind: "user",
  subject_id: "0f2a7c1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  expires_at: "2026-09-30T12:00:00Z",
  deleted_at: null,
  inserted_at: "2026-09-22T12:00:00Z",
  ...over,
});

const response = (
  uploads: AdminUpload[],
  live_bytes_sum = 2048,
  global_cap_bytes = 1024 * 1024,
): AdminUploadsResponse => ({ uploads, live_bytes_sum, global_cap_bytes });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("uploadIsLive — the soft-delete marker is the only liveness fact", () => {
  it("is true while deleted_at is null", () => {
    expect(uploadIsLive(upload({ id: "a", deleted_at: null }))).toBe(true);
  });

  it("is false once the row carries a deleted_at", () => {
    expect(uploadIsLive(upload({ id: "a", deleted_at: "2026-09-22T13:00:00Z" }))).toBe(false);
  });

  // An EXPIRED row is still live: the reaper, not the clock, is what unlinks
  // the file, and until it runs the bytes are still served and still count
  // against the cap. Deriving "gone" from `expires_at` here would hide the
  // one row an operator most wants to reach before the sweep does.
  it("stays true for a row whose expiry is in the past but which is not swept yet", () => {
    expect(uploadIsLive(upload({ id: "a", expires_at: "2000-01-01T00:00:00Z" }))).toBe(true);
  });
});

describe("budgetLabel — the disk budget, and what it says when there is no cap", () => {
  it("spells used and cap in the same human units, with the share of the cap", () => {
    expect(budgetLabel(512 * 1024, 1024 * 1024)).toBe("512 KB of 1 MB (50%)");
  });

  // A zero/absent cap cannot produce a percentage, and `x/0` renders as
  // "Infinity%" if nobody says so. Drop the share rather than print a number
  // that is not one.
  it("omits the share when the cap is not a positive number", () => {
    expect(budgetLabel(2048, 0)).toBe("2 KB of 0 bytes");
  });
});

describe("AdminUploadsTab — the list", () => {
  it("renders one row per upload, naming the file and the slug an operator reads off a link", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListUploads).mockResolvedValue(
      response([
        upload({ id: "u1", original_filename: "vacanza.png", slug: "aaaabbbbccccddddeeeeffffgg" }),
      ]),
    );

    render(() => <AdminUploadsTab />);

    const row = await screen.findByTestId("admin-upload-row-u1");
    expect(row).toHaveTextContent("vacanza.png");
    expect(row).toHaveTextContent("aaaabbbbccccddddeeeeffffgg");
  });

  it("shows the disk budget the server reports", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListUploads).mockResolvedValue(
      response([upload({ id: "u1" })], 512 * 1024, 1024 * 1024),
    );

    render(() => <AdminUploadsTab />);

    const budget = await screen.findByTestId("admin-uploads-budget");
    expect(budget).toHaveTextContent("512 KB of 1 MB (50%)");
  });

  it("says the registry is empty rather than rendering a headed table with no rows", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListUploads).mockResolvedValue(response([], 0, 1024 * 1024));

    render(() => <AdminUploadsTab />);

    expect(await screen.findByTestId("admin-uploads-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-uploads-table")).toBeNull();
  });

  it("surfaces a failed fetch instead of an empty list", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListUploads).mockRejectedValue(new Error("boom"));

    render(() => <AdminUploadsTab />);

    expect(await screen.findByTestId("admin-uploads-error")).toBeInTheDocument();
  });
});

describe("AdminUploadsTab — the destructive verb rides the LIVE rows only", () => {
  it("offers Delete on a live row", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListUploads).mockResolvedValue(response([upload({ id: "u1" })]));

    render(() => <AdminUploadsTab />);

    expect(await screen.findByTestId("admin-upload-delete-u1")).toBeInTheDocument();
  });

  it("keeps a soft-deleted row visible as the audit trail, with NO delete button", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListUploads).mockResolvedValue(
      response([upload({ id: "u2", deleted_at: "2026-09-22T13:00:00Z" })]),
    );

    render(() => <AdminUploadsTab />);

    const row = await screen.findByTestId("admin-upload-row-u2");
    expect(row).toBeInTheDocument();
    expect(screen.queryByTestId("admin-upload-delete-u2")).toBeNull();
    expect(row).toHaveTextContent(/deleted/i);
  });

  it("arms, then deletes by row id and re-reads the server's projection", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListUploads).mockResolvedValue(response([upload({ id: "u1" })]));
    vi.mocked(api.adminDeleteUpload).mockResolvedValue(undefined);

    render(() => <AdminUploadsTab />);

    const btn = await screen.findByTestId("admin-upload-delete-u1");
    expect(btn).toHaveTextContent(/^delete$/i);

    // Two-step: the first click only arms it. A single-click destructive verb
    // in a table of look-alike rows is the footgun InlineConfirmButton exists
    // to close, so assert the arming step did NOT call the API.
    fireEvent.click(btn);
    expect(btn).toHaveTextContent(/^confirm delete$/i);
    expect(api.adminDeleteUpload).not.toHaveBeenCalled();

    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.adminDeleteUpload).toHaveBeenCalledWith("test-bearer", "u1");
    });
    // The post-mutation list comes from the server, never from a local splice:
    // the row's new state (soft-deleted, still listed) is the server's to say.
    await waitFor(() => {
      expect(vi.mocked(api.adminListUploads).mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("reports a failed delete instead of leaving the row looking gone", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListUploads).mockResolvedValue(response([upload({ id: "u1" })]));
    vi.mocked(api.adminDeleteUpload).mockRejectedValue(new Error("boom"));

    render(() => <AdminUploadsTab />);

    const btn = await screen.findByTestId("admin-upload-delete-u1");
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(await screen.findByTestId("admin-uploads-error")).toBeInTheDocument();
  });
});
