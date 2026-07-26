// #378 — client half of the presence-push drift gate.
//
// Runs against the SAME fixture as `test/grappa/push/push_parity_test.exs`
// (`pushParityFixture.json`). ExUnit asserts the server PRODUCES those
// shapes; this asserts the client ACCEPTS them and routes them correctly.
//
// This is a real gate only because both suites read one file. A
// hand-copied literal here would not move when `Payload.build_presence/3`
// changed, so both suites would stay green while the contract broke.
//
// There is no codegen covering this boundary: `gen_wire_types --check`
// covers `wireTypes.ts` (PubSub/Channel shapes) only, and
// `notification_prefs` crosses as an opaque map.

import { describe, expect, it } from "vitest";

import fixture from "./pushParityFixture.json";
import { narrowPushPayload, parsePushTargetUrl } from "./pushPayload";
import { DEFAULT_NOTIFICATION_PREFS } from "./userSettings";

describe("#378 push parity — notification_prefs defaults", () => {
  it("DEFAULT_NOTIFICATION_PREFS matches the server's defaults", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual(fixture.notification_prefs_defaults);
  });

  it("presence push is opt-in on both axes", () => {
    // Default-ON would enable a new push class for every existing user,
    // including those who deliberately configured their prefs.
    expect(DEFAULT_NOTIFICATION_PREFS.presence_online).toBe(false);
    expect(DEFAULT_NOTIFICATION_PREFS.presence_offline).toBe(false);
  });
});

describe("#378 push parity — presence payloads", () => {
  for (const c of fixture.presence_payloads) {
    it(`narrowPushPayload accepts the server shape — ${c.why}`, () => {
      const narrowed = narrowPushPayload(c.payload);

      expect(narrowed).not.toBeNull();
      expect(narrowed).toEqual(c.payload);
      // No badge on a presence push: a presence flip creates no unread
      // message, so the SW must leave the icon badge untouched.
      expect(narrowed).not.toHaveProperty("badge");
    });

    it(`parsePushTargetUrl routes to the watched nick's query — ${c.why}`, () => {
      const target = parsePushTargetUrl(c.payload.url);

      expect(target).not.toBeNull();
      expect(target!.kind).toBe(c.expect_target.kind);
      expect(target!.channelName).toBe(c.expect_target.channelName);
      expect(target!.networkSlug).toBe(c.network_slug);
    });
  }

  it("a presence tag can never collide with a message tag", () => {
    // The `presence:` infix is the guard: a bare-nick tag would equal the
    // DM tag for that same nick, so the two banners would coalesce.
    for (const c of fixture.presence_payloads) {
      expect(c.payload.tag).toContain(":presence:");
      expect(c.payload.tag).not.toBe(`${c.network_slug}:${c.nick}`);
    }
  });
});
