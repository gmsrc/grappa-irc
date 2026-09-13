import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFICATION_SOUND_PRESETS,
  NOTIFICATION_SOUNDS,
  type NotificationSound,
  type SoundVoice,
} from "../lib/notificationSound";

// #1480 — the preset player.
//
// Playwright cannot hear anything and neither can jsdom, so what is testable
// here is what `playBeep` SCHEDULES: which nodes it builds, at which
// frequencies, from which buffer, and — the load-bearing one — when it does
// nothing at all. The fake AudioContext below records exactly that.
//
// The recipes themselves (which Hz, how long) are DATA in
// `notificationSound.ts` and are read from there rather than restated: a test
// that hardcoded 440 would pin this file's opinion of the table instead of the
// wiring under test. The one exception is the silent/stamp contract, which is
// the ruling and is asserted as literals.
//
// The fake records the GainNode AUTOMATION too — every `setValueAtTime` /
// `linearRampToValueAtTime` / `exponentialRampToValueAtTime` with its time —
// because the envelope is the only part of a preset that is inaudible from
// the recipe: `tone` kept its 440 Hz and its 80 ms across #1480 and still
// changed sound, since the shared envelope decayed it from the onset (issue
// 2119). A final-value assertion cannot see that — both shapes end at
// silence — so what is asserted is WHEN the peak is abandoned.

type StartedOsc = {
  type: OscillatorType;
  freqAt: Array<{ value: number; at: number }>;
  ramps: Array<{ value: number; at: number }>;
  startedAt: number;
  stoppedAt: number;
};

/** One scheduled gain event, in the order the player scheduled it. */
type GainEvent = { op: "set" | "linear" | "exponential"; value: number; at: number };
type GainRec = { automation: GainEvent[]; value: number };

type FakeContext = {
  state: AudioContextState;
  currentTime: number;
  constructed: number;
  resumes: number;
  oscillators: StartedOsc[];
  gains: GainRec[];
  bufferSources: Array<{ buffer: AudioBuffer | null; started: boolean }>;
  decoded: ArrayBuffer[];
};

let fake: FakeContext;
let decodeFails: boolean;

const makeGain = () => {
  const rec: GainRec = { automation: [], value: 0 };
  fake.gains.push(rec);
  return {
    gain: {
      setValueAtTime: (value: number, at: number) => rec.automation.push({ op: "set", value, at }),
      linearRampToValueAtTime: (value: number, at: number) =>
        rec.automation.push({ op: "linear", value, at }),
      exponentialRampToValueAtTime: (value: number, at: number) =>
        rec.automation.push({ op: "exponential", value, at }),
      set value(v: number) {
        rec.value = v;
      },
      get value() {
        return rec.value;
      },
    },
    connect: (next: unknown) => next,
  };
};

function installFakeAudio(): void {
  fake = {
    state: "running",
    currentTime: 0,
    constructed: 0,
    resumes: 0,
    oscillators: [],
    gains: [],
    bufferSources: [],
    decoded: [],
  };
  decodeFails = false;

  class FakeAudioContext {
    constructor() {
      fake.constructed += 1;
    }
    get state() {
      return fake.state;
    }
    get currentTime() {
      return fake.currentTime;
    }
    resume() {
      fake.resumes += 1;
      fake.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      const rec: StartedOsc = {
        type: "sine",
        freqAt: [],
        ramps: [],
        startedAt: Number.NaN,
        stoppedAt: Number.NaN,
      };
      fake.oscillators.push(rec);
      return {
        set type(v: OscillatorType) {
          rec.type = v;
        },
        get type() {
          return rec.type;
        },
        frequency: {
          setValueAtTime: (value: number, at: number) => rec.freqAt.push({ value, at }),
          linearRampToValueAtTime: (value: number, at: number) => rec.ramps.push({ value, at }),
        },
        connect: (next: unknown) => next,
        start: (at: number) => {
          rec.startedAt = at;
        },
        stop: (at: number) => {
          rec.stoppedAt = at;
        },
      };
    }
    createGain() {
      return makeGain();
    }
    createBufferSource() {
      const rec = { buffer: null as AudioBuffer | null, started: false };
      fake.bufferSources.push(rec);
      return {
        set buffer(b: AudioBuffer | null) {
          rec.buffer = b;
        },
        get buffer() {
          return rec.buffer;
        },
        connect: (next: unknown) => next,
        start: () => {
          rec.started = true;
        },
      };
    }
    decodeAudioData(bytes: ArrayBuffer) {
      fake.decoded.push(bytes);
      if (decodeFails) return Promise.reject(new Error("bad mp3"));
      return Promise.resolve({ duration: 0.5 } as unknown as AudioBuffer);
    }
  }

  vi.stubGlobal("AudioContext", FakeAudioContext);
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
}

