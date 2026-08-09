import type {
  AdminCredential,
  AdminNetwork,
  AdminSession,
  AdminVisitor,
  AdminVisitorNetwork,
} from "./api";

// #1157 — the row set behind the unified admin sessions view.
//
// The view lists ACTIVE AND INACTIVE sessions, which forces the grain:
// it is ROW-backed, with live process state joined on top, never the
// other way round. `GET /admin/sessions` is registry-driven — every row
// it returns IS a live pid — so building the list from it would drop
// parked, failed and expired-but-unreaped subjects out of the admin
// console entirely, which is exactly the population an operator opens
// this pane to look at.
//
// So the rows come from the two row-backed endpoints, which between
// them cover every credential in the database and are disjoint by
// construction (`/admin/credentials` filters `user_id IS NOT NULL`;
// `/admin/visitors` walks the visitor rows):
//
//   * `/admin/visitors`    — one row per (visitor, network), flattened
//                            out of the identity-wide `networks[]`
//   * `/admin/credentials` — one row per (user, network) already
//
// `/admin/sessions` is then LEFT-JOINED on, for the two things only it
// knows: the upstream peer triple, and the pid of a session whose DB row
// is gone. Its unmatched entries are appended rather than dropped —
// that is the orphan-pid class (`subject_label: null`), a real
// divergence the operator must be able to see.
//
// The join key is the composite `<kind>:<subject_id>:<network_id>` the
// `/admin/sessions/:id/*` verbs already parse, so the row that renders a
// button is keyed by the very string that button will POST.

/** The live-state core the three endpoints agree on. `/admin/sessions`
 * carries a superset (the peer triple); the row-backed pair do not. */
export type CoreLiveState = NonNullable<AdminVisitorNetwork["live_state"]>;

/** Visitor-only identity facts. Identity-wide, so every row flattened
 * out of the same visitor repeats them — and `DELETE /admin/visitors/:id`
 * acts on ALL of them at once, which is why the row carries the flag. */
export type VisitorIdentity = {
  visitor_id: string;
  expires_at: string | null;
  inserted_at: string;
  ip: string | null;
  identified: boolean;
};

export type AdminSubjectRow = {
  /** `<kind>:<subject_id>:<network_id>` — the id the admin verbs parse. */
  key: string;
  subject_kind: "user" | "visitor";
  subject_id: string;
  /** Display name: the configured nick, or the user's account name.
   * `null` only on an orphan-pid row whose DB row is gone. */
  label: string | null;
  network_id: number;
  /** `null` when the FK resolves to no known network (deleted-network
   * race). Never blanked silently — the caller renders the raw id. */
  network_slug: string | null;
  /** DB intent. `null` on an orphan-pid row: there is no credential to
   * have an intent. Distinct from `live` per the two-sources rule. */
  connection_state: AdminCredential["connection_state"] | null;
  /** Live BEAM state, `null` = the U-0 honesty signal (DB row exists,
   * no pid). */
  live: CoreLiveState | null;
  /** The upstream peer, known ONLY for rows with a registry entry. */
  upstream: AdminSession["live_state"] | null;
  last_seen_at: string | null;
  /** Present iff `subject_kind === "visitor"`. */
  visitor: VisitorIdentity | null;
};

export function rowKey(kind: "user" | "visitor", subjectId: string, networkId: number): string {
  return `${kind}:${subjectId}:${networkId}`;
}

/** Channel count for the dictated column. `null` (introspection timed
 * out, or no pid) is NOT zero and must not render as zero. */
export function channelCount(row: AdminSubjectRow): number | null {
  return row.live?.joined_channels?.length ?? null;
}

/**
 * Which verbs a row may offer.
 *
 * Reconnect is visitor-only, and deliberately so on the server:
 * `ensure_visitor_subject/1` answers 400 for a user subject, because a
 * user parks and reconnects their OWN sessions through
 * `PATCH /networks/:id`. Offering the button on a user row would render
 * a guaranteed 400.
 *
 * Which of Disconnect / Reconnect a visitor row shows is chosen on LIVE
 * truth, never on `connection_state`: a credential still marked
 * `:connected` whose pid died must offer Reconnect, and that divergence
 * is the whole reason both columns exist.
 */
export function rowActions(row: AdminSubjectRow): ("disconnect" | "reconnect" | "terminate")[] {
  if (row.subject_kind === "visitor") {
    return row.live === null ? ["reconnect"] : ["disconnect"];
  }
  return ["disconnect", "terminate"];
}

function slugOf(networks: AdminNetwork[], networkId: number): string | null {
  return networks.find((n) => n.id === networkId)?.slug ?? null;
}

/**
 * Build the unified row set.
 *
 * Ordering is stable and meaningful rather than incidental: visitors,
 * then users, then the orphan-pid rows last — the operator scans the
 * populations they came for, and anything that should not exist sits at
 * the bottom where it stands out.
 */
export function buildSubjectRows(input: {
  visitors: AdminVisitor[];
  credentials: AdminCredential[];
  sessions: AdminSession[];
  networks: AdminNetwork[];
}): AdminSubjectRow[] {
  const { visitors, credentials, sessions, networks } = input;

  const sessionByKey = new Map<string, AdminSession>();
  for (const s of sessions) {
    sessionByKey.set(rowKey(s.subject_kind, s.subject_id, s.network_id), s);
  }

  const rows: AdminSubjectRow[] = [];
  const claimed = new Set<string>();

  for (const v of visitors) {
    const identity: VisitorIdentity = {
      visitor_id: v.id,
      expires_at: v.expires_at,
      inserted_at: v.inserted_at,
      ip: v.ip,
      identified: v.identified,
    };

    for (const net of v.networks) {
      const key = rowKey("visitor", v.id, net.network_id);
      claimed.add(key);
      rows.push({
        key,
        subject_kind: "visitor",
        subject_id: v.id,
        label: net.nick,
        network_id: net.network_id,
        network_slug: net.network_slug,
        connection_state: net.connection_state,
        live: net.live_state,
        upstream: sessionByKey.get(key)?.live_state ?? null,
        last_seen_at: v.last_seen_at,
        visitor: identity,
      });
    }
  }

  for (const c of credentials) {
    const key = rowKey("user", c.user_id, c.network_id);
    claimed.add(key);
    rows.push({
      key,
      subject_kind: "user",
      subject_id: c.user_id,
      label: c.nick,
      network_id: c.network_id,
      network_slug: c.network_slug,
      connection_state: c.connection_state,
      live: c.live_state,
      upstream: sessionByKey.get(key)?.live_state ?? null,
      last_seen_at: c.last_seen_at,
      visitor: null,
    });
  }

  // The orphan-pid class: a registered pid with no DB row behind it.
  // Appending these is the point of the union — dropping them would
  // hide precisely the divergence the admin console exists to surface.
  for (const s of sessions) {
    const key = rowKey(s.subject_kind, s.subject_id, s.network_id);
    if (claimed.has(key)) continue;
    rows.push({
      key,
      subject_kind: s.subject_kind,
      subject_id: s.subject_id,
      label: s.subject_label,
      network_id: s.network_id,
      network_slug: slugOf(networks, s.network_id),
      connection_state: null,
      live: s.live_state,
      upstream: s.live_state,
      last_seen_at: s.last_seen_at,
      visitor: null,
    });
  }

  return rows;
}
