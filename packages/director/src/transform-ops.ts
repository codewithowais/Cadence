/**
 * Position & transform ops — PURE `(doc, …) => EditDoc` transforms behind the
 * on-canvas selection box, the Transform inspector and the Director's
 * `set_transform` / `align_clip` tools. One path for a drag, a typed number and a
 * sentence (edits-as-code); the web editor routes every result through `commit`.
 *
 * Keyframe-aware: when a transform prop (x / y / scale / rotation / opacity) already
 * carries keyframes, an edit upserts a keyframe at the playhead's clip-progress
 * instead of writing the static value (same upsert semantics as `setKeyframe`, but
 * shapes are supported too). Geometry comes from `@cadence/core`'s transform math.
 */
import {
  NINE_POINTS,
  alignDelta,
  boxAabb,
  boxToPatch,
  distributeDeltas,
  fitScaleFor,
  layerBox,
  parseEditDoc,
  unionRect,
  type AlignMode,
  type Clip,
  type Ctx2D,
  type EditDoc,
  type Keyframe,
  type KeyframeProp,
  type LayerBox,
  type NinePoint,
  type Track,
  type TransformPatch,
} from "@cadence/core";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const KF_EPS = 1e-3;
const KF_PROPS: readonly KeyframeProp[] = ["x", "y", "scale", "rotation", "opacity"];

interface Spatial {
  kind: string;
  start: number;
  duration: number;
  transform: { x: number; y: number; scale: number; rotation: number; opacity: number; flipX?: boolean; flipY?: boolean };
  keyframes?: Keyframe[];
  w?: number;
  h?: number;
}

function locate(doc: EditDoc, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of doc.tracks) for (const clip of track.clips) if (clip.id === clipId) return { track, clip };
  return null;
}

/** The clip's current layer box at `atSec` (null when it has no spatial footprint). */
export function layerBoxFor(doc: EditDoc, clipId: string, atSec?: number, ctx?: Ctx2D | null): LayerBox | null {
  const hit = locate(doc, clipId);
  if (!hit) return null;
  const t = atSec ?? hit.clip.start + Math.min(0.5, hit.clip.duration / 2);
  return layerBox(doc, hit.clip, hit.track.id, !!hit.track.locked, t, ctx);
}

function upsertKeyframe(clip: Spatial, prop: KeyframeProp, t: number, value: number): void {
  const kfs = [...(clip.keyframes ?? [])];
  const idx = kfs.findIndex((k) => k.prop === prop && Math.abs(k.t - t) < KF_EPS);
  const prev = idx >= 0 ? kfs[idx]! : undefined;
  const kf: Keyframe = { prop, t, value: round2(value), easing: prev?.easing ?? "linear" };
  if (idx >= 0) kfs[idx] = kf;
  else kfs.push(kf);
  clip.keyframes = kfs.sort((a, b) => a.t - b.t);
}

/** Apply a patch to a (cloned) clip in place. Returns false when the clip can't take it. */
function applyPatch(clip: Spatial, patch: TransformPatch, atSec: number): boolean {
  if (clip.kind !== "text" && clip.kind !== "shape" && clip.kind !== "video" && clip.kind !== "image" && clip.kind !== "solid") return false;
  const prog = clamp((atSec - clip.start) / Math.max(1e-4, clip.duration), 0, 1);
  const hasKf = (p: KeyframeProp): boolean => (clip.keyframes ?? []).some((k) => k.prop === p);
  const set = (prop: KeyframeProp, value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value)) return;
    if (hasKf(prop)) upsertKeyframe(clip, prop, round2(prog), value);
    else clip.transform[prop as "x" | "y" | "scale" | "rotation" | "opacity"] = round2(value);
  };
  set("x", patch.x);
  set("y", patch.y);
  if (patch.scale !== undefined) set("scale", Math.max(0.01, patch.scale));
  set("rotation", patch.rotation);
  if (patch.opacity !== undefined) set("opacity", clamp(patch.opacity, 0, 1));
  if (clip.kind === "shape") {
    if (patch.w !== undefined) clip.w = round2(Math.max(1, patch.w));
    if (patch.h !== undefined) clip.h = round2(Math.max(1, patch.h));
  }
  if (patch.flipX !== undefined) clip.transform.flipX = patch.flipX ? true : undefined;
  if (patch.flipY !== undefined) clip.transform.flipY = patch.flipY ? true : undefined;
  return true;
}

