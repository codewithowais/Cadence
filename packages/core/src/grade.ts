/**
 * Pure helpers for looks, transitions, and motion — shared by every surface so
 * a "warm look" or a Ken Burns zoom previews in the browser (CSS filter /
 * transform) exactly as it renders on the server canvas (ctx.filter) and, later,
 * on export (ffmpeg). Keeping this math in one place is what makes the preview
 * trustworthy.
 */
import type { ColorGrade, ImageClip, SolidClip, TextClip, VideoClip } from "./schema";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Ease-out cubic — fast start, gentle settle. Deterministic; p is 0..1. */
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - clamp01(p), 3);

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

/** Effective opacity including crossfade-in and -out ramps. */
export function transitionOpacity(
  clip: VideoClip | ImageClip | TextClip | SolidClip,
  timeSec: number,
): number {
  let op = clip.transform.opacity;
  if (clip.transitionInSec > 0) {
    op *= clamp01((timeSec - clip.start) / clip.transitionInSec);
  }
  if (clip.transitionOutSec > 0) {
    const end = clip.start + clip.duration;
    op *= clamp01((end - timeSec) / clip.transitionOutSec);
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

/** Offset (composition px) + scale multiplier from a kinetic title intro. */
export interface KineticState {
  /** X offset (composition px) still to travel toward the resting position. */
  dx: number;
  /** Y offset (composition px) still to travel toward the resting position. */
  dy: number;
  /** Extra scale multiplier on top of transform.scale (settles to 1). */
  scaleMul: number;
}

/**
 * Kinetic title state at `timeSec` — the text slides from (fromX, fromY) and
 * grows from `fromScale` toward its resting transform over the first
 * `durationSec`, eased. Identity when the clip has no kinetic animation, so it
 * is safe to call for every text clip. Deterministic, mirroring transitionOpacity.
 */
export function textKinetic(clip: TextClip, timeSec: number): KineticState {
  const a = clip.anim;
  if (a.style !== "kinetic" || a.durationSec <= 0) return { dx: 0, dy: 0, scaleMul: 1 };
  const e = easeOutCubic((timeSec - clip.start) / a.durationSec);
  return {
    dx: a.fromX * (1 - e),
    dy: a.fromY * (1 - e),
    scaleMul: a.fromScale + (1 - a.fromScale) * e,
  };
}

/**
 * Slide/wipe transition motion for a visual clip at `timeSec`, resolved purely
 * so canvas + Stage animate identically (the ffmpeg export uses the equivalent
 * xfade names). Faithful: only translates / reveals the existing frame.
 *
 *  - dx/dy    : composition-px offset (slide). "slide" enters from the right on
 *               the in-ramp and exits to the left on the out-ramp; 0 otherwise.
 *  - wipeFrac : 0..1 fraction of the frame revealed from the left ("wipe"); 1
 *               means fully shown (crossfade / dip-to-black never clip).
 *  - fadeOpacity: whether opacity should ramp for this transition. crossfade and
 *               dip-to-black fade (opacity); slide/wipe keep full opacity so the
 *               motion reads as a slide/wipe rather than a dissolve.
 */
export interface TransitionMotion {
  dx: number;
  dy: number;
  wipeFrac: number;
  fadeOpacity: boolean;
}

export function transitionMotion(
  clip: VideoClip | ImageClip | TextClip | SolidClip,
  timeSec: number,
  frameW: number,
  frameH: number,
): TransitionMotion {
  const type = clip.transitionType ?? "crossfade";
  const inP = clip.transitionInSec > 0 ? clamp01((timeSec - clip.start) / clip.transitionInSec) : 1;
  const end = clip.start + clip.duration;
  const outP = clip.transitionOutSec > 0 ? clamp01((end - timeSec) / clip.transitionOutSec) : 1;
  if (type === "crossfade" || type === "dip-to-black") {
    return { dx: 0, dy: 0, wipeFrac: 1, fadeOpacity: true };
  }
  if (type === "slide") {
    // Enter from the right (in-ramp), exit to the left (out-ramp), eased.
    let dx = 0;
    if (inP < 1) dx = (1 - easeOutCubic(inP)) * frameW;
    else if (outP < 1) dx = -(1 - easeOutCubic(outP)) * frameW;
    void frameH;
    return { dx, dy: 0, wipeFrac: 1, fadeOpacity: false };
  }
  // wipe: reveal from the left; hardest edge is the smaller of the two ramps.
  return { dx: 0, dy: 0, wipeFrac: Math.min(inP, outP), fadeOpacity: false };
}

/**
 * Punch-in emphasis scale for a video clip at `timeSec`. Returns a multiplier
 * that pulses from 1 up to `emphasis.zoom` at the center of the window
 * [atSec, atSec+durationSec] and back to 1 (sine pulse), and 1 outside it.
 * Identity when the clip has no emphasis. Deterministic.
 */
export function emphasisScale(clip: VideoClip, timeSec: number): number {
  const e = clip.emphasis;
  if (!e || e.durationSec <= 0 || e.zoom === 1) return 1;
  if (timeSec < e.atSec || timeSec > e.atSec + e.durationSec) return 1;
  const p = (timeSec - e.atSec) / e.durationSec;
  const pulse = Math.sin(clamp01(p) * Math.PI); // 0 at edges, 1 at center
  return 1 + (e.zoom - 1) * pulse;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
