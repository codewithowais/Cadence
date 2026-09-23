/**
 * THE motion-graphics resolvers — shape intro / exit / loop motion, progress fills,
 * live counters, and vector geometry for the graphics pack. Pure functions of
 * (clip, time), shared by every surface (browser Stage canvas, Skia node renderer,
 * ffmpeg export via the node renderer), exactly like text-anim.ts for text.
 *
 * Deterministic: no Math.random, no globals, no Date — a given (clip, t) always
 * resolves to the same state, so preview frames and exported frames agree.
 */
import type { ShapeClip, ShapeKind, TextAnim, TextClip, TextCounter } from "./schema";

/** The timing a counter needs: a span and its counter spec. */
type CounterHost = { start: number; duration: number; counter?: TextCounter };

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - clamp01(p), 3);
const easeInCubic = (p: number): number => Math.pow(clamp01(p), 3);
const easeInOutCubic = (p: number): number => {
  const x = clamp01(p);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
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
const frac = (n: number): number => n - Math.floor(n);

// ---- shape kinds -------------------------------------------------------------

/** Shapes drawn as a STROKE only (no interior fill): lines, arrows, marks. */
export const STROKE_SHAPES: ReadonlySet<ShapeKind> = new Set<ShapeKind>([
  "line",
  "arrow",
  "check",
  "chevron",
  "scribble",
  "arrow-curve",
  "squiggle",
]);

/** True when `kind` is stroke-only (color = stroke, else fill; thickness = strokeWidth). */
export function isStrokeShape(kind: ShapeKind): boolean {
  return STROKE_SHAPES.has(kind);
}

/** The original four kinds, drawn by the historical (byte-identical) code path. */
export const LEGACY_SHAPES: ReadonlySet<ShapeKind> = new Set<ShapeKind>(["rect", "ellipse", "line", "arrow"]);

// ---- motion state ------------------------------------------------------------

/**
 * One shape's resolved motion at a frame time. Identity = at rest. Applied by
 * `drawShape` as: translate(dx,dy) · swing(pivot top) · rotate · scale ·
 * stretch(about the stretch origin), then alpha, draw span, reveal, shimmer.
 */
export interface ShapeMotionState {
  dx: number;
  dy: number;
  /** Rotation about the shape center, degrees clockwise. */
  rotation: number;
  /** Uniform scale about the center. */
  scale: number;
  /** Non-uniform stretch about (originX, originY) — grow-x / grow-y / shrink-x. */
  stretchX: number;
  stretchY: number;
  originX: number;
  originY: number;
  /** Pendulum rotation (degrees) about the shape's top-center (swing loop). */
  swing: number;
  opacity: number;
  /** Visible span of the outline/stroke path, as fractions of its length. */
  drawFrom: number;
  drawTo: number;
  /** Multiplier on the interior fill (fades in after a draw-on). */
  fillAlpha: number;
  /** Visible horizontal span (wipe), as fractions of the width. */
  revealFrom: number;
  revealTo: number;
  /** Shimmer sweep phase 0..1 (−1 = none) and its strength. */
  shimmer: number;
  shimmerAmount: number;
  /** false ⇒ nothing to draw this frame. */
  visible: boolean;
}

export const IDENTITY_SHAPE_STATE: Readonly<ShapeMotionState> = Object.freeze({
  dx: 0,
  dy: 0,
  rotation: 0,
  scale: 1,
  stretchX: 1,
  stretchY: 1,
  originX: 0,
  originY: 0,
  swing: 0,
  opacity: 1,
  drawFrom: 0,
  drawTo: 1,
  fillAlpha: 1,
  revealFrom: 0,
  revealTo: 1,
  shimmer: -1,
  shimmerAmount: 0,
  visible: true,
});

/** Travel distance (composition px) for slides / drops / bounces: size-relative. */
function travelOf(clip: ShapeClip): number {
  return Math.max(24, Math.max(clip.w, clip.h) * 0.75);
}

/** Intro progress 0..1 at `t` (1 when there is no intro). */
export function shapeIntroProgress(clip: ShapeClip, t: number): number {
  const a = clip.anim;
  if (!a || a.style === "none" || a.durationSec <= 0) return 1;
  return clamp01((t - clip.start - a.delaySec) / a.durationSec);
}

/** Exit progress 0..1 at `t` (0 = not leaving yet, 1 = gone). */
export function shapeExitProgress(clip: ShapeClip, t: number): number {
  const ex = clip.anim?.exit;
  if (!ex || ex.style === "none" || ex.durationSec <= 0) return 0;
  const total = Math.min(ex.durationSec, clip.duration);
  return clamp01((t - (clip.start + clip.duration - total)) / total);
}

/**
 * The motion state of `clip` at timeline time `t` — intro, then loop, then exit,
 * composed (the shape twin of `textUnitState`). A clip with no `anim` resolves to
 * the identity state.
 */
export function shapeAnimState(clip: ShapeClip, t: number): ShapeMotionState {
  const s: ShapeMotionState = { ...IDENTITY_SHAPE_STATE };
  const a = clip.anim;
  if (!a) return s;
  const travel = travelOf(clip);
  const w = clip.w;
  const h = clip.h;

  // ---- intro ----
  if (a.style !== "none" && a.durationSec > 0) {
    const p = shapeIntroProgress(clip, t);
    const e = easeOutCubic(p);
    switch (a.style) {
      case "fade":
        s.opacity = e;
        break;
      case "pop":
        s.scale = Math.max(0, easeOutBack(p));
        s.opacity = clamp01(p * 4);
        break;
      case "grow":
        s.scale = e;
        break;
      case "grow-x":
        s.stretchX = e;
        s.originX = -w / 2;
        break;
      case "grow-y":
        s.stretchY = e;
        s.originY = h / 2;
        break;
      case "slide-up":
        s.dy = (1 - e) * travel;
        s.opacity = e;
        break;
      case "slide-down":
        s.dy = -(1 - e) * travel;
        s.opacity = e;
        break;
      case "slide-left":
        s.dx = (1 - e) * travel;
        s.opacity = e;
        break;
      case "slide-right":
        s.dx = -(1 - e) * travel;
        s.opacity = e;
        break;
      case "draw":
        // The outline draws over the first 80%, then the fill fades in.
        s.drawTo = easeInOutCubic(p / 0.8);
        s.fillAlpha = clamp01((p - 0.6) / 0.4);
        break;
      case "wipe":
        s.revealTo = e;
        break;
      case "spin":
        s.rotation = -(1 - e) * 360;
        s.scale = Math.max(0, e);
        s.opacity = clamp01(p * 2);
        break;
      case "drop":
        s.dy = -(1 - easeOutBounce(p)) * travel * 1.4;
        s.opacity = clamp01(p * 5);
        break;
    }
  }

  // ---- loop ----
  const lp = a.loop;
  if (lp.style !== "none" && (lp.amount > 0 || lp.style === "spin")) {
    const local = Math.max(0, t - clip.start);
    const ph = 2 * Math.PI * lp.speed * local;
    const amt = lp.amount;
    switch (lp.style) {
      case "pulse":
        s.scale *= 1 + 0.1 * amt * Math.sin(ph);
        break;
      case "bounce":
        s.dy -= Math.abs(Math.sin(Math.PI * lp.speed * local)) * Math.max(8, h * 0.28) * amt;
        break;
      case "wiggle":
        s.rotation += 12 * amt * Math.sin(ph * 1.7);
        break;
      case "float":
        s.dy += Math.max(4, h * 0.08) * amt * Math.sin(ph);
        break;
      case "spin":
        s.rotation += 360 * lp.speed * local;
        break;
      case "blink":
        if (Math.sin(ph) < -0.35) s.opacity *= 1 - 0.85 * amt;
        break;
      case "heartbeat": {
        const u = frac(lp.speed * local);
        const bump = (c: number, wd: number): number => (u >= c && u <= c + wd ? Math.sin((Math.PI * (u - c)) / wd) : 0);
        s.scale *= 1 + 0.2 * amt * (bump(0, 0.14) + 0.65 * bump(0.2, 0.14));
        break;
      }
      case "swing":
        s.swing = 14 * amt * Math.sin(ph);
        break;
      case "shimmer":
        s.shimmer = frac(lp.speed * local * 0.6);
        s.shimmerAmount = amt;
        break;
    }
  }

  // ---- exit ----
  const ex = a.exit;
  if (ex.style !== "none" && ex.durationSec > 0) {
    const q = shapeExitProgress(clip, t);
    if (q > 0) {
      const eq = easeInCubic(q);
      switch (ex.style) {
        case "fade":
          s.opacity *= 1 - q;
          break;
        case "shrink":
          s.scale *= 1 - eq;
          break;
        case "shrink-x":
          s.stretchX *= 1 - eq;
          s.originX = w / 2;
          s.originY = 0;
          break;
        case "slide-up":
          s.dy -= eq * travel;
          s.opacity *= 1 - q;
          break;
        case "slide-down":
          s.dy += eq * travel;
          s.opacity *= 1 - q;
          break;
        case "slide-left":
          s.dx -= eq * travel;
          s.opacity *= 1 - q;
          break;
        case "slide-right":
          s.dx += eq * travel;
          s.opacity *= 1 - q;
          break;
        case "undraw":
          s.drawFrom = Math.max(s.drawFrom, easeInOutCubic(q));
          s.fillAlpha *= 1 - clamp01(q / 0.4);
          break;
        case "wipe":
          s.revealFrom = Math.max(s.revealFrom, eq);
          break;
        case "pop":
          if (q < 0.3) s.scale *= 1 + 0.18 * (q / 0.3);
          else {
            const r = (q - 0.3) / 0.7;
            s.scale *= 1.18 * (1 - easeInCubic(r));
            s.opacity *= 1 - r;
          }
          break;
      }
    }
  }

  s.visible =
    s.opacity > 0 &&
    s.scale > 1e-4 &&
    s.stretchX > 1e-4 &&
    s.stretchY > 1e-4 &&
    s.drawTo > s.drawFrom &&
    s.revealTo > s.revealFrom;
  return s;
}

// ---- progress ------------------------------------------------------------------

/** The progress window [t0, t1] (timeline seconds) of a clip's progress fill. */
export function shapeProgressWindow(clip: ShapeClip): [number, number] | null {
  const pr = clip.progress;
  if (!pr) return null;
  const t0 = clip.start + Math.min(pr.startSec, clip.duration);
  const end = clip.start + clip.duration;
  const t1 = Math.min(end, pr.durationSec !== undefined ? t0 + pr.durationSec : end);
  return [t0, Math.max(t0, t1)];
}

/**
 * The fill level 0..1 of a progress shape at `t`: `from` → `to` over the progress
 * window, eased, `repeat` times (each cycle restarts from `from`). 1 when the clip
 * has no progress (fully drawn).
 */
export function shapeProgressLevel(clip: ShapeClip, t: number): number {
  const pr = clip.progress;
  if (!pr) return 1;
  const [t0, t1] = shapeProgressWindow(clip)!;
  const span = t1 - t0;
  let u = span <= 1e-9 ? (t >= t0 ? 1 : 0) : clamp01((t - t0) / span);
  if (pr.repeat > 1 && u < 1) u = frac(u * pr.repeat);
  const e = pr.easing === "ease-in-out" ? easeInOutCubic(u) : pr.easing === "ease-out" ? easeOutCubic(u) : u;
  return clamp01(pr.from + (pr.to - pr.from) * e);
}

// ---- counters ------------------------------------------------------------------

/** Thousands-separated fixed-decimal number, locale-independent (deterministic). */
export function formatNumber(v: number, decimals = 0): string {
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(decimals);
  const [int, dec] = fixed.split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${dec ? `.${dec}` : ""}`;
}

/** Seconds → "mm:ss" (or "hh:mm:ss"), zero-padded, clamped at 0. */
export function formatClock(sec: number, withHours = false): string {
  const s = Math.max(0, Math.round(sec));
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (withHours) return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** Format one counter value per its `format` (+ prefix/suffix). */
export function formatCounterValue(c: TextCounter, v: number): string {
  let body: string;
  switch (c.format) {
    case "mm:ss":
      body = formatClock(v);
      break;
    case "hh:mm:ss":
      body = formatClock(v, true);
      break;
    case "percent":
      body = `${formatNumber(v, c.decimals)}%`;
      break;
    default:
      body = formatNumber(v, c.decimals);
  }
  return `${c.prefix}${body}${c.suffix}`;
}

/** Number of discrete values a TICK counter shows (|to − from| + 1). */
export function counterSteps(c: TextCounter): number {
  return Math.floor(Math.abs(c.to - c.from)) + 1;
}

/**
 * The counter's value at `t`. TICK: the |to−from|+1 whole values split the clip
 * span evenly (a 3→0 countdown over 4 s holds 3, 2, 1, 0 for a second each).
 * SMOOTH: a continuous `from` → `to` over the span, eased.
 */
export function counterValue(clip: CounterHost, t: number): number {
  const c = clip.counter;
  if (!c) return 0;
  const p = clip.duration > 0 ? clamp01((t - clip.start) / clip.duration) : 1;
  if (c.mode === "smooth") {
    const e = c.easing === "ease-out" ? easeOutCubic(p) : p;
    return c.from + (c.to - c.from) * e;
  }
  const n = counterSteps(c);
  const k = Math.min(n - 1, Math.floor(p * n + 1e-9));
  return c.from + Math.sign(c.to - c.from) * k;
}

/** True when the counter has reached its final value (shows `endText` if set). */
export function counterDone(clip: CounterHost, t: number): boolean {
  const c = clip.counter;
  if (!c) return false;
  if (c.mode === "smooth") return t >= clip.start + clip.duration - 1e-9;
  return counterValue(clip, t) === c.from + Math.sign(c.to - c.from) * (counterSteps(c) - 1);
}

/** The text a counter clip draws at `t` (the clip's own `text` when not a counter). */
export function counterText(clip: CounterHost & { text: string }, t: number): string {
  const c = clip.counter;
  if (!c) return clip.text;
  if (c.endText && counterDone(clip, t)) return c.endText;
  return formatCounterValue(c, counterValue(clip, t));
}

/**
 * Timeline times where a TICK counter's text changes (k = 1 … n−1). Used by the
 * exporter to plan one still per value and a 1-frame sequence at each change.
 */
export function counterTickTimes(clip: CounterHost): number[] {
  const c = clip.counter;
  if (!c || c.mode !== "tick") return [];
  const n = counterSteps(c);
  const out: number[] = [];
  for (let k = 1; k < n; k++) out.push(clip.start + (clip.duration * k) / n);
  return out;
}

// ---- animated windows (export planning) ------------------------------------------

type Window = [number, number];

/**
 * The timeline windows during which a SHAPE's motion / progress changes its pixels
 * (keyframes and transition ramps are handled by `clipAnimatedWindows`). "whole"
 * when it animates continuously (a loop). [] when it has no motion.
 */
export function shapeMotionWindows(clip: ShapeClip): Window[] | "whole" {
  const out: Window[] = [];
  const start = clip.start;
  const end = clip.start + clip.duration;
  const a = clip.anim;
  if (a) {
    if (a.loop.style !== "none" && (a.loop.amount > 0 || a.loop.style === "spin")) return "whole";
    if (a.style !== "none" && a.durationSec > 0) out.push([start + a.delaySec, start + a.delaySec + a.durationSec]);
    if (a.exit.style !== "none" && a.exit.durationSec > 0) out.push([end - Math.min(a.exit.durationSec, clip.duration), end]);
  }
  const pr = clip.progress;
  if (pr && pr.from !== pr.to) {
    const [t0, t1] = shapeProgressWindow(clip)!;
    out.push([t0, Math.max(t1, t0 + 1e-3)]);
  }
  // Text parts carry their own intro / exit / loop and live counters.
  for (const part of clip.parts ?? []) {
    if (part.kind !== "text") continue;
    const pw = textAnimWindows(part.anim, start, end);
    if (pw === "whole") return "whole";
    out.push(...pw);
    const cw = counterWindows({ start, duration: clip.duration, counter: part.counter });
    if (cw === "whole") return "whole";
    out.push(...cw);
  }
  return out;
}

/** Animated windows of a TextAnim spanning [start, end] ("whole" for loops / carets). */
export function textAnimWindows(a: TextAnim | undefined, start: number, end: number): Window[] | "whole" {
  if (!a) return [];
  if (a.loop.style !== "none" && a.loop.amount > 0) return "whole";
  if (a.style === "typewriter" && a.caret) return "whole";
  const out: Window[] = [];
  if (a.style !== "none" && a.durationSec > 0) out.push([start + a.delaySec, start + a.delaySec + a.durationSec]);
  if (a.exit.style !== "none" && a.exit.durationSec > 0) out.push([end - Math.min(a.exit.durationSec, end - start), end]);
  return out;
}

/**
 * The windows during which a COUNTER text changes: "whole" for a smooth count (or
 * ticks faster than every two frames at 30 fps), else a tiny window at each tick so
 * every value exports as one still (a 60 s timer = 60 stills, not 1800 frames).
 */
export function counterWindows(clip: CounterHost): Window[] | "whole" {
  const c = clip.counter;
  if (!c) return [];
  if (c.from === c.to) return [];
  if (c.mode === "smooth") return "whole";
  const n = counterSteps(c);
  if (clip.duration / n < 2 / 30) return "whole";
  return counterTickTimes(clip).map((tk) => [Math.max(clip.start, tk - 1e-4), tk + 1e-4] as Window);
}

// ---- geometry ----------------------------------------------------------------------

/** One sub-path of a shape outline: flat [x0,y0,x1,y1,…] in shape-local px. */
export interface Polyline {
  pts: number[];
  closed: boolean;
}

function sampleEllipse(rx: number, ry: number, n: number, cx = 0, cy = 0): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return pts;
}

function roundRectPts(x: number, y: number, w: number, h: number, r: number): number[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const pts: number[] = [];
  const corner = (cx: number, cy: number, a0: number): void => {
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * (Math.PI / 2);
      pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  };
  if (rr <= 0) {
    // Start at the top-center so a draw-on reads naturally, clockwise.
    return [x + w / 2, y, x + w, y, x + w, y + h, x, y + h, x, y, x + w / 2, y];
  }
  pts.push(x + w / 2, y);
  corner(x + w - rr, y + rr, -Math.PI / 2);
  corner(x + w - rr, y + h - rr, 0);
  corner(x + rr, y + h - rr, Math.PI / 2);
  corner(x + rr, y + rr, Math.PI);
  pts.push(x + w / 2, y);
  return pts;
}

function starPts(points: number, rx: number, ry: number, inner: number): number[] {
  const pts: number[] = [];
  const n = points * 2;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const k = i % 2 === 0 ? 1 : inner;
    pts.push(Math.cos(a) * rx * k, Math.sin(a) * ry * k);
  }
  return pts;
}

/** Quadratic Bézier samples from p0 via c to p1 (inclusive). */
function quad(p0: [number, number], c: [number, number], p1: [number, number], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = (1 - u) * (1 - u);
    const b = 2 * (1 - u) * u;
    const d = u * u;
    out.push(a * p0[0] + b * c[0] + d * p1[0], a * p0[1] + b * c[1] + d * p1[1]);
  }
  return out;
}

/** Cubic Bézier samples p0 → p3 (inclusive). */
function cubic(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = (1 - u) ** 3;
    const b = 3 * (1 - u) ** 2 * u;
    const c = 3 * (1 - u) * u * u;
    const d = u ** 3;
    out.push(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]);
  }
  return out;
}

/**
 * The outline of a shape as polylines in shape-local px (centered on 0,0, fit to
 * the w×h box). Closed kinds trace clockwise from the top; stroke kinds trace from
 * their natural start (so a draw-on reads like a pen stroke). The arrow heads of
 * `arrow` / `arrow-curve` are NOT part of the path — see `arrowHead`.
 */
export function shapeOutline(kind: ShapeKind, w: number, h: number, radius = 0, thickness = 8): Polyline[] {
  const hw = w / 2;
  const hh = h / 2;
  switch (kind) {
    case "rect":
      return [{ pts: roundRectPts(-hw, -hh, w, h, radius), closed: true }];
    case "ellipse":
      return [{ pts: sampleEllipse(hw, hh, 96), closed: true }];
    case "line":
      return [{ pts: [-hw, 0, hw, 0], closed: false }];
    case "arrow": {
      const head = Math.max(thickness * 3.2, 20);
      return [{ pts: [-hw, 0, hw - head, 0], closed: false }];
    }
    case "star":
      return [{ pts: starPts(5, hw, hh, 0.46), closed: true }];
    case "sparkle": {
      // A four-point sparkle ✦ with concave sides (a softened astroid).
      const pts: number[] = [];
      const n = 96;
      const k = 2.4;
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        pts.push(Math.sign(c) * Math.pow(Math.abs(c), k) * hw, Math.sign(sn) * Math.pow(Math.abs(sn), k) * hh);
      }
      return [{ pts, closed: true }];
    }
    case "burst":
      return [{ pts: starPts(18, hw, hh, 0.84), closed: true }];
    case "triangle":
      return [{ pts: [0, -hh, hw, hh, -hw, hh, 0, -hh], closed: true }];
    case "play":
      return [{ pts: [-hw * 0.8, -hh, hw, 0, -hw * 0.8, hh, -hw * 0.8, -hh], closed: true }];
    case "heart": {
      // The classic parametric heart, normalized to the box, from the top cusp.
      const raw: number[] = [];
      const n = 120;
      for (let i = 0; i <= n; i++) {
        const u = (i / n) * Math.PI * 2;
        const x = 16 * Math.pow(Math.sin(u), 3);
        const y = -(13 * Math.cos(u) - 5 * Math.cos(2 * u) - 2 * Math.cos(3 * u) - Math.cos(4 * u));
        raw.push(x, y);
      }
      // x ∈ [-16, 16]; y ∈ [-12, 17] (approx) → fit to the box.
      const pts: number[] = [];
      for (let i = 0; i < raw.length; i += 2) pts.push((raw[i]! / 16) * hw, ((raw[i + 1]! - 2.5) / 14.5) * hh);
      return [{ pts, closed: true }];
    }
    case "bell": {
      // Bell: a rounded dome whose sides flare to the rim, a top knob, a clapper.
      // Designed in a unit box (x, y ∈ [-1, 1]) and scaled to w×h.
      const X = (v: number): number => v * hw;
      const Y = (v: number): number => v * hh;
      const right = [
        ...cubic([X(0), Y(-0.74)], [X(0.56), Y(-0.74)], [X(0.62), Y(-0.42)], [X(0.62), Y(-0.02)], 18),
        ...cubic([X(0.62), Y(-0.02)], [X(0.62), Y(0.3)], [X(0.8), Y(0.4)], [X(0.98), Y(0.52)], 14).slice(2),
      ];
      const body: number[] = [...right];
      for (let i = right.length - 2; i >= 0; i -= 2) body.push(-right[i]!, right[i + 1]!);
      return [
        { pts: body, closed: true },
        { pts: sampleEllipse(hw * 0.12, hh * 0.12, 24, 0, Y(-0.8)), closed: true },
        { pts: sampleEllipse(hw * 0.2, hh * 0.18, 32, 0, Y(0.72)), closed: true },
      ];
    }
    case "speech": {
      const bh = h * 0.78;
      const top = -hh;
      const bot = top + bh;
      const r = Math.min(bh * 0.32, w * 0.2);
      const pts: number[] = [];
      const arc = (cx: number, cy: number, a0: number): void => {
        for (let i = 0; i <= 8; i++) {
          const a = a0 + (i / 8) * (Math.PI / 2);
          pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
      };
      pts.push(0, top);
      arc(hw - r, top + r, -Math.PI / 2);
      arc(hw - r, bot - r, 0);
      pts.push(-w * 0.12, bot, -w * 0.3, hh, -w * 0.3, bot);
      arc(-hw + r, bot - r, Math.PI / 2);
      arc(-hw + r, top + r, Math.PI);
      pts.push(0, top);
      return [{ pts, closed: true }];
    }
    case "check":
      return [{ pts: [-hw, hh * 0.05, -hw * 0.3, hh * 0.75, hw, -hh * 0.8], closed: false }];
    case "chevron":
      return [{ pts: [-hw, hh * 0.5, 0, -hh * 0.5, hw, hh * 0.5], closed: false }];
    case "scribble": {
      // A hand-drawn loop: ~1.15 turns with a gentle wobble and an overshoot.
      const pts: number[] = [];
      const n = 150;
      const turns = 1.15;
      const a0 = -Math.PI * 0.62;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const a = a0 + u * turns * Math.PI * 2;
        const drift = 1 - 0.06 * u;
        const rx = hw * 0.93 * drift * (1 + 0.035 * Math.sin(3 * a + 0.7));
        const ry = hh * 0.88 * drift * (1 + 0.05 * Math.cos(2 * a + 0.3));
        pts.push(Math.cos(a) * rx + w * 0.015 * u, Math.sin(a) * ry - h * 0.03 * u);
      }
      return [{ pts, closed: false }];
    }
    case "squiggle": {
      // A hand-drawn wavy underline: two and a half gentle waves, slightly uneven.
      const pts: number[] = [];
      const n = 80;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const a = u * Math.PI * 5;
        pts.push(-hw + u * w, Math.sin(a) * hh * (0.75 + 0.25 * Math.sin(u * 7.3)));
      }
      return [{ pts, closed: false }];
    }
    case "arrow-curve": {
      const head = Math.max(thickness * 3.2, 18);
      const end: [number, number] = [hw - head * 0.6, -hh * 0.15];
      return [{ pts: quad([-hw, hh * 0.55], [-hw * 0.15, -hh * 1.05], end, 48), closed: false }];
    }
  }
  return [{ pts: roundRectPts(-hw, -hh, w, h, radius), closed: true }];
}

/** Arrow-head triangle (tip + two base corners) for arrow / arrow-curve, or null. */
export function arrowHead(kind: ShapeKind, w: number, h: number, thickness: number): number[] | null {
  if (kind === "arrow") {
    const head = Math.max(thickness * 3.2, 20);
    const hw = w / 2;
    return [hw, 0, hw - head, -head * 0.47, hw - head, head * 0.47];
  }
  if (kind === "arrow-curve") {
    const line = shapeOutline(kind, w, h, 0, thickness)[0]!.pts;
    const n = line.length;
    const ex = line[n - 2]!;
    const ey = line[n - 1]!;
    const px = line[n - 6]!;
    const py = line[n - 5]!;
    const ang = Math.atan2(ey - py, ex - px);
    const head = Math.max(thickness * 3.2, 18);
    const tipX = ex + Math.cos(ang) * head * 0.6;
    const tipY = ey + Math.sin(ang) * head * 0.6;
    const bx = tipX - Math.cos(ang) * head;
    const by = tipY - Math.sin(ang) * head;
    const nx = -Math.sin(ang) * head * 0.47;
    const ny = Math.cos(ang) * head * 0.47;
    return [tipX, tipY, bx + nx, by + ny, bx - nx, by - ny];
  }
  return null;
}

/** Total length of a set of polylines (for draw-on spans). */
export function polylineLength(lines: Polyline[]): number {
  let L = 0;
  for (const ln of lines) {
    const p = ln.pts;
    for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i]! - p[i - 2]!, p[i + 1]! - p[i - 1]!);
  }
  return L;
}

/**
 * The point at fraction `f` (0..1) along a set of polylines (treated as one pen
 * stroke, in order) — used for progress knobs on drawn paths.
 */
export function pointAlong(lines: Polyline[], f: number): [number, number] {
  const total = polylineLength(lines);
  let target = clamp01(f) * total;
  let last: [number, number] = [0, 0];
  for (const ln of lines) {
    const p = ln.pts;
    if (p.length >= 2) last = [p[0]!, p[1]!];
    for (let i = 2; i < p.length; i += 2) {
      const seg = Math.hypot(p[i]! - p[i - 2]!, p[i + 1]! - p[i - 1]!);
      if (target <= seg && seg > 0) {
        const u = target / seg;
        return [p[i - 2]! + (p[i]! - p[i - 2]!) * u, p[i - 1]! + (p[i + 1]! - p[i - 1]!) * u];
      }
      target -= seg;
      last = [p[i]!, p[i + 1]!];
    }
  }
  return last;
}
