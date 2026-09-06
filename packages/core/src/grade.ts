/**
 * Pure helpers for looks, transitions, and motion — shared by every surface so
 * a "warm look" or a Ken Burns zoom previews in the browser (CSS filter /
 * transform) exactly as it renders on the server canvas (ctx.filter) and, later,
 * on export (ffmpeg). Keeping this math in one place is what makes the preview
 * trustworthy.
 */
import type {
  BlendMode,
  CalloutClip,
  ColorGrade,
  CursorClip,
  FontWeight,
  ImageClip,
  Keyframe,
  KeyframeEasing,
  KeyframeProp,
  SolidClip,
  TextClip,
  TransitionType,
  VideoClip,
} from "./schema";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Ease-out cubic — fast start, gentle settle. Deterministic; p is 0..1. */
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - clamp01(p), 3);

/** Ease-in cubic — gentle start, fast finish. Deterministic; p is 0..1. */
const easeInCubic = (p: number): number => Math.pow(clamp01(p), 3);

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
 * Ease-in-out cubic — gentle acceleration then deceleration. The natural curve
 * for a mouse pointer gliding between two points. Deterministic; p is 0..1.
 */
const easeInOutCubic = (p: number): number => {
  const x = clamp01(p);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
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
  // Hue rotation previews via CSS/canvas hue-rotate(); export uses ffmpeg hue=h=.
  if (look.hueShift && look.hueShift !== 0) parts.push(`hue-rotate(${round(look.hueShift)}deg)`);
  if (look.warmth > 0) parts.push(`sepia(${round(look.warmth * 0.45)})`);
  // NOTE: `curves` has no CSS filter equivalent, so it is not previewed here — the
  // ffmpeg export applies it exactly (documented preview limit).
  return parts.length ? parts.join(" ") : "none";
}

/**
 * Map a BlendMode to a canvas `globalCompositeOperation`. Pure + deterministic,
 * the single mapping the canvas shares (the ffmpeg export mirrors it via
 * `blend=all_mode=…`): screen/multiply/overlay/soft-light map to the identically
 * named composite ops, "add" maps to "lighter" (additive), and "normal" is the
 * default "source-over".
 */
export type CanvasBlendOp =
  | "source-over"
  | "screen"
  | "multiply"
  | "overlay"
  | "soft-light"
  | "lighter";

export function blendCompositeOperation(mode: BlendMode): CanvasBlendOp {
  switch (mode) {
    case "screen":
      return "screen";
    case "multiply":
      return "multiply";
    case "overlay":
      return "overlay";
    case "soft-light":
      return "soft-light";
    case "add":
      return "lighter";
    case "normal":
    default:
      return "source-over";
  }
}

/** Resolve a keyframe segment easing to its 0..1 curve. Pure + deterministic. */
function keyframeEase(easing: KeyframeEasing, p: number): number {
  switch (easing) {
    case "ease-in":
      return easeInCubic(p);
    case "ease-out":
      return easeOutCubic(p);
    case "ease-in-out":
      return easeInOutCubic(p);
    case "linear":
    default:
      return clamp01(p);
  }
}

/**
 * THE keyframe resolver — the single PURE mapping every surface shares. Returns
 * the interpolated value of `prop` at `progress` (0..1 clip-progress) given a
 * clip's `keyframes`, falling back to `base` when the clip has no keyframes for
 * that prop:
 *
 *  - no keyframes for `prop`     → `base` (so it is always safe to call).
 *  - before the first keyframe   → the first keyframe's value (hold).
 *  - after the last keyframe     → the last keyframe's value (hold).
 *  - between two keyframes a→b   → a.value + (b.value - a.value) * ease(b.easing),
 *                                  i.e. the easing belongs to the INCOMING keyframe.
 *
 * The canvas + Stage call this directly (eased); the ffmpeg export mirrors it with
 * a piecewise-LINEAR time expression (documented approximation in plan.ts).
 * Deterministic, mirroring cursorPositionAt.
 */
