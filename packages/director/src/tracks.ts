/**
 * Pure track-management ops — the shared spine behind the Director's track tools
 * (add_track / remove_track / set_track / reorder_track / move_clip) AND the
 * timeline UI's track headers + cross-lane drag. Each is `(doc, …) => EditDoc`,
 * deterministic, and re-parsed through the schema so the result is always valid.
 *
 * Z-ORDER IS ARRAY ORDER: `tracks[i]` paints under `tracks[i+1]`. Reordering a
 * layer = reordering the array (reorderTrack). There is no `z` field — one source
 * of truth, already honored by `activeClipsAt` (canvas + Stage) and the ffmpeg
 * export's layer compositing.
 */
import { parseEditDoc, type EditDoc, type TrackKind } from "@cadence/core";
import { isMainVisualTrack } from "./edits";

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** A mutable view of a track inside a structuredClone (before re-parse). */
type MutableTrack = {
  id: string;
  kind: TrackKind;
  clips: { id: string; start: number; duration: number; kind: string }[];
  name?: string;
  hidden?: boolean;
  locked?: boolean;
  muted?: boolean;
  solo?: boolean;
};

function mutableTracks(clone: EditDoc): MutableTrack[] {
  return clone.tracks as unknown as MutableTrack[];
}

/** Generate a track id that is unique within the doc, seeded from the kind. */
function uniqueTrackId(clone: EditDoc, kind: TrackKind): string {
  const taken = new Set(clone.tracks.map((t) => t.id));
  const stem = kind === "audio" ? "audio" : "layer";
  for (let i = 1; ; i++) {
    const id = `${stem}-${i}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Gap-close a magnetic (main) visual track: sort its clips by start and re-lay
 * them contiguously from 0 — the reflow the primary footage lane uses so cuts
 * stay seamless. Mutates the track in place.
 */
function reflowMagnetic(track: MutableTrack): void {
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const clip of sorted) {
    clip.start = round(cursor);
    cursor = round(cursor + clip.duration);
  }
  track.clips = sorted;
}

export interface AddTrackOpts {
  kind: TrackKind;
  /** Header label; falls back to the generated id when absent. */
  name?: string;
  /** Insert the new track directly ABOVE this track (higher z). Appends when absent/unknown. */
  afterTrackId?: string;
}

/**
 * Add an empty track. The new track is inserted right AFTER `afterTrackId` in the
 * array (i.e. one z-layer above it), or appended to the top when omitted. Returns
 * the new doc; the created track's id is deterministic (`layer-N` / `audio-N`).
 */
export function addTrack(doc: EditDoc, opts: AddTrackOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const tracks = mutableTracks(clone);
  const id = uniqueTrackId(clone, opts.kind);
  const track: MutableTrack = {
    id,
    kind: opts.kind,
    clips: [],
    ...(opts.name ? { name: opts.name } : {}),
  };
  const at = opts.afterTrackId ? tracks.findIndex((t) => t.id === opts.afterTrackId) : -1;
  if (at >= 0) tracks.splice(at + 1, 0, track);
  else tracks.push(track);
  return parseEditDoc(clone);
}

/**
 * Remove a track (and every clip on it). Refuses to remove a LOCKED track — the
 * lock is there to protect the lane's clips from destructive edits.
 */
export function removeTrack(doc: EditDoc, trackId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const tracks = mutableTracks(clone);
  const track = tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`No track "${trackId}" to remove.`);
  if (track.locked) throw new Error(`Track "${trackId}" is locked — unlock it before removing it.`);
  clone.tracks = clone.tracks.filter((t) => t.id !== trackId);
  return parseEditDoc(clone);
}

export interface SetTrackOpts {
  name?: string;
  hidden?: boolean;
  locked?: boolean;
  muted?: boolean;
  solo?: boolean;
}

/**
 * Set a track's metadata (name / hidden / locked / muted / solo). Omitted fields
 * keep their current value. Always allowed — this is the control that toggles the
 * lock itself, so it never refuses on a locked track.
 */
export function setTrack(doc: EditDoc, trackId: string, opts: SetTrackOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const track = mutableTracks(clone).find((t) => t.id === trackId);
  if (!track) throw new Error(`No track "${trackId}" to update.`);
  if (opts.name !== undefined) track.name = opts.name;
  if (opts.hidden !== undefined) track.hidden = opts.hidden;
  if (opts.locked !== undefined) track.locked = opts.locked;
  if (opts.muted !== undefined) track.muted = opts.muted;
  if (opts.solo !== undefined) track.solo = opts.solo;
  return parseEditDoc(clone);
}

/**
 * Move a track to a new z-index in the array (0 = bottom of the stack). The index
 * is clamped into range. Reordering is a z-order change only — it never touches
 * clips — so it is allowed on locked tracks.
 */
export function reorderTrack(doc: EditDoc, trackId: string, toIndex: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const tracks = clone.tracks;
  const from = tracks.findIndex((t) => t.id === trackId);
  if (from < 0) throw new Error(`No track "${trackId}" to reorder.`);
  const [moved] = tracks.splice(from, 1);
  const dest = Math.max(0, Math.min(tracks.length, Math.round(toIndex)));
  tracks.splice(dest, 0, moved!);
  return parseEditDoc(clone);
}

/**
 * Move a clip to another track (or reposition it within its own track when
 * `toTrackId` is its current track — this generalizes a within-track reorder).
 *
 *  - Dropping onto a MAGNETIC/main visual track re-flows the lane (gap-close), so
 *    `toStartSec` only decides the clip's order in the sequence.
 *  - Dropping onto an OVERLAY/free lane keeps the given `toStartSec` (or the clip's
 *    current start when omitted) as a free position.
 *
 * Refuses when either the source or the destination track is locked.
 */
export function moveClipToTrack(
  doc: EditDoc,
  clipId: string,
  toTrackId: string,
  toStartSec?: number,
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const tracks = mutableTracks(clone);

  const fromTrack = tracks.find((t) => t.clips.some((c) => c.id === clipId));
  if (!fromTrack) throw new Error(`No clip "${clipId}" on any track.`);
  const toTrack = tracks.find((t) => t.id === toTrackId);
  if (!toTrack) throw new Error(`No destination track "${toTrackId}".`);
  if (fromTrack.locked) throw new Error(`Track "${fromTrack.id}" is locked — unlock it to move its clips.`);
  if (toTrack.locked) throw new Error(`Track "${toTrackId}" is locked — unlock it to drop clips onto it.`);

  const clip = fromTrack.clips.find((c) => c.id === clipId)!;
  // Detach from the source lane.
  fromTrack.clips = fromTrack.clips.filter((c) => c.id !== clipId);

  // Position: a magnetic lane re-flows anyway (start is only an ordering hint);
  // an overlay/free lane keeps the dropped start.
  if (toStartSec !== undefined) clip.start = round(Math.max(0, toStartSec));
  toTrack.clips.push(clip);

  // The MAGNETIC lane is the primary footage track — the FIRST main visual track
  // (never an overlay lane, never an upper layer). Dropping onto it gap-closes;
  // every other lane (overlays + upper layers) keeps the free position above.
  const firstMainVisual = tracks.find((t) => t.kind === "visual" && isMainVisualTrack(t.id));
  const magnetic =
    toTrack.kind === "visual" && isMainVisualTrack(toTrack.id) && firstMainVisual?.id === toTrack.id;
  if (magnetic) reflowMagnetic(toTrack);
  return parseEditDoc(clone);
}
