export const PCM_SAMPLE_RATE = 16_000;
export const MAX_CAPTURE_SECONDS = 60;
export const MAX_CAPTURE_FRAMES = PCM_SAMPLE_RATE * MAX_CAPTURE_SECONDS;

export function resampleMonoPcm(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = PCM_SAMPLE_RATE
): Float32Array {
  if (
    !Number.isInteger(sourceSampleRate) ||
    !Number.isInteger(targetSampleRate) ||
    sourceSampleRate < 8_000 ||
    targetSampleRate < 8_000
  ) {
    throw new Error("Unsupported microphone sample rate");
  }
  if (sourceSampleRate === targetSampleRate)
    return samples.slice(0, MAX_CAPTURE_FRAMES);
  const outputLength = Math.min(
    MAX_CAPTURE_FRAMES,
    Math.floor((samples.length * targetSampleRate) / sourceSampleRate)
  );
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = (index * sourceSampleRate) / targetSampleRate;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, samples.length - 1);
    const fraction = position - lower;
    output[index] =
      (samples[lower] ?? 0) * (1 - fraction) + (samples[upper] ?? 0) * fraction;
  }
  return output;
}

export function encodePcm16Wav(samples: Float32Array): Blob {
  if (samples.length === 0 || samples.length > MAX_CAPTURE_FRAMES) {
    throw new Error("A recording must be between 1 frame and 60 seconds");
  }
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(28, PCM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(normalized * 32767), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}
