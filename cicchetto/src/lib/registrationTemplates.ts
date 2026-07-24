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
// grappa's ENTIRE registration-success signal is the lowercase `+r`
// umode echo (`event_router.ex` self-MODE → `:umode_changed` →
// `umodesForNetwork(id).includes("r")`), which drives step-6
// auto-complete, the button auto-hide, and the commit-on-+r credential
// save. Only **bahamut (Azzurra IRC Services)** emits lowercase `+r`:
//   * **atheme (Libera / solanum)** has NO registered umode at all —
//     identity is account-only (WHOIS 330 / `account-notify`), so `+r`
//     never fires and none of the wizard's success logic would work.
//   * **oftc (oftc-ircservices / oftc-hybrid)** uses UPPERCASE `+R`
//     (different meaning on bahamut) AND its confirmation is an
//     out-of-band web link with no shipped verifier — impraticabile.
// So #349 ships the Azzurra flavor only. Making the wizard flavor-
// agnostic needs a new server signal (negotiate IRCv3 `account-notify`,
// handle self `ACCOUNT`, broadcast an identity event) — tracked as a
// follow-up issue; when it lands, this table gains the `atheme` entry
// (verified verb: `VERIFY REGISTER <nick> <key>`) + `registerableFlavor`
// widens. OFTC is a further follow-up (needs that signal + a bespoke
// local verifier).
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
