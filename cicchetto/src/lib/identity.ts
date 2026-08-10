import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

// #388 — per-network SERVICES-IDENTITY store: is this session identified to
// the network's NickServ, and under which account.
//
// Seeded by the `session_identity_changed` user-topic event (userTopic.ts),
// which the server emits from ONE normalized verdict
// (`Grappa.Session.IdentityState`) folding every flavour's evidence: bahamut's
// `+r` umode, OFTC's `+R`, IRCv3 `account-notify`, and numeric 330. Both the
// live edge and the cold user-topic snapshot ride that same event, so a reload
// mid-session re-learns the verdict.
//
// This store exists to stop cic deriving identity itself. It used to read
// `umodesForNetwork(id).includes("r")`, which is a bahamut-only spelling: on
// Libera (no registered umode at all) it read "never identified", and on OFTC
// lowercase `r` is an unrelated oper notice mode, so it would have read
// "identified" for the wrong reason. Whether a mode letter means identity is
// the SERVER's business — cic mirrors the verdict, it never re-derives it.
//
// Keyed by network id, like the umodes / isupport stores. Module-singleton
// reactive signal, harmlessly overwritten on the next seed.

type NetworkIdentity = {
  identified: boolean;
  account: string | null;
};

const exports_ = moduleRoot(() => {
  const [identityByNetwork, setIdentityByNetwork] = createSignal<Record<number, NetworkIdentity>>(
    {},
  );

  const seedIdentity = (networkId: number, identified: boolean, account: string | null): void => {
    setIdentityByNetwork((prev) => ({ ...prev, [networkId]: { identified, account } }));
  };

  return { identityByNetwork, seedIdentity };
});

export const identityByNetwork = exports_.identityByNetwork;
export const seedIdentity = exports_.seedIdentity;

/**
 * Whether we are identified to services on this network.
 *
 * Returns `false` for a network that has not been seeded yet (no live
 * session, or pre-snapshot). That is the deliberate tolerance the launcher
 * gates want: an unseeded network shows the "Register nick" / "Recover
 * identity" affordance rather than hiding it, matching the pre-#388
 * "no umodes seeded yet" posture. Offering an action that turns out to be
 * unnecessary is recoverable; hiding the only way out of an unidentified
 * session is not.
 */
export function identifiedForNetwork(networkId: number): boolean {
  return identityByNetwork()[networkId]?.identified ?? false;
}

/**
 * The services account name for this network, or `null` when unknown —
 * including when we ARE identified but the ircd exposes no account (the
 * normal bahamut case). Display data only: never infer identity from it,
 * ask `identifiedForNetwork` instead.
 */
export function accountForNetwork(networkId: number): string | null {
  return identityByNetwork()[networkId]?.account ?? null;
}
