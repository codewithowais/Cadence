/**
 * Divide an already-built video into clips (`split_into_scenes`).
 *
 * The pure op behind the Director tool AND the web "Divide into scenes" UI. It
 * takes cut points (in SOURCE-media seconds, or absolute timeline seconds, or an
 * "every N seconds" step) and splits every matching video clip into labelled
 * pieces using the engine's own `splitClipAtTime`, so each piece:
 *
 *  - keeps the right SOURCE offset (honouring speed, speed ramps and reverse,
 *    via core's `sourceTimeAt` — cut points are mapped back through it);
 *  - keeps its own audio (a video clip carries its audio, so picture and sound
 *    are cut in lockstep); a separate, sync-aligned audio clip of the SAME media
 *    is split at the same instants (the "audio link");
 *  - is RIPPLE-SAFE: the pieces exactly tile the original, so nothing downstream
 *    (captions, titles, b-roll, music, markers, other tracks) needs to move;
 *  - is one undoable edit for the caller (pure `(doc, opts) => EditDoc`).
 *
 * Cut points too close to a clip edge or to each other (`minShotSec`) are
 * dropped. Locked tracks and freeze-frame clips are left alone.
 */
import { parseEditDoc, sourceTimeAt, type Clip, type EditDoc, type VideoClip } from "@cadence/core";
import { isSequenceTrack, splitClipAtTime } from "./craft";
import { MIN_CLIP_SEC } from "./trims";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const EPS = 1e-6;

export interface SplitIntoScenesOptions {
  /** Split every main-lane video clip that plays this media (default: the first video clip's media). */
  mediaId?: string;
  /** Split only this clip. */
  clipId?: string;
  /** Cut points in SOURCE-media seconds (scene detection, sentences, silence, beats of the media). */
  sourceCuts?: readonly number[];
  /** Cut points in absolute TIMELINE seconds (timeline beats / markers). */
  timelineCuts?: readonly number[];
  /** Cut every N timeline seconds from the start of each target clip. */
  everySec?: number;
  /** Label for the i-th piece (single target clip only). */
  labels?: readonly string[];
  /** Numbered-label prefix ("Scene" → "Scene 1"). */
  labelPrefix?: string;
  /** Drop cuts leaving a piece shorter than this (seconds, default MIN_CLIP_SEC). */
  minShotSec?: number;
}

export interface SplitIntoScenesResult {
  doc: EditDoc;
  /** Number of video pieces produced across all target clips (0 when nothing was cut). */
  pieces: number;
  /** How many extra clips were created (new − before), incl. linked audio. */
  added: number;
  /** Ids of the video pieces in timeline order (labelled). */
  clipIds: string[];
}

/** Timeline time at which `clip` shows source second `src` (bisection over the monotonic `sourceTimeAt`). */
export function timelineTimeAtSource(clip: VideoClip, src: number): number | null {
  if (clip.freezeAtSec !== undefined) return null;
  const a = sourceTimeAt(clip, clip.start);
  const b = sourceTimeAt(clip, clip.start + clip.duration);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (src <= lo + EPS || src >= hi - EPS) return null; // not strictly inside the played window
  const increasing = b >= a;
  let l = clip.start;
  let h = clip.start + clip.duration;
  for (let i = 0; i < 48; i++) {
    const m = (l + h) / 2;
    const v = sourceTimeAt(clip, m);
    if (increasing ? v < src : v > src) l = m;
    else h = m;
  }
  return round((l + h) / 2);
}

