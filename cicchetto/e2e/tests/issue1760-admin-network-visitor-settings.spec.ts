// #1760 — the admin networks pane can now reach `visitor_enabled`,
// `visitor_autoconnect` and `services_flavor`. Before this, a network
// created from the panel was born `visitor_enabled = false`
// (`network.ex` column default) and there was no control to flip it: on
// 2026-08-24 `rizon` was added from the panel and had to be finished
// with a hand-written UPDATE against `runtime/grappa_prod.db`.
//
// 🔴 What this spec asserts is the EFFECT, not the control. A checkbox
// that renders and PATCHes nothing passes a "the control exists" test,
// and a checkbox whose PATCH lands passes a "the input is checked"
// test — neither would have caught the bug this issue is about, which
// is that the network stays unreachable. So the oracle is the server's
// own visitor allowlist, read back through `GET /me`:
// `home_data.available_networks` is `Networks.list_visitor_enabled/0`
// minus the subject's attached networks (`networks.ex`), i.e. exactly
// the tier a network created from the panel could not enter. Absent
// before the click, present after it. That is the operator's actual
// complaint, expressed as a number the server produced.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// only the admin user class reaches the tab; gate spec at
// m7-admin-gate-settings-drawer.spec.ts.
//
// Per `feedback_cicchetto_browser_smoke`: chromium renders the
// disabled→enabled transition on the autoconnect box, which is a
// computed `disabled` attribute jsdom can assert but only a browser can
// prove is actually unclickable.
//
// The seeded networks (bahamut-test, azzurra, azzurra2, azzurra3) are
// LOAD-BEARING for other specs and several are already visitor_enabled —
// never toggle those. This spec creates its own slug and deletes it in
// `finally`, the admin-network-crud.spec.ts pattern. The runner is
// `workers: 1, fullyParallel: false`, so the window in which a
// visitor_enabled extra network exists is inside this test alone.

import { adminLogin, openAdminConsole } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

type AdminNetworkRow = {
  id: number;
  slug: string;
  visitor_enabled: boolean;
  visitor_autoconnect: boolean;
  services_flavor: string | null;
};

async function openNetworksTab(page: import("@playwright/test").Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-networks").click();
  await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });
}

// The server's own row, not the pane's echo of it. Used for the
// `services_flavor` + `visitor_autoconnect` half, where there is no
// downstream projection as direct as the visitor allowlist.
async function fetchNetworkRow(token: string, slug: string): Promise<AdminNetworkRow | undefined> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { networks: AdminNetworkRow[] };
  return body.networks.find((n) => n.slug === slug);
}

