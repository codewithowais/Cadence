"use client";

import { useEffect, useRef, useState } from "react";

interface VoiceOverRecorderProps {
  disabled?: boolean;
  /** Called with the recorded audio File and its measured duration (seconds). */
  onRecorded: (file: File, durationSec: number) => void;
}

/** mm:ss for the live recording timer. */
function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Record a voice-over from the microphone via getUserMedia + MediaRecorder.
 * Everything is client-side: on stop we hand the caller a real audio File plus
 * the measured duration (MediaRecorder's webm output often reports an Infinity
 * duration when probed, so we time the take ourselves). Degrades gracefully:
 * unsupported browsers and denied-permission both surface an inline message and
 * never throw.
 */
export function VoiceOverRecorder({ disabled, onRecorded }: VoiceOverRecorderProps) {
  const [state, setState] = useState<"idle" | "recording">("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  // Stop the mic + timer if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      window.clearInterval(timerRef.current);
      try {
        if (recRef.current?.state === "recording") recRef.current.stop();
      } catch {
        /* noop */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Voice-over recording isn't supported in this browser. Upload an audio file instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission denied. Allow mic access in your browser, then try again — or upload an audio file."
          : name === "NotFoundError"
            ? "No microphone found. Plug one in, or upload an audio file instead."
            : "Couldn't start the microphone. Upload an audio file instead.",
      );
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream);
    } catch {
      setError("Couldn't start recording in this browser. Upload an audio file instead.");
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    recRef.current = rec;
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    rec.onstop = () => {
      window.clearInterval(timerRef.current);
      const durSec = Math.max(0.1, Math.round(((Date.now() - startRef.current) / 1000) * 1000) / 1000);
      stream.getTracks().forEach((t) => t.stop());
      const type = rec.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      setState("idle");
      setElapsed(0);
      if (blob.size > 0) {
        const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `voiceover-${Date.now()}.${ext}`, { type });
        onRecorded(file, durSec);
      } else {
        setError("That recording came out empty. Try again.");
      }
    };
    startRef.current = Date.now();
    try {
      rec.start();
    } catch {
      setError("Couldn't start recording. Upload an audio file instead.");
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    setState("recording");
    setElapsed(0);
    timerRef.current = window.setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), 200);
  }

  function stop() {
    try {
      recRef.current?.stop();
    } catch {
      /* noop */
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      {state === "recording" ? (
        <button
          type="button"
          onClick={stop}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/15 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-500/25"
        >
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" aria-hidden />
          Stop · {fmt(elapsed)}
        </button>
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={disabled}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
          Record voice-over
        </button>
      )}
      {error && (
        <span role="alert" className="max-w-[280px] shrink-0 text-[11px] leading-tight text-red-300">
          {error}
        </span>
      )}
    </span>
  );
}
