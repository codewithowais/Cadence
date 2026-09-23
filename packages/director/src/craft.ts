/**
 * Editing craft — the pure ops behind the timeline's "editing speed" features
 * (split every track, close gaps, cut an in/out range, freeze-frame hold,
 * content-preserving speed presets, group nudge, copy/paste attributes, and
 * edit-point navigation). Like every Cadence edit they are `(doc, …) => EditDoc`:
 * `structuredClone` in, mutate the clone, re-parse through the schema out, so the
 * result is always a valid, fully-defaulted doc. They are shared by the Director
 * tools (split_all_tracks / close_gaps / cut_range / hold_frame / retime_clip)
 * and the web timeline (buttons + keyboard), which routes them through its
 * undoable `commit`.
 *
 * SCHEMA NOTE — nothing here changes the schema. Every op only moves existing
 * fields (`start`, `duration`, `sourceIn`, `speed`, `freezeAtSec`, keyframes, …),
 * so old docs parse and render exactly as before.
 *
 * TRACK MODEL — a SEQUENCE track (the magnetic footage lane, user-added video
 * layers, plain audio tracks) lays its video/image (or audio) clips out back to
 * back; FREE tracks (titles, captions, b-roll, fades, music, voice-over, cursor,
 * callouts, shapes, adjustments…) position clips at moments. The PRIMARY track is
 * the first visual sequence track (the base footage); FOLLOWER tracks (titles,
 * captions, b-roll) are pinned to moments in that footage and move with it when a
 * primary-track edit shifts time. LOCKED tracks are never changed.
 */
import {
  parseEditDoc,
  sourceTimeAt,
  speedRampIntegral,
  valueAt,
  docDurationSec,
  type Clip,
  type EditDoc,
  type Keyframe,
  type KeyframeProp,
  type Track,
  type VideoClip,
} from "@cadence/core";
import { OVERLAY_TRACK_IDS } from "./edits";
import { MIN_CLIP_SEC } from "./trims";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const EPS = 1e-6;
/** Gaps narrower than this (seconds) are float noise, not real gaps. */
export const GAP_MIN_SEC = 0.01;

/** Free-positioned lanes (never packed back-to-back). `voiceover` joins the engine set. */
const FREE_TRACK_IDS = new Set<string>([...OVERLAY_TRACK_IDS, "voiceover"]);
/** Overlay lanes pinned to moments in the primary footage (they follow its edits). */
const FOLLOWER_TRACK_IDS = new Set(["titles", "captions", "broll"]);

/** True for a SEQUENCE track — clips laid out back to back (magnetic / layer / audio lanes). */
export function isSequenceTrack(track: Pick<Track, "id">): boolean {
  return !FREE_TRACK_IDS.has(track.id);
}

/** True when `clip` takes part in `track`'s back-to-back sequence. */
function isSequentialClip(track: Track, clip: Clip): boolean {
  if (track.kind === "audio") return clip.kind === "audio";
  return clip.kind === "video" || clip.kind === "image";
}

/** The base footage lane: the first visual sequence track, or null. */
function primaryTrack(doc: EditDoc): Track | null {
  return doc.tracks.find((t) => t.kind === "visual" && isSequenceTrack(t)) ?? null;
}

/** A clip id that is unique in the doc, derived from `base`. Deterministic. */
function uniqueClipId(doc: EditDoc, base: string): string {
  const taken = new Set<string>();
  for (const t of doc.tracks) for (const c of t.clips) taken.add(c.id);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

function findIn(doc: EditDoc, clipId: string): { track: Track; index: number; clip: Clip } | null {
  for (const track of doc.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, index, clip: track.clips[index]! };
  }
  return null;
}

/**
 * Move a clip in time by `delta` seconds, carrying the ABSOLUTE-time data that
 * rides on it (karaoke word timings, a punch-in window) so nothing desyncs.
 * Mutates the clip.
 */
function shiftClip(clip: Clip, delta: number): void {
  clip.start = round(Math.max(0, clip.start + delta));
  if (clip.kind === "text" && clip.words) {
    for (const w of clip.words) {
      w.start = round(Math.max(0, w.start + delta));
      w.end = round(Math.max(0, w.end + delta));
    }
  }
  if (clip.kind === "video" && clip.emphasis) {
    clip.emphasis.atSec = round(Math.max(0, clip.emphasis.atSec + delta));
  }
}

