/**
 * Position & transform math — PURE, deterministic, no DOM. The on-canvas selection
 * box (Stage), the Transform inspector and the Director's `set_transform` /
 * `align_clip` tools all read the same functions, so a drag, a typed number and a
 * sentence land on identical values.
 *
 * Conventions: composition pixels, y down, rotation in degrees CLOCKWISE about the
 * box centre. A `Box` is the on-canvas footprint of a layer (scale already applied).
 * Layers that rotate about an off-centre anchor (left/right-aligned text) are
 * handled by `LayerBox.anchor` — the box is the VISUAL footprint, the clip's
 * `transform.x/y` is its anchor, and `boxToPatch` converts back.
 */
import { activeClipsAt } from "./engine";
import { keyframeTransformState, lineWidth, textFont, wrapText, type Ctx2D } from "./draw";
import { valueAt, clipProgress } from "./grade";
import type { Clip, EditDoc, KeyframeProp, ShapeClip, TextClip } from "./schema";

// ---- geometry --------------------------------------------------------------

export interface Pt {
  x: number;
  y: number;
}

/** Centre, size and clockwise rotation (degrees) of a layer on the canvas. */
export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLE_IDS: readonly HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CORNER_HANDLES: readonly HandleId[] = ["nw", "ne", "se", "sw"];

