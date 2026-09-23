import { activeClipsAt, sourceTimeAt, type EditDoc, type TextClip } from "@cadence/core";

export interface PreviewState {
  /** Where to seek the source video (seconds), or null when no video is active. */
  sourceTime: number | null;
  /** Id of the active video clip (so playback reseeks only at cut boundaries). */
  videoClipId: string | null;
  /** Active text overlays at this time. */
  texts: TextClip[];
  /**
   * Native playback rate for the active video clip: its constant `speed` (1 when
   * none is active, or while a speed ramp drives the timing).
   */
  rate: number;
  /** True while the active video clip is a freeze-frame (the picture must hold). */
  frozen: boolean;
}

/**
 * Compute what the preview should show at `timeSec`, using the SAME
 * engine-agnostic timeline math as the server renderer. Runs in the browser
 * because @cadence/core is pure (no native deps), so the preview seeks the
 * user's actual uploaded footage — no ffmpeg, no upload round-trip. The source
 * time goes through core's `sourceTimeAt`, so speed, speed ramps, reverse and
 * freeze-frames preview the exact frame the canvas renderer and export show.
 */
export function computePreview(doc: EditDoc, timeSec: number): PreviewState {
  const active = activeClipsAt(doc, timeSec);
  let sourceTime: number | null = null;
  let videoClipId: string | null = null;
  let rate = 1;
  let frozen = false;
  const texts: TextClip[] = [];
  for (const { clip, track } of active) {
    // The base <video> shows the first full-frame clip — the same one the Stage
    // picks as `activeVideo` (b-roll plays in its own picture-in-picture element).
    if (clip.kind === "video" && track.id !== "broll" && videoClipId === null) {
      sourceTime = sourceTimeAt(clip, timeSec);
      videoClipId = clip.id;
      frozen = clip.freezeAtSec !== undefined;
      rate = clip.speedRamp && clip.speedRamp.length > 0 ? 1 : clip.speed ?? 1;
    } else if (clip.kind === "text") {
      texts.push(clip);
    }
  }
  return { sourceTime, videoClipId, texts, rate, frozen };
}
