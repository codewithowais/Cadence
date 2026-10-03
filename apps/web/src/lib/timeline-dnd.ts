/**
 * Timeline drag-and-drop — the PURE doc ops behind every drop and clip move.
 *
 * Every function is `(doc, …) => EditDoc` (or a small preview descriptor), never
 * mutates its input, and re-parses through the schema, so a drop is just another
 * edit-doc op routed through the editor's undoable `commit` (edits-as-code).
 *
 * Two placement modes, matching what editors expect:
 *  - "insert" (default): on the MAIN footage lane the clip is inserted at the
 *    nearest cut and everything after it ripples; on any other lane nothing moves
 *    or is destroyed — the clip slides to the nearest free slot instead.
 *  - "overwrite": the clip lands exactly where dropped and replaces whatever
 *    footage it covers (existing clips are trimmed / split / removed, via the
 *    engine's `splitClipAtTime`, so keyframes and fades stay right).
 *
 * Collision handling only applies to MEDIA clips (video / image / audio). Text,
 * stickers, graphics and shapes are overlays that may legitimately stack.
 */
import { parseEditDoc, type Clip, type EditDoc, type MediaAsset, type Track } from "@cadence/core";
import { addGraphic, addTrack, findGraphicPreset, isSequenceTrack, splitClipAtTime } from "@cadence/director";
import { captureMainSpans, findClip, MIN_CLIP_SEC, reanchorOverlays, reflowTrack } from "./edit-ops";
import { TEXT_PRESETS, insertSticker } from "./text-presets";
import { PRO_TEXT_PRESETS, insertProPreset } from "./text-presets-pro";

const EPS = 1e-4;
const round = (n: number): number => Math.round(n * 1000) / 1000;

export type DropMode = "insert" | "overwrite";

// ---- drag payloads ----------------------------------------------------------

/** What a draggable palette item carries (Media grid, text styles, stickers, graphics). */
export type DropPayload =
  | { type: "media"; mediaId: string; mediaKind: "video" | "image" | "audio"; durationSec?: number; label?: string }
  | { type: "text-preset"; key: string; text?: string; label?: string }
  | { type: "pro-text"; key: string; text?: string; label?: string }
  | { type: "sticker"; emoji: string; label?: string }
  | { type: "graphic"; preset: string; label?: string };

// ---- small predicates ---------------------------------------------------------

/** Video / image / audio — the clips that collide (and ripple); overlays may stack. */
export const isMediaClip = (c: Clip): boolean => c.kind === "video" || c.kind === "image" || c.kind === "audio";
const isVisualSeq = (c: Clip): boolean => c.kind === "video" || c.kind === "image";

/** True when `clip` may live on `track` (audio ↔ audio lane, everything else ↔ visual lane). */
export function clipFitsLane(clip: Clip, track: Track): boolean {
  return clip.kind === "audio" ? track.kind === "audio" : track.kind === "visual";
}

/** The MAGNETIC lane: the primary footage track (first visual sequence track). */
export function magneticTrackId(doc: EditDoc): string | null {
  const t = doc.tracks.find((x) => x.kind === "visual" && isSequenceTrack(x));
  return t ? t.id : null;
}

/** A lane's position among tracks of its own kind, bottom = 0 (array order). */
export function laneIndexInKind(doc: EditDoc, trackId: string): number {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t) return -1;
  return doc.tracks.filter((x) => x.kind === t.kind).findIndex((x) => x.id === trackId);
}

/** The lane `steps` positions away (+ = up the stack) within the same kind, or null. */
export function laneAtOffset(doc: EditDoc, trackId: string, steps: number): Track | null {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t) return null;
  const same = doc.tracks.filter((x) => x.kind === t.kind);
  const i = same.findIndex((x) => x.id === trackId) + steps;
  return same[i] ?? null;
}

// ---- collision math ---------------------------------------------------------

/**
 * The start closest to `desired` where a clip of `dur` seconds fits between the
 * given clips without overlapping any of them.
 */