// `noUncheckedIndexedAccess` is on, and biome bans the `!` shortcut, so array
// access goes through this: a missing element is a harness bug and should say
// so loudly rather than surface three lines later as "expected undefined".
const at = <T>(xs: readonly T[], i: number): T => {
  const v = xs[i];
  if (v === undefined) throw new Error(`beep test harness: no element at index ${i}`);
  return v;
};

// Narrow a preset to its voices. The throw is the point: if a preset stops
// being a synth the tests below are testing nothing, and should say so rather
// than skip themselves.
const synthVoices = (name: NotificationSound): readonly SoundVoice[] => {
  const preset = NOTIFICATION_SOUND_PRESETS[name];
  if (preset.kind !== "synth") throw new Error(`${name} must stay a synth preset`);
  return preset.voices;
};

const SYNTH_PRESETS = NOTIFICATION_SOUNDS.filter(
  (name) => NOTIFICATION_SOUND_PRESETS[name].kind === "synth",
);

// Every test needs a module instance whose lazily-built AudioContext (and
// whose sample cache) is its own — both are module-level singletons, so a
// shared import would let one test's decode satisfy the next one's assertion.
async function freshBeep() {
  vi.resetModules();
  return await import("../lib/beep");
}

beforeEach(() => {
  installFakeAudio();
  window.__lastBeepAt = undefined;
  // A FRESH Response per call, not one shared instance: a body can only be
  // read once, so `mockResolvedValue(new Response(...))` makes the second
  // fetch of the session fail inside `arrayBuffer()`. That is the harness
  // lying, not the module — measured while writing this file, where it turned
  // both the cache-eviction and the two-assets tests red for a reason that
  // does not exist in a browser.
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.__lastBeepAt = undefined;
});

describe("playBeep — the silent preset (#1480)", () => {
  it("schedules nothing and does NOT stamp the seam", async () => {
    const { playBeep } = await freshBeep();

    playBeep("none");

    expect(fake.oscillators).toHaveLength(0);
    expect(fake.bufferSources).toHaveLength(0);
    // The discriminating assertion. `none` is the DEFAULT, so a seam that
    // ticked here would report "beeped" for every subject who never opted in
    // — which is everyone — and the e2e oracle would be green on silence.
    expect(window.__lastBeepAt).toBeUndefined();
  });

  it("does not even build an AudioContext", async () => {
    const { playBeep } = await freshBeep();

    playBeep("none");

    expect(fake.constructed).toBe(0);

    // Negative control: the same module instance DOES build one for a real
    // preset, so the zero above is a property of `none` and not of a harness
    // that never wires the constructor up.
    playBeep("tone");
    expect(fake.constructed).toBe(1);
  });
});