export function valueAt(
  keyframes: Keyframe[] | undefined,
  prop: KeyframeProp,
  progress: number,
  base: number,
): number {
  if (!keyframes || keyframes.length === 0) return base;
  const kf = keyframes.filter((k) => k.prop === prop).sort((a, b) => a.t - b.t);
  if (kf.length === 0) return base;
  const p = clamp01(progress);
  const first = kf[0]!;
  if (p <= first.t) return first.value;
  const last = kf[kf.length - 1]!;
  if (p >= last.t) return last.value;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i]!;
    const b = kf[i + 1]!;
    if (p >= a.t && p <= b.t) {
      const span = Math.max(1e-6, b.t - a.t);
      const e = keyframeEase(b.easing, (p - a.t) / span);
      return a.value + (b.value - a.value) * e;
    }
  }
  return last.value;
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
  // "typewriter" reveals characters over time (see typewriterText); it never
  // slides or scales, so it is identity for the kinetic transform.
  if (a.style === "none" || a.style === "typewriter" || a.durationSec <= 0) {
    return { dx: 0, dy: 0, scaleMul: 1 };
  }
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
 * CSS-ready transition state for the BROWSER preview (Stage), derived from the
 * SAME pure `transitionMotion` + `transitionOpacity` helpers the canvas engine
 * (drawMedia) and the ffmpeg `xfade` map read — so picking a transition type in
 * the UI changes the preview exactly the way it will change on export (the "one
 * pure helper" rule). It returns primitives the Stage COMPOSES into its existing
 * per-layer transform (Ken Burns pan/scale, punch-in emphasis) instead of a
 * whole style string, so preview motion stacks cleanly:
 *
 *  - opacity      : final layer opacity — the fade-style types (crossfade /
 *                   dip-to-black / dissolve / zoom) ramp it; slide / wipe / smooth
 *                   stay fully opaque so the motion reads as a slide / wipe.
 *  - translateXPct/translateYPct : slide offset as a PERCENT of frame width /
 *                   height (slide / smooth enter from the right, exit to the left).
 *  - scaleMul     : extra scale multiplier for the "zoom" reveal (1 otherwise) —
 *                   multiply it into the clip's own scale.
 *  - clipPath     : a CSS `inset(...)` wipe reveal (left→right) for "wipe", else
 *                   "none".
 *  - type         : the resolved TransitionType (surfaced as a data-attribute so
 *                   the preview layer is inspectable / testable).
 *  - active       : whether the playhead is inside this clip's in/out transition
 *                   window right now (drives the data-attribute + tests).
 * Deterministic; mirrors the canvas engine's consumption of transitionMotion.
 */
export interface TransitionCss {
  type: TransitionType;
  opacity: number;
  translateXPct: number;
  translateYPct: number;
  scaleMul: number;
  clipPath: string;
  active: boolean;
}

export function transitionStyle(
  clip: VideoClip | ImageClip | TextClip | SolidClip,
  timeSec: number,
  frameW: number,
  frameH: number,
): TransitionCss {
  const type = clip.transitionType ?? "crossfade";
  const tm = transitionMotion(clip, timeSec, frameW, frameH);
  // Opacity ramps only for the fade-style types (matches drawMedia); slide/wipe
  // keep the clip's base opacity so they slide/reveal rather than dissolve.
  const opacity = tm.fadeOpacity ? transitionOpacity(clip, timeSec) : clip.transform.opacity;
  const end = clip.start + clip.duration;
  const inWin = clip.transitionInSec > 0 && timeSec >= clip.start && timeSec < clip.start + clip.transitionInSec;
  const outWin = clip.transitionOutSec > 0 && timeSec > end - clip.transitionOutSec && timeSec <= end;
  return {
    type,
    opacity,
    translateXPct: frameW > 0 ? round((tm.dx / frameW) * 100) : 0,
    translateYPct: frameH > 0 ? round((tm.dy / frameH) * 100) : 0,
    scaleMul: tm.scaleMul,
    clipPath: tm.wipeFrac < 1 ? `inset(0 ${round((1 - tm.wipeFrac) * 100)}% 0 0)` : "none",
    active: inWin || outWin,
  };
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

// ---- typewriter text -------------------------------------------------------

export interface TypewriterState {
  /** The characters visible at this time (a prefix of the full text). */
  text: string;
  /** How many characters are revealed (0..text length). */
  count: number;
  /** Whether the blinking caret should be drawn this frame. */
  caretVisible: boolean;
  /** True once every character has been revealed. */
  done: boolean;
}

/**
 * Visible substring of a "typewriter" text clip at `timeSec`. The text types out
 * one character at a time over `anim.durationSec` (linear), starting at the
 * clip's `start`. The caret (when `anim.caret`) blinks at ~1.9 Hz. For any other
 * style — or a zero duration — the full text is returned immediately, so this is
 * always safe to call. Pure + deterministic, mirroring the ffmpeg export's
 * time-gated drawtext slices so the preview and the export reveal identically.
 */
export function typewriterText(clip: TextClip, timeSec: number): TypewriterState {
  const full = clip.text;
  const len = full.length;
  const a = clip.anim;
  if (a.style !== "typewriter" || a.durationSec <= 0 || len === 0) {
    return { text: full, count: len, caretVisible: false, done: true };
  }
  const p = clamp01((timeSec - clip.start) / a.durationSec);
  // round() so the exact midpoint reveals ~half the string (a partial reveal).
  const count = Math.max(0, Math.min(len, Math.round(p * len)));
  const done = count >= len;
  // Caret blinks continuously; drawn only when requested.
  const blinkOn = Math.floor(Math.max(0, timeSec - clip.start) / 0.53) % 2 === 0;
  return { text: full.slice(0, count), count, caretVisible: a.caret && blinkOn, done };
}

// ---- cursor overlay --------------------------------------------------------

export interface CursorPoint {
  x: number;
  y: number;
}

/**
 * Pointer position (composition px) at `timeSec`, easing (ease-in-out cubic)
 * between the clip's waypoints. Before the first waypoint's `atSec` it rests at
 * the first point; after the last it rests at the last point. Waypoints are read
 * in `atSec` order. Pure + deterministic — the single mapping the canvas, the
 * Stage, and the ffmpeg export all share.
 */
export function cursorPositionAt(clip: CursorClip, timeSec: number): CursorPoint {
  const wp = [...clip.waypoints].sort((a, b) => a.atSec - b.atSec);
  const first = wp[0]!;
  if (timeSec <= first.atSec) return { x: first.x, y: first.y };
  const last = wp[wp.length - 1]!;
  if (timeSec >= last.atSec) return { x: last.x, y: last.y };
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i]!;
    const b = wp[i + 1]!;
    if (timeSec >= a.atSec && timeSec <= b.atSec) {
      const span = Math.max(1e-6, b.atSec - a.atSec);
      const e = easeInOutCubic((timeSec - a.atSec) / span);
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
    }
  }
  return { x: last.x, y: last.y };
}

