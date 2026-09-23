/**
 * Pure, client-side timeline edit operations for Cadence.
 *
 * Every function here is a PURE transform: `(doc, …args) => EditDoc`. They never
 * mutate the input (they `structuredClone` first) and always return a value run
 * back through `parseEditDoc` so the result is a fully-valid, fully-defaulted
 * doc. This is the single place the editor's direct-manipulation timeline goes
 * through, and — like every other mutation in the app — the caller routes the
 * result through the editor's `commit` (undo/redo) path.
 *
 * Nothing here changes the schema: trims/splits/reorders/ripples all operate on
 * the existing `start` / `duration` / `sourceIn` / `volume` fields.
 *
 * All times are seconds on the project timeline.
 */
import { parseEditDoc, type Clip, type EditDoc, type Track } from "@cadence/core";
import { addMarker as addMarkerEngine } from "@cadence/director";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Smallest timeline duration any clip may be trimmed/split to (seconds). */
export const MIN_CLIP_SEC = 0.05;

/**
 * Track ids that carry OVERLAYS (titles, captions, PiP b-roll, fades, music,
 * voice-over) rather than the MAIN back-to-back footage. Kept in sync with
 * `@/lib/doc`'s OVERLAY_TRACK_IDS. Overlay clips are positioned freely; the main
 * sequential tracks are re-laid back-to-back (rippled) after every structural
 * edit so there are never gaps.
 */
const OVERLAY_TRACK_IDS = new Set(["titles", "captions", "broll", "fades", "music", "voiceover", "sfx"]);

/** True for a track whose clips are laid out as a gapless back-to-back sequence. */
export function isMainSequentialTrack(track: Track): boolean {
  return !OVERLAY_TRACK_IDS.has(track.id);
}

/** Monotonic id source for clips created by split/duplicate (unique per session). */
let idSeq = 0;
const newClipId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

/** The kinds of clip that participate in a track's back-to-back reflow. */
function isSequentialClip(track: Track, clip: Clip): boolean {
  if (track.kind === "audio") return clip.kind === "audio";
  return clip.kind === "video" || clip.kind === "image";
}

/**
 * Re-lay a track's sequential clips in array order with no gaps, honoring each
 * visual clip's `transitionInSec` as an OVERLAP with the previous clip (so
 * hard-cut videos land back-to-back while crossfading images keep their
 * overlap). Non-sequential clips (text/solid overlays) are left untouched.
 * Mutates the passed track.
 */
function reflowTrack(track: Track): void {
  let prevEnd = 0;
  let first = true;
  for (const clip of track.clips) {
    if (!isSequentialClip(track, clip)) continue;
    const overlap = clip.kind === "video" || clip.kind === "image" ? clip.transitionInSec : 0;
    const start = first ? 0 : Math.max(0, prevEnd - overlap);
    clip.start = round(start);
    prevEnd = clip.start + clip.duration;
    first = false;
  }
}

/** Reflow every main sequential track of a doc (mutates it). */
function reflowMainTracks(doc: EditDoc): void {
  for (const track of doc.tracks) if (isMainSequentialTrack(track)) reflowTrack(track);
}

// ---- Overlay ripple (keep captions/titles/b-roll glued to the footage) ------

/**
 * Overlay tracks whose clips are pinned to a MOMENT in the footage and MUST move
 * when a structural edit re-lays the main track under them (captions especially).
 * Music / voice-over / fades are deliberately excluded — they are ambient audio /
 * whole-composition fades that are placed sensibly on their own and should not
 * jump around when a mid-timeline clip is trimmed or removed.
 */
const RIPPLE_OVERLAY_TRACK_IDS = new Set(["titles", "captions", "broll"]);

/** A main visual clip's timeline span, remembered so overlays can be re-anchored. */
export interface MainSpan {
  id: string;
  start: number;
  end: number;
}

/**
 * Snapshot the timeline spans of the MAIN sequential VISUAL clips (video/image),
 * ordered by start. Overlay clips (captions/titles/b-roll) anchor to these, so
 * this must be captured BEFORE a structural edit mutates the doc. Read-only.
 */
