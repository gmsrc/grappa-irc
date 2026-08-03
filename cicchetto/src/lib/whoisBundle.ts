import type { WhoisBundle } from "./api";

// Does this bundle carry any actual WHOIS data?
//
// A WHOIS for a nick nobody is holding still produces a bundle: bahamut
// answers 401 ERR_NOSUCHNICK and then 318 RPL_ENDOFWHOIS unconditionally
// (src/s_user.c), so the server drains an accumulator that never got a
// single field and emits an all-null bundle. Two callers need to tell that
// apart from a real answer, so the predicate lives here rather than in
// either of them:
//
//   * `WhoisCard` renders "no WHOIS information returned" instead of an
//     empty field list;
//   * `railWhois` treats it as NOT-an-answer, so a peer who was offline when
//     their query window was first shown is asked about again later instead
//     of being cached as unknown for the rest of the session.
//
// #221 — solanum-only fields (account / secure / certfp) count as data, or a
// Libera user's card would claim "nothing returned" while holding plenty.
// #673 — so does a lone extra line: an oper-only or privacy-stripped reply
// can carry nothing else, and it is still the answer /whois asked for.
export function whoisBundleHasFields(b: WhoisBundle): boolean {
  return (
    b.user !== null ||
    b.host !== null ||
    b.realname !== null ||
    b.server !== null ||
    b.is_operator ||
    b.idle_seconds !== null ||
    b.channels !== null ||
    b.using_ssl ||
    b.is_registered ||
    b.is_admin ||
    b.is_services_admin ||
    b.is_helper ||
    b.is_chanop ||
    b.is_agent ||
    b.is_java ||
    b.umodes !== null ||
    b.away_message !== null ||
    b.actually_host !== null ||
    b.account !== null ||
    b.secure ||
    b.certfp !== null ||
    (b.extra_lines?.length ?? 0) > 0
  );
}
