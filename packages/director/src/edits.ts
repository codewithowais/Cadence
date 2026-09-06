/**
 * Pure edit-doc transforms — the editorial operations, expressed as
 * doc-in / doc-out functions. Each is deterministic and re-parsed through the
 * schema so the result is always valid. Tools (tools.ts) wrap these; the real
 * Claude Director will call the same operations.
 */
import { docDurationSec, parseEditDoc, type ColorGrade, type EditDoc, type MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

const round = (n: number): number => Math.round(n * 1000) / 1000;

// ---- Aspect ratios ---------------------------------------------------------

export type AspectKey = "9:16" | "1:1" | "4:5" | "16:9";

export const ASPECTS: Record<AspectKey, { width: number; height: number; label: string }> = {
  "9:16": { width: 1080, height: 1920, label: "vertical (Reels/Shorts/TikTok)" },
  "1:1": { width: 1080, height: 1080, label: "square (feed)" },
  "4:5": { width: 1080, height: 1350, label: "portrait (feed)" },
  "16:9": { width: 1920, height: 1080, label: "widescreen" },
};

/** Reframe to a new aspect: resize the composition and re-anchor every clip. */
export function reframe(doc: EditDoc, aspect: AspectKey): EditDoc {
  const target = ASPECTS[aspect];
  const oldW = doc.meta.width;
  const oldH = doc.meta.height;
  const clone: EditDoc = structuredClone(doc);
  clone.meta.width = target.width;
  clone.meta.height = target.height;

  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") {
        // Media is frame-cover: center it in the new frame.
        clip.transform.x = target.width / 2;
        clip.transform.y = target.height / 2;
      } else if (clip.kind === "text") {
        // Keep text at the same relative position.
        clip.transform.x = (clip.transform.x / oldW) * target.width;
        clip.transform.y = (clip.transform.y / oldH) * target.height;
      }
    }
  }
  return parseEditDoc(clone);
}

// ---- Looks -----------------------------------------------------------------

export type LookKey =
  | "warm" | "cool" | "vivid" | "bw" | "cinematic" | "vintage" | "noir" | "vibrant" | "none";

export const LOOK_PRESETS: Record<LookKey, ColorGrade & { label: string }> = {
  warm: { brightness: 1.03, contrast: 1.05, saturation: 1.08, warmth: 0.5, label: "warm & golden" },
  cool: { brightness: 1.0, contrast: 1.06, saturation: 1.04, warmth: 0.0, label: "cool & crisp" },
  vivid: { brightness: 1.02, contrast: 1.1, saturation: 1.35, warmth: 0.1, label: "punchy & vivid" },
  bw: { brightness: 1.02, contrast: 1.12, saturation: 0, warmth: 0, label: "black & white" },
  cinematic: { brightness: 0.98, contrast: 1.14, saturation: 0.95, warmth: 0.22, label: "cinematic teal-amber" },
  vintage: { brightness: 1.02, contrast: 0.95, saturation: 0.82, warmth: 0.55, label: "vintage film" },
  noir: { brightness: 0.96, contrast: 1.22, saturation: 0, warmth: 0, label: "high-contrast noir" },
  vibrant: { brightness: 1.04, contrast: 1.08, saturation: 1.45, warmth: 0.12, label: "vibrant pop" },
  none: { brightness: 1, contrast: 1, saturation: 1, warmth: 0, label: "no grade" },
};

/** Apply a color grade preset to every visual media clip. */
export function applyLook(doc: EditDoc, look: LookKey): EditDoc {
  const preset = LOOK_PRESETS[look];
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") {
        clip.look = {
          brightness: preset.brightness,
          contrast: preset.contrast,
          saturation: preset.saturation,
          warmth: preset.warmth,
        };
      }
    }
  }
  return parseEditDoc(clone);
}

// ---- Captions --------------------------------------------------------------