/** Re-time every follower-overlay clip through `remap(start) → newStart`. Mutates. */
function remapFollowers(doc: EditDoc, remap: (t: number) => number): void {
  for (const track of doc.tracks) {
    if (!FOLLOWER_TRACK_IDS.has(track.id) || track.locked) continue;
    for (const clip of track.clips) {
      const next = remap(clip.start);
      if (Math.abs(next - clip.start) > EPS) shiftClip(clip, next - clip.start);
    }
  }
}

// ---- keyframes across a split ----------------------------------------------

/**
 * Split a clip's keyframes at clip-progress `p` (0..1) into the two halves'
 * keyframes, each re-normalized to its own 0..1 span. A boundary keyframe holding
 * the exact interpolated value at `p` is added to BOTH halves, so the animation
 * plays through the cut unchanged (instead of each half replaying the whole
 * curve compressed). Pure.
 */
export function splitKeyframes(
  keyframes: readonly Keyframe[] | undefined,
  p: number,
): [Keyframe[] | undefined, Keyframe[] | undefined] {
  if (!keyframes || keyframes.length === 0) return [undefined, undefined];
  const at = clamp(p, 0, 1);
  if (at <= EPS) return [undefined, keyframes.map((k) => ({ ...k }))];
  if (at >= 1 - EPS) return [keyframes.map((k) => ({ ...k })), undefined];
  const first: Keyframe[] = [];
  const second: Keyframe[] = [];
  const props = [...new Set(keyframes.map((k) => k.prop))] as KeyframeProp[];
  for (const prop of props) {
    const list = keyframes.filter((k) => k.prop === prop).sort((a, b) => a.t - b.t);
    const v = round(valueAt(list, prop, at, 0) * 1e3) / 1e3;
    const after = list.find((k) => k.t > at + EPS);
    for (const k of list) {
      if (k.t < at - EPS) first.push({ ...k, t: round(k.t / at) });
      else if (k.t > at + EPS) second.push({ ...k, t: round((k.t - at) / (1 - at)) });
    }
    first.push({ prop, t: 1, value: v, easing: after?.easing ?? "linear" });
    second.unshift({ prop, t: 0, value: v, easing: "linear" });
  }
  const byT = (a: Keyframe, b: Keyframe) => a.t - b.t;
  return [first.sort(byT), second.sort(byT)];
}

/** Split a speed-ramp curve at clip-progress `p` into two re-normalized curves. */
function splitRamp(
  ramp: readonly (readonly [number, number])[],
  p: number,
): [[number, number][], [number, number][]] {
  const pts = [...ramp].map(([x, m]) => [x, m] as [number, number]).sort((a, b) => a[0] - b[0]);
  const rateAt = (x: number): number => {
    if (x <= pts[0]![0]) return pts[0]![1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, m0] = pts[i]!;
      const [x1, m1] = pts[i + 1]!;
      if (x >= x0 && x <= x1) return m0 + ((m1 - m0) * (x - x0)) / Math.max(EPS, x1 - x0);
    }
    return pts[pts.length - 1]![1];
  };
  const m = round(clamp(rateAt(p), 0.1, 10));
  const first: [number, number][] = pts.filter(([x]) => x < p - EPS).map(([x, r]) => [round(x / p), r]);
  const second: [number, number][] = pts.filter(([x]) => x > p + EPS).map(([x, r]) => [round((x - p) / (1 - p)), r]);
  if (first.length === 0 || first[0]![0] > 0) first.unshift([0, round(rateAt(0))]);
  first.push([1, m]);
  second.unshift([0, m]);
  if (second[second.length - 1]![0] < 1) second.push([1, round(rateAt(1))]);
  return [first, second];
}

// ---- split -----------------------------------------------------------------

/**
 * Split ONE clip in two at timeline time `atSec`. The halves exactly tile the
 * original: the second half's `sourceIn` points at the source frame that was on
 * screen at `atSec` (honoring speed, speed ramps and reverse — via core's
 * `sourceTimeAt`); keyframes and ramps are re-normalized per half; the interior
 * edge is a hard cut (no transition, no audio fade, no text intro/exit in the
 * middle); karaoke words and a punch-in window go to the half they fall in.
 * Returns the doc unchanged (re-parsed) when `atSec` is not strictly inside the
 * clip, either half would be shorter than `MIN_CLIP_SEC`, or its track is locked.
 * Pure.
 */