describe("playBeep — synthesised presets (#1480)", () => {
  it("plays the 440 Hz tone cic shipped before the preset pack", async () => {
    const { playBeep } = await freshBeep();

    playBeep("tone");

    const voice = at(synthVoices("tone"), 0);

    expect(fake.oscillators).toHaveLength(1);
    const osc = at(fake.oscillators, 0);
    expect(osc.type).toBe(voice.wave);
    expect(at(osc.freqAt, 0).value).toBe(voice.fromHz);
    expect(osc.stoppedAt - osc.startedAt).toBeCloseTo(voice.durationMs / 1000, 6);
  });

  it("schedules one oscillator per voice, offset by the recipe's atMs", async () => {
    const { playBeep } = await freshBeep();
    fake.currentTime = 10;

    playBeep("chime");

    const voices = synthVoices("chime");

    expect(fake.oscillators).toHaveLength(voices.length);
    // The second note is what makes it a chime rather than a tone: if the
    // offset were dropped both voices would fire together and the preset
    // would be an interval, not a sequence.
    expect(at(fake.oscillators, 1).startedAt - at(fake.oscillators, 0).startedAt).toBeCloseTo(
      at(voices, 1).atMs / 1000,
      6,
    );
  });

  it("ramps a swept voice to its end frequency instead of holding the start", async () => {
    const { playBeep } = await freshBeep();

    playBeep("blip");

    const voice = at(synthVoices("blip"), 0);
    expect(at(at(fake.oscillators, 0).freqAt, 0).value).toBe(voice.fromHz);
    expect(at(at(fake.oscillators, 0).ramps, 0).value).toBe(voice.toHz);
    expect(voice.toHz).not.toBe(voice.fromHz);
  });

  it("stamps the seam on the attempt", async () => {
    const { playBeep } = await freshBeep();

    playBeep("pop");

    expect(typeof window.__lastBeepAt).toBe("number");
  });

  it("resumes a suspended context so the next gesture is not needed", async () => {
    const { playBeep } = await freshBeep();
    fake.state = "suspended";

    playBeep("tone");

    expect(fake.resumes).toBe(1);
  });
});

describe("playBeep — the gain envelope (issue 2119)", () => {
  it("holds tone at its peak for the body of the note instead of decaying from the onset", async () => {
    const { playBeep } = await freshBeep();

    playBeep("tone");

    const voice = at(synthVoices("tone"), 0);
    expect(fake.gains).toHaveLength(1);
    const env = at(fake.gains, 0).automation;

    // The third event is the whole bug. Without it the exponential ramp
    // starts where the 5 ms attack ends, so the note is ~20 dB down a third
    // of the way through its 80 ms and inaudible long before it stops — the
    // "same numbers, half the sound" Lucy reported.
    expect(env.map((e) => e.op)).toEqual(["set", "linear", "set", "exponential"]);
    const onset = at(env, 0);
    const attack = at(env, 1);
    const hold = at(env, 2);
    const release = at(env, 3);

    expect(attack.value).toBe(voice.gain);
    expect(hold.value).toBe(voice.gain);
    // The player holds for exactly the sustain the table declares — not a
    // number this file invents, or it would pin its own opinion of the recipe.
    expect(hold.at - attack.at).toBeCloseTo(voice.sustainMs / 1000, 6);
    expect(release.at - onset.at).toBeCloseTo(voice.durationMs / 1000, 6);

    // The perceptual claim, as a number a future table edit cannot quietly
    // undo: the peak survives nearly to the end. Pre-fix this ratio was
    // 0.0625 — the peak existed for one sixteenth of the note.
    expect((hold.at - onset.at) / (release.at - onset.at)).toBeGreaterThan(0.8);
    // ...and a release still exists, so the note fades instead of clicking
    // off the way the flat pre-#1480 gain did.
    expect(release.at).toBeGreaterThan(hold.at);
  });

  it.each(["chime", "blip", "pop"] as const)(
    "leaves a preset that declares no sustain exactly as #1480 shipped it — %s",
    async (name) => {
      const { playBeep } = await freshBeep();

      playBeep(name);

      const voices = synthVoices(name);
      expect(fake.gains).toHaveLength(voices.length);
      voices.forEach((voice, i) => {
        // These presets WANT the decay — a chime that held its peak and then
        // cut is not a chime. 2119 is about the one preset whose contract is
        // "what shipped before", so a zero sustain must reproduce the old
        // three-event envelope event for event.
        expect(voice.sustainMs).toBe(0);
        const env = at(fake.gains, i).automation;
        expect(env.map((e) => e.op)).toEqual(["set", "linear", "exponential"]);
        expect(at(env, 1).value).toBe(voice.gain);
        expect(at(env, 2).at - at(env, 0).at).toBeCloseTo(voice.durationMs / 1000, 6);
      });
    },
  );

  it("leaves every synth preset a release, so no sustain can swallow its own ramp", async () => {
    const { playBeep } = await freshBeep();
    expect(SYNTH_PRESETS.length).toBeGreaterThan(1);

    for (const name of SYNTH_PRESETS) {
      fake.gains = [];
      playBeep(name);

      expect(fake.gains).toHaveLength(synthVoices(name).length);
      for (const rec of fake.gains) {
        const last = at(rec.automation, rec.automation.length - 1);
        const prev = at(rec.automation, rec.automation.length - 2);
        // `attack + sustain > duration` is an arithmetic mistake TypeScript
        // cannot catch, and it lands as an out-of-order automation event —
        // which a real AudioContext throws on and `playBeep` then swallows,
        // turning a typo into silence. The table is the only place voices are
        // born, so the invariant is checked over ALL of it rather than argued
        // for whichever preset is being added.
        expect(last.op).toBe("exponential");
        expect(last.at).toBeGreaterThan(prev.at);
      }
    }
  });
});

