import { useRef, useState } from "react";
import { encodePcm16Wav, resampleMonoPcm } from "./voice-capture";

type CaptureState = "idle" | "recording" | "transcribing";

export function VoiceCaptureButton({
  onTranscript
}: {
  onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<CaptureState>("idle");
  const [error, setError] = useState<string>();
  const stopRef = useRef<(() => Promise<void>) | undefined>(undefined);

  async function start() {
    setError(undefined);
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      setError("This browser cannot record a PCM/WAV voice command.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 }
      });
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;
      const chunks: Float32Array[] = [];
      let frameCount = 0;
      const maxRawFrames = Math.floor(context.sampleRate * 60);
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        processor.disconnect();
        source.disconnect();
        silent.disconnect();
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        await context.close();
        setState("transcribing");
        try {
          const raw = new Float32Array(frameCount);
          let offset = 0;
          for (const chunk of chunks) {
            raw.set(chunk, offset);
            offset += chunk.length;
          }
          const wav = encodePcm16Wav(resampleMonoPcm(raw, context.sampleRate));
          const body = new FormData();
          body.set(
            "audio",
            new File([wav], "voice-command.wav", { type: "audio/wav" })
          );
          const response = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "x-request-id": crypto.randomUUID() },
            body
          });
          if (!response.ok)
            throw new Error("Voice transcription is unavailable.");
          const result: unknown = await response.json();
          const text =
            typeof (result as { text?: unknown })?.text === "string"
              ? (result as { text: string }).text.trim()
              : "";
          if (!text || text.length > 8_000)
            throw new Error("No usable speech was detected.");
          onTranscript(text);
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Voice transcription is unavailable."
          );
        } finally {
          stopRef.current = undefined;
          setState("idle");
        }
      };
      processor.onaudioprocess = (event) => {
        if (stopping) return;
        const input = event.inputBuffer.getChannelData(0);
        const remaining = maxRawFrames - frameCount;
        if (remaining <= 0) {
          void stop();
          return;
        }
        const chunk = input.slice(0, remaining);
        chunks.push(chunk);
        frameCount += chunk.length;
        if (frameCount >= maxRawFrames) void stop();
      };
      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      stopRef.current = stop;
      setState("recording");
    } catch {
      setError("Microphone access is required for a PCM/WAV voice command.");
      setState("idle");
    }
  }

  return (
    <div className="voice-capture">
      <button
        aria-pressed={state === "recording"}
        disabled={state === "transcribing"}
        onClick={() =>
          state === "recording" ? void stopRef.current?.() : void start()
        }
        type="button"
      >
        {state === "recording"
          ? "Stop recording"
          : state === "transcribing"
            ? "Transcribing…"
            : "Record voice command"}
      </button>
      <p>Records up to 60 seconds as PCM/WAV.</p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