const rad = (deg: number): number => (deg * Math.PI) / 180;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Rotate (x,y) clockwise by `deg` about (cx,cy). */
export function rotatePoint(x: number, y: number, cx: number, cy: number, deg: number): Pt {
  const r = rad(deg);
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** The four corners in order nw, ne, se, sw (after rotation). */
export function boxCorners(b: Box): [Pt, Pt, Pt, Pt] {
  const hw = b.w / 2;
  const hh = b.h / 2;
  const at = (dx: number, dy: number): Pt => rotatePoint(b.cx + dx, b.cy + dy, b.cx, b.cy, b.rot);
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** Axis-aligned bounds of a (possibly rotated) box. */
export function boxAabb(b: Box): Rect {
  const cs = boxCorners(b);
  return {
    left: Math.min(...cs.map((p) => p.x)),
    top: Math.min(...cs.map((p) => p.y)),
    right: Math.max(...cs.map((p) => p.x)),
    bottom: Math.max(...cs.map((p) => p.y)),
  };
}

/** Union of several rects. */
export function unionRect(rs: Rect[]): Rect {
  return {
    left: Math.min(...rs.map((r) => r.left)),
    top: Math.min(...rs.map((r) => r.top)),
    right: Math.max(...rs.map((r) => r.right)),
    bottom: Math.max(...rs.map((r) => r.bottom)),
  };
}

/** Is the point inside the (rotated) box, expanded by `pad` px on every side? */
export function pointInBox(b: Box, x: number, y: number, pad = 0): boolean {
  const p = rotatePoint(x, y, b.cx, b.cy, -b.rot);
  return Math.abs(p.x - b.cx) <= b.w / 2 + pad && Math.abs(p.y - b.cy) <= b.h / 2 + pad;
}

/** World position of a resize handle. */
export function handlePoint(b: Box, h: HandleId): Pt {
  const sx = h.includes("e") ? 1 : h.includes("w") ? -1 : 0;
  const sy = h.includes("s") ? 1 : h.includes("n") ? -1 : 0;
  return rotatePoint(b.cx + (sx * b.w) / 2, b.cy + (sy * b.h) / 2, b.cx, b.cy, b.rot);
}

/** World position of the rotate handle (above the top edge by `offset` px). */
export function rotateHandlePoint(b: Box, offset: number): Pt {
  return rotatePoint(b.cx, b.cy - b.h / 2 - offset, b.cx, b.cy, b.rot);
}

export interface ResizeOpts {
  /** Keep the start aspect ratio (Shift). */
  keepAspect?: boolean;
  /** Resize symmetrically about the centre (Alt). */
  fromCenter?: boolean;
  /** Smallest allowed width/height in px. */
  minSize?: number;
}

/**
 * Drag handle `handle` of `start` to the world pointer (px,py). Works for rotated
 * boxes: the pointer is un-rotated into the box's own frame, so the edge under the
 * cursor tracks it exactly and the opposite edge/corner stays pinned (unless
 * `fromCenter`). Pure.
 */
export function resizeBox(start: Box, handle: HandleId, px: number, py: number, opts: ResizeOpts = {}): Box {
  const min = opts.minSize ?? 8;
  const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const p = rotatePoint(px, py, start.cx, start.cy, -start.rot);
  const lx = p.x - start.cx;
  const ly = p.y - start.cy;
  let nw = start.w;
  let nh = start.h;
  if (sx !== 0) nw = opts.fromCenter ? 2 * sx * lx : sx * lx + start.w / 2;
  if (sy !== 0) nh = opts.fromCenter ? 2 * sy * ly : sy * ly + start.h / 2;
  nw = Math.max(min, nw);
  nh = Math.max(min, nh);
  if (opts.keepAspect && start.w > 0 && start.h > 0) {
    let k: number;
    if (sx !== 0 && sy !== 0) k = Math.max(nw / start.w, nh / start.h);
    else if (sx !== 0) k = nw / start.w;
    else k = nh / start.h;
    k = Math.max(k, min / Math.min(start.w, start.h));
    nw = start.w * k;
    nh = start.h * k;
  }
  // Local-frame centre offset: the pinned edge stays put, the moving one follows.
  const ox = sx === 0 || opts.fromCenter ? 0 : (sx * (nw - start.w)) / 2;
  const oy = sy === 0 || opts.fromCenter ? 0 : (sy * (nh - start.h)) / 2;
  const c = rotatePoint(start.cx + ox, start.cy + oy, start.cx, start.cy, start.rot);
  return { cx: c.x, cy: c.y, w: nw, h: nh, rot: start.rot };
}

/** Normalise an angle to (-180, 180]. */
export function normalizeDeg(d: number): number {
  let a = ((d + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  return a;
}

/**
 * Rotation (degrees) that points the rotate handle (straight above the centre at
 * rot=0) at the pointer. `snapStep` (e.g. 15 with Shift) rounds to that step.
 */
export function rotationFromPointer(b: Box, px: number, py: number, snapStep = 0): number {
  const a = (Math.atan2(py - b.cy, px - b.cx) * 180) / Math.PI + 90;
  let d = normalizeDeg(a);
  if (snapStep > 0) d = normalizeDeg(Math.round(d / snapStep) * snapStep);
  return d;
}

// ---- snapping --------------------------------------------------------------

export interface Guide {
  axis: "x" | "y";
  /** Position on the axis (a vertical line is axis "x" at x = pos). */
  pos: number;
  /** Extent along the other axis. */
  from: number;
  to: number;
  kind: "canvas" | "safe" | "layer";
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

export interface SnapOpts {
  /** Title-safe inset as a fraction of each side (default 0.05). */
  safeMargin?: number;
  /** Which sources to snap to. */
  canvas?: boolean;
  safe?: boolean;
  layers?: boolean;
}

interface Target {
  pos: number;
  from: number;
  to: number;
  kind: Guide["kind"];
}

function buildTargets(others: Box[], W: number, H: number, opts: SnapOpts): { xs: Target[]; ys: Target[] } {
  const m = opts.safeMargin ?? 0.05;
  const xs: Target[] = [];
  const ys: Target[] = [];
  if (opts.canvas !== false) {
    for (const x of [0, W / 2, W]) xs.push({ pos: x, from: 0, to: H, kind: "canvas" });
    for (const y of [0, H / 2, H]) ys.push({ pos: y, from: 0, to: W, kind: "canvas" });
  }
  if (opts.safe !== false) {
    for (const x of [W * m, W * (1 - m)]) xs.push({ pos: x, from: 0, to: H, kind: "safe" });
    for (const y of [H * m, H * (1 - m)]) ys.push({ pos: y, from: 0, to: W, kind: "safe" });
  }
  if (opts.layers !== false) {
    for (const o of others) {
      const r = boxAabb(o);
      for (const x of [r.left, (r.left + r.right) / 2, r.right]) xs.push({ pos: x, from: r.top, to: r.bottom, kind: "layer" });
      for (const y of [r.top, (r.top + r.bottom) / 2, r.bottom]) ys.push({ pos: y, from: r.left, to: r.right, kind: "layer" });
    }
  }
  return { xs, ys };
}

function bestSnap(cands: number[], targets: Target[], threshold: number): number | null {
  let best: number | null = null;
  for (const c of cands) {
    for (const t of targets) {
      const d = t.pos - c;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/**
 * Snap a MOVING box (its axis-aligned bounds: left / centre / right and top /
 * middle / bottom) to the canvas edges + centre, the title-safe margins and the
 * edges/centres of `others`. Returns the correction to add to the box position and
 * the guide lines to draw. `threshold` is in composition px.
 */
export function snapMove(box: Box, others: Box[], W: number, H: number, threshold: number, opts: SnapOpts = {}): SnapResult {
  const { xs, ys } = buildTargets(others, W, H, opts);
  const r = boxAabb(box);
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  const dx = bestSnap([r.left, cx, r.right], xs, threshold) ?? 0;
  const dy = bestSnap([r.top, cy, r.bottom], ys, threshold) ?? 0;
  const guides: Guide[] = [];
  const mr: Rect = { left: r.left + dx, right: r.right + dx, top: r.top + dy, bottom: r.bottom + dy };
  const mcx = cx + dx;
  const mcy = cy + dy;
  for (const t of xs) {
    if ([mr.left, mcx, mr.right].some((c) => Math.abs(c - t.pos) < 0.5)) {
      guides.push({ axis: "x", pos: t.pos, from: Math.min(t.from, mr.top), to: Math.max(t.to, mr.bottom), kind: t.kind });
    }
  }
  for (const t of ys) {
    if ([mr.top, mcy, mr.bottom].some((c) => Math.abs(c - t.pos) < 0.5)) {
      guides.push({ axis: "y", pos: t.pos, from: Math.min(t.from, mr.left), to: Math.max(t.to, mr.right), kind: t.kind });
    }
  }
  return { dx, dy, guides };
}

/** Snap a single pointer position (used while resizing) to the same targets. */
export function snapPoint(px: number, py: number, others: Box[], W: number, H: number, threshold: number, opts: SnapOpts = {}): { x: number; y: number; guides: Guide[] } {
  const { xs, ys } = buildTargets(others, W, H, opts);
  const dx = bestSnap([px], xs, threshold) ?? 0;
  const dy = bestSnap([py], ys, threshold) ?? 0;
  const guides: Guide[] = [];
  for (const t of xs) if (Math.abs(px + dx - t.pos) < 0.5 && dx !== 0) guides.push({ axis: "x", pos: t.pos, from: t.from, to: t.to, kind: t.kind });
  for (const t of ys) if (Math.abs(py + dy - t.pos) < 0.5 && dy !== 0) guides.push({ axis: "y", pos: t.pos, from: t.from, to: t.to, kind: t.kind });
  return { x: px + dx, y: py + dy, guides };
}

// ---- align / distribute / fit ----------------------------------------------

export type AlignH = "left" | "hcenter" | "right";
export type AlignV = "top" | "vmiddle" | "bottom";
export type AlignMode = AlignH | AlignV;

/** Movement (dx or dy) that aligns `r` to `ref` along one edge/centre. */
export function alignDelta(r: Rect, ref: Rect, mode: AlignMode): { dx: number; dy: number } {
  switch (mode) {
    case "left":
      return { dx: ref.left - r.left, dy: 0 };
    case "hcenter":
      return { dx: (ref.left + ref.right) / 2 - (r.left + r.right) / 2, dy: 0 };
    case "right":
      return { dx: ref.right - r.right, dy: 0 };
    case "top":
      return { dx: 0, dy: ref.top - r.top };
    case "vmiddle":
      return { dx: 0, dy: (ref.top + ref.bottom) / 2 - (r.top + r.bottom) / 2 };
    case "bottom":
      return { dx: 0, dy: ref.bottom - r.bottom };
  }
}

/** Equal-gap distribution along an axis: returns per-index deltas (first/last stay). */
export function distributeDeltas(rects: Rect[], axis: "h" | "v"): { dx: number; dy: number }[] {
  const n = rects.length;
  const out = rects.map(() => ({ dx: 0, dy: 0 }));
  if (n < 3) return out;
  const lo = (r: Rect): number => (axis === "h" ? r.left : r.top);
  const hi = (r: Rect): number => (axis === "h" ? r.right : r.bottom);
  const order = rects.map((_, i) => i).sort((a, b) => lo(rects[a]!) - lo(rects[b]!));
  const first = rects[order[0]!]!;
  const last = rects[order[n - 1]!]!;
  const total = hi(last) - lo(first);
  const sizes = order.reduce((s, i) => s + (hi(rects[i]!) - lo(rects[i]!)), 0);
  const gap = (total - sizes) / (n - 1);
  let cursor = lo(first);
  for (const i of order) {
    const r = rects[i]!;
    const d = cursor - lo(r);
    if (axis === "h") out[i]!.dx = d;
    else out[i]!.dy = d;
    cursor += hi(r) - lo(r) + gap;
  }
  return out;
}

/** Scale that makes a w×h layer fit inside (`fit`) or cover (`fill`) the canvas. */
export function fitScaleFor(w: number, h: number, W: number, H: number, mode: "fit" | "fill"): number {
  if (w <= 0 || h <= 0) return 1;
  const a = W / w;
  const b = H / h;
  return mode === "fit" ? Math.min(a, b) : Math.max(a, b);
}

/** 9-point anchor → fractions (0..1) of the canvas. */
export const NINE_POINTS: Record<string, { h: AlignH; v: AlignV }> = {
  "top-left": { h: "left", v: "top" },
  "top-center": { h: "hcenter", v: "top" },
  "top-right": { h: "right", v: "top" },
  "middle-left": { h: "left", v: "vmiddle" },
  center: { h: "hcenter", v: "vmiddle" },
  "middle-right": { h: "right", v: "vmiddle" },
  "bottom-left": { h: "left", v: "bottom" },
  "bottom-center": { h: "hcenter", v: "bottom" },
  "bottom-right": { h: "right", v: "bottom" },
};
export type NinePoint = keyof typeof NINE_POINTS;

// ---- clip → box ------------------------------------------------------------

/** What a layer can do on canvas. */
export type ResizeMode = "free" | "uniform" | "length" | "none";

export interface LayerBox {
  clipId: string;
  trackId: string;
  kind: Clip["kind"];
  /** The visual footprint (scale + keyframes at time t already applied). */
  box: Box;
  /** Which handles to show. */
  handles: readonly HandleId[];
  resize: ResizeMode;
  /** True when the layer can be dragged/nudged/rotated. */
  movable: boolean;
  /** Full-frame base media: selectable from the timeline only (never hit-tested). */
  background: boolean;
  /** Transform props that carry keyframes (edits at the playhead write a keyframe). */
  keyframed: KeyframeProp[];
  /** Unscaled local offset from the clip anchor (x,y) to the visual centre. */
  anchor: Pt;
  /** Unscaled content size (w,h before `scale`). */
  base: { w: number; h: number };
  /** Short human label ("Title", "Rectangle"…). */
  label: string;
}

export interface TransformPatch {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  /** Shape box width/height (composition px, pre-scale). */
  w?: number;
  h?: number;
  flipX?: boolean;
  flipY?: boolean;
}

/** Estimated (no canvas) unscaled size of a text block. */
export function estimateTextSize(clip: TextClip): { w: number; h: number } {
  const text = clip.uppercase ? clip.text.toUpperCase() : clip.text;
  const cw = clip.fontSize * (clip.fontWeight === "bold" ? 0.6 : 0.54) + (clip.letterSpacing ?? 0);
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (!clip.maxWidth) {
      lines.push(para);
      continue;
    }
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = cur ? `${cur} ${word}` : word;
      if (cur && test.length * cw > clip.maxWidth) {
        lines.push(cur);
        cur = word;
      } else cur = test;
    }
    lines.push(cur);
  }
  const widest = lines.reduce((m, l) => Math.max(m, l.length * cw), 0);
  const step = clip.fontSize * (clip.lineHeight ?? 1.2);
  return { w: Math.max(clip.fontSize * 0.6, widest), h: (Math.max(1, lines.length) - 1) * step + clip.fontSize };
}

/** Unscaled size of a text block — measured with `ctx` when given, else estimated. */
export function textBlockSize(clip: TextClip, ctx?: Ctx2D | null): { w: number; h: number } {
  if (!ctx) return estimateTextSize(clip);
  ctx.font = textFont(clip);
  const raw = clip.counter ? clip.text : clip.text;
  const text = clip.uppercase ? raw.toUpperCase() : raw;
  const ls = clip.letterSpacing ?? 0;
  const lines = clip.maxWidth ? wrapText(ctx, text, clip.maxWidth) : text.split("\n");
  const widest = lines.reduce((m, l) => Math.max(m, lineWidth(ctx, l, ls)), 0);
  const step = clip.fontSize * (clip.lineHeight ?? 1.2);
  return { w: Math.max(clip.fontSize * 0.6, widest), h: (lines.length - 1) * step + clip.fontSize };
}

const MIN_HIT = 28; // thin shapes (lines) keep a grabbable footprint

function keyframedProps(clip: { keyframes?: { prop: KeyframeProp }[] }): KeyframeProp[] {
  const out = new Set<KeyframeProp>();
  for (const k of clip.keyframes ?? []) if (k.prop === "x" || k.prop === "y" || k.prop === "scale" || k.prop === "rotation" || k.prop === "opacity") out.add(k.prop);
  return [...out];
}

/** Visual centre of a layer given its anchor (x,y), rotation and scale. */
function centerFrom(x: number, y: number, rot: number, scale: number, anchor: Pt): Pt {
  const r = rotatePoint(x + anchor.x * scale, y + anchor.y * scale, x, y, rot);
  return r;
}

/**
 * Resolve one clip's on-canvas box at `timeSec`, or null when it has no spatial
 * footprint (audio, adjustment, callout, cursor, full-frame solid). Text is
 * measured with `ctx` when provided, else estimated.
 */
export function layerBox(doc: EditDoc, clip: Clip, trackId: string, trackLocked: boolean, timeSec: number, ctx?: Ctx2D | null): LayerBox | null {
  const W = doc.meta.width;
  const H = doc.meta.height;
  if (clip.kind === "text") {
    const k = keyframeTransformState(clip, timeSec);
    const size = textBlockSize(clip, ctx);
    const ax = clip.align === "left" ? size.w / 2 : clip.align === "right" ? -size.w / 2 : 0;
    const anchor = { x: ax, y: 0 };
    const c = centerFrom(k.x, k.y, k.rotation, k.scale, anchor);
    return {
      clipId: clip.id,
      trackId,
      kind: "text",
      box: { cx: c.x, cy: c.y, w: size.w * k.scale, h: size.h * k.scale, rot: k.rotation },
      handles: CORNER_HANDLES,
      resize: "uniform",
      movable: !trackLocked,
      background: false,
      keyframed: keyframedProps(clip),
      anchor,
      base: size,
      label: "Text",
    };
  }
  if (clip.kind === "shape") {
    const k = keyframeTransformState(clip, timeSec);
    const line = clip.shape === "line" || clip.shape === "arrow";
    const baseH = line ? Math.max(MIN_HIT, clip.strokeWidth || 8) : clip.h;
    return {
      clipId: clip.id,
      trackId,
      kind: "shape",
      box: { cx: k.x, cy: k.y, w: clip.w * k.scale, h: baseH * k.scale, rot: k.rotation },
      handles: line ? ["e", "w"] : HANDLE_IDS,
      resize: line ? "length" : "free",
      movable: !trackLocked,
      background: false,
      keyframed: keyframedProps(clip),
      anchor: { x: 0, y: 0 },
      base: { w: clip.w, h: baseH },
      label: line ? (clip.shape === "arrow" ? "Arrow" : "Line") : clip.shape.charAt(0).toUpperCase() + clip.shape.slice(1),
    };
  }
  if (clip.kind === "video" || clip.kind === "image") {
    const isBroll = trackId === "broll";
    const k = keyframeTransformState(clip, timeSec);
    if (!isBroll) {
      return {
        clipId: clip.id,
        trackId,
        kind: clip.kind,
        box: { cx: W / 2, cy: H / 2, w: W, h: H, rot: 0 },
        handles: [],
        resize: "none",
        movable: false,
        background: true,
        keyframed: keyframedProps(clip),
        anchor: { x: 0, y: 0 },
        base: { w: W, h: H },
        label: clip.kind === "video" ? "Video" : "Photo",
      };
    }
    return {
      clipId: clip.id,
      trackId,
      kind: clip.kind,
      box: { cx: k.x, cy: k.y, w: W * k.scale, h: H * k.scale, rot: 0 },
      handles: CORNER_HANDLES,
      resize: "uniform",
      movable: !trackLocked,
      background: false,
      keyframed: keyframedProps(clip),
      anchor: { x: 0, y: 0 },
      base: { w: W, h: H },
      label: "Overlay",
    };
  }
  return null;
}

/**
 * Every spatial layer visible at `timeSec`, bottom → top (the draw order). Hidden
 * tracks are skipped; locked tracks yield non-movable boxes.
 */
export function layerBoxesAt(doc: EditDoc, timeSec: number, ctx?: Ctx2D | null): LayerBox[] {
  const out: LayerBox[] = [];
  for (const { clip, track } of activeClipsAt(doc, timeSec)) {
    const lb = layerBox(doc, clip, track.id, !!track.locked, timeSec, ctx);
    if (lb) out.push(lb);
  }
  return out;
}

/** Topmost non-background layer under the world point (composition px). */
export function hitTestLayers(layers: LayerBox[], x: number, y: number, pad = 0): LayerBox | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    if (l.background) continue;
    if (pointInBox(l.box, x, y, pad)) return l;
  }
  return null;
}

/** Convert an edited visual box back into the clip's own transform fields. */
export function boxToPatch(layer: LayerBox, box: Box): TransformPatch {
  const scaleBase = layer.box.w / (layer.base.w || 1); // current effective scale
  let scale = scaleBase;
  const patch: TransformPatch = {};
  if (layer.resize === "uniform") {
    scale = box.w / (layer.base.w || 1);
    patch.scale = round2(Math.max(0.01, scale));
  } else if (layer.resize === "free") {
    patch.w = round2(Math.max(1, box.w / scaleBase));
    patch.h = round2(Math.max(1, box.h / scaleBase));
  } else if (layer.resize === "length") {
    patch.w = round2(Math.max(1, box.w / scaleBase));
  }
  // Anchor from the visual centre: anchor = centre - R(rot)·(scale·offset).
  const off = rotatePoint(layer.anchor.x * scale, layer.anchor.y * scale, 0, 0, box.rot);
  patch.x = round2(box.cx - off.x);
  patch.y = round2(box.cy - off.y);
  patch.rotation = round2(box.rot);
  return patch;
}

/** Current resolved transform values of a clip at `timeSec` (keyframes applied). */
export function resolvedTransform(clip: Clip, timeSec: number): { x: number; y: number; scale: number; rotation: number; opacity: number; flipX: boolean; flipY: boolean } | null {
  if (clip.kind !== "text" && clip.kind !== "shape" && clip.kind !== "video" && clip.kind !== "image" && clip.kind !== "solid") return null;
  const t = clip.transform;
  const p = clipProgress(clip, timeSec);
  const kf = clip.keyframes;
  return {
    x: valueAt(kf, "x", p, t.x),
    y: valueAt(kf, "y", p, t.y),
    scale: valueAt(kf, "scale", p, t.scale),
    rotation: valueAt(kf, "rotation", p, t.rotation),
    opacity: valueAt(kf, "opacity", p, t.opacity),
    flipX: !!t.flipX,
    flipY: !!t.flipY,
  };
}

/** Narrowing helper used by callers that need the shape-specific fields. */
export function isShapeClip(c: Clip): c is ShapeClip {
  return c.kind === "shape";
}