describe("playBeep — sampled presets (#1480)", () => {
  it("fetches the preset's asset and plays the decoded buffer", async () => {
    const { playBeep } = await freshBeep();
    const preset = NOTIFICATION_SOUND_PRESETS.icq;
    if (preset.kind !== "sample") throw new Error("icq must stay a sampled preset");

    playBeep("icq");
    await vi.waitFor(() => expect(fake.bufferSources).toHaveLength(1));

    expect(globalThis.fetch).toHaveBeenCalledWith(preset.url);
    expect(at(fake.bufferSources, 0).started).toBe(true);
    expect(at(fake.bufferSources, 0).buffer).not.toBeNull();
    // No oscillator: a sampled preset must not also synthesise, or the two
    // species would stack on top of each other.
    expect(fake.oscillators).toHaveLength(0);
  });

  it("decodes each asset once and replays the cached buffer", async () => {
    const { playBeep } = await freshBeep();

    playBeep("xp_notify");
    await vi.waitFor(() => expect(fake.bufferSources).toHaveLength(1));
    playBeep("xp_notify");
    await vi.waitFor(() => expect(fake.bufferSources).toHaveLength(2));

    expect(fake.decoded).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps different presets on different assets", async () => {
    const { playBeep } = await freshBeep();

    playBeep("xp_ding");
    playBeep("xp_balloon");
    await vi.waitFor(() => expect(fake.bufferSources).toHaveLength(2));

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("a failed decode is swallowed AND evicted, so the next attempt retries", async () => {
    const { playBeep } = await freshBeep();
    decodeFails = true;

    playBeep("xp_exclamation");
    await vi.waitFor(() => expect(fake.decoded).toHaveLength(1));
    expect(fake.bufferSources).toHaveLength(0);

    // The eviction is the point: caching a rejected promise would poison the
    // preset for the rest of the session, so one bad response on a flaky
    // network would silence the operator until they reload.
    decodeFails = false;
    playBeep("xp_exclamation");
    await vi.waitFor(() => expect(fake.bufferSources).toHaveLength(1));
  });

  it("a failed fetch never reaches the decoder and never throws", async () => {
    const { playBeep } = await freshBeep();
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("gone", { status: 404 }));

    expect(() => playBeep("icq")).not.toThrow();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    expect(fake.decoded).toHaveLength(0);
    expect(fake.bufferSources).toHaveLength(0);
  });
});

describe("playBeep — failure posture (#1480)", () => {
  it("a browser with no AudioContext is a no-op, not a crash", async () => {
    vi.stubGlobal("AudioContext", undefined);
    (window as unknown as { AudioContext: unknown }).AudioContext = undefined;
    (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext = undefined;
    const { playBeep } = await freshBeep();

    expect(() => playBeep("tone")).not.toThrow();
  });

  it("a throwing node constructor is swallowed — the WS handler must survive", async () => {
    const { playBeep } = await freshBeep();
    // First build the context, THEN break it: the throw has to happen inside
    // the try, which is where a real invalid-state error would land.
    playBeep("tone");
    const ctx = fake;
    ctx.oscillators = [];
    vi.spyOn(window.AudioContext.prototype, "createOscillator").mockImplementation(() => {
      throw new Error("InvalidStateError");
    });

    expect(() => playBeep("tone")).not.toThrow();
  });
});