/** Main-lane, unlocked, non-frozen video clips that play `mediaId` (or `clipId`), in timeline order. */
function targets(doc: EditDoc, opts: SplitIntoScenesOptions): VideoClip[] {
  const out: VideoClip[] = [];
  let mediaId = opts.mediaId;
  if (!opts.clipId && !mediaId) {
    for (const t of doc.tracks) {
      if (t.kind !== "visual" || !isSequenceTrack(t) || t.locked) continue;
      const v = t.clips.find((c) => c.kind === "video");
      if (v && v.kind === "video") {
        mediaId = v.mediaId;
        break;
      }
    }
  }
  for (const t of doc.tracks) {
    if (t.kind !== "visual" || !isSequenceTrack(t) || t.locked) continue;
    for (const c of t.clips) {
      if (c.kind !== "video" || c.freezeAtSec !== undefined) continue;
      if (opts.clipId ? c.id === opts.clipId : c.mediaId === mediaId) out.push(c);
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Absolute timeline cut times for one target clip, ≥ minShot from its edges and each other. */
function cutTimesFor(clip: VideoClip, opts: SplitIntoScenesOptions, minShot: number): number[] {
  const times: number[] = [];
  for (const c of opts.sourceCuts ?? []) {
    const t = timelineTimeAtSource(clip, c);
    if (t !== null) times.push(t);
  }
  for (const t of opts.timelineCuts ?? []) times.push(t);
  if (opts.everySec && opts.everySec > 0) {
    for (let t = clip.start + opts.everySec; t < clip.start + clip.duration - EPS; t += opts.everySec) times.push(round(t));
  }
  const end = clip.start + clip.duration;
  const kept: number[] = [];
  let prev = clip.start;
  for (const t of [...new Set(times.map(round))].sort((a, b) => a - b)) {
    if (t - prev < minShot - EPS || end - t < minShot - EPS) continue;
    kept.push(t);
    prev = t;
  }
  return kept;
}

/**
 * Split the matching video clip(s) at the given cut points into labelled pieces.
 * Returns the SAME doc reference (`pieces` = 0) when nothing was cut.
 */
export function splitIntoScenes(doc: EditDoc, opts: SplitIntoScenesOptions): SplitIntoScenesResult {
  const minShot = Math.max(MIN_CLIP_SEC, opts.minShotSec ?? MIN_CLIP_SEC);
  const plans = targets(doc, opts)
    .map((clip) => ({ clip, times: cutTimesFor(clip, opts, minShot) }))
    .filter((p) => p.times.length > 0);
  if (plans.length === 0) return { doc, pieces: 0, added: 0, clipIds: [] };

  const countClips = (d: EditDoc) => d.tracks.reduce((n, t) => n + t.clips.length, 0);
  const before = countClips(doc);
  let out = doc;
  for (const { clip, times } of plans) {
    // Linked audio: sync-aligned audio clips of the same media (plain speed, forward).
    const linkable = clip.speed === 1 && !clip.reversed && !clip.speedRamp;
    const linkedIds: string[] = [];
    if (linkable) {
      for (const t of doc.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) {
          if (c.kind === "audio" && c.mediaId === clip.mediaId && Math.abs(c.sourceIn - c.start - (clip.sourceIn - clip.start)) < 1e-3) {
            linkedIds.push(c.id);
          }
        }
      }
    }
    // Latest cut first: the first half always keeps the original id, so every
    // earlier cut still lands inside it.
    for (const t of [...times].reverse()) {
      out = splitClipAtTime(out, clip.id, t);
      for (const id of linkedIds) {
        const a = out.tracks.flatMap((tr) => tr.clips).find((c) => c.id === id);
        if (a && t > a.start + MIN_CLIP_SEC && t < a.start + a.duration - MIN_CLIP_SEC) out = splitClipAtTime(out, id, t);
      }
    }
  }
  if (countClips(out) === before) return { doc, pieces: 0, added: 0, clipIds: [] };

  // Label the pieces (timeline order, per target clip).
  const clone: EditDoc = structuredClone(out);
  const prefix = opts.labelPrefix ?? "Scene";
  const clipIds: string[] = [];
  let n = 0;
  for (const { clip } of plans) {
    const end = clip.start + clip.duration;
    const pieces: Clip[] = [];
    for (const t of clone.tracks) {
      if (t.kind !== "visual" || !isSequenceTrack(t)) continue;
      for (const c of t.clips) {
        if (c.kind === "video" && c.mediaId === clip.mediaId && c.start >= clip.start - EPS && c.start < end - EPS && c.start + c.duration <= end + 1e-3) {
          pieces.push(c);
        }
      }
    }
    pieces.sort((a, b) => a.start - b.start);
    pieces.forEach((p, i) => {
      n++;
      p.label = plans.length === 1 && opts.labels?.[i] ? opts.labels[i] : `${prefix} ${n}`;
      clipIds.push(p.id);
    });
  }
  const result = parseEditDoc(clone);
  return { doc: result, pieces: clipIds.length, added: countClips(result) - before, clipIds };
}