export function splitClipAtTime(doc: EditDoc, clipId: string, atSec: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const found = findIn(clone, clipId);
  if (!found || found.track.locked) return parseEditDoc(clone);
  const { track, index, clip } = found;
  const local = atSec - clip.start;
  const firstDur = round(local);
  const secondDur = round(clip.duration - local);
  if (firstDur < MIN_CLIP_SEC || secondDur < MIN_CLIP_SEC) return parseEditDoc(clone);
  const p = local / clip.duration;

  const first: Clip = structuredClone(clip);
  const second: Clip = structuredClone(clip);
  first.duration = firstDur;
  second.id = uniqueClipId(clone, `${clip.id}-b`);
  second.start = round(clip.start + local);
  second.duration = secondDur;

  if (first.kind === "video" && second.kind === "video" && clip.kind === "video") {
    if (clip.freezeAtSec === undefined) {
      const at = round(sourceTimeAt(clip, atSec));
      if (clip.reversed) first.sourceIn = at; // earlier half shows the END of the window
      else second.sourceIn = at;
    }
    if (clip.speedRamp && clip.speedRamp.length >= 2) {
      const [a, b] = splitRamp(clip.speedRamp, p);
      first.speedRamp = a;
      second.speedRamp = b;
    }
    first.fadeOutSec = 0;
    second.fadeInSec = 0;
    const inFirst = (t: number) => t >= first.start && t < first.start + first.duration;
    if (first.emphasis && !inFirst(first.emphasis.atSec)) first.emphasis = undefined;
    if (second.emphasis && inFirst(second.emphasis.atSec)) second.emphasis = undefined;
  } else if (first.kind === "audio" && second.kind === "audio") {
    second.sourceIn = round(second.sourceIn + local);
    first.fadeOutSec = 0;
    second.fadeInSec = 0;
  } else if (first.kind === "text" && second.kind === "text") {
    // The words keep playing: no intro on the second half, no exit on the first.
    second.anim = { ...second.anim, style: "none", durationSec: 0, delaySec: 0 };
    first.anim = { ...first.anim, exit: { ...first.anim.exit, style: "none" } };
    if (clip.kind === "text" && clip.words) {
      first.words = clip.words.filter((w) => w.start < atSec);
      second.words = clip.words.filter((w) => w.start >= atSec);
    }
  }
  if ("transitionOutSec" in first) first.transitionOutSec = 0;
  if ("transitionInSec" in second) second.transitionInSec = 0;
  if ("keyframes" in clip && "keyframes" in first && "keyframes" in second) {
    const [ka, kb] = splitKeyframes(clip.keyframes, p);
    first.keyframes = ka;
    second.keyframes = kb;
  }

  track.clips.splice(index, 1, first, second);
  return parseEditDoc(clone);
}

/**
 * SPLIT ALL TRACKS at `atSec`: every clip (any kind) on an UNLOCKED track that
 * strictly contains `atSec` is split there — the Premiere/Resolve "add edit to all
 * tracks" (⇧S). Returns the SAME doc reference when nothing was split, so a caller
 * can skip an empty undo step. Pure.
 */
export function splitAllAtTime(doc: EditDoc, atSec: number): EditDoc {
  const ids: string[] = [];
  for (const track of doc.tracks) {
    if (track.locked) continue;
    for (const c of track.clips) {
      if (atSec > c.start + MIN_CLIP_SEC - EPS && atSec < c.start + c.duration - MIN_CLIP_SEC + EPS) ids.push(c.id);
    }
  }
  let out = doc;
  for (const id of ids) out = splitClipAtTime(out, id, atSec);
  return ids.length === 0 ? doc : out;
}

// ---- gaps ------------------------------------------------------------------

/** An empty stretch on a sequence track, between two clips (or before the first). */
export interface TrackGap {
  trackId: string;
  start: number;
  end: number;
}

/**
 * Every GAP on the doc's sequence tracks: empty time between consecutive
 * sequential clips (crossfade overlaps are not gaps), plus the leading gap before
 * the first clip on the PRIMARY footage track (the base video must start at 0 or
 * the export opens on black). Upper layers keep their lead-in (a picture-in-
 * picture that appears at 5s is intentional). Free lanes (captions, titles, music…)
 * position clips at moments by design and never report gaps. Read-only.
 */
