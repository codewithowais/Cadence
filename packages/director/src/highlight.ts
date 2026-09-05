/**
 * Deterministic "highlight cut" skill. Given a source video + its transcript,
 * select the most salient segments up to a target duration and lay them
 * back-to-back into a valid edit-doc. This is a real editorial operation — the
 * stub Director's brain is rules, not an LLM, but the OUTPUT is a genuine,
 * editable edit-doc, identical in shape to what the real Claude Director emits.
 */
import { parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

export interface HighlightOptions {
  targetSec: number;
  width?: number;
  height?: number;
  fps?: number;
  title?: string;
}

interface Chosen {
  start: number;
  duration: number;
}

function selectSegments(transcript: Transcript, targetSec: number): Chosen[] {
  const withDur = transcript.segments.map((s) => ({
    start: s.start,
    duration: Math.max(0.1, s.end - s.start),
    score: s.score ?? s.end - s.start,
  }));
  // Rank by salience, take until we reach the target, then restore chronology.
  const ranked = [...withDur].sort((a, b) => b.score - a.score);
  const picked: typeof withDur = [];
  let total = 0;
  for (const seg of ranked) {
    if (total >= targetSec) break;
    picked.push(seg);
    total += seg.duration;
  }
  picked.sort((a, b) => a.start - b.start);
  return picked.map(({ start, duration }) => ({ start, duration }));
}

export function buildHighlightDoc(
  media: MediaAsset,
  transcript: Transcript,
  opts: HighlightOptions,
): EditDoc {
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const chosen = selectSegments(transcript, opts.targetSec);

  // Build clips as plain doc-data; parseEditDoc validates and fills defaults
  // (transform, volume). This is the edits-as-code flow: emit data, not objects.
  const clips: Array<Record<string, unknown>> = [];
  let timelinePos = 0;
  for (let i = 0; i < chosen.length; i++) {
    const seg = chosen[i]!;
    clips.push({
      id: `hl${i}`,
      kind: "video",
      start: round(timelinePos),
      duration: round(seg.duration),
      mediaId: media.id,
      sourceIn: round(seg.start),
      // Center full-frame; the anchor is the clip's center.
      transform: { x: width / 2, y: height / 2 },
    });
    timelinePos += seg.duration;
  }

  const titleText = opts.title ?? "Highlights";
  const titleDuration = Math.min(2.5, Math.max(1, timelinePos));

  return parseEditDoc({
    version: 1,
    meta: {
      title: titleText,
      fps: opts.fps ?? 30,
      width,
      height,
      background: "#0e1116",
    },
    media: [media],
    tracks: [
      { id: "video", kind: "visual", clips },
      {
        id: "titles",
        kind: "visual",
        clips: [
          {
            id: "title",
            kind: "text",
            start: 0,
            duration: titleDuration,
            text: titleText,
            fontSize: 84,
            color: "#ffcf70",
            align: "center",
            transform: { x: width / 2, y: height - 120 },
          },
        ],
      },
    ],
  });
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
