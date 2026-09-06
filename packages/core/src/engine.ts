/**
 * Engine-agnostic render contract + timeline math.
 *
 * The Director and the app depend ONLY on these types, never on a concrete
 * renderer. Today we ship a Node canvas renderer (packages/render-node); the
 * browser will preview with Omniclip/WebCodecs; a future worker may swap in
 * MLT/ffmpeg. None of those changes touch this interface or the edit-doc.
 */
import type { Clip, EditDoc, Track, VideoClip } from "./schema";

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
 */
export function activeClipsAt(doc: EditDoc, timeSec: number): ClipOnTrack[] {
  const out: ClipOnTrack[] = [];
  for (const track of doc.tracks) {
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
  const speed = clip.speed ?? 1;
  // Reversed: play the source window backwards — local 0 shows the END of the
  // window [sourceIn, sourceIn + duration*speed), local duration shows sourceIn.
  if (clip.reversed) return clip.sourceIn + clip.duration * speed - local * speed;
  return clip.sourceIn + local * speed;
}

/** Seconds of SOURCE a video clip consumes given its timeline duration + speed. */
export function sourceSpanSec(clip: VideoClip): number {
  return clip.duration * (clip.speed ?? 1);
}