export function trackGaps(doc: EditDoc, trackId?: string): TrackGap[] {
  const primary = primaryTrack(doc);
  const out: TrackGap[] = [];
  for (const track of doc.tracks) {
    if (trackId !== undefined && track.id !== trackId) continue;
    if (!isSequenceTrack(track)) continue;
    const seq = track.clips.filter((c) => isSequentialClip(track, c)).sort((a, b) => a.start - b.start);
    if (seq.length === 0) continue;
    let prevEnd = track.id === primary?.id ? 0 : seq[0]!.start;
    for (const c of seq) {
      if (c.start > prevEnd + GAP_MIN_SEC) out.push({ trackId: track.id, start: round(prevEnd), end: round(c.start) });
      prevEnd = Math.max(prevEnd, c.start + c.duration);
    }
  }
  return out;
}

/**
 * Close ONE gap on `trackId` — the one containing `atSec` (a click on the gap) —
 * by pulling everything on that track after the gap left by its length. When the
 * track is the primary footage, the captions / titles / b-roll after the gap move
 * with it (anything that sat inside the gap lands at its start). Locked tracks and
 * a time that is not inside a gap are no-ops. Pure.
 */
export function closeGap(doc: EditDoc, trackId: string, atSec: number): EditDoc {
  const gap = trackGaps(doc, trackId).find((g) => atSec >= g.start - EPS && atSec <= g.end + EPS);
  const clone: EditDoc = structuredClone(doc);
  const track = clone.tracks.find((t) => t.id === trackId);
  if (!gap || !track || track.locked) return parseEditDoc(clone);
  const len = gap.end - gap.start;
  for (const c of track.clips) if (c.start >= gap.end - EPS) shiftClip(c, -len);
  if (track.id === primaryTrack(clone)?.id) {
    remapFollowers(clone, (t) => (t >= gap.end - EPS ? t - len : t > gap.start ? gap.start : t));
  }
  return parseEditDoc(clone);
}

/**
 * Close EVERY gap on `trackId` (or on every unlocked sequence track when omitted),
 * left to right, via `closeGap` — so followers of the primary track stay in sync.
 * Returns the SAME doc reference when there was nothing to close. Pure.
 */
export function closeGaps(doc: EditDoc, trackId?: string): EditDoc {
  let out = doc;
  const trackIds = doc.tracks
    .filter((t) => !t.locked && isSequenceTrack(t) && (trackId === undefined || t.id === trackId))
    .map((t) => t.id);
  for (const id of trackIds) {
    // Each close removes one gap; bounded by the clip count so it always ends.
    const limit = (doc.tracks.find((t) => t.id === id)?.clips.length ?? 0) + 1;
    for (let i = 0; i < limit; i++) {
      const g = trackGaps(out, id)[0];
      if (!g) break;
      out = closeGap(out, id, (g.start + g.end) / 2);
    }
  }
  return out;
}

// ---- in/out range ------------------------------------------------------------

/**
 * RIPPLE-DELETE the time range [startSec, endSec] across the WHOLE timeline (the
 * Premiere "extract"): every unlocked track is cut at both ends of the range, the
 * pieces inside are removed, and everything after the range slides left to close
 * it — footage, captions, music, overlays and markers alike, so nothing drifts out
 * of sync. Locked tracks are left untouched. A range shorter than `MIN_CLIP_SEC`
 * returns the SAME doc reference. Pure.
 */
export function rippleDeleteRange(doc: EditDoc, startSec: number, endSec: number): EditDoc {
  const a = round(Math.max(0, Math.min(startSec, endSec)));
  const b = round(Math.max(startSec, endSec));
  if (b - a < MIN_CLIP_SEC) return doc;
  let out = doc;
  for (const t of [a, b]) {
    const ids: string[] = [];
    for (const track of out.tracks) {
      if (track.locked) continue;
      for (const c of track.clips) if (t > c.start + EPS && t < c.start + c.duration - EPS) ids.push(c.id);
    }
    for (const id of ids) out = splitClipAtTime(out, id, t);
  }
  const clone: EditDoc = structuredClone(out);
  const len = b - a;
  const tol = MIN_CLIP_SEC; // slivers a split refused to make are treated as inside
  for (const track of clone.tracks) {
    if (track.locked) continue;
    track.clips = track.clips.filter((c) => !(c.start >= a - tol && c.start + c.duration <= b + tol));
    for (const c of track.clips) if (c.start >= b - tol) shiftClip(c, -len);
  }
  clone.markers = (clone.markers ?? [])
    .filter((m) => !(m.t > a + EPS && m.t < b - EPS))
    .map((m) => (m.t >= b - EPS ? { ...m, t: round(Math.max(0, m.t - len)) } : m));
  return parseEditDoc(clone);
}

