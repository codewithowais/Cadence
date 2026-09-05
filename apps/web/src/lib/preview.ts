import { activeClipsAt, type EditDoc, type TextClip } from "@cadence/core";

export interface PreviewState {
  /** Where to seek the source video (seconds), or null when no video is active. */
  sourceTime: number | null;
  /** Id of the active video clip (so playback reseeks only at cut boundaries). */
  videoClipId: string | null;
  /** Active text overlays at this time. */
  texts: TextClip[];
}

/**
 * Compute what the preview should show at `timeSec`, using the SAME
 * engine-agnostic timeline math as the server renderer. Runs in the browser
 * because @cadence/core is pure (no native deps), so the preview seeks the
 * user's actual uploaded footage — no ffmpeg, no upload round-trip.
 */
export function computePreview(doc: EditDoc, timeSec: number): PreviewState {
  const active = activeClipsAt(doc, timeSec);
  let sourceTime: number | null = null;
  let videoClipId: string | null = null;
  const texts: TextClip[] = [];
  for (const { clip } of active) {
    if (clip.kind === "video") {
      sourceTime = clip.sourceIn + (timeSec - clip.start);
      videoClipId = clip.id;
    } else if (clip.kind === "text") {
      texts.push(clip);
    }
  }
  return { sourceTime, videoClipId, texts };
}