export interface RippleState {
  /** The click time (seconds) this ripple belongs to. */
  atSec: number;
  /** 0..1 progress through the ripple's lifetime. */
  progress: number;
  /** Ring radius as a fraction of its max radius (grows with progress). */
  radiusFrac: number;
  /** 0..1 opacity (fades out as it expands). */
  opacity: number;
}

/**
 * Click ripples active at `timeSec`. For each click time c with
 * timeSec ∈ [c, c + rippleSec] the ring expands (radiusFrac 0→1) and fades
 * (opacity 1→0). Returns every active ripple (usually 0 or 1). Pure +
 * deterministic; the renderer turns radiusFrac into pixels. The ffmpeg export
 * approximates the same expansion with concentric rings gated in sequence.
 */
export function cursorRipples(clip: CursorClip, timeSec: number): RippleState[] {
  const out: RippleState[] = [];
  const dur = Math.max(1e-6, clip.rippleSec);
  for (const c of clip.clicks) {
    if (timeSec < c || timeSec > c + dur) continue;
    const progress = clamp01((timeSec - c) / dur);
    out.push({ atSec: c, progress, radiusFrac: progress, opacity: 1 - progress });
  }
  return out;
}

// ---- callout / highlight ---------------------------------------------------

export interface CalloutTransform {
  /** Zoom scale (1 = no zoom). */
  scale: number;
  /** Canvas ctx translate applied BEFORE scale, so the rect center holds still. */
  tx: number;
  ty: number;
}

/**
 * The whole-frame zoom transform for a callout: scale about the rect's CENTER by
 * `zoom`, so the highlighted region magnifies while its center stays put. Canvas
 * applies `translate(tx,ty); scale(scale,scale)`; the ffmpeg export derives its
 * crop offset as (-tx, -ty). Identity when zoom <= 1. Pure + deterministic.
 */
export function calloutTransform(clip: CalloutClip): CalloutTransform {
  const s = Math.max(1, clip.zoom);
  if (s === 1) return { scale: 1, tx: 0, ty: 0 };
  const cx = clip.x + clip.w / 2;
  const cy = clip.y + clip.h / 2;
  return { scale: s, tx: cx * (1 - s), ty: cy * (1 - s) };
}

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the callout's border sits in FINAL output coordinates, accounting for the
 * zoom (the rect grows by `zoom` about its own center). With no zoom this is just
 * {x,y,w,h}. Shared by the canvas (drawn in screen space, over the zoomed content)
 * and the ffmpeg export (drawbox after the scale/crop). Pure + deterministic.
 */
export function calloutScreenRect(clip: CalloutClip): ScreenRect {
  const s = Math.max(1, clip.zoom);
  if (s === 1) return { x: clip.x, y: clip.y, w: clip.w, h: clip.h };
  const cx = clip.x + clip.w / 2;
  const cy = clip.y + clip.h / 2;
  const w = clip.w * s;
  const h = clip.h * s;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