/**
 * KEEP ONLY the range [startSec, endSec]: ripple-delete everything after it, then
 * everything before it, so the kept section starts at 0 (a "trim to selection").
 * Returns the SAME doc reference when the range already spans the whole timeline.
 * Pure.
 */
export function keepRange(doc: EditDoc, startSec: number, endSec: number): EditDoc {
  const a = Math.max(0, Math.min(startSec, endSec));
  const b = Math.max(startSec, endSec);
  const total = docDurationSec(doc);
  if (b - a < MIN_CLIP_SEC) return doc;
  let out = b < total - EPS ? rippleDeleteRange(doc, b, total) : doc;
  if (a > EPS) out = rippleDeleteRange(out, 0, a);
  return out;
}

// ---- freeze-frame hold -------------------------------------------------------

/** Default length (seconds) of an inserted freeze-frame hold. */
export const FREEZE_HOLD_SEC = 2;

/**
 * FREEZE FRAME HERE (CapCut "Freeze"): insert a `holdSec` still of the exact frame
 * on screen at `atSec` into a VIDEO clip on a sequence track, then let the clip
 * play on. The clip is split at `atSec` (or the hold goes before/after it when
 * `atSec` sits at its head/tail), a silent frozen copy (`freezeAtSec` = the source
 * time shown there; keyframed transform baked to its value at that moment) is
 * inserted, and everything later on the track — plus the captions / titles /
 * b-roll following the primary footage — shifts right by `holdSec`. Returns the
 * doc unchanged (re-parsed) for a non-video clip, a free/locked lane, or an
 * already-frozen clip. Pure.
 */
export function insertFreezeFrame(
  doc: EditDoc,
  clipId: string,
  atSec: number,
  holdSec: number = FREEZE_HOLD_SEC,
): EditDoc {
  const src = findIn(doc, clipId);
  if (!src || src.clip.kind !== "video" || src.track.locked || !isSequenceTrack(src.track) || src.clip.freezeAtSec !== undefined) {
    return parseEditDoc(structuredClone(doc));
  }
  const orig = src.clip;
  const hold = round(clamp(holdSec, MIN_CLIP_SEC, 60));
  const end = orig.start + orig.duration;
  const at = clamp(atSec, orig.start, end);
  const frameSec = 1 / Math.max(1, doc.meta.fps);
  const mode: "before" | "split" | "after" =
    at <= orig.start + MIN_CLIP_SEC ? "before" : at >= end - MIN_CLIP_SEC ? "after" : "split";
  const shownAt = mode === "before" ? orig.start : mode === "after" ? Math.max(orig.start, end - frameSec) : at;
  const insertAt = round(mode === "before" ? orig.start : mode === "after" ? end : at);

  let out = mode === "split" ? splitClipAtTime(doc, clipId, at) : doc;
  const clone: EditDoc = structuredClone(out);
  const found = findIn(clone, clipId)!;
  const track = found.track;

  const freeze = structuredClone(orig) as VideoClip;
  freeze.id = uniqueClipId(clone, `${orig.id}-freeze`);
  freeze.start = insertAt;
  freeze.duration = hold;
  freeze.freezeAtSec = round(sourceTimeAt(orig, shownAt));
  freeze.sourceIn = freeze.freezeAtSec;
  freeze.speed = 1;
  delete freeze.speedRamp;
  freeze.reversed = false;
  freeze.stabilize = false;
  freeze.volume = 0;
  freeze.fadeInSec = 0;
  freeze.fadeOutSec = 0;
  freeze.transitionInSec = 0;
  freeze.transitionOutSec = 0;
  freeze.emphasis = undefined;
  if (orig.keyframes && orig.keyframes.length > 0) {
    const p = orig.duration > 0 ? (shownAt - orig.start) / orig.duration : 0;
    const tf = freeze.transform;
    tf.x = valueAt(orig.keyframes, "x", p, tf.x);
    tf.y = valueAt(orig.keyframes, "y", p, tf.y);
    tf.scale = Math.max(0.01, valueAt(orig.keyframes, "scale", p, tf.scale));
    tf.rotation = valueAt(orig.keyframes, "rotation", p, tf.rotation);
    tf.opacity = clamp(valueAt(orig.keyframes, "opacity", p, tf.opacity), 0, 1);
  }
  freeze.keyframes = undefined;

  // Everything at/after the insertion point on this track moves right.
  for (const c of track.clips) if (c.start >= insertAt - EPS) shiftClip(c, hold);
  const insertIndex = mode === "before" ? found.index : found.index + 1;
  track.clips.splice(insertIndex, 0, freeze);
  if (track.id === primaryTrack(clone)?.id) remapFollowers(clone, (t) => (t >= insertAt - EPS ? t + hold : t));
  out = parseEditDoc(clone);
  return out;
}