export function captureMainSpans(doc: EditDoc): MainSpan[] {
  const spans: MainSpan[] = [];
  for (const track of doc.tracks) {
    if (!isMainSequentialTrack(track)) continue;
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") {
        spans.push({ id: clip.id, start: clip.start, end: clip.start + clip.duration });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * After a main-track structural edit (trim / split-less reflow / reorder / ripple
 * -delete / duplicate) has re-laid the main clips, shift the overlay clips
 * (captions/titles/PiP b-roll) so they stay in sync with the footage they sit
 * over. Each overlay's start time is mapped from the OLD main layout (`before`,
 * captured with `captureMainSpans`) to the NEW one now in `clone`:
 *
 *  - a clip that still exists carries its overlays with it (same local offset);
 *  - a removed clip's overlays collapse to where the gap closed (the next
 *    surviving clip's new start);
 *  - anything past the last old clip shifts by the net duration change.
 *
 * This is the fix for the review's P0-2: "ripple-delete or trim a mid-timeline
 * clip and every caption/title after it is now out of sync." Mutates `clone`.
 */
export function reanchorOverlays(clone: EditDoc, before: MainSpan[]): void {
  if (before.length === 0) return;
  const after = new Map<string, MainSpan>();
  for (const s of captureMainSpans(clone)) after.set(s.id, s);

  const oldTotal = before[before.length - 1]!.end;
  let newTotal = 0;
  for (const s of after.values()) newTotal = Math.max(newTotal, s.end);
  const tailDelta = newTotal - oldTotal;

  const remap = (t: number): number => {
    for (let i = 0; i < before.length; i++) {
      const span = before[i]!;
      if (t < span.start - 1e-6) return t; // before the first clip → unchanged
      if (t < span.end - 1e-6) {
        const a = after.get(span.id);
        if (a) return round(a.start + Math.min(t - span.start, Math.max(0, a.end - a.start)));
        // The anchoring clip was removed: collapse to the next surviving clip.
        for (let j = i + 1; j < before.length; j++) {
          const nb = after.get(before[j]!.id);
          if (nb) return round(nb.start);
        }
        return round(newTotal);
      }
    }
    return round(Math.max(0, t + tailDelta)); // past the last old clip
  };

  for (const track of clone.tracks) {
    if (!RIPPLE_OVERLAY_TRACK_IDS.has(track.id)) continue;
    for (const clip of track.clips) clip.start = Math.max(0, remap(clip.start));
  }
}

/** A located clip together with its position in the doc. */
export interface FoundClip {
  trackIndex: number;
  clipIndex: number;
  track: Track;
  clip: Clip;
}

/** Find a clip (and its track) by clip id, or `null`. Read-only. */
export function findClip(doc: EditDoc, clipId: string): FoundClip | null {
  for (let ti = 0; ti < doc.tracks.length; ti++) {
    const track = doc.tracks[ti]!;
    for (let ci = 0; ci < track.clips.length; ci++) {
      const clip = track.clips[ci]!;
      if (clip.id === clipId) return { trackIndex: ti, clipIndex: ci, track, clip };
    }
  }
  return null;
}

/** Source duration (seconds) of the media a clip references, or `null` if unknown. */
function mediaDurationSec(doc: EditDoc, mediaId: string): number | null {
  const m = doc.media.find((x) => x.id === mediaId);
  return m?.durationSec != null ? m.durationSec : null;
}

/**
 * Largest timeline `duration` a clip may occupy given how much SOURCE remains
 * after its `sourceIn` (video honors `speed`; audio is 1:1). Images and clips
 * whose media duration is unknown are unbounded (`Infinity`).
 */
export function maxTimelineDuration(doc: EditDoc, clip: Clip): number {
  if (clip.kind === "video") {
    const md = mediaDurationSec(doc, clip.mediaId);
    if (md == null) return Infinity;
    const speed = clip.speed ?? 1;
    return Math.max(MIN_CLIP_SEC, (md - clip.sourceIn) / speed);
  }
  if (clip.kind === "audio") {
    const md = mediaDurationSec(doc, clip.mediaId);
    if (md == null) return Infinity;
    return Math.max(MIN_CLIP_SEC, md - clip.sourceIn);
  }
  return Infinity;
}

// ---- Volume / mute ---------------------------------------------------------

/**
 * Set a single clip's volume (0..1). Only video and audio clips carry volume;
 * for any other kind this is a no-op. Pure.
 */
export function setClipVolume(doc: EditDoc, clipId: string, volume: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const found = findClip(clone, clipId);
  if (found && (found.clip.kind === "video" || found.clip.kind === "audio")) {
    found.clip.volume = clamp(round(volume), 0, 1);
  }
  return parseEditDoc(clone);
}

// ---- Audio fade (per-clip fade handles) ------------------------------------

/**
 * Set a single clip's audio fade-in / fade-out (seconds) — the same
 * `fadeInSec` / `fadeOutSec` schema fields the Audio room's `audioFade` fn writes,
 * but targeted at ONE clip by id (the timeline's corner fade handles always know
 * which clip they are dragging). Only video and audio clips carry a fade; any
 * other kind is a no-op. Each value is clamped to [0, clip.duration] so a ramp
 * never exceeds the clip. Pure + re-parsed through the schema.
 */
export function setClipFade(
  doc: EditDoc,
  clipId: string,
  fade: { fadeInSec?: number; fadeOutSec?: number },
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const found = findClip(clone, clipId);
  if (found && (found.clip.kind === "video" || found.clip.kind === "audio")) {
    const max = found.clip.duration;
    if (fade.fadeInSec !== undefined) found.clip.fadeInSec = clamp(round(fade.fadeInSec), 0, max);
    if (fade.fadeOutSec !== undefined) found.clip.fadeOutSec = clamp(round(fade.fadeOutSec), 0, max);
  }
  return parseEditDoc(clone);
}

// ---- Speed (constant) / speed-ramp clear -----------------------------------

/**
 * Set a single VIDEO clip's CONSTANT playback speed (0.25..4) and drop any speed
 * ramp on it, so the clip plays back at one steady multiplier. The clip keeps its
 * timeline duration; only how much source it consumes changes (see `sourceTimeAt`
 * in core). Non-video clips are a no-op. Pure + re-parsed through the schema.
 *
 * A scalar `speed` and a `speedRamp` are mutually exclusive in the engine (the
 * ramp overrides the scalar), so setting a constant speed also removes the ramp —
 * this is the "Constant speed" escape hatch from a curve.
 */
export function setClipSpeed(doc: EditDoc, clipId: string, speed: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const found = findClip(clone, clipId);
  if (found && found.clip.kind === "video") {
    found.clip.speed = clamp(round(speed), 0.25, 4);
    delete found.clip.speedRamp;
  }
  return parseEditDoc(clone);
}

/**
 * Remove a VIDEO clip's speed RAMP (time-remap curve), reverting it to its scalar
 * constant `speed`. Non-video clips / clips with no ramp are a no-op. Pure +
 * re-parsed through the schema.
 */
export function clearClipSpeedRamp(doc: EditDoc, clipId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const found = findClip(clone, clipId);
  if (found && found.clip.kind === "video") {
    delete found.clip.speedRamp;
  }
  return parseEditDoc(clone);
}

// ---- Trim ------------------------------------------------------------------

export type TrimEdge = "left" | "right";

/**
 * Trim a clip by dragging one of its edges to timeline time `edgeTime`.
 *
 *  - RIGHT edge → changes `duration` only (the out point); the in point stays.
 *  - LEFT edge  → changes `start` + `sourceIn` + `duration` (trim from head);
 *    the out point (start+duration) stays fixed, and `sourceIn` moves with the
 *    head so the same source frame stays under the new left edge. Extending the
 *    head earlier is allowed only while `sourceIn > 0` (there is more source to
 *    reveal).
 *
 * Durations are clamped to `[MIN_CLIP_SEC, availableSource]`. Afterwards the
 * clip's main sequential track is rippled (re-laid back-to-back) so trimming
 * never leaves a gap and later clips shift; overlay clips keep their free
 * position. Pure.
 */
export function trimClip(doc: EditDoc, clipId: string, edge: TrimEdge, edgeTime: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const before = captureMainSpans(clone); // capture BEFORE mutating, for overlay ripple
  const found = findClip(clone, clipId);
  if (!found) return parseEditDoc(clone);
  const { track, clip } = found;
  const speed = clip.kind === "video" ? clip.speed ?? 1 : 1;
  const oldStart = clip.start;
  const oldEnd = clip.start + clip.duration;
  const maxDur = maxTimelineDuration(clone, clip);

  if (edge === "right") {
    // Out point moves; in point (start / sourceIn) fixed.
    let duration = edgeTime - oldStart;
    duration = clamp(duration, MIN_CLIP_SEC, maxDur);
    clip.duration = round(duration);
  } else {
    // Head trim: out point fixed at oldEnd; start + sourceIn + duration move.
    // How far left we may extend is bounded by remaining source before sourceIn.
    let earliest = 0;
    if ((clip.kind === "video" || clip.kind === "audio") && clip.sourceIn > 0) {
      earliest = oldStart - clip.sourceIn / speed;
    } else if (clip.kind === "video" || clip.kind === "audio") {
      earliest = oldStart; // no source before sourceIn → can't extend head earlier
    }
    const latest = oldEnd - MIN_CLIP_SEC; // can't cross the out point
    const newStart = clamp(edgeTime, Math.max(0, earliest), latest);
    const delta = newStart - oldStart; // >0 = trimming head shorter, <0 = extending
    if (clip.kind === "video" || clip.kind === "audio") {
      clip.sourceIn = Math.max(0, round(clip.sourceIn + delta * speed));
    }
    clip.start = round(newStart);
    clip.duration = round(oldEnd - newStart);
  }

  if (isMainSequentialTrack(track)) {
    reflowTrack(track);
    reanchorOverlays(clone, before); // keep captions/titles/b-roll in sync
  }
  return parseEditDoc(clone);
}

// ---- Split -----------------------------------------------------------------

/**
 * Split a clip in two at timeline time `atSec`. The first half keeps the
 * original in point; the second half starts at `atSec` with `sourceIn` advanced
 * to the matching source frame (video honors `speed`; audio is 1:1; images have
 * no source offset). Interior transitions are dropped (the first loses its out
 * transition, the second loses its in transition) so a mid-sequence cut is
 * clean. A punch-in `emphasis` (video) is kept on whichever half still contains
 * its window. No reflow is needed — the two halves exactly tile the original.
 * Returns the doc unchanged if `atSec` isn't strictly inside the clip (or either
 * half would be shorter than `MIN_CLIP_SEC`). Pure.
 */
export function splitClip(doc: EditDoc, clipId: string, atSec: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const found = findClip(clone, clipId);
  if (!found) return parseEditDoc(clone);
  const { track, clipIndex, clip } = found;

  const local = atSec - clip.start;
  const firstDur = round(local);
  const secondDur = round(clip.duration - local);
  if (firstDur < MIN_CLIP_SEC || secondDur < MIN_CLIP_SEC) return parseEditDoc(clone);

  const first: Clip = structuredClone(clip);
  const second: Clip = structuredClone(clip);

  first.duration = firstDur;
  second.id = newClipId(`${clip.id}-b`);
  second.start = round(clip.start + local);
  second.duration = secondDur;

  if (second.kind === "video") {
    const speed = second.speed ?? 1;
    second.sourceIn = round(second.sourceIn + local * speed);
  } else if (second.kind === "audio") {
    second.sourceIn = round(second.sourceIn + local);
  }

  // Interior edge = a hard cut: no fades in the middle of the original span.
  if ("transitionOutSec" in first) first.transitionOutSec = 0;
  if ("transitionInSec" in second) second.transitionInSec = 0;

  // Keep a punch-in only on the half whose timeline range contains its window.
  if (first.kind === "video" && first.emphasis) {
    const at = first.emphasis.atSec;
    if (!(at >= first.start && at < first.start + first.duration)) first.emphasis = undefined;
  }
  if (second.kind === "video" && second.emphasis) {
    const at = second.emphasis.atSec;
    if (!(at >= second.start && at < second.start + second.duration)) second.emphasis = undefined;
  }

  track.clips.splice(clipIndex, 1, first, second);
  return parseEditDoc(clone);
}

// ---- Reorder ---------------------------------------------------------------

/** The sequential (reflowed) clips of a track, in order, with their array indices. */
function sequentialEntries(track: Track): { clip: Clip; arrayIndex: number }[] {
  const out: { clip: Clip; arrayIndex: number }[] = [];
  track.clips.forEach((clip, arrayIndex) => {
    if (isSequentialClip(track, clip)) out.push({ clip, arrayIndex });
  });
  return out;
}

/**
 * Move a clip to a new position among the sequential clips of its own track,
 * then ripple the track back-to-back. `toSeqIndex` is an index into the track's
 * sequential clips (0 = first). No-op for non-sequential (overlay) clips. Pure.
 */
export function reorderClip(doc: EditDoc, clipId: string, toSeqIndex: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const before = captureMainSpans(clone); // capture BEFORE mutating, for overlay ripple
  const found = findClip(clone, clipId);
  if (!found) return parseEditDoc(clone);
  const { track, clip } = found;
  if (!isSequentialClip(track, clip)) return parseEditDoc(clone);

  const seq = sequentialEntries(track);
  const fromSeq = seq.findIndex((e) => e.clip.id === clipId);
  const to = clamp(Math.round(toSeqIndex), 0, seq.length - 1);
  if (fromSeq < 0 || fromSeq === to) return parseEditDoc(clone);

  // Rebuild the ordered list of sequential clips, then write them back into the
  // same array slots (positions of non-sequential clips are preserved).
  const ordered = seq.map((e) => e.clip);
  const [moved] = ordered.splice(fromSeq, 1);
  ordered.splice(to, 0, moved!);
  seq.forEach((e, i) => {
    track.clips[e.arrayIndex] = ordered[i]!;
  });

  reflowTrack(track);
  if (isMainSequentialTrack(track)) reanchorOverlays(clone, before); // captions follow their clip
  return parseEditDoc(clone);
}

/** Move a clip one slot earlier/later among its track's sequential clips (arrow keys). */
export function moveClip(doc: EditDoc, clipId: string, dir: "earlier" | "later"): EditDoc {
  const found = findClip(doc, clipId);
  if (!found || !isSequentialClip(found.track, found.clip)) return doc;
  const seq = sequentialEntries(found.track);
  const at = seq.findIndex((e) => e.clip.id === clipId);
  if (at < 0) return doc;
  return reorderClip(doc, clipId, dir === "earlier" ? at - 1 : at + 1);
}

// ---- Delete / duplicate ----------------------------------------------------

/**
 * Delete a clip WITHOUT closing the gap (leaves later clips where they are).
 * Empty tracks are dropped. Pure.
 */
export function deleteClip(doc: EditDoc, clipId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) track.clips = track.clips.filter((c) => c.id !== clipId);
  clone.tracks = clone.tracks.filter((t) => t.clips.length > 0);
  return parseEditDoc(clone);
}

