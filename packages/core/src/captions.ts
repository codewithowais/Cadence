/**
 * Caption sidecar export — PURE EditDoc → SRT / WebVTT text. No I/O.
 *
 * These are the CANONICAL caption serializers (a client-side helper also exists
 * in the web app for the UI, but this core version is the source of truth for the
 * export). Captions come from the "captions" track's text clips (falling back to
 * every text clip when there is no dedicated captions track), ordered by start.
 * Timestamps are formatted per each spec:
 *   - SRT : hh:mm:ss,mmm  (comma before milliseconds)
 *   - VTT : hh:mm:ss.mmm  (dot before milliseconds), under a "WEBVTT" header.
 */
import type { EditDoc, TextClip } from "./schema";

/** Zero-pad an integer to `width` digits. */
function pad(n: number, width: number): string {
  return String(Math.floor(n)).padStart(width, "0");
}

/**
 * Format a non-negative time in seconds as `hh:mm:ss{sep}mmm`. `sep` is "," for
 * SRT and "." for VTT. Deterministic; milliseconds are floored to the frame the
 * caller passes (seconds), never rounded past a boundary.
 */
export function formatTimestamp(sec: number, sep: "," | "."): string {
  const clamped = Math.max(0, sec);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = (totalMs - ms) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(ms, 3)}`;
}

/** The ordered caption text clips for a doc (captions track, else all text clips). */
export function captionClips(doc: EditDoc): TextClip[] {
  const captionsTrack = doc.tracks.find((t) => t.id === "captions");
  const source = captionsTrack
    ? captionsTrack.clips
    : doc.tracks.flatMap((t) => t.clips);
  return source
    .filter((c): c is TextClip => c.kind === "text" && c.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);
}

/** Serialize a doc's captions to SubRip (.srt) text. Empty string when none. */
export function toSrt(doc: EditDoc): string {
  const clips = captionClips(doc);
  const blocks = clips.map((c, i) => {
    const start = formatTimestamp(c.start, ",");
    const end = formatTimestamp(c.start + c.duration, ",");
    return `${i + 1}\n${start} --> ${end}\n${c.text.trim()}`;
  });
  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}

/** Serialize a doc's captions to WebVTT (.vtt) text (always has the WEBVTT header). */
export function toVtt(doc: EditDoc): string {
  const clips = captionClips(doc);
  const blocks = clips.map((c) => {
    const start = formatTimestamp(c.start, ".");
    const end = formatTimestamp(c.start + c.duration, ".");
    return `${start} --> ${end}\n${c.text.trim()}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}