// ---- speed presets (content-preserving) ------------------------------------

/** One-tap speed presets offered in the clip inspector. */
export const SPEED_PRESETS = [0.5, 1, 1.5, 2] as const;

/**
 * RETIME a video clip to a constant `speed` (0.25–4) while keeping the SAME
 * footage (CapCut behaviour): the clip's source span is preserved, so its
 * timeline duration becomes `span / speed` — 2× halves it, 0.5× doubles it. Any
 * speed ramp is replaced by the constant speed. On a sequence track the rest of
 * the lane ripples (later clips shift by the change) and, for the primary
 * footage, captions / titles / b-roll over or after the clip are re-timed to stay
 * on the same moments. A frozen clip, non-video clip or locked track is a no-op.
 * Pure.
 */
export function retimeClip(doc: EditDoc, clipId: string, speed: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const found = findIn(clone, clipId);
  if (!found || found.clip.kind !== "video" || found.track.locked || found.clip.freezeAtSec !== undefined) {
    return parseEditDoc(clone);
  }
  const clip = found.clip;
  const next = round(clamp(speed, 0.25, 4));
  const ramp = clip.speedRamp && clip.speedRamp.length >= 2 ? clip.speedRamp : null;
  const span = ramp ? clip.duration * speedRampIntegral(ramp, 1) : clip.duration * (clip.speed ?? 1);
  const oldStart = clip.start;
  const oldDur = clip.duration;
  const newDur = round(Math.max(MIN_CLIP_SEC, span / next));
  const delta = newDur - oldDur;
  clip.speed = next;
  delete clip.speedRamp;
  clip.duration = newDur;
  clip.fadeInSec = Math.min(clip.fadeInSec, newDur);
  clip.fadeOutSec = Math.min(clip.fadeOutSec, newDur);
  if (clip.emphasis) {
    clip.emphasis.atSec = round(oldStart + (clip.emphasis.atSec - oldStart) * (newDur / oldDur));
  }
  if (isSequenceTrack(found.track) && Math.abs(delta) > EPS) {
    for (const c of found.track.clips) if (c !== clip && c.start > oldStart + EPS) shiftClip(c, delta);
    if (found.track.id === primaryTrack(clone)?.id) {
      const oldEnd = oldStart + oldDur;
      remapFollowers(clone, (t) =>
        t < oldStart ? t : t < oldEnd ? round(oldStart + (t - oldStart) * (newDur / oldDur)) : t + delta,
      );
    }
  }
  return parseEditDoc(clone);
}

// ---- group nudge -------------------------------------------------------------

/**
 * NUDGE a group of clips in time by `deltaSec` (keyboard ⌥←/→). Only
 * free-positioned clips move — overlays, titles, captions, clips on free lanes and
 * non-sequential clips (text/solids) on layers; clips in a magnetic sequence stay
 * back to back (reorder those instead). Locked tracks never move. The group keeps
 * its spacing: the delta is clamped so the earliest movable clip stops at 0.
 * Returns the SAME doc reference when nothing can move. Pure.
 */
export function nudgeClips(doc: EditDoc, clipIds: readonly string[], deltaSec: number): EditDoc {
  const want = new Set(clipIds);
  const clone: EditDoc = structuredClone(doc);
  const movable: Clip[] = [];
  for (const track of clone.tracks) {
    if (track.locked) continue;
    for (const c of track.clips) {
      if (!want.has(c.id)) continue;
      if (isSequenceTrack(track) && isSequentialClip(track, c)) continue;
      movable.push(c);
    }
  }
  if (movable.length === 0 || Math.abs(deltaSec) < EPS) return doc;
  const earliest = Math.min(...movable.map((c) => c.start));
  const delta = Math.max(deltaSec, -earliest);
  if (Math.abs(delta) < EPS) return doc;
  for (const c of movable) shiftClip(c, delta);
  return parseEditDoc(clone);
}