export function nearestFreeStart(
  clips: readonly { start: number; duration: number }[],
  desired: number,
  dur: number,
): number {
  const d = Math.max(0, desired);
  const overlaps = (s: number): boolean => clips.some((c) => s < c.start + c.duration - EPS && s + dur > c.start + EPS);
  if (!overlaps(d)) return round(d);
  const cands = new Set<number>([0]);
  for (const c of clips) {
    cands.add(round(c.start + c.duration));
    const before = c.start - dur;
    if (before >= -EPS) cands.add(round(Math.max(0, before)));
  }
  const sorted = [...cands].sort((a, b) => Math.abs(a - d) - Math.abs(b - d));
  for (const s of sorted) if (!overlaps(s)) return s;
  return round(d);
}

/** Media clips on a lane (excluding `ignore`), by start. */
function laneMedia(track: Track, ignore: ReadonlySet<string>): Clip[] {
  return track.clips.filter((c) => isMediaClip(c) && !ignore.has(c.id)).sort((a, b) => a.start - b.start);
}

/**
 * Carve `[a, b)` out of a lane's media clips (overwrite semantics): clips
 * straddling an edge are split with the engine op, then everything inside the
 * window is removed. Clips in `ignore` are untouched. Pure.
 */
export function carveRange(doc: EditDoc, trackId: string, a: number, b: number, ignore: ReadonlySet<string> = new Set()): EditDoc {
  let d = doc;
  for (const t of [a, b]) {
    const lane = d.tracks.find((x) => x.id === trackId);
    if (!lane) return d;
    const ids = lane.clips
      .filter((c) => isMediaClip(c) && !ignore.has(c.id) && t > c.start + MIN_CLIP_SEC && t < c.start + c.duration - MIN_CLIP_SEC)
      .map((c) => c.id);
    for (const id of ids) d = splitClipAtTime(d, id, t);
  }
  const clone: EditDoc = structuredClone(d);
  const lane = clone.tracks.find((x) => x.id === trackId);
  if (!lane) return d;
  lane.clips = lane.clips.filter((c) => {
    if (!isMediaClip(c) || ignore.has(c.id)) return true;
    return !(c.start >= a - MIN_CLIP_SEC && c.start + c.duration <= b + MIN_CLIP_SEC);
  });
  return parseEditDoc(clone);
}

// ---- placement ----------------------------------------------------------------

/** Index among a magnetic lane's sequential clips where a drop at `at` will land. */
function insertIndex(seq: readonly Clip[], at: number, mode: DropMode): number {
  return mode === "overwrite"
    ? seq.filter((c) => c.start < at - EPS).length
    : seq.filter((c) => c.start + c.duration / 2 <= at).length;
}

/** What a drop of `durationSec` at `startSec` onto `trackId` will actually do (for the preview). */
export interface DropPreview {
  /** False when the lane is locked / missing / the wrong media family. */
  valid: boolean;
  /** Where the clip will start (after cut-snapping / free-slot search). */
  startSec: number;
  /** The span the clip will cover. */
  endSec: number;
  /** True when the clip lands on the magnetic lane (later clips ripple). */
  ripples: boolean;
  /** The window that will be replaced (overwrite mode only). */
  carve: [number, number] | null;
}

/**
 * Resolve a prospective drop without touching the doc. `kind` is the clip kind
 * that would land ("audio" / "video" / "image" / "text" …).
 */
export function previewDrop(
  doc: EditDoc,
  o: { trackId: string; startSec: number; durationSec: number; kind: Clip["kind"]; mode: DropMode; ignoreIds?: readonly string[] },
): DropPreview {
  const track = doc.tracks.find((t) => t.id === o.trackId);
  const dur = Math.max(MIN_CLIP_SEC, o.durationSec);
  const start0 = Math.max(0, o.startSec);
  const bad: DropPreview = { valid: false, startSec: start0, endSec: start0 + dur, ripples: false, carve: null };
  if (!track || track.locked) return bad;
  const audio = o.kind === "audio";
  if (audio ? track.kind !== "audio" : track.kind !== "visual") return bad;
  const ignore = new Set(o.ignoreIds ?? []);
  const media = o.kind === "video" || o.kind === "image" || o.kind === "audio";
  if (!media) return { valid: true, startSec: start0, endSec: start0 + dur, ripples: false, carve: null };
  const magnetic = track.id === magneticTrackId(doc) && (o.kind === "video" || o.kind === "image");
  if (magnetic) {
    const seq = track.clips.filter((c) => isVisualSeq(c) && !ignore.has(c.id)).sort((a, b) => a.start - b.start);
    if (o.mode === "overwrite") return { valid: true, startSec: start0, endSec: start0 + dur, ripples: false, carve: [start0, start0 + dur] };
    const idx = insertIndex(seq, start0, "insert");
    const at = idx < seq.length ? seq[idx]!.start : seq.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    return { valid: true, startSec: round(at), endSec: round(at + dur), ripples: true, carve: null };
  }
  if (o.mode === "overwrite") return { valid: true, startSec: start0, endSec: start0 + dur, ripples: false, carve: [start0, start0 + dur] };
  const s = nearestFreeStart(laneMedia(track, ignore), start0, dur);
  return { valid: true, startSec: s, endSec: round(s + dur), ripples: false, carve: null };
}

