/**
 * Engine-agnostic render contract + timeline math.
 *
 * The Director and the app depend ONLY on these types, never on a concrete
 * renderer. Today we ship a Node canvas renderer (packages/render-node); the
 * browser will preview with Omniclip/WebCodecs; a future worker may swap in
 * MLT/ffmpeg. None of those changes touch this interface or the edit-doc.
 */
import type { Clip, EditDoc, SpeedRamp, Track, VideoClip } from "./schema";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** A rendered still frame. `data` is the encoded image bytes. */
export interface RenderedFrame {
  width: number;
  height: number;
  format: "png";
  data: Uint8Array;
}

/** Anything that can turn an edit-doc into pixels. */
export interface RenderEngine {
  /** Render a single frame at `timeSec` on the project timeline. */
  renderFrame(doc: EditDoc, timeSec: number): Promise<RenderedFrame>;
}

/** True if `clip` is on screen / audible at `timeSec`. */
export function isClipActiveAt(clip: Clip, timeSec: number): boolean {
  return timeSec >= clip.start && timeSec < clip.start + clip.duration;
}

/** A clip together with the track it belongs to. */
export interface ClipOnTrack {
  track: Track;
  clip: Clip;
}

/**
 * All clips active at `timeSec`, in paint order (earlier tracks first, i.e.
 * bottom of the stack). Callers draw them in the returned order.
 *
 * A `hidden` track contributes nothing — so the canvas raster, the browser Stage,
 * and the client preview all skip a hidden layer for free (they share this
 * helper). Hidden is the single guard: it keeps preview↔canvas↔export in agreement
 * (the ffmpeg export skips the same hidden tracks).
 */
export function activeClipsAt(doc: EditDoc, timeSec: number): ClipOnTrack[] {
  const out: ClipOnTrack[] = [];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (isClipActiveAt(clip, timeSec)) out.push({ track, clip });
    }
  }
  return out;
}

/** Total timeline duration in seconds (max clip end across all tracks). */
export function docDurationSec(doc: EditDoc): number {
  let end = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.start + clip.duration);
    }
  }
  return end;
}

/** Convert a frame index to a timestamp in seconds for this doc's fps. */
export function frameToSec(doc: EditDoc, frame: number): number {
  return frame / doc.meta.fps;
}

/**
 * Which point of the SOURCE media a video clip shows at timeline time `timeSec`.
 * The clip occupies [start, start+duration) on the timeline; `speed` (1 = real
 * time) maps timeline progress onto the source:
 *
 *   sourceTime = sourceIn + (timeSec - start) * speed
 *
 * So a clip playing at 0.5× (slow-mo) advances through source half as fast, and
 * 2× twice as fast. This is the single pure mapping every surface shares — the
 * browser Stage seeks here, and the ffmpeg export derives its per-clip source
 * window (`-t = duration * speed`) and `setpts=PTS/speed` from the same rule —
 * so preview and export always agree. Clamped to the clip's timeline range.
 */
export function sourceTimeAt(clip: VideoClip, timeSec: number): number {
  // Freeze-frame: hold one source frame for the whole clip, regardless of local time.
  if (clip.freezeAtSec !== undefined) return clip.freezeAtSec;
  const local = Math.max(0, Math.min(clip.duration, timeSec - clip.start));
  const ramp = clip.speedRamp;
  // Speed RAMP (time remap): the source consumed by clip-progress p is the
  // integral of the piecewise-linear rate curve, so the clip can slow down then
  // speed up within its slot. The integral is strictly increasing (rates > 0), so
  // this stays monotonic — playback always maps forward. Overrides scalar `speed`.
  if (ramp && ramp.length > 0) {
    const dur = Math.max(1e-6, clip.duration);
    const consumed = dur * speedRampIntegral(ramp, local / dur);
    if (clip.reversed) {
      const span = dur * speedRampIntegral(ramp, 1);
      return clip.sourceIn + span - consumed;
    }
    return clip.sourceIn + consumed;
  }
  const speed = clip.speed ?? 1;
  // Reversed: play the source window backwards — local 0 shows the END of the
  // window [sourceIn, sourceIn + duration*speed), local duration shows sourceIn.
  if (clip.reversed) return clip.sourceIn + clip.duration * speed - local * speed;
  return clip.sourceIn + local * speed;
}

/**
 * Piecewise-linear playback rate (speed multiplier) at clip-progress `u` (0..1)
 * from a ramp's control points. Points are read in progress order; before the
 * first / after the last control point the end multiplier is HELD flat (matching
 * the hold-outside semantics of `valueAt` / `cursorPositionAt`). Pure.
 */
function speedRampRateAt(pts: readonly (readonly [number, number])[], u: number): number {
  const uu = clamp01(u);
  const first = pts[0]!;
  if (uu <= first[0]) return first[1];
  const last = pts[pts.length - 1]!;
  if (uu >= last[0]) return last[1];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (uu >= a[0] && uu <= b[0]) {
      const span = Math.max(1e-6, b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * ((uu - a[0]) / span);
    }
  }
  return last[1];
}

/**
 * The integral ∫₀^p rate(u) du of a speed ramp — i.e. the FRACTION of the clip's
 * timeline (as a real-time-equivalent multiple) whose source has been consumed by
 * clip-progress `p`. Multiply by `duration` to get source-seconds. Exact:
 * trapezoidal over the control-point breakpoints, where the rate is linear
 * between consecutive breakpoints. Strictly increasing (rates ≥ 0.1 > 0), so the
 * source-time mapping it drives is monotonic. Pure + deterministic — the single
 * helper the canvas, the Stage, and the ffmpeg export all share for ramps.
 */
export function speedRampIntegral(ramp: SpeedRamp, p: number): number {
  if (ramp.length === 0) return clamp01(p);
  const pts = [...ramp].sort((a, b) => a[0] - b[0]);
  const target = clamp01(p);
  // Breakpoints: 0, the target, and every control-point progress in (0, target].
  const breaks = Array.from(new Set<number>([0, target, ...pts.map((q) => q[0])]))
    .filter((x) => x >= 0 && x <= target)
    .sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < breaks.length - 1; i++) {
    const a = breaks[i]!;
    const b = breaks[i + 1]!;
    area += ((b - a) * (speedRampRateAt(pts, a) + speedRampRateAt(pts, b))) / 2;
  }
  return area;
}

/** Seconds of SOURCE a video clip consumes given its timeline duration + speed. */
export function sourceSpanSec(clip: VideoClip): number {
  const ramp = clip.speedRamp;
  // A ramp's total source span is the full integral × duration (the average rate
  // over the clip); no ramp ⇒ the historical duration × scalar speed (unchanged).
  if (ramp && ramp.length > 0) return Math.max(1e-6, clip.duration) * speedRampIntegral(ramp, 1);
  return clip.duration * (clip.speed ?? 1);
}