// ---- copy / paste attributes -------------------------------------------------

/** The attribute groups that can be copied from one clip and pasted onto others. */
export type AttributeGroup = "look" | "transform" | "motion" | "audio" | "speed";

/** Plain-language labels for the paste-attributes picker (in display order). */
export const ATTRIBUTE_GROUPS: readonly { group: AttributeGroup; label: string; hint: string }[] = [
  { group: "look", label: "Look", hint: "Color grade, LUT, curves & HSL" },
  { group: "transform", label: "Transform & blend", hint: "Position, scale, rotation, opacity, blend mode" },
  { group: "motion", label: "Motion", hint: "Keyframes, Ken Burns move, text animation" },
  { group: "audio", label: "Audio", hint: "Volume, fades & pan" },
  { group: "speed", label: "Speed", hint: "Constant speed or speed ramp" },
];

/** Clip kinds that carry animation keyframes. */
type KeyframedClip = Extract<Clip, { kind: "video" | "image" | "text" | "audio" | "solid" | "shape" }>;
function canKeyframe(c: Clip): c is KeyframedClip {
  return c.kind === "video" || c.kind === "image" || c.kind === "text" || c.kind === "audio" || c.kind === "solid" || c.kind === "shape";
}

/** A snapshot of one clip's copyable settings (deep copies — safe to keep). */
export interface ClipAttributes {
  /** The kind of clip the attributes were copied from (for UI copy). */
  sourceKind: Clip["kind"];
  look?: Extract<Clip, { kind: "video" }>["look"];
  transform?: Extract<Clip, { kind: "video" }>["transform"];
  blendMode?: Extract<Clip, { kind: "video" }>["blendMode"];
  keyframes?: Keyframe[];
  kenBurns?: Extract<Clip, { kind: "image" }>["motion"];
  textAnim?: Extract<Clip, { kind: "text" }>["anim"];
  volume?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  pan?: number;
  speed?: number;
  speedRamp?: [number, number][];
}

/**
 * Snapshot a clip's copyable attributes (⌘⇧C). Returns null for an unknown clip
 * or a kind that carries nothing copyable. Read-only; the result is deep-copied.
 */
export function copyClipAttributes(doc: EditDoc, clipId: string): ClipAttributes | null {
  const found = findIn(doc, clipId);
  if (!found) return null;
  const c = structuredClone(found.clip) as Clip;
  const a: ClipAttributes = { sourceKind: c.kind };
  if (c.kind === "video" || c.kind === "image") {
    a.look = c.look;
    a.blendMode = c.blendMode;
  }
  if ("transform" in c && c.transform) a.transform = c.transform as ClipAttributes["transform"];
  if (canKeyframe(c)) a.keyframes = c.keyframes ?? [];
  if (c.kind === "image") a.kenBurns = c.motion;
  if (c.kind === "text") a.textAnim = c.anim;
  if (c.kind === "video" || c.kind === "audio") {
    a.volume = c.volume;
    a.fadeInSec = c.fadeInSec;
    a.fadeOutSec = c.fadeOutSec;
    a.pan = c.pan;
  }
  if (c.kind === "video" && c.freezeAtSec === undefined) {
    a.speed = c.speed ?? 1;
    if (c.speedRamp && c.speedRamp.length >= 2) a.speedRamp = c.speedRamp.map(([x, m]) => [x, m] as [number, number]);
  }
  return attributeGroupsOf(a).length > 0 ? a : null;
}

/** Which attribute groups a snapshot actually carries (drives the picker). */
export function attributeGroupsOf(a: ClipAttributes | null | undefined): AttributeGroup[] {
  if (!a) return [];
  const out: AttributeGroup[] = [];
  if (a.look) out.push("look");
  if (a.transform || a.blendMode) out.push("transform");
  if (a.keyframes !== undefined || a.kenBurns || a.textAnim) out.push("motion");
  if (a.volume !== undefined) out.push("audio");
  if (a.speed !== undefined) out.push("speed");
  return out;
}

const TRANSFORM_PROPS = new Set<KeyframeProp>(["x", "y", "scale", "rotation", "opacity"]);