export interface TransformOpts {
  /** Timeline time of the edit (the playhead) — decides where a keyframe lands. */
  atSec?: number;
}

/** Set transform fields on several clips at once (one parse → one undo step). */
export function setTransforms(doc: EditDoc, entries: { clipId: string; patch: TransformPatch }[], opts: TransformOpts = {}): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let changed = 0;
  for (const { clipId, patch } of entries) {
    const hit = locate(clone, clipId);
    if (!hit) continue;
    const at = opts.atSec ?? hit.clip.start;
    if (applyPatch(hit.clip as unknown as Spatial, patch, at)) changed++;
  }
  if (changed === 0) throw new Error("Nothing to move — select a text, shape or overlay first.");
  return parseEditDoc(clone);
}

/** Set transform fields on one clip. */
export function setTransform(doc: EditDoc, clipId: string, patch: TransformPatch, opts: TransformOpts = {}): EditDoc {
  if (!locate(doc, clipId)) throw new Error(`No clip “${clipId}” to transform.`);
  return setTransforms(doc, [{ clipId, patch }], opts);
}

/** Move clips by (dx, dy) composition px (arrow-key nudge, relative director moves). */
export function moveClipsBy(doc: EditDoc, clipIds: string[], dx: number, dy: number, opts: TransformOpts & { ctx?: Ctx2D | null } = {}): EditDoc {
  const entries: { clipId: string; patch: TransformPatch }[] = [];
  for (const id of clipIds) {
    const lb = layerBoxFor(doc, id, opts.atSec, opts.ctx);
    if (!lb || !lb.movable) continue;
    const hit = locate(doc, id)!;
    const t = opts.atSec ?? hit.clip.start;
    const cur = layerBoxFor(doc, id, t, opts.ctx)!;
    const patch = boxToPatch(cur, { ...cur.box, cx: cur.box.cx + dx, cy: cur.box.cy + dy });
    entries.push({ clipId: id, patch: { x: patch.x, y: patch.y } });
  }
  if (entries.length === 0) throw new Error("Nothing movable is selected.");
  return setTransforms(doc, entries, opts);
}

export type AlignTarget = AlignMode | NinePoint;
export interface AlignOpts extends TransformOpts {
  /** Align to the canvas (default) or to the combined bounds of the selection. */
  relativeTo?: "canvas" | "selection";
  ctx?: Ctx2D | null;
  /** Inset from the canvas edges (px) for edge alignments; 0 = flush. */
  margin?: number;
}

/**
 * Align clips. `to` is an edge/centre mode (left · center · right · top · middle ·
 * bottom) or a 9-point anchor (top-left … bottom-right, center) which aligns BOTH
 * axes. Relative to the canvas (default) or the selection's combined bounds.
 */
export function alignClips(doc: EditDoc, clipIds: string[], to: AlignTarget, opts: AlignOpts = {}): EditDoc {
  const layers: LayerBox[] = [];
  for (const id of clipIds) {
    const hit = locate(doc, id);
    const lb = layerBoxFor(doc, id, opts.atSec ?? hit?.clip.start, opts.ctx);
    if (lb && lb.movable) layers.push(lb);
  }
  if (layers.length === 0) throw new Error("Nothing to align — select a text, shape or overlay first.");
  const W = doc.meta.width;
  const H = doc.meta.height;
  const m = opts.margin ?? 0;
  const ref =
    opts.relativeTo === "selection" && layers.length > 1
      ? unionRect(layers.map((l) => boxAabb(l.box)))
      : { left: m, top: m, right: W - m, bottom: H - m };
  const modes: AlignMode[] = to in NINE_POINTS ? [NINE_POINTS[to]!.h, NINE_POINTS[to]!.v] : [to as AlignMode];
  const entries = layers.map((l) => {
    const r = boxAabb(l.box);
    let dx = 0;
    let dy = 0;
    for (const mode of modes) {
      const d = alignDelta({ left: r.left + dx, right: r.right + dx, top: r.top + dy, bottom: r.bottom + dy }, ref, mode);
      dx += d.dx;
      dy += d.dy;
    }
    const patch = boxToPatch(l, { ...l.box, cx: l.box.cx + dx, cy: l.box.cy + dy });
    return { clipId: l.clipId, patch: { x: patch.x, y: patch.y } as TransformPatch };
  });
  return setTransforms(doc, entries, opts);
}

