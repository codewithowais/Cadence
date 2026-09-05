/**
 * Pure edit-doc transforms — the editorial operations, expressed as
 * doc-in / doc-out functions. Each is deterministic and re-parsed through the
 * schema so the result is always valid. Tools (tools.ts) wrap these; the real
 * Claude Director will call the same operations.
 */
import { parseEditDoc, type ColorGrade, type EditDoc } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

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

export type LookKey = "warm" | "cool" | "vivid" | "bw" | "cinematic" | "none";

export const LOOK_PRESETS: Record<LookKey, ColorGrade & { label: string }> = {
  warm: { brightness: 1.03, contrast: 1.05, saturation: 1.08, warmth: 0.5, label: "warm & golden" },
  cool: { brightness: 1.0, contrast: 1.06, saturation: 1.04, warmth: 0.0, label: "cool & crisp" },
  vivid: { brightness: 1.02, contrast: 1.1, saturation: 1.35, warmth: 0.1, label: "punchy & vivid" },
  bw: { brightness: 1.02, contrast: 1.12, saturation: 0, warmth: 0, label: "black & white" },
  cinematic: { brightness: 0.98, contrast: 1.14, saturation: 0.95, warmth: 0.22, label: "cinematic teal-amber" },
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
  };
  return parseEditDoc(clone);
}
