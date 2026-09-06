/**
 * Client-side READ + CLEAR helpers for the VFX / Audio engine fields.
 *
 * The pure APPLY functions live in `@cadence/director` (`chromaKey`, `setBlend`,
 * `addMask`, `regionBlur`, `audioFade`, `setPan`, `normalizeLoudness`, …). This
 * module is their read-side mirror: it reads the current effect state off the doc
 * so the room controls can reflect the single source of truth, and it provides
 * the few "clear" mutations the director package doesn't export (turn a chroma
 * key / mask / region blur off again). Every clear re-parses through the schema
 * (like the director's edits) and is meant to be routed through the editor's
 * commit path, so it stays undoable.
 *
 * The compositing targets mirror `compositeTargets` in the director's edits.ts:
 * chroma / blend / mask target the OVERLAY (b-roll) clips when present, otherwise
 * the MAIN visual clips. Region blur/pixelate always target the MAIN clips.
 */
import {
  parseEditDoc,
  type BlendMode,
  type ChromaKey,
  type EditDoc,
  type ImageClip,
  type Mask,
  type RegionFx,
  type VideoClip,
} from "@cadence/core";

/** Overlay track ids (not the main footage) — kept in sync with director edits.ts. */
const OVERLAY_TRACK_IDS = new Set([
  "titles",
  "captions",
  "broll",
  "fades",
  "music",
  "cursor",
  "callouts",
  "demo-text",
]);
const isMainVisualTrack = (id: string): boolean => !OVERLAY_TRACK_IDS.has(id);

type VisualClip = VideoClip | ImageClip;

/** Read-only mirror of the director's `compositeTargets`: b-roll first, else main. */
function compositeTargets(doc: EditDoc): VisualClip[] {
  const broll = doc.tracks.find((t) => t.id === "broll");
  const brollMedia = (broll?.clips ?? []).filter(
    (c): c is VisualClip => c.kind === "video" || c.kind === "image",
  );
  if (brollMedia.length > 0) return brollMedia;
  const out: VisualClip[] = [];
  for (const track of doc.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") out.push(clip);
    }
  }
  return out;
}

/** Where a chroma / blend / mask edit will land, for an honest UI note. */
export function compositeScope(doc: EditDoc): "broll" | "main" | "none" {
  const broll = doc.tracks.find((t) => t.id === "broll");
  const hasBroll = (broll?.clips ?? []).some((c) => c.kind === "video" || c.kind === "image");
  if (hasBroll) return "broll";
  return compositeTargets(doc).length > 0 ? "main" : "none";
}

/** The chroma key currently on the compositing clip(s), or null. */
export function currentChroma(doc: EditDoc): ChromaKey | null {
  return compositeTargets(doc).find((c) => c.chroma)?.chroma ?? null;
}

/** The blend mode currently on the compositing clip(s) (defaults to "normal"). */
export function currentBlend(doc: EditDoc): BlendMode {
  return compositeTargets(doc).find((c) => c.blendMode && c.blendMode !== "normal")?.blendMode ?? "normal";
}

/** The mask currently on the compositing clip(s), or null. */
export function currentMask(doc: EditDoc): Mask | null {
  return compositeTargets(doc).find((c) => c.mask)?.mask ?? null;
}

/** The region blur/pixelate currently on a MAIN visual clip, or null. */
export function currentRegionFx(doc: EditDoc): RegionFx | null {
  for (const track of doc.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if ((clip.kind === "video" || clip.kind === "image") && clip.regionFx) return clip.regionFx;
    }
  }
  return null;
}

/** Remove the chroma key from every compositing clip (undoable via commit). */
export function clearChroma(doc: EditDoc): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  for (const clip of compositeTargets(clone)) delete (clip as { chroma?: unknown }).chroma;
  return parseEditDoc(clone);
}

/** Remove the shape mask from every compositing clip (undoable via commit). */
export function clearMask(doc: EditDoc): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  for (const clip of compositeTargets(clone)) delete (clip as { mask?: unknown }).mask;
  return parseEditDoc(clone);
}

/** Remove the region blur/pixelate from every MAIN visual clip (undoable via commit). */
export function clearRegionFx(doc: EditDoc): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") delete (clip as { regionFx?: unknown }).regionFx;
    }
  }
  return parseEditDoc(clone);
}

/** The fade in/out (seconds) on the first audio clip of a track, or null if none. */
export function trackFade(doc: EditDoc, trackId: string): { fadeInSec: number; fadeOutSec: number } | null {
  const track = doc.tracks.find((t) => t.id === trackId);
  const clip = track?.clips.find((c) => c.kind === "audio");
  if (!clip || clip.kind !== "audio") return null;
  return { fadeInSec: clip.fadeInSec ?? 0, fadeOutSec: clip.fadeOutSec ?? 0 };
}

/** The stereo pan (-1..1) on the first audio clip of a track, or null if none. */
export function trackPan(doc: EditDoc, trackId: string): number | null {
  const track = doc.tracks.find((t) => t.id === trackId);
  const clip = track?.clips.find((c) => c.kind === "audio");
  if (!clip || clip.kind !== "audio") return null;
  return clip.pan ?? 0;
}
