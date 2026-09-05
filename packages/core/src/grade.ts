/**
 * Pure helpers for looks, transitions, and motion — shared by every surface so
 * a "warm look" or a Ken Burns zoom previews in the browser (CSS filter /
 * transform) exactly as it renders on the server canvas (ctx.filter) and, later,
 * on export (ffmpeg). Keeping this math in one place is what makes the preview
 * trustworthy.
 */
import type { ColorGrade, ImageClip, TextClip, VideoClip } from "./schema";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** A CSS/canvas `filter` string for a color grade ("none" when neutral). */
export function cssFilter(look: ColorGrade): string {
  const parts: string[] = [];
  if (look.brightness !== 1) parts.push(`brightness(${round(look.brightness)})`);
  if (look.contrast !== 1) parts.push(`contrast(${round(look.contrast)})`);
  if (look.saturation !== 1) parts.push(`saturate(${round(look.saturation)})`);
  if (look.warmth > 0) parts.push(`sepia(${round(look.warmth * 0.45)})`);
  return parts.length ? parts.join(" ") : "none";
}

/** Progress 0..1 through a clip at `timeSec`. */
export function clipProgress(
  clip: { start: number; duration: number },
  timeSec: number,
): number {
  return clamp01((timeSec - clip.start) / Math.max(0.0001, clip.duration));
}

/** Effective opacity including the crossfade-in ramp. */
export function transitionOpacity(
  clip: VideoClip | ImageClip | TextClip,
  timeSec: number,
): number {
  let op = clip.transform.opacity;
  if (clip.transitionInSec > 0) {
    op *= clamp01((timeSec - clip.start) / clip.transitionInSec);
  }
  return op;
}

export interface MotionState {
  /** Extra scale multiplier from Ken Burns (on top of transform.scale). */
  scale: number;
  /** Pan as a fraction of frame width/height. */
  panXFrac: number;
  panYFrac: number;
}

/** Current Ken Burns state for a still at `timeSec`. */
export function imageMotion(clip: ImageClip, timeSec: number): MotionState {
  const p = clipProgress(clip, timeSec);
  return {
    scale: 1 + (clip.motion.zoom - 1) * p,
    panXFrac: clip.motion.panX * p,
    panYFrac: clip.motion.panY * p,
  };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
