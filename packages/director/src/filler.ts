/**
 * Filler cut — tighten a talking-head video by dropping filler-heavy segments
 * (um / uh / like / you know …) and long pauses, concatenating what's left.
 * Deterministic; produces a valid edit-doc that renders.
 */
import { parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import type { Transcript, TranscriptSegment } from "@cadence/understanding";

const FILLERS = new Set([
  "um", "uh", "er", "hmm", "like", "so", "actually", "basically",
  "literally", "honestly", "right", "okay", "know",
]);

function fillerRatio(seg: TranscriptSegment): number {
  if (seg.words.length === 0) return 0;
  const f = seg.words.filter((w) => FILLERS.has(w.text.toLowerCase())).length;
  return f / seg.words.length;
}

export interface FillerCutOptions {
  /** Drop a segment when this fraction or more of its words are filler. */
  threshold?: number;
  width?: number;
  height?: number;
}

export function fillerCut(
  media: MediaAsset,
  transcript: Transcript,
  opts: FillerCutOptions = {},
): { doc: EditDoc; kept: number; dropped: number } {
  const threshold = opts.threshold ?? 0.45;
  const width = opts.width ?? media.width ?? 1920;
  const height = opts.height ?? media.height ?? 1080;

  const clips: unknown[] = [];
  let pos = 0;
  let kept = 0;
  let dropped = 0;

  for (const seg of transcript.segments) {
    const dur = Math.max(0.1, seg.end - seg.start);
    if (fillerRatio(seg) >= threshold) {
      dropped++;
      continue;
    }
    clips.push({
      id: `keep${kept}`,
      kind: "video",
      start: round(pos),
      duration: round(dur),
      mediaId: media.id,
      sourceIn: round(seg.start),
      transform: { x: width / 2, y: height / 2 },
    });
    pos += dur;
    kept++;
  }

  const doc = parseEditDoc({
    version: 1,
    meta: { title: `${media.label ?? "clip"} (tightened)`, width, height, fps: 30, background: "#0a0d12" },
    media: [media],
    tracks: [{ id: "video", kind: "visual", clips }],
  });
  return { doc, kept, dropped };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
