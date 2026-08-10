import type { ServicesFlavor } from "./api";
import { networkBySlug } from "./networks";

// #349 — per-network NickServ REGISTER / verify command templates.
//
// cic constructs the services command bodies (exactly as compose.ts
// already does for `/ns …`) and sends them over the normal
// `sendBodyLines(slug, "NickServ", body, …)` wire path. This module is
// the SINGLE source of truth for the per-flavor verbs so the wizard
// (RegistrationWizardModal) never open-codes a command string.
//
// The flavor is server-owned (`Grappa.Networks.Network.services_flavor`,
// set by the operator at bind) and rides each `GET /networks` row as
// `services_flavor` — cic keys the template table on it. cic carries NO
// picker (#349 vjt decision (b)): the operator, not the user, knows the
// dialect. `"unknown"` / `null` have NO template — the wizard button is
// hidden (`registerableFlavor` returns false).
//
// ## Why Azzurra ONLY (for now)
//
// #349 shipped here because grappa's ENTIRE registration-success signal
// was then the lowercase `+r` umode echo, which only bahamut (Azzurra IRC
// Services) emits: atheme (Libera / solanum) assigns no registered umode
// at all, and on OFTC lowercase `r` is an unrelated oper notice mode. The
// success logic could not have worked anywhere else.
//
// **That blocker is gone.** #388 built the signal this comment asked for:
// the server negotiates `account-notify`, handles self `ACCOUNT` and
// numeric 330, folds them with the per-flavour umode in
// `Grappa.Session.IdentityState`, and broadcasts ONE normalized
// `session_identity_changed` verdict. All three consumers named here —
// step-6 auto-complete, the launcher auto-hide, and the commit-on-identity
// credential save — read that verdict now; none of them knows what a umode
// is. Do not re-derive identity from a mode letter to widen this table.
//
// What still gates each flavour is therefore only its VERBS:
//   * **atheme** needs its table entry (verb verified:
//     `VERIFY REGISTER <nick> <key>`), after which `registerableFlavor`
//     can widen.
//   * **oftc** needs more than a verb: confirmation is an out-of-band web
//     link with no shipped verifier.
//
// Verbs are SOURCE-VERIFIED (azzurra/services GPLv2 source: REGISTER
// takes the password FIRST then the email; confirmation is `AUTH <code>`
// — a SINGLE numeric arg (the emailed code), NOT nick+code:
// `NS_AUTH_SYNTAX_ERROR` "Syntax: AUTH code"). Command bodies are
// `PRIVMSG NickServ :<body>` payloads (the leading `/ns` is not part of
// the body — `sendBodyLines(slug, "NickServ", …)` targets NickServ
// directly).

export type RegistrationTemplate = {
  // The services nick the wizard messages + mirrors replies from. Kept
  // per-flavor so a future services suite with a differently-named
  // registration bot needs only a table entry, not a code change.
  servicesNick: string;
  // REGISTER command body. Password FIRST, email second — the ordering
  // is load-bearing.
  buildRegister: (password: string, email: string) => string;
  // Confirmation / verify command body. `nick` is the operator's own
  // per-network nick (kept in the signature for the future atheme entry,
  // which needs it in the verb; Azzurra's `AUTH <code>` ignores it).
  buildVerify: (nick: string, code: string) => string;
};

// The flavors that actually have a working template + an observable
// success signal. Type-level twin of the `registerableFlavor` guard
// below so the table is exhaustive over exactly these keys. Only
// `"azzurra"` for #349 (see the "Why Azzurra ONLY" note above); the
// follow-up that adds a flavor-agnostic identity signal widens this to
// include `"atheme"`.
export type RegisterableFlavor = "azzurra";

const REGISTRATION_TEMPLATES: Record<RegisterableFlavor, RegistrationTemplate> = {
  azzurra: {
    servicesNick: "NickServ",
    buildRegister: (password, email) => `REGISTER ${password} ${email}`,
    // Azzurra: `AUTH <code>` — single arg, the nick is NOT part of the
    // verb (the emailed code alone identifies the pending registration).
    buildVerify: (_nick, code) => `AUTH ${code}`,
  },
};

// True only for a flavor that has a working template AND a success
// signal grappa can observe (currently `"azzurra"` only). Every other
// value — `"atheme"`, `"oftc"`, `"unknown"`, `null` — returns false, so
// the wizard button hides: either there's nothing to register against,
// or (atheme/oftc) grappa can't yet see the registration complete. A
// `flavor is RegisterableFlavor` type guard so `templateForFlavor` can
// index the table without a cast.
export function registerableFlavor(flavor: ServicesFlavor | null): flavor is RegisterableFlavor {
  return flavor === "azzurra";
}

// The template for a flavor, or `null` when the flavor is not
// registerable.
export function templateForFlavor(flavor: ServicesFlavor | null): RegistrationTemplate | null {
  return registerableFlavor(flavor) ? REGISTRATION_TEMPLATES[flavor] : null;
}

// Resolve a network's services flavor from its slug via the networks
// store. Returns `null` when the network isn't in the store yet or the
// server left the flavor unset — both collapse to "button hidden".
export function flavorForSlug(slug: string): ServicesFlavor | null {
  return networkBySlug(slug)?.services_flavor ?? null;
}
