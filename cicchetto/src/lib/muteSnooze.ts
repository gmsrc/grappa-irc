// #950 — the snooze OFFER table for the per-conversation mute (#866).
//
// `muted_targets[key].until` has carried unix seconds since #866 shipped, and
// both readers already resolve it (`notificationPrefs.withLiveMutes` here,
// `UserSettings.get_notification_prefs/1` on the server). Nothing WROTE a
// non-null one: every UI mute was `{ until: null }`, so the snooze was dead
// storage. This module is the writer's vocabulary — the offers a human picks
// from, and the one conversion from an offer to the integer.
//
// Pure, `now` injected: the durations are arithmetic, "until tomorrow" is a
// LOCAL-calendar question (the next midnight where the operator is), and both
// must be testable without fake timers.
//
// Clock note, deliberately unresolved (#950): this integer is computed on the
// CLIENT's clock and compared against the SERVER's (`System.os_time(:second)`)
// and the client's own (`Date.now()`). A skewed device therefore snoozes for
// skew ± the chosen span. That is pre-existing in the shape — #866 filed the
// two-clock question and nobody has examined it — and is NOT quietly corrected
// here: a fix belongs where the skew is measured, not inside a duration table.

export type MuteSnoozeValue = "1h" | "8h" | "tomorrow" | "forever";

export type MuteSnoozeOption = {
  value: MuteSnoozeValue;
  /** What the operator reads in the picker. cic owns the human strings. */
  label: string;
};

/**
 * The offers, in menu order: #866's three time-boxes, then the permanent mute
 * the drawer picker has always written. Permanent is offered HERE too so the
 * rail entry is a complete answer to "silence this conversation" — otherwise
 * the one-tap door could only ever snooze.
 */
export const MUTE_SNOOZE_OPTIONS: readonly MuteSnoozeOption[] = [
  { value: "1h", label: "for 1 hour" },
  { value: "8h", label: "for 8 hours" },
  { value: "tomorrow", label: "until tomorrow" },
  { value: "forever", label: "until I unmute" },
];

const HOUR_SECONDS = 3_600;

/**
 * The `until` an offer means, in unix SECONDS — or null for the permanent
 * mute, which is the shape's own "never expires".
 *
 * "until tomorrow" is the next LOCAL midnight, not a rolling 24 hours: an
 * operator silencing a channel at 23:00 means "until the morning", and a
 * rolling day would hold it through all of tomorrow as well.
 */
export function snoozeUntil(value: MuteSnoozeValue, now: Date): number | null {
  switch (value) {
    case "1h":
      return Math.floor(now.getTime() / 1000) + HOUR_SECONDS;
    case "8h":
      return Math.floor(now.getTime() / 1000) + 8 * HOUR_SECONDS;
    case "tomorrow": {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      return Math.floor(midnight.getTime() / 1000);
    }
    case "forever":
      return null;
  }
}
