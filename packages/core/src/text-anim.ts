/**
 * THE text-animation resolver — one pure function family shared by every surface
 * (browser Stage canvas, node canvas, ffmpeg export via the node canvas). Given a
 * text clip, a frame time, and which animation UNIT is being drawn (the whole
 * block, a line, a word, or a letter), it returns that unit's transform/opacity/
 * blur/reveal state. Deterministic: pseudo-random effects (glitch jitter, neon
 * flicker, scramble glyphs) use an integer hash, never Math.random.
 *
 * Timing model (per intro/exit): with `n` units over a `total` duration, each unit
 * animates for `unitDur` and units start `stagger` apart, chosen so the LAST unit
 * finishes exactly at `total` — the text always settles `anim.durationSec` after
 * the intro starts, whatever the unit.
 */
import type { SolidClip, ShapeClip, TextAnim, TextClip } from "./schema";
import { counterWindows, shapeMotionWindows } from "./shape-anim";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - clamp01(p), 3);
const easeInCubic = (p: number): number => Math.pow(clamp01(p), 3);
const easeOutBack = (p: number): number => {
  const x = clamp01(p);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const easeOutBounce = (p: number): number => {
  let x = clamp01(p);
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

/** Deterministic 0..1 hash of an integer (mulberry32 finalizer). */
export function hash01(n: number): number {
  let x = (Math.floor(n) ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/** One animation unit's resolved state at a frame time. Identity = at rest. */
export interface UnitAnimState {
  /** Offset (composition px, text-local) from the unit's resting position. */
  dx: number;
  dy: number;
  /** Scale about the unit's center. */
  scaleX: number;
  scaleY: number;
  /** Rotation about the unit's center, degrees clockwise. */
  rotation: number;
  /** Opacity multiplier 0..1. */
  opacity: number;
  /** Gaussian blur radius, composition px (0 = sharp). */
  blur: number;
  /** Visible horizontal span of the unit, as fractions of its width (wipe). */
  revealFrom: number;
  revealTo: number;
  /** Clip the unit to its resting line box (the "baseline" rise-from-behind mask). */
  baselineMask: boolean;
  /** 0..1 RGB-split strength (glitch). */
  glitch: number;
  /** 0..1 fraction of characters still scrambled. */
  scramble: number;
  /** false ⇒ not drawn at all this frame (typewriter-by-unit, before its turn). */
  visible: boolean;
}

export const IDENTITY_UNIT_STATE: Readonly<UnitAnimState> = Object.freeze({
  dx: 0,
  dy: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
  blur: 0,
  revealFrom: 0,
  revealTo: 1,
  baselineMask: false,
  glitch: 0,
  scramble: 0,
  visible: true,
});

/**
 * Per-unit timing for a staggered animation of `n` units over `total` seconds:
 * each unit animates for `unitDur`, starting `stagger` after the previous one, and
 * the last unit ends exactly at `total`.
 */
export function staggerTiming(total: number, n: number): { unitDur: number; stagger: number } {
  const T = Math.max(1e-6, total);
  if (n <= 1) return { unitDur: T, stagger: 0 };
  // Units overlap heavily for long letter runs, gently for a few lines.
  const unitDur = T * (n <= 3 ? 0.6 : 0.45);
  return { unitDur, stagger: (T - unitDur) / (n - 1) };
}

/** True when the clip's intro is one of the original five (legacy-exact) styles. */
export function isLegacyTextAnim(anim: TextAnim): boolean {
  return (
    (anim.style === "none" ||
      anim.style === "kinetic" ||
      anim.style === "pop" ||
      anim.style === "bounce" ||
      anim.style === "typewriter") &&
    anim.unit === "whole" &&
    anim.exit.style === "none" &&
    anim.loop.style === "none"
  );
}

/** Intro progress (0..1) of unit `index` of `count` at timeline time `t`. */
export function introProgress(clip: TextClip, t: number, index: number, count: number): number {
  const a = clip.anim;
  if (a.durationSec <= 0) return 1;
  const { unitDur, stagger } = staggerTiming(a.durationSec, count);
  const t0 = clip.start + a.delaySec + index * stagger;
  return clamp01((t - t0) / unitDur);
}

/** Exit progress (0..1, 1 = fully gone) of unit `index` of `count` at `t`. */
export function exitProgress(clip: TextClip, t: number, index: number, count: number): number {
  const ex = clip.anim.exit;
  if (ex.style === "none" || ex.durationSec <= 0) return 0;
  const end = clip.start + clip.duration;
  const total = Math.min(ex.durationSec, clip.duration);
  const { unitDur, stagger } = staggerTiming(total, count);
  const t0 = end - total + index * stagger;
  return clamp01((t - t0) / unitDur);
}

/**
 * The animation state of unit `index` (of `count` units) of `clip` at timeline
 * time `t` — intro, then loop, then exit, composed. For the legacy styles
 * (kinetic/pop/bounce) the whole-block result equals the historical `textKinetic`
 * offsets exactly; typewriter's character reveal is handled by `typewriterText`
 * for the whole block and becomes a staggered pop-in per unit.
 */
export function textUnitState(clip: TextClip, t: number, index = 0, count = 1): UnitAnimState {
  const s: UnitAnimState = { ...IDENTITY_UNIT_STATE };
  const a = clip.anim;
  // Motion distances scale with the unit: letters travel less than whole lines so
  // neighbours don't collide mid-flight.
  const travel = a.unit === "letter" ? 0.45 : a.unit === "word" ? 0.7 : 1;
  const fs = clip.fontSize * travel;

  // ---- intro ----
  if (a.style !== "none" && a.durationSec > 0) {
    const p = introProgress(clip, t, index, count);
    const e = easeOutCubic(p);
    switch (a.style) {
      case "kinetic": {
        s.dx = a.fromX * (1 - e);
        s.dy = a.fromY * (1 - e);
        const k = a.fromScale + (1 - a.fromScale) * e;
        s.scaleX = s.scaleY = k;
        break;
      }
      case "pop": {
        const eb = easeOutBack(p);
        s.dx = a.fromX * (1 - eb);
        s.dy = a.fromY * (1 - eb);
        const k = a.fromScale + (1 - a.fromScale) * eb;
        s.scaleX = s.scaleY = k;
        break;
      }
      case "bounce": {
        const eb = easeOutBounce(p);
        s.dx = a.fromX * (1 - eb);
        s.dy = a.fromY * (1 - eb);
        const k = a.fromScale + (1 - a.fromScale) * e;
        s.scaleX = s.scaleY = k;
        break;
      }
      case "typewriter":
        // Whole-block typewriter reveals characters (typewriterText); per unit it
        // is a hard staggered pop-in.
        if (count > 1 || a.unit !== "whole") s.visible = p > 0;
        break;
      case "fade":
        s.opacity = e;
        break;
      case "rise":
        s.dy = (1 - e) * 0.7 * fs;
        s.opacity = e;
        break;
      case "drop":
        s.dy = -(1 - e) * 0.7 * fs;
        s.opacity = e;
        break;
      case "slide-left":
        s.dx = (1 - e) * 1.5 * fs;
        s.opacity = e;
        break;
      case "slide-right":
        s.dx = -(1 - e) * 1.5 * fs;
        s.opacity = e;
        break;
      case "zoom-in": {
        const k = 0.2 + 0.8 * easeOutBack(p);
        s.scaleX = s.scaleY = k;
        s.opacity = clamp01(p * 2);
        break;
      }
      case "stomp": {
        const k = 1 + 1.8 * travel * (1 - e);
        s.scaleX = s.scaleY = k;
        s.opacity = clamp01(p * 4);
        break;
      }
      case "blur-in":
        s.blur = (1 - e) * 0.4 * fs;
        s.opacity = clamp01(p * 1.5);
        break;
      case "wipe":
        s.revealTo = e;
        break;
      case "baseline":
        s.dy = (1 - e) * 1.05 * clip.fontSize * (clip.lineHeight ?? 1.2);
        s.baselineMask = true;
        break;
      case "tumble": {
        s.rotation = -(1 - e) * 110;
        const k = 0.4 + 0.6 * e;
        s.scaleX = s.scaleY = k;
        s.dy = (1 - e) * 0.3 * fs;
        s.opacity = clamp01(p * 2);
        break;
      }
      case "spin": {
        s.rotation = -(1 - e) * 360;
        const k = Math.max(0.01, e);
        s.scaleX = s.scaleY = k;
        s.opacity = clamp01(p * 2);
        break;
      }
      case "flip":
        s.scaleY = Math.max(0.01, e);
        s.opacity = clamp01(p * 3);
        break;
      case "neon": {
        if (p < 1) {
          const pattern = [0, 1, 0, 0, 1, 1, 0, 1, 1, 1];
          const on = pattern[Math.min(pattern.length - 1, Math.floor(p * pattern.length))] === 1;
          s.opacity = on ? 0.55 + 0.45 * p : p > 0 ? 0.08 : 0;
        }
        break;
      }
      case "glitch": {
        if (p < 1) {
          const step = Math.floor(t * 30);
          s.glitch = 1 - p;
          s.dx = (hash01(step * 7 + index * 131) - 0.5) * 0.3 * fs * (1 - p);
          s.dy = (hash01(step * 13 + index * 71) - 0.5) * 0.08 * fs * (1 - p);
          s.opacity = clamp01(p * 3);
        }
        break;
      }
      case "scramble":
        s.scramble = 1 - p;
        s.opacity = clamp01(p * 5);
        break;
    }
  }

  // ---- loop (continuous emphasis) ----
  const lp = a.loop;
  if (lp.style !== "none" && lp.amount > 0) {
    const local = Math.max(0, t - clip.start);
    const ph = 2 * Math.PI * lp.speed * local + index * 0.55;
    const amt = lp.amount;
    switch (lp.style) {
      case "breathe": {
        const k = 1 + 0.08 * amt * Math.sin(ph);
        s.scaleX *= k;
        s.scaleY *= k;
        break;
      }
      case "float":
        s.dy += 0.14 * fs * amt * Math.sin(ph);
        break;
      case "wiggle":
        s.rotation += 7 * amt * Math.sin(ph * 1.7);
        break;
      case "flicker": {
        const step = Math.floor(local * lp.speed * 14);
        if (hash01(step * 31 + index * 17) < 0.36 * amt) s.opacity *= 0.25;
        break;
      }
      case "pulse":
        s.opacity *= 1 - 0.45 * amt * (0.5 + 0.5 * Math.sin(ph));
        break;
      case "shake": {
        const step = Math.floor(local * 24);
        s.dx += (hash01(step * 7 + index * 3) - 0.5) * 0.08 * fs * amt;
        s.dy += (hash01(step * 13 + index * 5) - 0.5) * 0.08 * fs * amt;
        break;
      }
      case "wave":
        s.dy += 0.2 * fs * amt * Math.sin(ph);
        break;
    }
  }

  // ---- exit ----
  const ex = a.exit;
  if (ex.style !== "none" && ex.durationSec > 0) {
    const q = exitProgress(clip, t, index, count);
    if (q > 0) {
      const eq = easeInCubic(q);
      const fadeOut = 1 - q;
      switch (ex.style) {
        case "fade":
          s.opacity *= fadeOut;
          break;
        case "rise":
          s.dy -= eq * 0.7 * fs;
          s.opacity *= fadeOut;
          break;
        case "sink":
          s.dy += eq * 0.7 * fs;
          s.opacity *= fadeOut;
          break;
        case "slide-left":
          s.dx -= eq * 1.5 * fs;
          s.opacity *= fadeOut;
          break;
        case "slide-right":
          s.dx += eq * 1.5 * fs;
          s.opacity *= fadeOut;
          break;
        case "zoom-out":
          s.scaleX *= 1 - 0.8 * eq;
          s.scaleY *= 1 - 0.8 * eq;
          s.opacity *= fadeOut;
          break;
        case "blow-up":
          s.scaleX *= 1 + 1.5 * eq;
          s.scaleY *= 1 + 1.5 * eq;
          s.opacity *= fadeOut;
          break;
        case "blur-out":
          s.blur += eq * 0.4 * fs;
          s.opacity *= fadeOut;
          break;
        case "wipe":
          s.revealFrom = Math.max(s.revealFrom, eq);
          break;
        case "tumble":
          s.rotation += eq * 110;
          s.scaleX *= 1 - 0.6 * eq;
          s.scaleY *= 1 - 0.6 * eq;
          s.opacity *= fadeOut;
          break;
      }
    }
  }

  return s;
}

/** Characters used for the scramble effect (visually dense, font-safe). */
const SCRAMBLE_GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&@*+=?";

/**
 * The scrambled rendition of `text` at scramble fraction `amount` (0 = the real
 * text, 1 = fully scrambled). Each non-space character resolves at its own
 * deterministic threshold; unresolved ones cycle glyphs ~20×/s. Pure.
 */
export function scrambleText(text: string, amount: number, t: number, seed = 0): string {
  if (amount <= 0) return text;
  const step = Math.floor(t * 20);
  const chars = [...text];
  return chars
    .map((ch, i) => {
      if (/\s/.test(ch)) return ch;
      if (hash01(seed * 977 + i * 131) >= amount) return ch;
      const g = Math.floor(hash01(step * 53 + i * 7 + seed * 11) * SCRAMBLE_GLYPHS.length);
      return SCRAMBLE_GLYPHS[g]!;
    })
    .join("");
}

// ---- animated windows (for export) ------------------------------------------

type Window = [number, number];

function mergeWindows(ws: Window[], lo: number, hi: number): Window[] {
  const clipped = ws
    .map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)] as Window)
    .filter(([a, b]) => b - a > 1e-6)
    .sort((x, y) => x[0] - y[0]);
  const out: Window[] = [];
  for (const w of clipped) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

/**
 * The timeline windows during which a synthetic clip's pixels CHANGE over time
 * (intro/exit animations, transition ramps, keyframes, loops, animated gradients,
 * a blinking caret). Outside these windows the clip is static, so an exporter can
 * rasterize one still for the static span and a frame sequence only for these
 * windows. Returns [] for a fully static clip. Pure.
 */
export function clipAnimatedWindows(clip: TextClip | ShapeClip | SolidClip): Window[] {
  const start = clip.start;
  const end = clip.start + clip.duration;
  const whole: Window[] = [[start, end]];
  if (clip.keyframes && clip.keyframes.length > 0) return whole;
  const ws: Window[] = [];
  if (clip.transitionInSec > 0) ws.push([start, start + clip.transitionInSec]);
  if (clip.transitionOutSec > 0) ws.push([end - clip.transitionOutSec, end]);
  if (clip.kind === "solid") {
    if (clip.gradient && clip.gradient.motion !== "none" && clip.gradient.speed > 0) return whole;
  }
  if (clip.kind === "shape") {
    // Shape motion (intro / exit / loop) and progress fills — see shape-anim.ts.
    const mw = shapeMotionWindows(clip);
    if (mw === "whole") return whole;
    ws.push(...mw);
  }
  if (clip.kind === "text") {
    // Live counters change at each tick (or continuously when smooth).
    const cw = counterWindows(clip);
    if (cw === "whole") return whole;
    ws.push(...cw);
    const a = clip.anim;
    if (a.loop.style !== "none" && a.loop.amount > 0) return whole;
    if (clip.karaoke?.enabled && clip.words && clip.words.length > 0) return whole;
    if (a.style === "typewriter" && a.caret) return whole;
    if (a.style !== "none" && a.durationSec > 0) {
      // Kinetic-family styles hold their "from" pose during the delay — that pose
      // is static, so the window starts when the intro actually moves.
      ws.push([start + a.delaySec, start + a.delaySec + a.durationSec]);
    }
    if (a.exit.style !== "none" && a.exit.durationSec > 0) {
      ws.push([end - Math.min(a.exit.durationSec, clip.duration), end]);
    }
  }
  return mergeWindows(ws, start, end);
}

/**
 * The static sub-spans of a clip (its span minus `clipAnimatedWindows`), each a
 * range where one still frame is exact. Pure.
 */
export function clipStaticSpans(clip: TextClip | ShapeClip | SolidClip): Window[] {
  const start = clip.start;
  const end = clip.start + clip.duration;
  const anim = clipAnimatedWindows(clip);
  const out: Window[] = [];
  let cur = start;
  for (const [a, b] of anim) {
    if (a > cur + 1e-6) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (end > cur + 1e-6) out.push([cur, end]);
  return out;
}