/**
 * Ripple-delete a clip: remove it and close the gap by re-laying its main
 * sequential track back-to-back. Overlay clips are simply removed (nothing to
 * ripple). Empty tracks are dropped. Pure.
 */
export function rippleDeleteClip(doc: EditDoc, clipId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const before = captureMainSpans(clone); // capture BEFORE mutating, for overlay ripple
  const found = findClip(clone, clipId);
  if (!found) return parseEditDoc(clone);
  const wasMain = isMainSequentialTrack(found.track);
  for (const track of clone.tracks) track.clips = track.clips.filter((c) => c.id !== clipId);
  clone.tracks = clone.tracks.filter((t) => t.clips.length > 0);
  if (wasMain) {
    reflowMainTracks(clone);
    reanchorOverlays(clone, before); // trailing captions/titles close the gap too
  }
  return parseEditDoc(clone);
}

// ---- Markers (persisted in doc.markers) ------------------------------------
//
// Markers live on the PERSISTED `doc.markers` field (`{ t, label? }[]`), so they
// survive save/load and undo/redo. Add routes through the engine's pure
// `addMarker`; remove/bulk-add are pure client transforms of the same field.
// Two markers within `MARKER_EPSILON` seconds are treated as the same marker.

/** Markers this close (seconds) are considered duplicates. */
export const MARKER_EPSILON = 0.03;