// The visitor allowlist as the SERVER computes it for this subject.
async function availableSlugs(token: string): Promise<string[]> {
  const res = await fetch(`${GRAPPA_BASE_URL}/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as {
    home_data: { available_networks: Array<{ slug: string }> };
  };
  return body.home_data.available_networks.map((n) => n.slug);
}

async function createNetwork(token: string, slug: string): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { id: number }).id;
}

async function deleteNetworkBestEffort(token: string, id: number | null): Promise<void> {
  if (id === null) return;
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/networks/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
}

test("#1760 flipping visitors-allowed from the pane puts the network in the visitor allowlist", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const slug = `e2enet-vis-${Date.now()}`;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);

    // The bug, stated as a measurement: a network born from the panel is
    // NOT in the allowlist. If this ever starts out true, the default
    // moved and the rest of the spec proves nothing.
    expect(
      await availableSlugs(admin.token),
      "a freshly created network must start OUTSIDE the visitor allowlist",
    ).not.toContain(slug);

    await adminLogin(page, admin);
    await openNetworksTab(page);

    const enabled = page.getByTestId(`admin-network-visitor-enabled-${slug}`);
    const save = page.getByTestId(`admin-network-save-${slug}`);
    await expect(enabled).not.toBeChecked();
    await expect(save).toBeDisabled();

    await enabled.check();
    await expect(save).toBeEnabled();
    await save.click();

    // The pane agrees with itself: post-Save the row re-fetches and the
    // box is no longer dirty. Necessary, nowhere near sufficient.
    await expect(enabled).toBeChecked();
    await expect(save).toBeDisabled();
    await expect(page.getByTestId("admin-networks-error")).toHaveCount(0);

    // The oracle. The server now offers this network to the subject.
    await expect
      .poll(async () => await availableSlugs(admin.token), { timeout: 10_000 })
      .toContain(slug);
  } finally {
    await deleteNetworkBestEffort(admin.token, networkId);
  }
});

test("#1760 autoconnect unlocks with visitor access and is revoked together with it", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const slug = `e2enet-auto-${Date.now()}`;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);

    await adminLogin(page, admin);
    await openNetworksTab(page);

    const enabled = page.getByTestId(`admin-network-visitor-enabled-${slug}`);
    const auto = page.getByTestId(`admin-network-visitor-autoconnect-${slug}`);
    const save = page.getByTestId(`admin-network-save-${slug}`);

    // Locked while the network accepts no visitors — the server would
    // take the flag and the login filter would silently drop it
    // (`Networks.list_visitor_autoconnect/0`'s callers AND the pair), so the only
    // place the operator can be told is here.
    await expect(auto).toBeDisabled();

    await enabled.check();
    await expect(auto).toBeEnabled();
    await auto.check();
    await save.click();
    await expect(save).toBeDisabled();

    // Both landed, in one PATCH.
    const armed = await fetchNetworkRow(admin.token, slug);
    expect(armed?.visitor_enabled).toBe(true);
    expect(armed?.visitor_autoconnect).toBe(true);

    // Revoking visitor access must take autoconnect with it. Leaving
    // `visitor_autoconnect = true` on a network visitors cannot reach is
    // the stranded pair — no error, no effect, and invisible until
    // somebody re-enables the network months later and gets an
    // auto-connect nobody asked for.
    await enabled.uncheck();
    await expect(auto).not.toBeChecked();
    await expect(auto).toBeDisabled();
    await save.click();
    await expect(save).toBeDisabled();

    const revoked = await fetchNetworkRow(admin.token, slug);
    expect(revoked?.visitor_enabled).toBe(false);
    expect(
      revoked?.visitor_autoconnect,
      "revoking visitor access must clear autoconnect in the same write",
    ).toBe(false);
    await expect(page.getByTestId("admin-networks-error")).toHaveCount(0);
  } finally {
    await deleteNetworkBestEffort(admin.token, networkId);
  }
});

test("#1760 services flavor round-trips through the server, blank included", async ({ page }) => {
  const admin = getSeededAdmin();
  const slug = `e2enet-flavor-${Date.now()}`;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);
    expect((await fetchNetworkRow(admin.token, slug))?.services_flavor).toBeNull();

    await adminLogin(page, admin);
    await openNetworksTab(page);

    const flavor = page.getByTestId(`admin-network-services-flavor-${slug}`);
    const save = page.getByTestId(`admin-network-save-${slug}`);
    await expect(flavor).toHaveValue("");

    await flavor.selectOption("atheme");
    await save.click();
    await expect(save).toBeDisabled();
    expect((await fetchNetworkRow(admin.token, slug))?.services_flavor).toBe("atheme");

    // Back to unclassified. The blank option is `null` on the wire, not
    // an omitted key — omitting it would make a wrong flavor permanent,
    // since unsupplied keys keep their current value.
    await flavor.selectOption("");
    await save.click();
    await expect(save).toBeDisabled();
    expect(
      (await fetchNetworkRow(admin.token, slug))?.services_flavor,
      "the blank option must CLEAR the flavor, not leave the previous one",
    ).toBeNull();
    await expect(page.getByTestId("admin-networks-error")).toHaveCount(0);
  } finally {
    await deleteNetworkBestEffort(admin.token, networkId);
  }
});
