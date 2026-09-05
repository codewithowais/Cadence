/**
 * Transcript vocabulary — the primary "understanding" artifact the Director
 * reasons over. Times are seconds relative to the source media.
 */
import type { MediaAsset } from "@cadence/core";

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  words: Word[];
  /** Optional 0..1 confidence / salience the Director may use to rank. */
  score?: number;
}

export interface Transcript {
  mediaId: string;
  durationSec: number;
  language: string;
  segments: TranscriptSegment[];
  /** Flat word list (across all segments) for word-accurate cutting. */
  words: Word[];
}

/**
 * Anything that turns a media asset into a Transcript. Implementations:
 *  - StubTranscriber (deterministic, offline, free) — default for dev/tests.
 *  - (next) FasterWhisperTranscriber — local Whisper, free, real audio.
 * The Director depends only on this interface.
 */
export interface Transcriber {
  transcribe(media: MediaAsset): Promise<Transcript>;
}
