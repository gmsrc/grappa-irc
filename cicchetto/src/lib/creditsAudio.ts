// #1773 — the credit roll's soundtrack: a synthesised arpeggio, with ZERO
// audio assets in the tree.
//
// WHY SYNTHESISED, and why this is not a preference. The issue asked for
// "something epic", and the obvious candidates (Star Wars, Super Mario) are
// under copyright. grappa ships a PUBLIC PWA and a `.deb`, so shipping either
// would put a licence violation in a distro package. The alternatives were an
// original chiptune, a CC0 track with its licence recorded in-tree, or this:
// a few seconds of WebAudio with no asset at all. It is also by far the
// smallest payload, and the modal is already a synthetic-graphics affair, so
// nothing about it is out of place.
//
// Autoplay is legal here because the modal opens on a click — the user
// gesture requirement is satisfied by the thing that mounted this. A
// suspended context is still resumed explicitly: Safari hands one back
// suspended more often than Chromium does.
//
// The AudioContext is handed IN rather than constructed here, and `stop()`
// CLOSES it. Two reasons: jsdom has no AudioContext, so the caller has to do
// the feature test anyway and a constructor inside would make this module
// untestable; and an easter egg that leaves a live audio graph behind a
// closed modal is the battery bug this file's sibling rAF loop was careful
// not to be.

/** A running soundtrack. Both verbs are idempotent. */
export type CreditsArpeggio = {
  /** Fade to silence (or back), without tearing down the graph. */
  readonly setMuted: (muted: boolean) => void;
  /** Silence it, drop every node, and CLOSE the context handed to `start`. */
  readonly stop: () => void;
};

// A minor, because "epic" in eight notes is a minor arpeggio and everyone
// knows it: A3 · C4 · E4 · A4 · B4 · A4 · E4 · C4, over an A2 drone.
const SEQUENCE_HZ = [220, 261.63, 329.63, 440, 493.88, 440, 329.63, 261.63] as const;
const DRONE_HZ = 110;
const STEP_S = 0.24;
const LOOP_S = SEQUENCE_HZ.length * STEP_S;

// Quiet on purpose: this opens without being asked for, on a surface someone
// may be showing a colleague. Loud enough to be a joke, not loud enough to be
// an incident.
const PEAK_GAIN = 0.06;
const DRONE_GAIN = 0.025;
// Ramp constant for the mute toggle. An instant gain jump clicks.
const MUTE_RAMP_S = 0.02;

/**
 * Start the soundtrack on `ctx`, which this function then OWNS — `stop()`
 * closes it. Never throws: a browser that refuses a node leaves the modal
 * silent rather than broken.
 */
export function startCreditsArpeggio(ctx: AudioContext, muted: boolean): CreditsArpeggio {
  const master = ctx.createGain();
  master.gain.value = muted ? 0 : PEAK_GAIN;
  master.connect(ctx.destination);

  const drone = ctx.createOscillator();
  const droneGain = ctx.createGain();
  drone.type = "sine";
  drone.frequency.value = DRONE_HZ;
  droneGain.gain.value = DRONE_GAIN / PEAK_GAIN;
  drone.connect(droneGain);
  droneGain.connect(master);

  // Every note oscillator is kept so `stop()` can silence one scheduled a
  // beat into the future — `onended` cannot be relied on for that, because a
  // note that has not started yet never ends.
  const voices: OscillatorNode[] = [drone];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleNote = (hz: number, at: number): void => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = hz;
    // Pluck: near-instant attack, exponential decay over the step. Exponential
    // because a linear fade on a plucked tone reads as a cut.
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(1, at + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, at + STEP_S * 0.9);
    osc.connect(env);
    env.connect(master);
    osc.start(at);
    osc.stop(at + STEP_S);
    voices.push(osc);
    osc.onended = (): void => {
      const i = voices.indexOf(osc);
      if (i !== -1) voices.splice(i, 1);
      osc.disconnect();
      env.disconnect();
    };
  };

  // One loop is scheduled ahead at a time, then re-armed. A per-note timer
  // would put the rhythm on the main thread's mercy; scheduling the whole bar
  // against `ctx.currentTime` keeps it on the audio clock, where it belongs.
  const scheduleLoop = (): void => {
    if (stopped) return;
    const base = ctx.currentTime;
    SEQUENCE_HZ.forEach((hz, i) => {
      scheduleNote(hz, base + i * STEP_S);
    });
    timer = setTimeout(scheduleLoop, LOOP_S * 1000);
  };

  try {
    if (ctx.state === "suspended") void ctx.resume();
    drone.start();
    scheduleLoop();
  } catch {
    // A browser that refuses to start the graph gets a silent modal, not a
    // broken one. Nothing below depends on the loop having armed.
  }

  return {
    setMuted: (next: boolean): void => {
      if (stopped) return;
      master.gain.setTargetAtTime(next ? 0 : PEAK_GAIN, ctx.currentTime, MUTE_RAMP_S);
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const voice of voices) {
        try {
          voice.stop();
        } catch {
          // Already stopped, or never started. Either way it is silent.
        }
        voice.disconnect();
      }
      voices.length = 0;
      master.disconnect();
      void ctx.close();
    },
  };
}
