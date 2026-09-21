import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATE_FORMAT_KEYS,
  type DateFormatKey,
  FALLBACK_LOCALE,
  getDateFormat,
  renderDate,
  renderDateTime,
  renderDayLabel,
  resolveLocale,
  setDateFormat,
} from "../lib/dateFormat";

// issue 2270 — the date NOTATION preference. Sibling of timeFormat.test.ts.
//
// Every instant below is built from LOCAL components (`new Date(y, m, d, …)`),
// never from an ISO string or an epoch literal. Both the explicit-key renderer
// (local getters) and the `auto` one (Intl in the runtime zone) read local
// fields, so a local-component instant makes the expectations independent of
// the runner's TZ — which is the same class of hazard as the locale one this
// whole issue is about, and it would otherwise make these tests pass in Rome
// and fail in CI.
const AT = (h: number, min: number, s: number): number =>
  new Date(2026, 8, 21, h, min, s).getTime(); // 2026-09-21, a Monday

const INSTANT = AT(0, 5, 7);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("renderDate — the closed set renders the notation it names", () => {
  // The three explicit keys are LOCALE-FREE by construction: the user asked for
  // a field order, so the order is assembled from the date's own fields rather
  // than delegated to a locale that might disagree. Passing a hostile locale is
  // the point of the argument here — `en-US` must not drag `dmy` back to
  // month-first, which is the entire bug in issue 2270.
  it("dmy renders day-first regardless of the locale in hand", () => {
    expect(renderDate(INSTANT, "dmy", "en-US")).toBe("21/09/2026");
    expect(renderDate(INSTANT, "dmy", "it-IT")).toBe("21/09/2026");
  });

  it("mdy renders month-first regardless of the locale in hand", () => {
    expect(renderDate(INSTANT, "mdy", "it-IT")).toBe("09/21/2026");
    expect(renderDate(INSTANT, "mdy", "en-US")).toBe("09/21/2026");
  });

  it("ymd renders ISO-ordered, dash-separated", () => {
    expect(renderDate(INSTANT, "ymd", "en-US")).toBe("2026-09-21");
    expect(renderDate(INSTANT, "ymd", "it-IT")).toBe("2026-09-21");
  });

  it("pads single-digit days and months — a notation is a fixed width", () => {
    const early = new Date(2026, 0, 3, 12, 0, 0).getTime(); // 3 January
    expect(renderDate(early, "dmy", "en-GB")).toBe("03/01/2026");
    expect(renderDate(early, "mdy", "en-GB")).toBe("01/03/2026");
    expect(renderDate(early, "ymd", "en-GB")).toBe("2026-01-03");
  });

  // `auto` is where the locale is load-bearing — it is the ONE key that defers.
  it("auto follows the locale it is handed, both ways", () => {
    expect(renderDate(INSTANT, "auto", "it-IT")).toBe("21/09/2026");
    expect(renderDate(INSTANT, "auto", "en-GB")).toBe("21/09/2026");
    expect(renderDate(INSTANT, "auto", "en-US")).toBe("09/21/2026");
  });

  // The acceptance criterion from the reporter, stated as its own test: an
  // Italian viewer gets gg/mm/aaaa, and gets it from the DEFAULT key.
  it("an Italian viewer on the default key gets gg/mm/aaaa", () => {
    expect(renderDate(INSTANT, "auto", "it-IT")).toBe("21/09/2026");
  });

  // The reported case itself: English UI, Italian region. `auto` cannot save
  // this viewer — the web exposes no region — which is WHY the preference
  // exists. Pinning it here keeps anyone from "fixing" the default instead.
  it("auto CANNOT rescue the reported case — en-US resolves month-first, and the key is the only cure", () => {
    expect(renderDate(INSTANT, "auto", "en-US")).toBe("09/21/2026");
    expect(renderDate(INSTANT, "dmy", "en-US")).toBe("21/09/2026");
  });
});

describe("every renderer is TOTAL — a non-finite instant must not throw", () => {
  // The regression this pins is one this branch INTRODUCED and the full suite
  // caught: `Date.prototype.toLocaleString()` answers "Invalid Date" for a
  // non-finite instant, but `Intl.DateTimeFormat.format()` throws
  // `RangeError: date value is not finite`. These run inside render paths, so
  // a throw is a blank pane — strictly worse than the string it replaced.
  //
  // `NaN` is the shape that actually arrived (an absent `signon` reaching
  // `epochSeconds * 1000`); the infinities are here because `Number.isFinite`
  // is the guard and a `> 0` or `!Number.isNaN` one would let them through to
  // the same throw.
  const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  it("renderDate answers a placeholder instead of throwing", () => {
    for (const bad of BAD) {
      for (const key of DATE_FORMAT_KEYS) {
        expect(() => renderDate(bad, key, "en-US")).not.toThrow();
        expect(renderDate(bad, key, "en-US")).toBe("—");
      }
    }
  });

  it("renderDateTime and renderDayLabel do the same — all three doors, not one", () => {
    for (const bad of BAD) {
      expect(renderDateTime(bad, "auto", "en-US", "hms")).toBe("—");
      expect(renderDayLabel(bad, "auto", "en-US")).toBe("—");
      // The explicit keys route through different code than `auto` (no Intl at
      // all for the date), so they are asserted separately rather than assumed.
      expect(renderDateTime(bad, "dmy", "en-US", "hm")).toBe("—");
      expect(renderDayLabel(bad, "dmy", "en-US")).toBe("—");
    }
  });

  it("a REAL instant is untouched by the guard — the placeholder is not the answer to everything", () => {
    // Negative control: without this, a renderer that returned "—" for every
    // input would satisfy the two tests above.
    expect(renderDate(INSTANT, "dmy", "en-US")).not.toBe("—");
    expect(renderDateTime(INSTANT, "dmy", "en-US", "hms")).not.toBe("—");
    expect(renderDayLabel(INSTANT, "auto", "en-GB")).not.toBe("—");
  });
});