/**
 * PASTE attributes onto every clip in `clipIds` (⌘⇧V). `groups` limits what is
 * pasted (default: every group the snapshot carries). Each group only lands on
 * clips that support it — a look on video/photos, audio settings on video/audio,
 * a text animation on text, speed on video (content-preserving, via `retimeClip`
 * for a constant speed; a ramp keeps the clip's length) — and keyframes are
 * filtered to the props the target can animate. Locked tracks are skipped. Pure.
 */
export function pasteClipAttributes(
  doc: EditDoc,
  clipIds: readonly string[],
  attrs: ClipAttributes,
  groups?: readonly AttributeGroup[],
): EditDoc {
  const use = new Set<AttributeGroup>(groups ?? attributeGroupsOf(attrs));
  const clone: EditDoc = structuredClone(doc);
  const retime: string[] = [];
  const want = new Set(clipIds);
  for (const track of clone.tracks) {
    if (track.locked) continue;
    for (const c of track.clips) {
      if (!want.has(c.id)) continue;
      if (use.has("look") && attrs.look && (c.kind === "video" || c.kind === "image")) c.look = structuredClone(attrs.look);
      if (use.has("transform")) {
        if (attrs.transform && "transform" in c && c.transform) (c as { transform: unknown }).transform = structuredClone(attrs.transform);
        if (attrs.blendMode && (c.kind === "video" || c.kind === "image")) c.blendMode = attrs.blendMode;
      }
      if (use.has("motion")) {
        if (attrs.keyframes !== undefined && canKeyframe(c)) {
          const audioOnly = c.kind === "audio";
          const canVolume = c.kind === "video" || c.kind === "audio";
          const kfs = attrs.keyframes.filter((k) =>
            k.prop === "volume" ? canVolume : !audioOnly && TRANSFORM_PROPS.has(k.prop),
          );
          (c as { keyframes?: Keyframe[] }).keyframes = kfs.length > 0 ? structuredClone(kfs) : undefined;
        }
        if (attrs.kenBurns && c.kind === "image") c.motion = structuredClone(attrs.kenBurns);
        if (attrs.textAnim && c.kind === "text") c.anim = structuredClone(attrs.textAnim);
      }
      if (use.has("audio") && attrs.volume !== undefined && (c.kind === "video" || c.kind === "audio")) {
        c.volume = clamp(attrs.volume, 0, 1);
        c.fadeInSec = clamp(attrs.fadeInSec ?? 0, 0, c.duration);
        c.fadeOutSec = clamp(attrs.fadeOutSec ?? 0, 0, c.duration);
        c.pan = clamp(attrs.pan ?? 0, -1, 1);
      }
      if (use.has("speed") && attrs.speed !== undefined && c.kind === "video" && c.freezeAtSec === undefined) {
        if (attrs.speedRamp && attrs.speedRamp.length >= 2) c.speedRamp = structuredClone(attrs.speedRamp);
        else retime.push(c.id);
      }
    }
  }
  let out = parseEditDoc(clone);
  for (const id of retime) out = retimeClip(out, id, attrs.speed ?? 1);
  return out;
}

// ---- navigation ---------------------------------------------------------------

/**
 * Every EDIT POINT on the timeline — 0, the end, and each clip's in and out on a
 * visible track — sorted and de-duplicated (ms precision). Read-only.
 */
export function editPoints(doc: EditDoc): number[] {
  const set = new Set<number>([0]);
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const c of track.clips) {
      set.add(round(c.start));
      set.add(round(c.start + c.duration));
    }
  }
  set.add(round(docDurationSec(doc)));
  return [...set].sort((a, b) => a - b);
}

/**
 * The next (`dir` = 1) or previous (`dir` = -1) edit point from `timeSec` —
 * the ↑/↓ "go to next/previous cut". `null` when there is none that way.
 */
export function nextEditPoint(doc: EditDoc, timeSec: number, dir: 1 | -1): number | null {
  const pts = editPoints(doc);
  if (dir > 0) return pts.find((p) => p > timeSec + 1e-3) ?? null;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i]! < timeSec - 1e-3) return pts[i]!;
  return null;
}

/** The next / previous timeline marker from `timeSec` (⇧↑/⇧↓), or `null`. */
export function nextMarkerTime(doc: EditDoc, timeSec: number, dir: 1 | -1): number | null {
  const ts = (doc.markers ?? []).map((m) => m.t).sort((a, b) => a - b);
  if (dir > 0) return ts.find((t) => t > timeSec + 1e-3) ?? null;
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i]! < timeSec - 1e-3) return ts[i]!;
  return null;
}