/**
 * Add a marker at `t` seconds (via the engine's pure `addMarker`), unless one
 * already sits within `MARKER_EPSILON`. Returns the SAME doc reference when it's a
 * duplicate, so the caller can skip an empty undo step. Pure.
 */
export function addMarkerAt(doc: EditDoc, t: number): EditDoc {
  const rt = round(Math.max(0, t));
  if ((doc.markers ?? []).some((m) => Math.abs(m.t - rt) < MARKER_EPSILON)) return doc;
  return addMarkerEngine(doc, rt);
}

/** Remove the marker nearest `t` (within `MARKER_EPSILON`). Pure. */
export function removeMarkerAt(doc: EditDoc, t: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  clone.markers = (clone.markers ?? []).filter((m) => Math.abs(m.t - t) >= MARKER_EPSILON);
  return parseEditDoc(clone);
}

/**
 * Bulk-add markers (e.g. detected beats): merge `times` into `doc.markers`,
 * deduping within `MARKER_EPSILON`, clamping to `[0, limitSec]`, and sorting
 * ascending. `label` tags the new markers (e.g. "beat"). Pure.
 */
export function addMarkersAt(
  doc: EditDoc,
  times: number[],
  label?: string,
  limitSec?: number,
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const all = [...(clone.markers ?? [])];
  for (const raw of times) {
    let t = round(Math.max(0, raw));
    if (limitSec != null) {
      if (t > limitSec + 1e-3) continue;
      t = Math.min(t, round(limitSec));
    }
    if (all.some((m) => Math.abs(m.t - t) < MARKER_EPSILON)) continue;
    all.push(label ? { t, label } : { t });
  }
  all.sort((x, y) => x.t - y.t);
  clone.markers = all;
  return parseEditDoc(clone);
}