/**
 * Put a clip OBJECT (new or detached) on `trackId` at `startSec` per `mode`.
 * Returns null when the lane is missing / locked / the wrong family.
 */
function placeObject(
  doc: EditDoc,
  obj: Clip,
  trackId: string,
  startSec: number,
  mode: DropMode,
  ignore: ReadonlySet<string>,
  before: ReturnType<typeof captureMainSpans>,
  reflowSourceId: string | null,
): EditDoc | null {
  const lane = doc.tracks.find((t) => t.id === trackId);
  if (!lane || lane.locked || !clipFitsLane(obj, lane)) return null;
  const dur = obj.duration;
  const start0 = Math.max(0, round(startSec));
  const magnetic = trackId === magneticTrackId(doc) && isVisualSeq(obj);
  let work = doc;
  let placeStart = start0;
  if (isMediaClip(obj)) {
    if (mode === "overwrite") work = carveRange(work, trackId, start0, start0 + dur, ignore);
    else if (!magnetic) placeStart = nearestFreeStart(laneMedia(lane, ignore), start0, dur);
  }
  const clone: EditDoc = structuredClone(work);
  const tgt = clone.tracks.find((t) => t.id === trackId)!;
  obj.start = placeStart;
  // A clip leaving the magnetic lane closes its gap (and its captions follow) BEFORE
  // the clip lands elsewhere — otherwise the re-anchor pass would drag the dropped
  // clip itself along with the footage it used to sit over. Moving within the
  // magnetic lane is one reorder, re-anchored once at the end.
  const sameLane = magnetic && reflowSourceId === trackId;
  let spans = before;
  if (reflowSourceId && !sameLane) {
    const src = clone.tracks.find((t) => t.id === reflowSourceId);
    if (src) reflowTrack(src);
    reanchorOverlays(clone, before);
    spans = captureMainSpans(clone);
  }
  if (magnetic) {
    const seq = tgt.clips.filter(isVisualSeq).sort((a, b) => a.start - b.start);
    const idx = insertIndex(seq, start0, mode);
    const pos = idx < seq.length ? tgt.clips.indexOf(seq[idx]!) : tgt.clips.length;
    tgt.clips.splice(pos, 0, obj);
    reflowTrack(tgt);
    reanchorOverlays(clone, spans);
  } else {
    tgt.clips.push(obj);
  }
  return parseEditDoc(clone);
}

/**
 * Move one existing clip onto `trackId` at `startSec` (same lane = reposition /
 * reorder). Collision-aware per `mode`. Returns the SAME doc when nothing can
 * happen (locked / wrong family / unknown). Pure.
 */
export function placeClip(
  doc: EditDoc,
  clipId: string,
  trackId: string,
  startSec: number,
  mode: DropMode = "insert",
  alsoIgnore: readonly string[] = [],
): EditDoc {
  const found = findClip(doc, clipId);
  if (!found || found.track.locked) return doc;
  const dest = doc.tracks.find((t) => t.id === trackId);
  if (!dest || dest.locked || !clipFitsLane(found.clip, dest)) return doc;
  const before = captureMainSpans(doc);
  const srcMagnetic = found.track.id === magneticTrackId(doc) && isVisualSeq(found.clip);
  const obj: Clip = structuredClone(found.clip);
  const detached: EditDoc = structuredClone(doc);
  const srcLane = detached.tracks.find((t) => t.id === found.track.id)!;
  srcLane.clips = srcLane.clips.filter((c) => c.id !== clipId);
  const ignore = new Set([clipId, ...alsoIgnore]);
  const out = placeObject(parseEditDoc(detached), obj, trackId, startSec, mode, ignore, before, srcMagnetic ? found.track.id : null);
  return out ?? doc;
}

