import type { EditDoc, Track, TransitionType } from "@cadence/core";
import { clearFadeOut, clearTransition, setTransition } from "@cadence/director";
import { isMainSequentialTrack } from "./edit-ops";

/**
 * Bulk transition helpers for the "Apply to all / Auto / Remove all" controls.
 *
 * These are thin folds over the ENGINE's pure per-cut ops (`setTransition`
 * / `clearTransition` / `clearFadeOut` from `@cadence/director`) — no transition
 * logic is reimplemented here. Each returns a NEW doc so the editor can route the
 * whole batch through a SINGLE undoable `commit` (one coalesced undo step).
 *
 * A "cut" is the boundary between two back-to-back clips on a magnetic main
 * VISUAL track, i.e. every video/image clip after the first. The first clip has
 * no incoming cut (its optional fade-in-from-black is left to the per-cut chip).
 */

/** The unlocked, magnetic main VISUAL tracks whose cuts the bulk ops act on. */
function mainVisualTracks(doc: EditDoc): Track[] {
  return doc.tracks.filter(
    (t) => t.kind === "visual" && isMainSequentialTrack(t) && !t.locked,
  );
}

/** The ids of the sequential video/image clips on a main visual track, in order. */
function seqClipIds(track: Track): string[] {
  return track.clips
    .filter((c) => c.kind === "video" || c.kind === "image")
    .map((c) => c.id);
}

/** How many cut boundaries the main visual track(s) currently have (for gating). */
export function mainCutCount(doc: EditDoc): number {
  let n = 0;
  for (const track of mainVisualTracks(doc)) {
    n += Math.max(0, seqClipIds(track).length - 1);
  }
  return n;
}

/** True when at least one main-track cut already carries a transition / fade-out. */
export function hasAnyTransition(doc: EditDoc): boolean {
  for (const track of mainVisualTracks(doc)) {
    for (const c of track.clips) {
      if (c.kind !== "video" && c.kind !== "image") continue;
      if (c.transitionInSec > 0 || c.transitionOutSec > 0) return true;
    }
  }
  return false;
}

/**
 * Apply `type` + `durSec` to EVERY cut on the main visual track(s). Each cut is
 * first cleared (so the picked duration wins even where a transition already
 * exists), then set via the engine's per-cut `setTransition`. Clip ids are read
 * from the incoming `doc` (ids are stable across the pure ops), so re-laying
 * between folds never loses a target. Returns the batched doc for one commit.
 */
export function setAllTransitions(doc: EditDoc, type: TransitionType, durSec: number): EditDoc {
  let next = doc;
  for (const track of mainVisualTracks(doc)) {
    const ids = seqClipIds(track);
    for (let i = 1; i < ids.length; i++) {
      next = clearTransition(next, ids[i]!);
      next = setTransition(next, type, durSec, { clipId: ids[i]! });
    }
  }
  return next;
}

/**
 * Hard-cut everything: clear the incoming transition on every main-track cut
 * (and any head fade-in-from-black on the first clip), plus a tail
 * fade-out-to-black on the last clip. Returns the batched doc for one commit.
 */
export function clearAllTransitions(doc: EditDoc): EditDoc {
  let next = doc;
  for (const track of mainVisualTracks(doc)) {
    const seq = track.clips.filter((c) => c.kind === "video" || c.kind === "image");
    for (const c of seq) {
      if (c.transitionInSec > 0) next = clearTransition(next, c.id);
    }
    const last = seq[seq.length - 1];
    if (last && last.transitionOutSec > 0) next = clearFadeOut(next, last.id);
  }
  return next;
}
