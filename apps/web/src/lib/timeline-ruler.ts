/**
 * Pure timeline-ruler + time-display math (no React): adaptive ticks with
 * timecode labels, the NLE-style `MM:SS:FF` readout, zoom helpers and the
 * edge auto-scroll speed used while dragging. Unit-tested in
 * `tests/timeline-dnd.test.ts`.
 */

const round = (n: number, d = 1000): number => Math.round(n * d) / d;

/** One ruler tick. `label` is only present on major ticks. */
export interface RulerTick {
  t: number;
  major: boolean;
  label?: string;
}

/** Candidate MAJOR spacings (seconds), smallest first. Sub-second steps are frame-based. */
function majorSteps(fps: number): number[] {
  const f = 1 / Math.max(1, fps);
  return [f, 2 * f, 5 * f, 10 * f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
}

/** Minor subdivisions to try for a major step, best (most) first. */
const MINOR_DIVS = [10, 6, 5, 4, 3, 2];

/**
 * `m:ss` / `h:mm:ss` — the ruler label for whole-second steps. Sub-second steps
 * use `m:ss:ff` (frames) so every label is unique at high zoom.
 */
export function fmtRulerLabel(t: number, step: number, fps: number, hours: boolean): string {
  const s = Math.max(0, t);
  const whole = Math.floor(s + 1e-6);
  const frames = Math.round((s - whole) * fps);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const r = whole % 60;
  const base =
    hours || h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
      : `${m}:${String(r).padStart(2, "0")}`;
  return step < 1 - 1e-9 ? `${base}:${String(Math.min(fps - 1, frames)).padStart(2, "0")}` : base;
}

/**
 * Full NLE timecode `MM:SS:FF` (or `H:MM:SS:FF` past an hour) for the current-time
 * readout. Frames are floored so the readout never runs ahead of the picture.
 */
export function fmtTimecode(sec: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(Math.max(0, sec) * f + 1e-6);
  const frames = totalFrames % f;
  const whole = Math.floor(totalFrames / f);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}:${pad(frames)}` : `${pad(m)}:${pad(s)}:${pad(frames)}`;
}

/** Is `major / n` a clean tick spacing (frame-aligned below 1s, whole ms above)? */
function cleanDivision(major: number, n: number, fps: number): boolean {
  const minor = major / n;
  if (major < 1 - 1e-9) {
    const fr = minor * fps;
    return Math.abs(fr - Math.round(fr)) < 1e-6 && fr >= 1 - 1e-6;
  }
  const ms = minor * 1000;
  return Math.abs(ms - Math.round(ms)) < 1e-6;
}

/** The step the ruler picks for a zoom level: majors ≥ `minMajorPx` apart. */
export function rulerSteps(pxPerSec: number, fps: number, minMajorPx = 84): { major: number; minorDiv: number } {
  const steps = majorSteps(fps);
  const major = steps.find((s) => s * pxPerSec >= minMajorPx) ?? steps[steps.length - 1]!;
  const majorPx = major * pxPerSec;
  const minorDiv = MINOR_DIVS.find((n) => majorPx / n >= 9 && cleanDivision(major, n, fps)) ?? 1;
  return { major, minorDiv };
}

/** Hard cap so a degenerate zoom can never emit thousands of DOM nodes. */
const MAX_TICKS = 1500;

/**
 * Adaptive ruler ticks over `[from, to]` seconds (defaults to the whole timeline).
 * Majors carry timecode labels; minors subdivide them when there's room. Pass
 * `from`/`to` (the visible window) to render only what's on screen at high zoom.
 */
export function rulerTicks(pxPerSec: number, totalSec: number, fps: number, from = 0, to = totalSec): RulerTick[] {
  if (!(pxPerSec > 0) || totalSec <= 0) return [];
  const { major, minorDiv } = rulerSteps(pxPerSec, fps);
  const minor = major / minorDiv;
  const hours = totalSec >= 3600;
  const out: RulerTick[] = [];
  const lo = Math.max(0, from);
  const hi = Math.min(totalSec + 1e-6, to);
  const first = Math.max(0, Math.floor(lo / minor + 1e-9));
  for (let i = first; out.length < MAX_TICKS; i++) {
    const t = i * minor;
    if (t > hi + 1e-9) break;
    const isMajor = minorDiv === 1 || i % minorDiv === 0;
    const rt = round(t, 10000);
    out.push(isMajor ? { t: rt, major: true, label: fmtRulerLabel(rt, major, fps, hours) } : { t: rt, major: false });
  }
  return out;
}

/** Clamp a zoom multiplier into `[min, max]` at 0.1 resolution. */
export function clampZoom(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n * 10) / 10));
}

/**
 * Px/frame of scroll to apply while dragging near an edge of `[min, max]`. Zero in
 * the dead zone, ramping (ease-in) up to `maxSpeed` at / past the edge.
 */
export function edgeScrollSpeed(pos: number, min: number, max: number, edge = 56, maxSpeed = 22): number {
  if (max - min < edge * 2) return 0;
  if (pos < min + edge) {
    const k = Math.min(1, (min + edge - pos) / edge);
    return -Math.ceil(maxSpeed * k * k);
  }
  if (pos > max - edge) {
    const k = Math.min(1, (pos - (max - edge)) / edge);
    return Math.ceil(maxSpeed * k * k);
  }
  return 0;
}

/**
 * Where to scroll so the playhead stays comfortably in view while following it,
 * or `null` when it's already inside the safe band. Targets the left quarter so a
 * whole "page" of timeline is revealed ahead of the playhead (no jitter).
 */
export function followScrollTarget(playheadPx: number, scrollLeft: number, viewPx: number, contentPx: number): number | null {
  if (viewPx <= 0 || contentPx <= viewPx + 1) return null;
  const pad = viewPx * 0.1;
  if (playheadPx >= scrollLeft + pad && playheadPx <= scrollLeft + viewPx - pad) return null;
  const target = playheadPx - viewPx * 0.25;
  return Math.max(0, Math.min(contentPx - viewPx, target));
}

/** Track-height presets (px) the per-track cycle button walks through. */
export const TRACK_HEIGHTS = [36, 56, 84] as const;
export type TrackHeight = (typeof TRACK_HEIGHTS)[number];
export function nextTrackHeight(h: number): TrackHeight {
  const i = TRACK_HEIGHTS.findIndex((x) => x === h);
  return i < 0 ? TRACK_HEIGHTS[1] : TRACK_HEIGHTS[(i + 1) % TRACK_HEIGHTS.length]!;
}