/**
 * Move a block of clips on the magnetic lane to a new slot: `toIndex` is the
 * position among the lane's sequential clips NOT in the block (0 = first). The
 * block keeps its internal order. Pure.
 */
export function reorderBlock(doc: EditDoc, clipIds: readonly string[], toIndex: number): EditDoc {
  const magId = magneticTrackId(doc);
  if (!magId) return doc;
  const lane = doc.tracks.find((t) => t.id === magId)!;
  if (lane.locked) return doc;
  const want = new Set(clipIds);
  const block = lane.clips.filter((c) => want.has(c.id) && isVisualSeq(c));
  if (block.length === 0) return doc;
  const before = captureMainSpans(doc);
  const clone: EditDoc = structuredClone(doc);
  const tgt = clone.tracks.find((t) => t.id === magId)!;
  const seqAll = tgt.clips.filter(isVisualSeq);
  const rest = seqAll.filter((c) => !want.has(c.id));
  const idx = Math.max(0, Math.min(rest.length, Math.round(toIndex)));
  const blockClips = seqAll.filter((c) => want.has(c.id));
  const ordered = [...rest.slice(0, idx), ...blockClips, ...rest.slice(idx)];
  if (ordered.every((c, i) => c.id === seqAll[i]!.id)) return doc; // already there
  // Write the new order back into the sequential slots (overlay-ish clips keep theirs).
  const slots: number[] = [];
  tgt.clips.forEach((c, i) => {
    if (isVisualSeq(c)) slots.push(i);
  });
  slots.forEach((slot, i) => {
    tgt.clips[slot] = ordered[i]!;
  });
  reflowTrack(tgt);
  reanchorOverlays(clone, before);
  return parseEditDoc(clone);
}

/**
 * Move a multi-selection as one unit (the mouse group-drag):
 *  - selected clips on the MAGNETIC lane travel together as a block to
 *    `blockIndex` (their slot among the unselected footage);
 *  - every other selected clip shifts by `deltaSec` (clamped so none goes
 *    negative) and, when `laneSteps` ≠ 0, moves that many lanes up (+) / down (−)
 *    within its own kind, each landing per `mode` (the group never collides with
 *    itself). Clips on locked lanes stay put. Pure.
 */
export function moveClipsGroup(
  doc: EditDoc,
  clipIds: readonly string[],
  o: { deltaSec: number; laneSteps?: number; mode: DropMode; blockIndex?: number | null },
): EditDoc {
  const magId = magneticTrackId(doc);
  const all = clipIds.filter((id) => findClip(doc, id));
  const ignore = new Set(all);
  const onMain = all.filter((id) => {
    const f = findClip(doc, id)!;
    return f.track.id === magId && isVisualSeq(f.clip);
  });
  const free = all.filter((id) => !onMain.includes(id) && !findClip(doc, id)!.track.locked);
  let d = doc;
  if (onMain.length > 0 && o.blockIndex != null) d = reorderBlock(d, onMain, o.blockIndex);
  if (free.length > 0) {
    const entries = free.map((id) => ({ id, f: findClip(doc, id)! })).sort((a, b) => a.f.clip.start - b.f.clip.start);
    const minStart = Math.min(...entries.map((e) => e.f.clip.start));
    const delta = Math.max(o.deltaSec, -minStart);
    const steps = o.laneSteps ?? 0;
    // Targets come from the ORIGINAL layout: a block reorder re-anchors follower
    // lanes (captions / b-roll) to the footage, which must not double-move clips
    // the user is also dragging.
    const targetStart = new Map(entries.map((e) => [e.id, e.f.clip.start + delta]));
    // Every lane must exist & be free for a lane move, else the group keeps its lanes.
    const laneFor = (trackId: string): Track | null => (steps === 0 ? d.tracks.find((t) => t.id === trackId) ?? null : laneAtOffset(d, trackId, steps));
    const allLanesOk = entries.every((e) => {
      const lane = laneFor(e.f.track.id);
      return !!lane && !lane.locked && clipFitsLane(e.f.clip, lane);
    });
    for (const e of entries) {
      const cur = findClip(d, e.id);
      if (!cur) continue;
      const lane = allLanesOk ? laneFor(cur.track.id) : d.tracks.find((t) => t.id === cur.track.id) ?? null;
      if (!lane) continue;
      d = placeClip(d, e.id, lane.id, targetStart.get(e.id)!, o.mode, [...ignore]);
    }
  }
  return d;
}

