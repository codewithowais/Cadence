/**
 * Director tools for POSITION — `set_transform`, `align_clip`, `arrange_clip` — plus
 * the plain-language parser behind the StubDirector ("move the title to the top
 * left", "make the logo smaller", "center it", "rotate 15 degrees"). All three call
 * the same pure ops the on-canvas selection box and the Transform inspector use.
 */
import { z } from "zod";
import { NINE_POINTS, boxToPatch, docDurationSec, type EditDoc, type LayerBox, type TransformPatch } from "@cadence/core";
import type { ProjectState } from "./project";
import type { DirectorTool, ToolResult } from "./tools";
import {
  alignClips,
  arrangeClip,
  fitClip,
  layerBoxFor,
  resetTransform,
  resolveTransformTargets,
  setTransforms,
  type AlignTarget,
  type ArrangeMode,
  type TransformNoun,
} from "./transform-ops";

function commit(project: ProjectState, doc: EditDoc, summary: string): ToolResult {
  project.setDoc(doc);
  return { summary, durationSec: docDurationSec(project.doc) };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const Noun = z.enum(["title", "logo", "shape", "caption", "overlay", "it"]);
const ALIGN_TARGETS = ["left", "hcenter", "right", "top", "vmiddle", "bottom", ...Object.keys(NINE_POINTS)] as [string, ...string[]];

/** Which layer(s) a tool call means: a clip id, or a noun resolved against the doc. */
function pickTargets(doc: EditDoc, clip: string | undefined, all: boolean | undefined): LayerBox[] {
  if (clip && !(Noun.options as readonly string[]).includes(clip)) {
    const lb = layerBoxFor(doc, clip);
    return lb ? [lb] : [];
  }
  const noun = (clip as TransformNoun | undefined) ?? "it";
  const cands = resolveTransformTargets(doc, noun);
  if (cands.length === 0) return [];
  // "the title" / "it" = the top-most match; `all` = every match.
  return all ? cands : [cands[cands.length - 1]!];
}

// ---- set_transform ----------------------------------------------------------------

export interface SetTransformInput {
  /** A clip id, or a noun: title · logo · shape · caption · overlay · it (the top layer). */
  clip?: string;
  /** Apply to every matching layer instead of just the top-most. */
  all?: boolean;
  /** Absolute position of the layer's CENTRE, in composition px or as a 0..1 fraction. */
  x?: number;
  y?: number;
  xFrac?: number;
  yFrac?: number;
  /** Relative move in composition px. */
  dx?: number;
  dy?: number;
  /** Relative move as a fraction of the frame. */
  dxFrac?: number;
  dyFrac?: number;
  /** Absolute scale multiplier, or a relative factor (0.8 = 20% smaller). */
  scale?: number;
  scaleBy?: number;
  /** Absolute rotation, or relative degrees (clockwise). */
  rotation?: number;
  rotateBy?: number;
  opacity?: number;
  /** On-canvas size in composition px. */
  width?: number;
  height?: number;
  flipX?: boolean | "toggle";
  flipY?: boolean | "toggle";
  fit?: "fit" | "fill";
  reset?: boolean;
}

/** Pure core of `set_transform` (also used by the unit tests / UI). */
export function applyTransformInput(doc: EditDoc, input: SetTransformInput, atSec?: number): { doc: EditDoc; count: number } {
  const targets = pickTargets(doc, input.clip, input.all);
  if (targets.length === 0) throw new Error("There's nothing to move yet — add a title, shape or overlay first.");
  const W = doc.meta.width;
  const H = doc.meta.height;
  let next = doc;
  if (input.reset) {
    for (const t of targets) next = resetTransform(next, t.clipId);
    return { doc: next, count: targets.length };
  }
  if (input.fit) {
    for (const t of targets) next = fitClip(next, t.clipId, input.fit, { atSec });
    return { doc: next, count: targets.length };
  }
  const entries: { clipId: string; patch: TransformPatch }[] = [];
  for (const t of targets) {
    const b = { ...t.box };
    if (input.scaleBy !== undefined) {
      b.w *= input.scaleBy;
      b.h *= input.scaleBy;
    }
    if (input.scale !== undefined && t.resize === "uniform") {
      b.w = t.base.w * input.scale;
      b.h = t.base.h * input.scale;
    } else if (input.scale !== undefined) {
      const k = input.scale / (t.box.w / (t.base.w || 1));
      b.w = t.box.w * k;
      b.h = t.box.h * k;
    }
    if (input.width !== undefined) {
      const k = input.width / b.w;
      b.w = input.width;
      if (t.resize === "uniform" || input.height === undefined) b.h *= t.resize === "free" ? 1 : k;
    }
    if (input.height !== undefined) {
      const k = input.height / b.h;
      b.h = input.height;
      if (t.resize === "uniform") b.w *= k;
    }
    if (input.x !== undefined) b.cx = input.x;
    if (input.y !== undefined) b.cy = input.y;
    if (input.xFrac !== undefined) b.cx = input.xFrac * W;
    if (input.yFrac !== undefined) b.cy = input.yFrac * H;
    if (input.dx !== undefined) b.cx += input.dx;
    if (input.dy !== undefined) b.cy += input.dy;
    if (input.dxFrac !== undefined) b.cx += input.dxFrac * W;
    if (input.dyFrac !== undefined) b.cy += input.dyFrac * H;
    if (input.rotation !== undefined) b.rot = input.rotation;
    if (input.rotateBy !== undefined) b.rot += input.rotateBy;
    const patch = boxToPatch(t, b);
    if (input.opacity !== undefined) patch.opacity = input.opacity;
    const hit = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === t.clipId);
    const tf = hit && "transform" in hit ? hit.transform : undefined;
    if (input.flipX !== undefined) patch.flipX = input.flipX === "toggle" ? !tf?.flipX : input.flipX;
    if (input.flipY !== undefined) patch.flipY = input.flipY === "toggle" ? !tf?.flipY : input.flipY;
    entries.push({ clipId: t.clipId, patch });
  }
  next = setTransforms(next, entries, { atSec });
  return { doc: next, count: entries.length };
}

