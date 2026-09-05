/**
 * StubTranscriber — deterministic, offline, free. Generates a plausible
 * word-timed transcript from a media asset's duration so the full pipeline
 * (ingest → understand → Director → render) is buildable and testable without
 * downloading a Whisper model. Swap for FasterWhisperTranscriber later; same
 * `Transcriber` interface, so nothing downstream changes.
 */
import type { MediaAsset } from "@cadence/core";
import type { Transcript, TranscriptSegment, Word } from "./transcript.js";
import type { Transcriber } from "./transcript.js";

const WORD_POOL = [
  "so", "today", "we're", "going", "to", "talk", "about", "the", "thing", "that",
  "actually", "matters", "here", "and", "honestly", "it", "changed", "everything",
  "for", "me", "let", "me", "show", "you", "exactly", "how", "this", "works",
  "because", "most", "people", "get", "it", "completely", "wrong", "but", "once",
  "you", "see", "the", "trick", "it", "becomes", "obvious", "right", "okay", "watch",
];

/** Tiny deterministic RNG (mulberry32) so the same media always yields the same transcript. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class StubTranscriber implements Transcriber {
  async transcribe(media: MediaAsset): Promise<Transcript> {
    const duration = media.durationSec ?? 120;
    const rng = makeRng(seedFrom(media.id));

    const words: Word[] = [];
    const segments: TranscriptSegment[] = [];

    let t = 0.5; // small lead-in
    let wordIdx = 0;
    let segIdx = 0;

    while (t < duration - 0.5) {
      const segWordCount = 8 + Math.floor(rng() * 7); // 8..14 words
      const segWords: Word[] = [];
      const segStart = t;

      for (let i = 0; i < segWordCount && t < duration - 0.5; i++) {
        const dur = 0.26 + rng() * 0.22; // 0.26..0.48s per word
        const word: Word = {
          text: WORD_POOL[wordIdx % WORD_POOL.length]!,
          start: round(t),
          end: round(t + dur),
        };
        words.push(word);
        segWords.push(word);
        t += dur;
        wordIdx++;
      }

      if (segWords.length > 0) {
        const segEnd = segWords[segWords.length - 1]!.end;
        segments.push({
          id: `seg${segIdx}`,
          text: segWords.map((w) => w.text).join(" "),
          start: round(segStart),
          end: round(segEnd),
          words: segWords,
          score: round(rng()),
        });
        segIdx++;
      }

      t += 0.3 + rng() * 0.5; // inter-segment gap 0.3..0.8s
    }

    return {
      mediaId: media.id,
      durationSec: round(duration),
      language: "en",
      segments,
      words,
    };
  }
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