/** Space three or more clips evenly along an axis (first and last stay put). */
export function distributeClips(doc: EditDoc, clipIds: string[], axis: "h" | "v", opts: AlignOpts = {}): EditDoc {
  const layers: LayerBox[] = [];
  for (const id of clipIds) {
    const hit = locate(doc, id);
    const lb = layerBoxFor(doc, id, opts.atSec ?? hit?.clip.start, opts.ctx);
    if (lb && lb.movable) layers.push(lb);
  }
  if (layers.length < 3) throw new Error("Pick at least three layers to distribute.");
  const deltas = distributeDeltas(layers.map((l) => boxAabb(l.box)), axis);
  const entries = layers.map((l, i) => {
    const d = deltas[i]!;
    const patch = boxToPatch(l, { ...l.box, cx: l.box.cx + d.dx, cy: l.box.cy + d.dy });
    return { clipId: l.clipId, patch: { x: patch.x, y: patch.y } as TransformPatch };
  });
  return setTransforms(doc, entries, opts);
}

/** Scale a layer so it fits inside (`fit`) or covers (`fill`) the canvas, centred. */
export function fitClip(doc: EditDoc, clipId: string, mode: "fit" | "fill", opts: AlignOpts = {}): EditDoc {
  const lb = layerBoxFor(doc, clipId, opts.atSec, opts.ctx);
  if (!lb || !lb.movable) throw new Error("This layer can't be resized.");
  const W = doc.meta.width;
  const H = doc.meta.height;
  const patch: TransformPatch = {};
  if (lb.resize === "uniform") {
    patch.scale = fitScaleFor(lb.base.w, lb.base.h, W, H, mode);
  } else if (lb.resize === "free") {
    const s = lb.box.w / (lb.base.w || 1);
    if (mode === "fill") {
      patch.w = W / s;
      patch.h = H / s;
    } else {
      const k = fitScaleFor(lb.base.w, lb.base.h, W / s, H / s, "fit");
      patch.w = lb.base.w * k;
      patch.h = lb.base.h * k;
    }
  } else if (lb.resize === "length") {
    patch.w = W / (lb.box.w / (lb.base.w || 1));
  }
  const hit = locate(doc, clipId)!;
  patch.x = lb.resize === "uniform" ? W / 2 - rotX(lb, patch.scale ?? 1) : W / 2;
  patch.y = lb.resize === "uniform" ? H / 2 - rotY(lb, patch.scale ?? 1) : H / 2;
  void hit;
  return setTransform(doc, clipId, patch, opts);
}

// Anchor offset (unscaled) rotated into world space for `scale` — keeps the visual centre on the canvas centre.
function rotX(lb: LayerBox, scale: number): number {
  const r = (lb.box.rot * Math.PI) / 180;
  return (lb.anchor.x * Math.cos(r) - lb.anchor.y * Math.sin(r)) * scale;
}
function rotY(lb: LayerBox, scale: number): number {
  const r = (lb.box.rot * Math.PI) / 180;
  return (lb.anchor.x * Math.sin(r) + lb.anchor.y * Math.cos(r)) * scale;
}

/** Reset rotation / scale / flip / opacity, centre the layer, and drop its transform keyframes. */
export function resetTransform(doc: EditDoc, clipId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const hit = locate(clone, clipId);
  if (!hit) throw new Error(`No clip “${clipId}” to reset.`);
  const c = hit.clip as unknown as Spatial;
  if (!["text", "shape", "video", "image", "solid"].includes(c.kind)) throw new Error("This layer has no transform to reset.");
  const lb = layerBox(clone, hit.clip, hit.track.id, false, hit.clip.start);
  c.transform.scale = 1;
  c.transform.rotation = 0;
  c.transform.opacity = 1;
  c.transform.flipX = undefined;
  c.transform.flipY = undefined;
  c.transform.x = clone.meta.width / 2 - (lb ? rotX(lb, 1) : 0);
  c.transform.y = clone.meta.height / 2 - (lb ? rotY(lb, 1) : 0);
  if (lb && hit.track.id !== "broll" && lb.background) {
    c.transform.x = clone.meta.width / 2;
    c.transform.y = clone.meta.height / 2;
  }
  if (c.keyframes) {
    const rest = c.keyframes.filter((k) => !KF_PROPS.includes(k.prop));
    c.keyframes = rest.length > 0 ? rest : undefined;
  }
  return parseEditDoc(clone);
}