/**
 * Burn-in captions from the transcript, mapped through the current cuts. For
 * each video clip we take the transcript segments that fall inside its source
 * range and place a caption at the corresponding timeline time, so captions stay
 * in sync even after cutting/reordering.
 */
export function addCaptions(doc: EditDoc, transcript: Transcript): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  // Remove any prior captions track so re-running is idempotent.
  clone.tracks = clone.tracks.filter((t) => t.id !== "captions");

  const h = clone.meta.height;
  const w = clone.meta.width;
  // Size to the frame so captions fit in portrait as well as landscape.
  const fontSize = Math.round(Math.min(h * 0.05, w * 0.058));
  const maxChars = Math.max(16, Math.floor((w * 0.92) / (fontSize * 0.52)));
  const captions: unknown[] = [];
  let n = 0;

  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      const srcStart = clip.sourceIn;
      const srcEnd = clip.sourceIn + clip.duration;
      for (const seg of transcript.segments) {
        const s = Math.max(seg.start, srcStart);
        const e = Math.min(seg.end, srcEnd);
        if (e - s < 0.25) continue;
        const tlStart = clip.start + (s - srcStart);
        captions.push({
          id: `cap${n++}`,
          kind: "text",
          start: Math.round(tlStart * 1000) / 1000,
          duration: Math.round((e - s) * 1000) / 1000,
          text: seg.text.length > maxChars ? seg.text.slice(0, maxChars - 1) + "…" : seg.text,
          fontSize,
          color: "#ffffff",
          background: "#0a0d12cc",
          align: "center",
          transform: { x: w / 2, y: h - Math.round(h * 0.12) },
          transitionInSec: 0.12,
        });
      }
    }
  }

  clone.tracks.push({ id: "captions", kind: "visual", clips: captions as never });
  return parseEditDoc(clone);
}

// ---- Auto-mix --------------------------------------------------------------

/** Level audio: normalize speech to full, duck any music track under it. */
export function autoMix(doc: EditDoc): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const hasMusic = clone.tracks.some((t) => t.id === "music");
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "video") clip.volume = 1;
      if (clip.kind === "audio") clip.volume = track.id === "music" ? 0.28 : 1;
    }
  }
  return parseEditDoc(clone);
}

// ---- Quality ---------------------------------------------------------------

export type QualityKey = "standard" | "high" | "ultra";

export function setQuality(doc: EditDoc, preset: QualityKey, aiUpscale = false): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const baseW = clone.meta.width;
  const baseH = clone.meta.height;
  const table: Record<QualityKey, { scale: number; sharpen: number; denoise: number }> = {
    standard: { scale: 1, sharpen: 0, denoise: 0 },
    high: { scale: Math.max(1, Math.round((2560 / baseW) * 100) / 100), sharpen: 0.3, denoise: 0.2 },
    ultra: { scale: Math.max(1, Math.round((3840 / baseW) * 100) / 100), sharpen: 0.5, denoise: 0.35 },
  };
  const q = table[preset];
  clone.quality = {
    preset,
    targetWidth: Math.round((baseW * q.scale) / 2) * 2,
    targetHeight: Math.round((baseH * q.scale) / 2) * 2,
    sharpen: q.sharpen,
    denoise: q.denoise,
    aiUpscale,
    faithful: true,
  };
  return parseEditDoc(clone);
}

// ---- Titles ----------------------------------------------------------------

export type TitleStyle = "card" | "lower-third";

