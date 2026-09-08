import { describe, expect, it } from "vitest";
import {
  encodePcm16Wav,
  MAX_CAPTURE_FRAMES,
  PCM_SAMPLE_RATE,
  resampleMonoPcm
} from "./voice-capture";

describe("safe browser PCM capture", () => {
  it("encodes a canonical bounded mono PCM16 WAV", async () => {
    const wav = encodePcm16Wav(new Float32Array([0, 1, -1]));
    const bytes = new Uint8Array(await wav.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(wav.type).toBe("audio/wav");
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(PCM_SAMPLE_RATE);
    expect(view.getUint32(40, true)).toBe(6);
  });

  it("resamples and caps microphone frames at sixty seconds", () => {
    expect(resampleMonoPcm(new Float32Array(48_000), 48_000)).toHaveLength(
      PCM_SAMPLE_RATE
    );
    expect(
      resampleMonoPcm(new Float32Array(MAX_CAPTURE_FRAMES + 1), PCM_SAMPLE_RATE)
    ).toHaveLength(MAX_CAPTURE_FRAMES);
    expect(() => encodePcm16Wav(new Float32Array(0))).toThrow(/recording/i);
  });
});