describe("renderDateTime — the composite the four call sites need", () => {
  it("joins the notation with the app's own time renderer", () => {
    // The time half is `timeFormat.ts` (#217), not a second locale decision:
    // the app already owns "with/without seconds" and already renders 24h.
    expect(renderDateTime(INSTANT, "dmy", "en-US", "hms")).toBe("21/09/2026 00:05:07");
    expect(renderDateTime(INSTANT, "dmy", "en-US", "hm")).toBe("21/09/2026 00:05");
  });

  it("carries the notation key through to the date half", () => {
    expect(renderDateTime(INSTANT, "mdy", "it-IT", "hms")).toBe("09/21/2026 00:05:07");
    expect(renderDateTime(INSTANT, "ymd", "it-IT", "hm")).toBe("2026-09-21 00:05");
  });
});

describe("renderDayLabel — the scrollback day separator keeps its WORDS", () => {
  // The separator's weekday and month are LANGUAGE, and the key is NOTATION.
  // Forcing `en-GB` on an Italian viewer who picks `dmy` would answer a
  // notation question by changing the language — so the language always comes
  // from the resolved locale and only the ORDER follows the key.
  it("auto keeps today's localized long-form label, punctuation and all", () => {
    // MEASURED in the runtime, not assumed: en-GB carries no comma and en-US
    // does. `auto` delegates the whole string to Intl precisely so it keeps
    // whatever each locale does here.
    expect(renderDayLabel(INSTANT, "auto", "en-GB")).toBe("Monday 21 September");
    expect(renderDayLabel(INSTANT, "auto", "en-US")).toBe("Monday, September 21");
    expect(renderDayLabel(INSTANT, "auto", "it-IT")).toBe("lunedì 21 settembre");
  });

  it("an explicit key renders the localized weekday beside the chosen notation", () => {
    expect(renderDayLabel(INSTANT, "dmy", "en-GB")).toBe("Monday, 21/09/2026");
    expect(renderDayLabel(INSTANT, "ymd", "en-GB")).toBe("Monday, 2026-09-21");
  });

  it("keeps the weekday in the viewer's LANGUAGE while the key drives the order", () => {
    // The whole reason the label is not just `renderDate`: an Italian viewer
    // who asks for `dmy` must still read "lunedì", not "Monday".
    expect(renderDayLabel(INSTANT, "dmy", "it-IT")).toBe("lunedì, 21/09/2026");
  });
});

describe("resolveLocale — the chain, and the floor it must never be", () => {
  it("prefers the first entry of navigator.languages", () => {
    vi.stubGlobal("navigator", { languages: ["it-IT", "en"], language: "en-US" });
    expect(resolveLocale()).toBe("it-IT");
  });

  it("falls back to navigator.language when languages is empty", () => {
    vi.stubGlobal("navigator", { languages: [], language: "fr-FR" });
    expect(resolveLocale()).toBe("fr-FR");
  });

  it("ends at a day-first fallback, NEVER a hardcoded en-US", () => {
    // vjt, issue 2270: "it must never collapse to a hardcoded `en-US`" — an
    // Italian browser would regress. Asserted as an inequality as well as an
    // equality so the intent survives a change of fallback.
    vi.stubGlobal("navigator", { languages: undefined, language: undefined });
    expect(resolveLocale()).toBe(FALLBACK_LOCALE);
    expect(FALLBACK_LOCALE).not.toBe("en-US");
    expect(renderDate(INSTANT, "auto", FALLBACK_LOCALE)).toBe("21/09/2026");
  });
});

describe("the key store — closed set, defaulting to auto", () => {
  it("defaults to auto, which is a real key and not an absence", () => {
    expect(getDateFormat()).toBe("auto");
    expect(DATE_FORMAT_KEYS).toContain("auto");
  });

  it("round-trips every key in the closed set", () => {
    for (const key of DATE_FORMAT_KEYS) {
      setDateFormat(key);
      expect(getDateFormat()).toBe(key);
    }
  });

  it("carries exactly the four keys the ruling named", () => {
    expect([...DATE_FORMAT_KEYS]).toEqual(["auto", "dmy", "mdy", "ymd"]);
  });

  it("ignores a stored value outside the set", () => {
    localStorage.setItem("cicchetto.dateFormat", "yyyy/dd/mm");
    // A hostile localStorage value must not reach the renderer as a key.
    const stored = localStorage.getItem("cicchetto.dateFormat") as DateFormatKey;
    expect(DATE_FORMAT_KEYS).not.toContain(stored);
  });
});