/** Add a title card or lower-third at the start, with a fade in/out. */
export function addTitle(doc: EditDoc, text: string, style: TitleStyle = "card"): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const w = clone.meta.width;
  const h = clone.meta.height;
  const id = `title-${Date.now()}`;
  const clip =
    style === "lower-third"
      ? {
          id, kind: "text" as const, start: 0, duration: 3,
          text, fontSize: Math.round(h * 0.045), color: "#ffffff", align: "left" as const,
          background: "#0a0d12cc",
          transform: { x: Math.round(w * 0.06), y: Math.round(h * 0.82) },
          transitionInSec: 0.3, transitionOutSec: 0.3,
        }
      : {
          id, kind: "text" as const, start: 0, duration: 2.8,
          text, fontSize: Math.round(h * 0.09), color: "#ffffff", align: "center" as const,
          transform: { x: w / 2, y: h / 2 },
          transitionInSec: 0.4, transitionOutSec: 0.4,
        };

  let titles = clone.tracks.find((t) => t.id === "titles");
  if (!titles) {
    titles = { id: "titles", kind: "visual", clips: [] };
    clone.tracks.push(titles);
  }
  (titles.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

// ---- Background music ------------------------------------------------------

/**
 * Add a background-music track referencing an audio asset. The music clip spans
 * the whole timeline and starts ducked (low volume) so speech stays on top;
 * auto_mix re-asserts the duck. Music has no visual — it is silent in the canvas
 * preview but honored by the ffmpeg export (amix). Re-running replaces the track.
 */
export function addMusic(
  doc: EditDoc,
  asset: MediaAsset,
  opts: { volume?: number; startSec?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  // Ensure the audio asset is present in the doc's media so the export can find it.
  if (!clone.media.some((m) => m.id === asset.id)) clone.media.push(asset);
  clone.tracks = clone.tracks.filter((t) => t.id !== "music");

  const total = docDurationSec(clone) || asset.durationSec || 30;
  const clip = {
    id: `music-${Date.now()}`,
    kind: "audio" as const,
    start: Math.max(0, opts.startSec ?? 0),
    duration: round(total),
    mediaId: asset.id,
    sourceIn: 0,
    volume: opts.volume ?? 0.28,
  };
  clone.tracks.push({ id: "music", kind: "audio", clips: [clip as never] });
  return parseEditDoc(clone);
}

// ---- B-roll / overlay (picture-in-picture) ---------------------------------

export type BrollCorner = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * Overlay a b-roll image or video clip as a smaller picture-in-picture over the
 * main clip for [atSec, atSec+durationSec]. It lives on the top "broll" visual
 * track (painted last, so it sits over everything) with a fractional scale and a
 * corner-anchored transform. Faithful: it composites an existing clip, unchanged.
 */
export function addBroll(
  doc: EditDoc,
  asset: MediaAsset,
  opts: { atSec?: number; durationSec?: number; corner?: BrollCorner; size?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  if (!clone.media.some((m) => m.id === asset.id)) clone.media.push(asset);

  const W = clone.meta.width;
  const H = clone.meta.height;
  const size = Math.max(0.1, Math.min(1, opts.size ?? 0.35));
  const atSec = Math.max(0, opts.atSec ?? 0);
  const durationSec = Math.max(0.1, opts.durationSec ?? Math.min(4, docDurationSec(clone) || 4));
  const corner: BrollCorner = opts.corner ?? "center";

  // Anchor is the clip CENTER; margin keeps the PiP box inside the frame.
  const margin = 0.04;
  const half = size / 2;
  const cx: Record<BrollCorner, number> = {
    center: 0.5,
    "top-left": half + margin,
    "top-right": 1 - half - margin,
    "bottom-left": half + margin,
    "bottom-right": 1 - half - margin,
  };
  const cy: Record<BrollCorner, number> = {
    center: 0.5,
    "top-left": half + margin,
    "top-right": half + margin,
    "bottom-left": 1 - half - margin,
    "bottom-right": 1 - half - margin,
  };

  const clip: Record<string, unknown> = {
    id: `broll-${Date.now()}`,
    kind: asset.kind === "video" ? "video" : "image",
    start: round(atSec),
    duration: round(durationSec),
    mediaId: asset.id,
    transform: { x: round(cx[corner] * W), y: round(cy[corner] * H), scale: round(size) },
    transitionInSec: 0.25,
    transitionOutSec: 0.25,
  };
  if (asset.kind === "video") clip.sourceIn = 0;

  let broll = clone.tracks.find((t) => t.id === "broll");
  if (!broll) {
    broll = { id: "broll", kind: "visual", clips: [] };
    clone.tracks.push(broll);
  }
  (broll.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

// ---- Kinetic (animated) titles ---------------------------------------------

/**
 * Add a kinetic title that slides up and scales in, then holds. The animation is
 * pure data on the text clip (`anim`), resolved deterministically by
 * `textKinetic` in core — so canvas, Stage, and export agree.
 */
export function addKineticTitle(doc: EditDoc, text: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const w = clone.meta.width;
  const h = clone.meta.height;
  const animDur = 0.6;
  const clip = {
    id: `ktitle-${Date.now()}`,
    kind: "text" as const,
    start: 0,
    duration: 3,
    text,
    fontSize: Math.round(h * 0.09),
    color: "#ffffff",
    align: "center" as const,
    transform: { x: w / 2, y: h / 2 },
    transitionInSec: 0.25,
    transitionOutSec: 0.4,
    // Slide up from below (+8% of height) and grow from 0.6 over the intro.
    anim: { style: "kinetic" as const, fromX: 0, fromY: Math.round(h * 0.08), fromScale: 0.6, durationSec: animDur },
  };

  let titles = clone.tracks.find((t) => t.id === "titles");
  if (!titles) {
    titles = { id: "titles", kind: "visual", clips: [] };
    clone.tracks.push(titles);
  }
  (titles.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

// ---- Punch-in emphasis -----------------------------------------------------

/**
 * Set a punch-in emphasis (scale pulse) on the video clip active at `atSec`. The
 * emphasis is pure data on the clip (`emphasis`), resolved by `emphasisScale` in
 * core so canvas, Stage, and export scale identically. Faithful: only zooms the
 * existing frame up and back.
 */
export function addEmphasis(
  doc: EditDoc,
  opts: { atSec?: number; durationSec?: number; zoom?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const durationSec = Math.max(0.2, opts.durationSec ?? 2);
  const zoom = Math.max(1, opts.zoom ?? 1.25);
  const atSec = Math.max(0, opts.atSec ?? 0);

  // Find the video clip whose timeline range contains atSec (fallback: first video).
  let target: { start: number; duration: number; emphasis?: unknown } | null = null;
  for (const track of clone.tracks) {
    if (track.id === "broll") continue; // don't punch-in the PiP itself
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      if (atSec >= clip.start && atSec < clip.start + clip.duration) {
        target = clip;
        break;
      }
      if (!target) target = clip; // remember the first as a fallback
    }
    if (target && atSec >= target.start && atSec < target.start + target.duration) break;
  }
  if (!target) throw new Error("Add a video first — punch-in needs footage.");

  // Clamp the window to the clip so the pulse fully lands inside it.
  const winStart = Math.max(atSec, target.start);
  const winEnd = Math.min(winStart + durationSec, target.start + target.duration);
  target.emphasis = { atSec: round(winStart), durationSec: round(Math.max(0.2, winEnd - winStart)), zoom: round(zoom) };
  return parseEditDoc(clone);
}

// ---- Fades -----------------------------------------------------------------

/** Add a fade from black at the start and a fade to black at the end. */
export function addFades(doc: EditDoc, inSec = 0.6, outSec = 0.6): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const total = docDurationSec(clone);
  if (total <= 0) return clone;
  const clips: unknown[] = [
    { id: "fade-in", kind: "solid", start: 0, duration: Math.min(inSec, total), color: "#000000", transitionOutSec: Math.min(inSec, total) },
  ];
  if (total > outSec) {
    clips.push({ id: "fade-out", kind: "solid", start: total - outSec, duration: outSec, color: "#000000", transitionInSec: outSec });
  }
  clone.tracks = clone.tracks.filter((t) => t.id !== "fades");
  clone.tracks.push({ id: "fades", kind: "visual", clips: clips as never });
  return parseEditDoc(clone);
}