// ---- new items (palette → timeline) ---------------------------------------------------

/** The media asset's clip object (the same shape Media-grid drops have always made). */
export function createMediaClip(doc: EditDoc, media: MediaAsset): Clip {
  const id = `clip-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  if (media.kind === "audio") {
    return { id, kind: "audio", start: 0, duration: round(media.durationSec ?? 5), mediaId: media.id, sourceIn: 0, volume: 1 } as unknown as Clip;
  }
  return {
    id,
    kind: media.kind === "image" ? "image" : "video",
    start: 0,
    duration: round(media.durationSec ?? (media.kind === "image" ? 4 : 5)),
    mediaId: media.id,
    sourceIn: 0,
    transitionInSec: 0,
    transform: { x: doc.meta.width / 2, y: doc.meta.height / 2 },
  } as unknown as Clip;
}

/**
 * Drop a media asset onto a specific lane at a specific time (insert or
 * overwrite). Registers the asset in `doc.media`. Returns the SAME doc for a
 * locked / missing / wrong-family lane. Pure.
 */
export function insertMediaAt(doc: EditDoc, media: MediaAsset, trackId: string, startSec: number, mode: DropMode = "insert"): { doc: EditDoc; clipId: string | null } {
  const clip = createMediaClip(doc, media);
  const withMedia: EditDoc = structuredClone(doc);
  if (!withMedia.media.some((m) => m.id === media.id)) withMedia.media.push(media);
  const before = captureMainSpans(withMedia);
  const out = placeObject(parseEditDoc(withMedia), clip, trackId, startSec, mode, new Set(), before, null);
  return out ? { doc: out, clipId: clip.id } : { doc, clipId: null };
}

/**
 * Drop media on the preview (the Stage): it becomes a picture-in-picture overlay on
 * a free lane (b-roll, else the first free layer, else a fresh one) at the drop
 * point. Audio goes to a free audio lane instead. Pure.
 */
export function addMediaAsOverlay(
  doc: EditDoc,
  media: MediaAsset,
  startSec: number,
  at?: { xFrac: number; yFrac: number },
): { doc: EditDoc; clipId: string | null } {
  let d = doc;
  const audio = media.kind === "audio";
  const mag = magneticTrackId(d);
  const free = (t: Track): boolean => !t.locked && t.id !== mag && (audio ? t.kind === "audio" : t.kind === "visual" && t.id !== "titles" && t.id !== "captions");
  let lane = audio
    ? d.tracks.find(free)
    : d.tracks.find((t) => t.id === "broll" && free(t)) ?? [...d.tracks].reverse().find(free);
  if (!lane) {
    d = addTrack(d, { kind: audio ? "audio" : "visual", name: audio ? "Audio" : "Overlay" });
    lane = d.tracks[d.tracks.length - 1]!;
  }
  const clip = createMediaClip(d, media);
  if (!audio) {
    const w = d.meta.width;
    const h = d.meta.height;
    (clip as unknown as { transform: Record<string, number> }).transform = {
      x: Math.round((at?.xFrac ?? 0.5) * w),
      y: Math.round((at?.yFrac ?? 0.5) * h),
      scale: 0.4,
    };
  }
  const withMedia: EditDoc = structuredClone(d);
  if (!withMedia.media.some((m) => m.id === media.id)) withMedia.media.push(media);
  const before = captureMainSpans(withMedia);
  const out = placeObject(parseEditDoc(withMedia), clip, lane.id, startSec, "insert", new Set(), before, null);
  return out ? { doc: out, clipId: clip.id } : { doc, clipId: null };
}

/** The ids of clips present in `after` but not in `before`. */
function newClipIds(before: EditDoc, after: EditDoc): string[] {
  const had = new Set(before.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  return after.tracks.flatMap((t) => t.clips.map((c) => c.id)).filter((id) => !had.has(id));
}

/** Seconds a dropped palette item will occupy (for the drop preview's width). */
export function payloadDurationSec(p: DropPayload, mediaDuration?: number): number {
  switch (p.type) {
    case "media":
      return p.durationSec ?? mediaDuration ?? (p.mediaKind === "image" ? 4 : 5);
    case "text-preset":
      return 3;
    case "pro-text":
      return 4;
    case "sticker":
      return 3;
    case "graphic": {
      const def = findGraphicPreset(p.preset);
      const d = def?.defaults.durationSec;
      return typeof d === "number" ? d : 4;
    }
  }
}

/** The clip kind a payload becomes (for lane-fit checks while hovering). */
export function payloadClipKind(p: DropPayload): Clip["kind"] {
  if (p.type === "media") return p.mediaKind;
  if (p.type === "graphic") return "shape";
  return "text";
}

function setClipCenter(doc: EditDoc, clipId: string, at: { xFrac: number; yFrac: number }): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const f = findClip(clone, clipId);
  if (!f || !("transform" in f.clip)) return doc;
  (f.clip as { transform: { x: number; y: number } }).transform = {
    ...(f.clip as { transform: object }).transform,
    x: Math.round(at.xFrac * clone.meta.width),
    y: Math.round(at.yFrac * clone.meta.height),
  } as never;
  return parseEditDoc(clone);
}

/**
 * Turn a dropped palette item into an edit-doc op. With a `trackId` the new clip
 * lands on that lane at `startSec`; without one (a drop on the preview) it becomes
 * an overlay at the drop point (`at`). Returns null when the drop can't apply
 * (unknown preset / media, locked or incompatible lane). Pure.
 */
export function dropItemIntoDoc(
  doc: EditDoc,
  payload: DropPayload,
  o: { startSec: number; trackId?: string | null; mode?: DropMode; at?: { xFrac: number; yFrac: number }; media?: MediaAsset },
): { doc: EditDoc; clipId: string | null; summary: string } | null {
  const mode = o.mode ?? "insert";
  const startSec = Math.max(0, round(o.startSec));
  if (payload.type === "media") {
    const media = o.media;
    if (!media) return null;
    const res = o.trackId ? insertMediaAt(doc, media, o.trackId, startSec, mode) : addMediaAsOverlay(doc, media, startSec, o.at);
    if (!res.clipId) return null;
    return { doc: res.doc, clipId: res.clipId, summary: `Added ${media.label ?? media.kind}` };
  }
  let next: EditDoc;
  let summary: string;
  let newIds: string[];
  if (payload.type === "graphic") {
    const w = doc.meta.width;
    const h = doc.meta.height;
    const placed = o.at ? { x: Math.round(o.at.xFrac * w), y: Math.round(o.at.yFrac * h) } : {};
    try {
      const res = addGraphic(doc, { preset: payload.preset, atSec: startSec, ...placed });
      next = res.doc;
      newIds = res.clipIds;
    } catch {
      return null;
    }
    summary = `Added ${payload.label ?? "graphic"}`;
    return { doc: next, clipId: newIds[0] ?? null, summary };
  }
  if (payload.type === "sticker") {
    next = insertSticker(doc, payload.emoji, { startSec, xFrac: o.at?.xFrac, yFrac: o.at?.yFrac });
    summary = `Added ${payload.emoji} sticker`;
  } else if (payload.type === "text-preset") {
    const preset = TEXT_PRESETS.find((p) => p.key === payload.key);
    if (!preset) return null;
    next = preset.build(doc, { text: payload.text, startSec, xFrac: o.at?.xFrac, yFrac: o.at?.yFrac });
    summary = `Added ${preset.label} text`;
  } else {
    const preset = PRO_TEXT_PRESETS.find((p) => p.key === payload.key);
    if (!preset) return null;
    const res = insertProPreset(doc, preset, startSec, payload.text);
    next = res.doc;
    summary = `Added ${preset.label} text`;
  }
  newIds = newClipIds(doc, next);
  const id = newIds[newIds.length - 1] ?? null;
  if (!id || next === doc) return null;
  if (o.at && payload.type === "pro-text") next = setClipCenter(next, id, o.at);
  // Dropped on a specific free visual lane → move the new overlay there (no collisions for overlays).
  if (o.trackId) {
    const lane = next.tracks.find((t) => t.id === o.trackId);
    const here = findClip(next, id);
    if (lane && !lane.locked && lane.kind === "visual" && lane.id !== magneticTrackId(next) && here && here.track.id !== lane.id) {
      next = placeClip(next, id, lane.id, startSec, "insert");
    }
  }
  return { doc: next, clipId: id, summary };
}
