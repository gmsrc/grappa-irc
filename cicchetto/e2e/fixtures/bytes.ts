// Shared tiny-file byte fixtures for upload specs.
//
// 1×1 transparent RGBA PNG — VALID bytes (correct IDAT CRC), verified
// against the server's fail-closed exiftool strip. The previous
// inline copies of this constant (i2b / ux-6-b / rev-g-h22 specs)
// carried a corrupted IDAT chunk — bad CRC — that survived for months
// because nothing validated image bytes server-side; the #39 metadata
// strip (2026-06-10) rejects it with 422 metadata_strip_failed
// ("Bad CRC for IDAT chunk"). Keep ONE copy here so the next
// byte-level gate breaks one constant, not a scavenger hunt.
//
// Node context: Buffer.from(TINY_PNG_HEX, "hex"). In-page context:
// pass the string into page.evaluate and decode there.
export const TINY_PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082";

// #682 — a minimal, VALID MPEG-1 Layer III frame sequence, built rather than
// pasted: 417 bytes per frame at 128 kbps / 44.1 kHz, so a hex constant for
// even a few frames would be kilobytes of noise in a source file.
//
// Header bytes, for the next reader who has to check them against a spec
// sheet rather than trust a magic number:
//   FF FB — syncword + MPEG-1 + Layer III + no CRC
//   90    — 128 kbps, 44100 Hz, no padding
//   40    — joint stereo, no emphasis
// Frame size = floor(144 * 128000 / 44100) = 417.
//
// The payload is silence (zeroes). Specs use this to satisfy an <audio>
// element from a `page.route` handler, so that a radio station's stream is
// served LOCALLY and the suite never reaches a third-party host.
const MP3_FRAME_HEADER = [0xff, 0xfb, 0x90, 0x40];
const MP3_FRAME_BYTES = 417;

export function silentMp3(frames: number): Buffer {
  const frame = Buffer.alloc(MP3_FRAME_BYTES);
  for (const [i, byte] of MP3_FRAME_HEADER.entries()) frame[i] = byte;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}