export const setTransformTool: DirectorTool<SetTransformInput> = {
  name: "set_transform",
  description:
    "Move / resize / rotate / flip / fade ONE on-screen layer (or all matching with `all`). `clip` = a clip id or a noun (title · logo · shape · caption · overlay · it = the top-most layer). Position the layer's CENTRE with `x`,`y` (px) or `xFrac`,`yFrac` (0..1), or move relatively with `dx`,`dy` (px) / `dxFrac`,`dyFrac`. Size: `scale` (absolute), `scaleBy` (0.8 = 20% smaller), or `width`/`height` px. `rotation` (absolute°) / `rotateBy` (relative°), `opacity` 0..1, `flipX`/`flipY` (true | false | 'toggle'), `fit`: 'fit'|'fill' the frame, `reset: true` to clear the transform. If the property is keyframed the edit writes a keyframe at the playhead.",
  inputSchema: z.object({
    clip: z.string().optional(),
    all: z.boolean().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    xFrac: z.number().min(-1).max(2).optional(),
    yFrac: z.number().min(-1).max(2).optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    dxFrac: z.number().min(-2).max(2).optional(),
    dyFrac: z.number().min(-2).max(2).optional(),
    scale: z.number().positive().max(20).optional(),
    scaleBy: z.number().positive().max(20).optional(),
    rotation: z.number().min(-3600).max(3600).optional(),
    rotateBy: z.number().min(-3600).max(3600).optional(),
    opacity: z.number().min(0).max(1).optional(),
    width: z.number().positive().max(20000).optional(),
    height: z.number().positive().max(20000).optional(),
    flipX: z.union([z.boolean(), z.literal("toggle")]).optional(),
    flipY: z.union([z.boolean(), z.literal("toggle")]).optional(),
    fit: z.enum(["fit", "fill"]).optional(),
    reset: z.boolean().optional(),
  }) as z.ZodType<SetTransformInput>,
  async execute(input, ctx) {
    const { doc, count } = applyTransformInput(ctx.project.doc, input);
    return commit(ctx.project, doc, `Updated the position of ${count} layer${count === 1 ? "" : "s"} — drag it on the preview to fine-tune.`);
  },
};

// ---- align_clip --------------------------------------------------------------------

export interface AlignClipInput {
  clip?: string;
  all?: boolean;
  /** An edge / centre (left · hcenter · right · top · vmiddle · bottom) or a 9-point anchor. */
  to: string;
  relativeTo?: "canvas" | "selection";
  /** Inset from the frame edge in px (default 5% of the short side for edges/corners). */
  margin?: number;
}

