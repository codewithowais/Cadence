/**
 * Pure helpers for looks, transitions, and motion — shared by every surface so
 * a "warm look" or a Ken Burns zoom previews in the browser (CSS filter /
 * transform) exactly as it renders on the server canvas (ctx.filter) and, later,
 * on export (ffmpeg). Keeping this math in one place is what makes the preview
 * trustworthy.
 */
import type { ColorGrade, FontWeight, ImageClip, SolidClip, TextClip, VideoClip } from "./schema";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Ease-out cubic — fast start, gentle settle. Deterministic; p is 0..1. */
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - clamp01(p), 3);

/**
 * Ease-out-back — overshoots past 1 then settles, giving a "pop". Deterministic;
 * the standard constants (c1 = 1.70158). p is 0..1.
 */
const easeOutBack = (p: number): number => {
  const x = clamp01(p);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/**
 * Ease-out-bounce — a damped bounce settling to 1. Deterministic; the standard
 * piecewise constants (n1 = 7.5625, d1 = 2.75). p is 0..1.
 */
const easeOutBounce = (p: number): number => {
  let x = clamp01(p);
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

/**
 * Resolve a named FontWeight to a CSS/canvas `font` weight token. Named mid
 * weights map to their numeric equivalents so the canvas, the browser preview,
 * and (where a weighted face is available) export all agree. Pure + deterministic.
 */
export function fontWeightToCss(weight: FontWeight): string {
  switch (weight) {
    case "medium":
      return "500";
    case "semibold":
      return "600";
    case "bold":
      return "bold";
    case "normal":
    default:
      return "normal";
  }
}

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
 * Animated title state at `timeSec` — the text moves from (fromX, fromY) and
 * grows from `fromScale` toward its resting transform over the first
 * `durationSec`, using the easing for its `anim.style`:
 *  - "kinetic" — ease-out cubic (slide + scale in).
 *  - "pop"     — ease-out-back on the scale (overshoots past 1, then settles).
 *  - "bounce"  — ease-out-bounce on the offset (drops in with a bounce settle).
 * Identity for "none" (or a zero duration), so it is safe to call for every text
 * clip. Deterministic, mirroring transitionOpacity.
 */
export function textKinetic(clip: TextClip, timeSec: number): KineticState {
  const a = clip.anim;
  if (a.style === "none" || a.durationSec <= 0) return { dx: 0, dy: 0, scaleMul: 1 };
  const p = (timeSec - clip.start) / a.durationSec;
  if (a.style === "pop") {
    // Scale overshoots past its resting 1 then settles; offsets follow the same curve.
    const e = easeOutBack(p);
    return { dx: a.fromX * (1 - e), dy: a.fromY * (1 - e), scaleMul: a.fromScale + (1 - a.fromScale) * e };
  }
  if (a.style === "bounce") {
    // Offset bounces into place; scale eases in normally (cubic) alongside it.
    const eb = easeOutBounce(p);
    const ec = easeOutCubic(p);
    return { dx: a.fromX * (1 - eb), dy: a.fromY * (1 - eb), scaleMul: a.fromScale + (1 - a.fromScale) * ec };
  }
  // "kinetic": ease-out cubic on both offset and scale.
  const e = easeOutCubic(p);
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
  /** Extra scale multiplier for the "zoom" reveal (settles to 1); 1 otherwise. */
  scaleMul: number;
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
  // crossfade / dip-to-black / dissolve are all opacity ramps in the preview
  // (they differ only in the xfade name used on export).
  if (type === "crossfade" || type === "dip-to-black" || type === "dissolve") {
    return { dx: 0, dy: 0, wipeFrac: 1, fadeOpacity: true, scaleMul: 1 };
  }
  if (type === "slide" || type === "smooth") {
    // Enter from the right (in-ramp), exit to the left (out-ramp), eased. "smooth"
    // shares the slide motion in the preview (feathered on export via smoothleft).
    let dx = 0;
    if (inP < 1) dx = (1 - easeOutCubic(inP)) * frameW;
    else if (outP < 1) dx = -(1 - easeOutCubic(outP)) * frameW;
    void frameH;
    return { dx, dy: 0, wipeFrac: 1, fadeOpacity: false, scaleMul: 1 };
  }
  if (type === "zoom") {
    // Incoming frame scales in from slightly larger while it fades (a punchy reveal).
    let scaleMul = 1;
    if (inP < 1) scaleMul = 1 + (1 - easeOutCubic(inP)) * 0.18;
    else if (outP < 1) scaleMul = 1 + (1 - easeOutCubic(outP)) * 0.18;
    return { dx: 0, dy: 0, wipeFrac: 1, fadeOpacity: true, scaleMul };
  }
  // wipe: reveal from the left; hardest edge is the smaller of the two ramps.
  return { dx: 0, dy: 0, wipeFrac: Math.min(inP, outP), fadeOpacity: false, scaleMul: 1 };
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
