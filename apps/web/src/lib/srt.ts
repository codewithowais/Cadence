import type { Clip, EditDoc } from "@cadence/core";

/**
 * Client-side SubRip (.srt) generation from an edit-doc's captions.
 *
 * The captions live as `text` clips on the dedicated "captions" track (that's how
 * the Director lays them down). This is a small, local generator so the Deliver
 * room can offer a caption sidecar download today without waiting on a core
 * `toSrt` — it can be swapped for the engine's version later with no UI change.
 * Pure: reads the doc, returns a string. No I/O, no side effects.
 */

/** The track ids that carry burned/soft caption text, in preference order. */
const CAPTION_TRACK_IDS = ["captions"] as const;

interface Cue {
  start: number;
  end: number;
  text: string;
}

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");

/** Format a timeline second as an SRT timestamp: hh:mm:ss,mmm. */
export function srtTimestamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

/** Collect caption cues (start/end/text) from the doc's captions track, in order. */
export function captionCues(doc: EditDoc): Cue[] {
  const track = doc.tracks.find((t) => CAPTION_TRACK_IDS.includes(t.id as (typeof CAPTION_TRACK_IDS)[number]));
  if (!track) return [];
  return track.clips
    .filter((c): c is Extract<Clip, { kind: "text" }> => c.kind === "text")
    .map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text.trim() }))
    .filter((c) => c.text.length > 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start);
}

/** True when the doc has at least one non-empty caption cue to export. */
export function hasCaptions(doc: EditDoc): boolean {
  return captionCues(doc).length > 0;
}

/**
 * Build a full SubRip document from the doc's captions. Returns "" when there are
 * no captions, so callers can guard the download.
 */
export function captionsToSrt(doc: EditDoc): string {
  const cues = captionCues(doc);
  if (cues.length === 0) return "";
  const blocks = cues.map(
    (c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}`,
  );
  // Trailing newline is conventional and keeps players that expect it happy.
  return blocks.join("\n\n") + "\n";
}