export const alignClipTool: DirectorTool<AlignClipInput> = {
  name: "align_clip",
  description:
    "Align a layer to the frame: `to` = left · hcenter · right · top · vmiddle · bottom (one axis) or a 9-point anchor (top-left · top-center · top-right · middle-left · center · middle-right · bottom-left · bottom-center · bottom-right). `clip` = a clip id or noun (title · logo · shape · caption · overlay · it). Edge/corner moves keep a 5% title-safe margin unless `margin` is given.",
  inputSchema: z.object({
    clip: z.string().optional(),
    all: z.boolean().optional(),
    to: z.enum(ALIGN_TARGETS),
    relativeTo: z.enum(["canvas", "selection"]).optional(),
    margin: z.number().min(0).max(2000).optional(),
  }) as z.ZodType<AlignClipInput>,
  async execute(input, ctx) {
    const targets = pickTargets(ctx.project.doc, input.clip, input.all);
    if (targets.length === 0) throw new Error("There's nothing to align yet — add a title, shape or overlay first.");
    const doc0 = ctx.project.doc;
    const edge = input.to !== "center" && input.to !== "hcenter" && input.to !== "vmiddle";
    const margin = input.margin ?? (edge ? Math.round(Math.min(doc0.meta.width, doc0.meta.height) * 0.05) : 0);
    const doc = alignClips(doc0, targets.map((t) => t.clipId), input.to as AlignTarget, { relativeTo: input.relativeTo, margin });
    return commit(ctx.project, doc, `Aligned ${targets.length} layer${targets.length === 1 ? "" : "s"} to ${input.to.replace("-", " ")}.`);
  },
};

// ---- arrange_clip ------------------------------------------------------------------

export interface ArrangeClipInput {
  clip?: string;
  mode: ArrangeMode;
}

export const arrangeClipTool: DirectorTool<ArrangeClipInput> = {
  name: "arrange_clip",
  description: "Change a layer's stacking order: `mode` = forward · backward · front · back. `clip` = a clip id or noun (title · logo · shape · caption · overlay · it).",
  inputSchema: z.object({
    clip: z.string().optional(),
    mode: z.enum(["forward", "backward", "front", "back"]),
  }) as z.ZodType<ArrangeClipInput>,
  async execute(input, ctx) {
    const [t] = pickTargets(ctx.project.doc, input.clip, false);
    if (!t) throw new Error("There's nothing to arrange yet — add a title, shape or overlay first.");
    const doc = arrangeClip(ctx.project.doc, t.clipId, input.mode);
    return commit(ctx.project, doc, `Moved the layer ${input.mode === "front" ? "to the front" : input.mode === "back" ? "to the back" : input.mode}.`);
  },
};

// ---- plain-language parser ---------------------------------------------------------

export interface TransformStep {
  tool: DirectorTool<never>;
  input: unknown;
}

const NOUN_RE = String.raw`(?:(?:the|my|this|that|a)\s+)?(title|heading|headline|text|caption|subtitle|logo|watermark|image|photo|picture|overlay|pip|sticker|badge|icon|shape|box|rectangle|circle|arrow|line|it|this|that)`;
// Size words ("title bigger") belong to style_text, so only non-text nouns are scaled here.
const SCALE_NOUN_RE = String.raw`(?:(?:the|my|this|that|a)\s+)?(logo|watermark|image|photo|picture|overlay|pip|sticker|badge|icon|shape|box|rectangle|circle|arrow|line|it|this|that)`;

function nounOf(raw: string | undefined): TransformNoun {
  const w = (raw ?? "it").toLowerCase();
  if (/^(title|heading|headline|text|subtitle)$/.test(w)) return "title";
  if (w === "caption") return "caption";
  if (/^(logo|watermark|image|photo|picture|pip|icon)$/.test(w)) return "logo";
  if (/^(shape|box|rectangle|circle|arrow|line)$/.test(w)) return "shape";
  if (/^(overlay|sticker|badge)$/.test(w)) return "overlay";
  return "it";
}

const POS_RE = String.raw`(top|upper|bottom|lower|middle|center|centre|left|right)(?:[\s-]+(left|right|center|centre|middle|top|bottom))?`;