export type ArrangeMode = "forward" | "backward" | "front" | "back";

/**
 * Bring a layer forward / backward or to the front / back. Z-order IS track order,
 * so this moves the clip's track — or, when the track carries other clips
 * overlapping it in time, lifts the clip onto its own new "Layer" track first.
 */
export function arrangeClip(doc: EditDoc, clipId: string, mode: ArrangeMode): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const ti = clone.tracks.findIndex((t) => t.clips.some((c) => c.id === clipId));
  if (ti < 0) throw new Error(`No clip “${clipId}” to arrange.`);
  const track = clone.tracks[ti]!;
  const clip = track.clips.find((c) => c.id === clipId)!;
  if (track.kind !== "visual") throw new Error("Only picture layers have a stacking order.");
  if (track.locked) throw new Error(`Track “${track.id}” is locked — unlock it to restack.`);
  const vis = clone.tracks.map((t, i) => (t.kind === "visual" ? i : -1)).filter((i) => i >= 0);
  const p = vis.indexOf(ti);
  const target = mode === "forward" ? p + 1 : mode === "backward" ? p - 1 : mode === "front" ? vis.length - 1 : 0;
  const overlaps = track.clips.some((o) => o.id !== clip.id && o.start < clip.start + clip.duration && o.start + o.duration > clip.start);

  if (!overlaps) {
    const np = clamp(target, 0, vis.length - 1);
    if (np === p) return doc; // already at the limit — a no-op, not an error
    const [moved] = clone.tracks.splice(ti, 1);
    // Re-derive the destination array index after removal.
    const visAfter = clone.tracks.map((t, i) => (t.kind === "visual" ? i : -1)).filter((i) => i >= 0);
    const destVis = np > p ? visAfter[np - 1]! + 1 : visAfter[np]!;
    clone.tracks.splice(destVis, 0, moved!);
    return parseEditDoc(clone);
  }

  if (clip.kind === "video" || clip.kind === "image") {
    throw new Error("Footage clips share a lane — use the track controls to reorder them.");
  }
  const atFront = mode === "front" || (mode === "forward" && p === vis.length - 1);
  const atBack = mode === "back" || (mode === "backward" && p === 0);
  track.clips = track.clips.filter((c) => c.id !== clip.id);
  let n = 1;
  while (clone.tracks.some((t) => t.id === `layer-${n}`)) n++;
  const lane = { id: `layer-${n}`, kind: "visual" as const, name: `Layer ${n}`, clips: [clip] };
  let at: number;
  if (atFront) at = vis[vis.length - 1]! + 1;
  else if (atBack) at = vis[0]!;
  else if (mode === "forward") at = ti + 1;
  else at = ti;
  clone.tracks.splice(at, 0, lane as unknown as Track);
  return parseEditDoc(clone);
}

// ---- finding the layer a sentence means ------------------------------------

export type TransformNoun = "title" | "logo" | "shape" | "caption" | "overlay" | "it";

/** The layers (z-ordered, bottom → top) a phrase like "the logo" could mean. */
export function resolveTransformTargets(doc: EditDoc, noun: TransformNoun, ctx?: Ctx2D | null): LayerBox[] {
  const all: LayerBox[] = [];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const lb = layerBox(doc, clip, track.id, !!track.locked, clip.start + Math.min(0.5, clip.duration / 2), ctx);
      if (lb && !lb.background && lb.movable) all.push(lb);
    }
  }
  const byKind = (f: (l: LayerBox) => boolean): LayerBox[] => all.filter(f);
  let pick: LayerBox[] = [];
  if (noun === "title") pick = byKind((l) => l.kind === "text" && l.trackId !== "captions");
  else if (noun === "caption") pick = byKind((l) => l.kind === "text" && l.trackId === "captions");
  else if (noun === "logo") pick = byKind((l) => l.kind === "image" || l.kind === "video" || l.trackId === "broll");
  else if (noun === "shape") pick = byKind((l) => l.kind === "shape");
  else if (noun === "overlay") pick = byKind((l) => l.kind !== "text" || l.trackId !== "captions");
  if (pick.length === 0) pick = all;
  return pick;
}
