/**
 * Transcriber factory — FREE-FIRST + GRACEFUL. Returns the real local
 * `WhisperTranscriber` ONLY when both a Whisper CLI and ffmpeg are available;
 * otherwise falls back to the deterministic, offline `StubTranscriber`. The
 * Director and API depend only on the `Transcriber` interface, so this swap is
 * invisible downstream.
 */
import type { Transcriber } from "./transcript";
import { StubTranscriber } from "./stub-transcriber";
import { WhisperTranscriber } from "./whisper-transcriber";

/**
 * Pick the best available transcriber. Async because availability is probed by
 * spawning `which`/`ffmpeg -version` (never throws — a missing Whisper simply
 * yields the Stub).
 */
export async function pickTranscriber(): Promise<Transcriber> {
  const whisper = new WhisperTranscriber();
  if (await whisper.isAvailable()) return whisper;
  return new StubTranscriber();
}

/** Alias for `pickTranscriber` — the conventional factory name. */
export const createTranscriber = pickTranscriber;