function positionOf(a: string, b?: string): string | null {
  const norm = (w: string): string => (w === "upper" ? "top" : w === "lower" ? "bottom" : w === "centre" ? "center" : w);
  const x = norm(a);
  const y = b ? norm(b) : undefined;
  const set = new Set([x, y].filter(Boolean) as string[]);
  const v = set.has("top") ? "top" : set.has("bottom") ? "bottom" : set.has("middle") || set.has("center") ? "middle" : null;
  const h = set.has("left") ? "left" : set.has("right") ? "right" : null;
  if (v && h) return v === "middle" ? `middle-${h}` : `${v}-${h}`;
  if (v === "top" || v === "bottom") {
    // "top center" / "top" alone → only the vertical axis.
    return set.has("center") && set.size > 1 ? `${v}-center` : v;
  }
  if (h) return h;
  if (set.has("middle") || set.has("center")) return "center";
  return null;
}

/**
 * Parse transform phrases out of `req` (already lower-cased). Returns the Director
 * steps and `rest` — the request with the matched phrases removed so no other parser
 * double-reads them.
 */
export function parseTransformRequest(req: string): { steps: TransformStep[]; rest: string } {
  const steps: TransformStep[] = [];
  let rest = req;
  const take = (m: RegExpMatchArray): void => {
    rest = rest.replace(m[0], " ");
  };
  const clipOf = (raw: string | undefined): { clip: TransformNoun } => ({ clip: nounOf(raw) });
  const add = (tool: DirectorTool<never>, input: unknown): void => {
    steps.push({ tool, input });
  };

  // "move/put the title to the top left", "send the logo to the bottom right corner"
  const move = rest.match(new RegExp(String.raw`\b(?:move|put|place|shift|send|position|drag|snap)\s+${NOUN_RE}\s+(?:over\s+)?(?:to|at|into|in|on)\s+(?:the\s+)?${POS_RE}(?:\s+(?:corner|side|edge|of the (?:screen|frame|video)))?`));
  if (move) {
    const pos = positionOf(move[2]!, move[3]);
    if (pos) {
      add(alignClipTool as never, { ...clipOf(move[1]), to: pos === "left" ? "left" : pos === "right" ? "right" : pos });
      take(move);
    }
  }

  // "center it" / "centre the logo" / "center the title horizontally"
  const center = rest.match(new RegExp(String.raw`\bcent(?:er|re)\s+${NOUN_RE}(?:\s+(horizontally|vertically))?(?:\s+(?:on|in)\s+the\s+(?:screen|frame|video))?`));
  if (center) {
    const to = center[2] === "horizontally" ? "hcenter" : center[2] === "vertically" ? "vmiddle" : "center";
    add(alignClipTool as never, { ...clipOf(center[1]), to });
    take(center);
  }

  // "align the title to the left"
  const align = rest.match(new RegExp(String.raw`\balign\s+${NOUN_RE}\s+(?:to|with|on)\s+(?:the\s+)?(left|right|top|bottom|center|centre|middle)`));
  if (align) {
    const w = align[2]!;
    const to = w === "center" || w === "centre" ? "hcenter" : w === "middle" ? "vmiddle" : w;
    add(alignClipTool as never, { ...clipOf(align[1]), to });
    take(align);
  }

  // "make the logo smaller / bigger" (+ "a bit" / "much")
  const size = rest.match(new RegExp(String.raw`\bmake\s+${SCALE_NOUN_RE}\s+(?:a\s+(?:bit|little|touch)\s+|much\s+|way\s+|slightly\s+)?(smaller|bigger|larger)|\b(?:shrink|enlarge|scale up|scale down)\s+${SCALE_NOUN_RE}`));
  if (size) {
    const sm = size[0].match(/smaller|shrink|scale down/) !== null;
    const strong = /much|way/.test(size[0]);
    const mild = /a (?:bit|little|touch)|slightly/.test(size[0]);
    const k = sm ? (strong ? 0.6 : mild ? 0.9 : 0.8) : strong ? 1.6 : mild ? 1.1 : 1.25;
    add(setTransformTool as never, { ...clipOf(size[1] ?? size[3]), scaleBy: k });
    take(size);
  }

  // "scale it to 150%"
  const scaleTo = rest.match(new RegExp(String.raw`\b(?:scale|resize)\s+${SCALE_NOUN_RE}\s+(?:to|by)\s+(\d{2,4})\s*%`));
  if (scaleTo) {
    add(setTransformTool as never, { ...clipOf(scaleTo[1]), scale: Number(scaleTo[2]) / 100 });
    take(scaleTo);
  }

  // "rotate 15 degrees", "rotate the logo 45° left", "tilt it 10 degrees"
  const rot = rest.match(new RegExp(String.raw`\b(?:rotate|tilt|turn|spin)\s+(?:${NOUN_RE}\s+)?(?:by\s+|to\s+)?(-?\d+(?:\.\d+)?)\s*(?:°|degrees?|deg)\s*(counter[\s-]?clockwise|anti[\s-]?clockwise|clockwise|left|right)?`));
  if (rot) {
    const ccw = /counter|anti|left/.test(rot[3] ?? "");
    const deg = Number(rot[2]) * (ccw ? -1 : 1);
    const absolute = /\bto\s+-?\d/.test(rot[0]);
    add(setTransformTool as never, { ...clipOf(rot[1]), ...(absolute ? { rotation: deg } : { rotateBy: deg }) });
    take(rot);
  }

  // "flip the logo horizontally", "mirror it"
  const flip = rest.match(new RegExp(String.raw`\b(?:flip|mirror)\s+${NOUN_RE}(?:\s+(horizontally|vertically|upside down))?`));
  if (flip) {
    const v = flip[2] === "vertically" || flip[2] === "upside down";
    add(setTransformTool as never, { ...clipOf(flip[1]), ...(v ? { flipY: "toggle" } : { flipX: "toggle" }) });
    take(flip);
  }

  // "move it up / down / left / right (a bit | by 100px)"
  const nudge = rest.match(new RegExp(String.raw`\b(?:move|nudge|shift)\s+${NOUN_RE}\s+(up|down|left|right)(?:\s+(?:a\s+(?:bit|little)|slightly|by\s+(\d+)\s*(?:px|pixels?)?|(\d+)\s*(?:px|pixels?)))?`));
  if (nudge) {
    const px = nudge[3] ?? nudge[4];
    const frac = /a (?:bit|little)|slightly/.test(nudge[0]) ? 0.03 : 0.08;
    const dir = nudge[2]!;
    const sgn = dir === "up" || dir === "left" ? -1 : 1;
    const input: SetTransformInput & { clip: TransformNoun } = { ...clipOf(nudge[1]) };
    if (dir === "left" || dir === "right") {
      if (px) input.dx = sgn * Number(px);
      else input.dxFrac = sgn * frac;
    } else if (px) input.dy = sgn * Number(px);
    else input.dyFrac = sgn * frac;
    add(setTransformTool as never, input);
    take(nudge);
  }

  // "make it 50% transparent", "set the logo opacity to 60%"
  const opa = rest.match(new RegExp(String.raw`\bmake\s+${NOUN_RE}\s+(\d{1,3})\s*%\s*(transparent|opaque)|\b(?:set\s+)?${NOUN_RE}\s+opacity\s+(?:to\s+)?(\d{1,3})\s*%`));
  if (opa) {
    const pct = Number(opa[2] ?? opa[5]);
    const opacity = opa[3] === "transparent" ? 1 - pct / 100 : pct / 100;
    add(setTransformTool as never, { ...clipOf(opa[1] ?? opa[4]), opacity: round2(Math.max(0, Math.min(1, opacity))) });
    take(opa);
  }

  // Stacking order.
  const front = rest.match(new RegExp(String.raw`\b(?:bring|send|move)\s+${NOUN_RE}\s+(?:to\s+(?:the\s+)?(front|back)|(forward|backward|backwards))\b`));
  if (front) {
    const mode = front[2] ?? (front[3] === "forward" ? "forward" : "backward");
    add(arrangeClipTool as never, { ...clipOf(front[1]), mode });
    take(front);
  }

  // "fit the logo to the screen" / "fill the frame with it" / "reset the logo"
  const fit = rest.match(new RegExp(String.raw`\b(fit|fill)\s+${SCALE_NOUN_RE}\s+(?:to|in|into|on)\s+the\s+(?:screen|frame|video|canvas)`));
  if (fit) {
    add(setTransformTool as never, { ...clipOf(fit[2]), fit: fit[1] });
    take(fit);
  }
  const reset = rest.match(new RegExp(String.raw`\breset\s+(?:the\s+)?(?:position|transform)\s+(?:of\s+)?${NOUN_RE}|\breset\s+${NOUN_RE}\s+(?:position|transform)`));
  if (reset) {
    add(setTransformTool as never, { ...clipOf(reset[1] ?? reset[2]), reset: true });
    take(reset);
  }

  return { steps, rest };
}