// ---- Beat-snapped cutting --------------------------------------------------

/**
 * Split the main-track video/image clip sitting under each of `times` (e.g. beat
 * markers). Processed left-to-right so each split's second half is what the next
 * (later) time falls into. A time that lands on a clip edge or would leave a
 * sub-`MIN_CLIP_SEC` fragment is skipped (via `splitClip`'s own guard). Reuses
 * the existing `splitClip` op. Returns the SAME doc reference when nothing was
 * split. Pure.
 */
export function splitAtTimes(doc: EditDoc, times: number[]): EditDoc {
  let out = doc;
  const sorted = [...new Set(times.map((t) => round(t)))].sort((a, b) => a - b);
  for (const t of sorted) {
    let targetId: string | null = null;
    for (const track of out.tracks) {
      if (!isMainSequentialTrack(track)) continue;
      for (const clip of track.clips) {
        if (
          (clip.kind === "video" || clip.kind === "image") &&
          t > clip.start + MIN_CLIP_SEC &&
          t < clip.start + clip.duration - MIN_CLIP_SEC
        ) {
          targetId = clip.id;
          break;
        }
      }
      if (targetId) break;
    }
    if (targetId) out = splitClip(out, targetId, t);
  }
  return out;
}

/**
 * Duplicate a clip. On a main sequential track the copy is inserted directly
 * after the original and the track is rippled (so the timeline grows by the
 * clip's duration and everything after shifts right). On an overlay track the
 * copy is placed immediately after the original (its `start` offset by the
 * original's duration) with no reflow. Pure.
 */
export function duplicateClip(doc: EditDoc, clipId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const before = captureMainSpans(clone); // capture BEFORE mutating, for overlay ripple
  const found = findClip(clone, clipId);
  if (!found) return parseEditDoc(clone);
  const { track, clipIndex, clip } = found;
  const copy: Clip = structuredClone(clip);
  copy.id = newClipId(`${clip.id}-copy`);

  if (isMainSequentialTrack(track)) {
    track.clips.splice(clipIndex + 1, 0, copy);
    reflowTrack(track);
    reanchorOverlays(clone, before); // trailing overlays shift by the inserted duration
  } else {
    copy.start = round(clip.start + clip.duration);
    track.clips.splice(clipIndex + 1, 0, copy);
  }
  return parseEditDoc(clone);
}
