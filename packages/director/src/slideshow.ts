/**
 * Slideshow builder — turn a group of photos into a video: each still gets a
 * duration, a Ken Burns move, and a crossfade into the next. This is creation,
 * not editing: no source video or transcript required.
 */
import { parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import { LOOK_PRESETS, type LookKey } from "./edits";

export interface SlideshowOptions {
  perImageSec?: number;
  crossfadeSec?: number;
  width?: number;
  height?: number;
  look?: LookKey;
  title?: string;
}

/** Alternating Ken Burns moves so consecutive stills don't feel static. */
function kenBurnsFor(i: number): { zoom: number; panX: number; panY: number } {
  const moves = [
    { zoom: 1.14, panX: 0.05, panY: 0.0 },
    { zoom: 1.12, panX: -0.05, panY: 0.03 },
    { zoom: 1.16, panX: 0.0, panY: -0.05 },
    { zoom: 1.1, panX: 0.04, panY: 0.04 },
  ];
  return moves[i % moves.length]!;
}

export function buildSlideshowDoc(images: MediaAsset[], opts: SlideshowOptions = {}): EditDoc {
  if (images.length === 0) throw new Error("Add some photos first to make a slideshow.");
  const per = opts.perImageSec ?? 3.2;
  const xf = opts.crossfadeSec ?? 0.6;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const look = opts.look ? LOOK_PRESETS[opts.look] : null;

  const clips: unknown[] = [];
  let pos = 0;
  images.forEach((img, i) => {
    const start = i === 0 ? 0 : pos;
    clips.push({
      id: `img${i}`,
      kind: "image",
      start: round(start),
      duration: round(per),
      mediaId: img.id,
      transform: { x: width / 2, y: height / 2 },
      transitionInSec: i === 0 ? 0 : xf,
      motion: kenBurnsFor(i),
      ...(look
        ? { look: { brightness: look.brightness, contrast: look.contrast, saturation: look.saturation, warmth: look.warmth } }
        : {}),
    });
    pos = start + per - xf;
  });

  const totalDur = pos + xf;
  const tracks: unknown[] = [{ id: "photos", kind: "visual", clips }];

  if (opts.title) {
    tracks.push({
      id: "titles",
      kind: "visual",
      clips: [
        {
          id: "title",
          kind: "text",
          start: 0,
          duration: Math.min(2.6, totalDur),
          text: opts.title,
          fontSize: Math.round(height * 0.08),
          color: "#ffffff",
          align: "center",
          transform: { x: width / 2, y: height / 2 },
          transitionInSec: 0.4,
        },
      ],
    });
  }

  return parseEditDoc({
    version: 1,
    meta: { title: opts.title ?? "Slideshow", width, height, fps: 30, background: "#0a0d12" },
    media: images,
    tracks,
  });
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
