/**
 * THE shared 2D drawing code for every SYNTHETIC layer — text, solids, shapes,
 * callouts, cursors, and the whole-frame VFX finishing pass.
 *
 * WHY here: the browser preview (Stage `<canvas>`), the headless Node renderer
 * (@napi-rs/canvas / Skia), and the ffmpeg export (which rasterizes through the
 * Node renderer) must draw text and graphics IDENTICALLY. Keeping one copy of the
 * drawing code — written against a minimal STRUCTURAL 2D context that both the DOM
 * `CanvasRenderingContext2D` and Skia's `SKRSContext2D` satisfy — makes "what you
 * see is what exports" true by construction instead of by three hand-kept mirrors.
 *
 * Every function is pure given its inputs: the frame time `t` is passed explicitly
 * (no module state), and nothing here touches the DOM, the filesystem, or a
 * specific canvas implementation. Media (video/image) drawing stays with each
 * renderer, since decoding pixels is environment-specific.
 */
import {
  calloutScreenRect,
  clipProgress,
  cursorPositionAt,
  cursorRipples,
  fontWeightToCss,
  transitionMotion,
  transitionOpacity,
  transitionSpec,
  typewriterText,
  valueAt,
  type TransitionSpec,
} from "./grade";
import {
  LEGACY_SHAPES,
  arrowHead,
  counterText,
  isStrokeShape,
  pointAlong,
  polylineLength,
  shapeAnimState,
  shapeOutline,
  shapeProgressLevel,
  type Polyline,
  type ShapeMotionState,
} from "./shape-anim";
import {
  IDENTITY_UNIT_STATE,
  exitProgress,
  introProgress,
  scrambleText,
  textUnitState,
} from "./text-anim";
import { TextClip as TextClipSchema } from "./schema";
import type {
  BackgroundGradient,
  BackgroundPattern,
  CalloutClip,
  CaptionWord,
  CursorClip,
  ImageClip,
  ShapeClip,
  ShapePart,
  SolidClip,
  TextClip,
  TextFillGradient,
  VideoClip,
  Vfx,
} from "./schema";

// ---- the structural 2D context ---------------------------------------------

/** A canvas gradient: the only method the drawing code needs. */
export interface Gradient2D {
  addColorStop(offset: number, color: string): void;
}

/**
 * The minimal 2D-context surface the shared drawing code uses. Property types are
 * deliberately WIDE (string / unknown) so both the DOM `CanvasRenderingContext2D`
 * and Skia's `SKRSContext2D` are structurally assignable to it — each renderer
 * passes its own context straight in, no adapter.
 */
export interface Ctx2D {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    ccw?: boolean,
  ): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, radii?: number): void;
  fill(): void;
  stroke(): void;
  clip(fillRule?: "nonzero" | "evenodd"): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient2D;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient2D;
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  miterLimit: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  filter: string;
}

const degToRad = (deg: number): number => (deg * Math.PI) / 180;

// ---- keyframed transform ---------------------------------------------------

/**
 * Resolve a visual clip's keyframed transform at `t` via the shared PURE `valueAt`
 * helper. Each field falls back to the clip's static transform value when it has
 * no keyframe for that prop, so this is always safe to call. `opacityMul` is the
 * keyframed opacity as a MULTIPLIER on the base opacity, so it composes with the
 * transition ramps.
 */
export function keyframeTransformState(
  clip: VideoClip | ImageClip | TextClip | SolidClip | ShapeClip,
  t: number,
): { x: number; y: number; scale: number; rotation: number; opacityMul: number } {
  const kf = clip.keyframes;
  const prog = clipProgress(clip, t);
  const base = clip.transform.opacity || 1;
  return {
    x: valueAt(kf, "x", prog, clip.transform.x),
    y: valueAt(kf, "y", prog, clip.transform.y),
    scale: valueAt(kf, "scale", prog, clip.transform.scale),
    rotation: valueAt(kf, "rotation", prog, clip.transform.rotation),
    opacityMul: valueAt(kf, "opacity", prog, clip.transform.opacity) / base,
  };
}

// ---- text layout -----------------------------------------------------------

/**
 * Word-wrap `text` into lines no wider than `maxWidth` (composition px), by whole
 * words. Deterministic; measured with the ctx's current font. A word longer than
 * `maxWidth` is left on its own line (never broken mid-word). Explicit newlines
 * always break. Returns [text] when there is nothing to wrap.
 */
export function wrapText(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push(para);
      continue;
    }
    let cur = words[0]!;
    for (let i = 1; i < words.length; i++) {
      const test = `${cur} ${words[i]}`;
      if (ctx.measureText(test).width <= maxWidth) cur = test;
      else {
        out.push(cur);
        cur = words[i]!;
      }
    }
    out.push(cur);
  }
  return out.length > 0 ? out : [text];
}

/** Width of one line accounting for extra letter spacing (0 = native measure). */
export function lineWidth(ctx: Ctx2D, line: string, letterSpacing: number): number {
  if (letterSpacing === 0) return ctx.measureText(line).width;
  const chars = [...line];
  let w = 0;
  for (const ch of chars) w += ctx.measureText(ch).width;
  return w + letterSpacing * Math.max(0, chars.length - 1);
}

/**
 * Draw a stack of text lines (fill or stroke) centered vertically about y=0, with
 * optional per-character letter spacing. With `letterSpacing === 0` this is a plain
 * fillText/strokeText per line (byte-identical to the historical single-line path),
 * so the default caption look is unchanged; with spacing it lays each glyph out by
 * hand (honoring alignment) since the 2D context has no reliable tracking control.
 */
function drawTextLines(
  ctx: Ctx2D,
  lines: string[],
  lineStep: number,
  letterSpacing: number,
  mode: "fill" | "stroke",
  align: "left" | "center" | "right",
): void {
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    const y = (i - (n - 1) / 2) * lineStep;
    if (letterSpacing === 0) {
      if (mode === "fill") ctx.fillText(line, 0, y);
      else ctx.strokeText(line, 0, y);
      continue;
    }
    const chars = [...line];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + letterSpacing * Math.max(0, chars.length - 1);
    let x = align === "center" ? -total / 2 : align === "right" ? -total : 0;
    const prevAlign = ctx.textAlign;
    ctx.textAlign = "left";
    for (let k = 0; k < chars.length; k++) {
      if (mode === "fill") ctx.fillText(chars[k]!, x, y);
      else ctx.strokeText(chars[k]!, x, y);
      x += widths[k]! + letterSpacing;
    }
    ctx.textAlign = prevAlign;
  }
}

/** One laid-out karaoke token: the display text plus its index into `clip.words`. */
interface KaraokeToken {
  text: string;
  word: number;
}

/**
 * Wrap karaoke `words` into lines of tokens no wider than `maxWidth` (composition
 * px), by whole words, tracking each token's index into the original word list so
 * the active word can be highlighted. `space` is the measured inter-word advance
 * (space glyph + letter spacing). With no `maxWidth`, everything stays on one line.
 */
function wrapKaraokeTokens(
  ctx: Ctx2D,
  words: string[],
  space: number,
  maxWidth: number | undefined,
): KaraokeToken[][] {
  const tokens: KaraokeToken[] = words.map((text, word) => ({ text, word }));
  if (!maxWidth || tokens.length === 0) return [tokens];
  const lines: KaraokeToken[][] = [];
  let cur: KaraokeToken[] = [tokens[0]!];
  let curW = ctx.measureText(tokens[0]!.text).width;
  for (let i = 1; i < tokens.length; i++) {
    const w = ctx.measureText(tokens[i]!.text).width;
    if (curW + space + w <= maxWidth) {
      cur.push(tokens[i]!);
      curW += space + w;
    } else {
      lines.push(cur);
      cur = [tokens[i]!];
      curW = w;
    }
  }
  lines.push(cur);
  return lines;
}

/**
 * Draw karaoke caption lines: each word laid out left-to-right (alignment honored),
 * with the word active at time `t` highlighted per `clip.karaoke.style` — "color"
 * recolors it, "fill" draws a highlight pill behind it (dark ink on top), "box"
 * strokes a highlight outline around it. Already-spoken words draw in the base color
 * at full opacity; upcoming words are drawn slightly dimmer.
 */
function drawKaraokeLines(
  ctx: Ctx2D,
  lines: KaraokeToken[][],
  lineStep: number,
  clip: TextClip,
  words: CaptionWord[],
  t: number,
  op: number,
): void {
  const ls = clip.letterSpacing ?? 0;
  const space = ctx.measureText(" ").width + ls;
  const base = clip.color;
  const hi = clip.karaoke?.highlight ?? "#ffd54a";
  const style = clip.karaoke?.style ?? "color";
  const shadow = clip.shadow;
  const padX = clip.fontSize * 0.18;
  const padY = clip.fontSize * 0.14;
  const boxH = clip.fontSize + padY * 2;
  const radius = boxH * 0.28;

  const setShadow = (on: boolean): void => {
    if (on && shadow) {
      ctx.shadowColor = shadow.color;
      ctx.shadowBlur = shadow.blur;
      ctx.shadowOffsetX = shadow.offsetX;
      ctx.shadowOffsetY = shadow.offsetY;
    } else {
      ctx.shadowColor = "rgba(0,0,0,0)";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
  };

  const n = lines.length;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    const y = (i - (n - 1) / 2) * lineStep;
    const widths = line.map((tok) => ctx.measureText(tok.text).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, line.length - 1);
    let x = clip.align === "center" ? -total / 2 : clip.align === "right" ? -total : 0;
    for (let k = 0; k < line.length; k++) {
      const tok = line[k]!;
      const w = widths[k]!;
      const word = words[tok.word];
      const active = !!word && t >= word.start && t < word.end;
      const spoken = !!word && t >= word.end;
      const alpha = active || spoken ? op : op * 0.72;

      if (active && style === "fill") {
        setShadow(false);
        ctx.globalAlpha = op;
        ctx.fillStyle = hi;
        ctx.beginPath();
        ctx.roundRect(x - padX, y - boxH / 2, w + padX * 2, boxH, radius);
        ctx.fill();
        setShadow(true);
        ctx.globalAlpha = op;
        ctx.fillStyle = "#0a0d12";
        ctx.fillText(tok.text, x, y);
      } else if (active && style === "box") {
        setShadow(false);
        ctx.globalAlpha = op;
        ctx.strokeStyle = hi;
        ctx.lineWidth = Math.max(2, clip.fontSize * 0.05);
        ctx.beginPath();
        ctx.roundRect(x - padX, y - boxH / 2, w + padX * 2, boxH, radius);
        ctx.stroke();
        setShadow(true);
        ctx.globalAlpha = op;
        ctx.fillStyle = hi;
        ctx.fillText(tok.text, x, y);
      } else {
        setShadow(true);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = active ? hi : base;
        ctx.fillText(tok.text, x, y);
      }
      x += w + space;
    }
  }
  ctx.globalAlpha = op;
  setShadow(false);
  ctx.textAlign = prevAlign;
}

// ---- text ------------------------------------------------------------------

/** Options for drawing into a canvas whose backing pixels ≠ composition pixels. */
export interface DrawOpts {
  /**
   * Device pixels per composition pixel (1 for the node/export renderer). Canvas
   * `shadowBlur`, shadow offsets, and `filter: blur()` are NOT scaled by the
   * current transform, so a preview canvas drawn under a scale transform passes
   * its scale here to keep blurs/shadows proportional (preview == export).
   */
  pxScale?: number;
}

/** The CSS/canvas `font` shorthand for a text clip (weight + optional italic). */
export function textFont(clip: TextClip): string {
  const style = clip.italic ? "italic " : "";
  return `${style}${fontWeightToCss(clip.fontWeight)} ${clip.fontSize}px ${clip.fontFamily}`;
}

/** `#RRGGBB[AA]` → `rgba(r,g,b,a)` with the alpha multiplied by `mul`. */
export function hexToRgba(hex: string, mul = 1): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const a = h.length >= 8 ? (parseInt(h.slice(6, 8), 16) || 0) / 255 : 1;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a * mul)).toFixed(3)})`;
}

/** Linear mix of two `#RRGGBB` colors (t = 0 → a, 1 → b), as `#RRGGBB`. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = a.replace("#", "");
  const pb = b.replace("#", "");
  const ch = (s: string, i: number): number => parseInt(s.slice(i, i + 2), 16) || 0;
  const out = [0, 2, 4].map((i) => Math.round(ch(pa, i) + (ch(pb, i) - ch(pa, i)) * t));
  return `#${out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

/** One positioned run of text (a line in whole mode, or one animation unit). */
interface TextRun {
  text: string;
  x: number;
  y: number;
  align: "left" | "center" | "right";
}

/** Draw one run (fill or stroke), laying glyphs out by hand when letter-spaced. */
function drawRun(ctx: Ctx2D, run: TextRun, ls: number, mode: "fill" | "stroke"): void {
  if (ls === 0) {
    ctx.textAlign = run.align;
    if (mode === "fill") ctx.fillText(run.text, run.x, run.y);
    else ctx.strokeText(run.text, run.x, run.y);
    return;
  }
  const chars = [...run.text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + ls * Math.max(0, chars.length - 1);
  let x = run.align === "center" ? run.x - total / 2 : run.align === "right" ? run.x - total : run.x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  for (let k = 0; k < chars.length; k++) {
    if (mode === "fill") ctx.fillText(chars[k]!, x, run.y);
    else ctx.strokeText(chars[k]!, x, run.y);
    x += widths[k]! + ls;
  }
  ctx.textAlign = prevAlign;
}

/** The text block's bounding box in block-local coordinates (centered on y=0). */
interface BlockBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Left edge of a line of width `w` for an alignment anchored at x=0. */
const alignLeft = (align: "left" | "center" | "right", w: number): number =>
  align === "center" ? -w / 2 : align === "right" ? -w : 0;

/** A gradient fill spanning `block`, expressed relative to `origin` (the current translate). */
function textGradient(
  ctx: Ctx2D,
  grad: TextFillGradient,
  block: BlockBox,
  origin: { x: number; y: number },
): Gradient2D {
  const th = degToRad(grad.angle);
  const cx = block.x + block.w / 2 - origin.x;
  const cy = block.y + block.h / 2 - origin.y;
  const half = (Math.abs(block.w * Math.cos(th)) + Math.abs(block.h * Math.sin(th))) / 2 || 1;
  const g = ctx.createLinearGradient(
    cx - Math.cos(th) * half,
    cy - Math.sin(th) * half,
    cx + Math.cos(th) * half,
    cy + Math.sin(th) * half,
  );
  const n = grad.stops.length;
  grad.stops.forEach((c, i) => g.addColorStop(n === 1 ? 0 : i / (n - 1), c));
  return g;
}

interface PaintFx {
  block: BlockBox;
  gradOrigin: { x: number; y: number };
  /** 0..1 animation-driven RGB split (glitch intro). */
  glitch: number;
  px: number;
}

/**
 * Paint a set of runs with the clip's full look: effect copies (echo / splice /
 * glitch) behind, the outline, then the fill (solid or gradient) with its shadow,
 * lift, or neon glow — or a hollow stroke. With no effect/gradient this issues the
 * exact historical sequence (outline → shadow → fill).
 */
function paintRuns(ctx: Ctx2D, clip: TextClip, runs: TextRun[], ls: number, fx: PaintFx): void {
  const fs = clip.fontSize;
  const eff = clip.effect && clip.effect.style !== "none" ? clip.effect : null;
  const drawAll = (mode: "fill" | "stroke", dx = 0, dy = 0): void => {
    for (const r of runs) drawRun(ctx, dx || dy ? { ...r, x: r.x + dx, y: r.y + dy } : r, ls, mode);
  };
  const baseAlpha = ctx.globalAlpha;
  const dir = degToRad(eff?.direction ?? -45);
  const dist = fs * 0.14 * (eff?.offset ?? 0.5);
  const ox = Math.cos(dir) * dist;
  const oy = -Math.sin(dir) * dist;

  // ---- copies behind the text ----
  if (eff?.style === "echo") {
    const col = eff.color ?? clip.color;
    const k = [0.5, 0.3, 0.15];
    const strength = Math.min(1, 0.4 + eff.intensity * 1.2);
    for (let i = 3; i >= 1; i--) {
      ctx.globalAlpha = baseAlpha * k[i - 1]! * strength;
      ctx.fillStyle = col;
      drawAll("fill", ox * i, oy * i);
    }
    ctx.globalAlpha = baseAlpha;
  }
  if (eff?.style === "splice") {
    ctx.fillStyle = eff.color ?? "#00d1ff";
    drawAll("fill", ox, oy);
  }
  const effGlitch = eff?.style === "glitch" ? fs * 0.06 * (0.4 + eff.offset * 1.2) * (0.5 + eff.intensity) : 0;
  const animGlitch = fx.glitch > 0 ? fs * 0.12 * fx.glitch : 0;
  const gd = effGlitch + animGlitch;
  if (gd > 0) {
    ctx.globalAlpha = baseAlpha * 0.85;
    ctx.fillStyle = "#00e5ff";
    drawAll("fill", -gd, 0);
    ctx.fillStyle = "#ff2bd6";
    drawAll("fill", gd, 0);
    ctx.globalAlpha = baseAlpha;
  }

  // ---- outline (under the fill) ----
  if (clip.outline && clip.outline.width > 0) {
    ctx.lineWidth = clip.outline.width * 2; // half sits under the fill → visible width
    ctx.strokeStyle = clip.outline.color;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    drawAll("stroke");
  }

  const fill: unknown = clip.fillGradient ? textGradient(ctx, clip.fillGradient, fx.block, fx.gradOrigin) : clip.color;

  // ---- hollow / splice: stroke only ----
  if (eff && (eff.style === "hollow" || eff.style === "splice")) {
    ctx.lineWidth = Math.max(1, fs * (0.03 + 0.05 * eff.intensity));
    ctx.strokeStyle = fill;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    drawAll("stroke");
    return;
  }

  // ---- neon: colored glow + bright core ----
  if (eff?.style === "neon") {
    const glow = eff.color ?? clip.color;
    ctx.shadowColor = glow;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = glow;
    ctx.shadowBlur = fs * (0.2 + 0.5 * eff.intensity) * fx.px;
    drawAll("fill");
    ctx.shadowBlur = fs * (0.08 + 0.2 * eff.intensity) * fx.px;
    drawAll("fill");
    ctx.fillStyle = clip.fillGradient ? fill : mixHex(clip.color.slice(0, 7), "#ffffff", 0.65);
    ctx.shadowBlur = fs * 0.05 * fx.px;
    drawAll("fill");
    return;
  }

  // ---- shadow / lift, then the fill ----
  if (eff?.style === "lift") {
    ctx.shadowColor = `rgba(0,0,0,${(0.25 + 0.5 * eff.intensity).toFixed(3)})`;
    ctx.shadowBlur = fs * (0.15 + 0.35 * eff.intensity) * fx.px;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = fs * 0.08 * fx.px;
  } else if (clip.shadow) {
    ctx.shadowColor = clip.shadow.color;
    ctx.shadowBlur = clip.shadow.blur * fx.px;
    ctx.shadowOffsetX = clip.shadow.offsetX * fx.px;
    ctx.shadowOffsetY = clip.shadow.offsetY * fx.px;
  }
  ctx.fillStyle = fill;
  drawAll("fill");
}

/** A laid-out animation unit: its text and resting center/width in block space. */
interface UnitBox {
  text: string;
  cx: number;
  cy: number;
  w: number;
}

/** Split `lines` into positioned animation units (line / word / letter). */
function layoutUnits(
  ctx: Ctx2D,
  lines: string[],
  unit: "line" | "word" | "letter",
  lineStep: number,
  ls: number,
  align: "left" | "center" | "right",
): UnitBox[] {
  const out: UnitBox[] = [];
  const n = lines.length;
  lines.forEach((line, li) => {
    const cy = (li - (n - 1) / 2) * lineStep;
    if (unit === "line") {
      const w = lineWidth(ctx, line, ls);
      if (line.trim()) out.push({ text: line, cx: alignLeft(align, w) + w / 2, cy, w });
      return;
    }
    if (unit === "word") {
      const words = line.split(" ").filter((w) => w.length > 0);
      const space = ctx.measureText(" ").width + ls;
      const widths = words.map((w) => lineWidth(ctx, w, ls));
      const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, words.length - 1);
      let x = alignLeft(align, total);
      words.forEach((w, i) => {
        out.push({ text: w, cx: x + widths[i]! / 2, cy, w: widths[i]! });
        x += widths[i]! + space;
      });
      return;
    }
    const chars = [...line];
    const adv = chars.map((c) => ctx.measureText(c).width);
    const total = adv.reduce((a, b) => a + b, 0) + ls * Math.max(0, chars.length - 1);
    let x = alignLeft(align, total);
    chars.forEach((c, i) => {
      if (!/\s/.test(c)) out.push({ text: c, cx: x + adv[i]! / 2, cy, w: adv[i]! });
      x += adv[i]! + ls;
    });
  });
  return out;
}

/** Block-level (panel / highlight) opacity while per-unit text animates in/out. */
function blockAlpha(clip: TextClip, t: number): number {
  const a = clip.anim;
  let v = 1;
  const moveOnly = a.style === "none" || a.style === "kinetic" || a.style === "pop" || a.style === "bounce";
  if (!moveOnly && a.durationSec > 0) v *= Math.min(1, introProgress(clip, t, 0, 1) * 1.6);
  if (a.exit.style !== "none") v *= 1 - exitProgress(clip, t, 0, 1);
  return v;
}

/** Draw the background panel (pill / box) and the per-line highlight effect. */
function paintPanels(
  ctx: Ctx2D,
  clip: TextClip,
  lines: string[],
  lineStep: number,
  ls: number,
  op: number,
): void {
  const boxStyle = clip.box?.style ?? (clip.background ? "pill" : "none");
  if (boxStyle !== "none") {
    const padX = clip.box?.padX ?? clip.fontSize * 0.4;
    const padY = clip.box?.padY ?? clip.fontSize * 0.28;
    const nFull = lines.length;
    const widest = lines.reduce((m, l) => Math.max(m, lineWidth(ctx, l, ls)), 0);
    const w = widest + padX * 2;
    const h = (nFull - 1) * lineStep + clip.fontSize + padY * 2;
    const bx = clip.align === "center" ? -w / 2 : clip.align === "right" ? -w + padX : -padX;
    const radius = clip.box?.radius ?? (boxStyle === "pill" ? h * 0.28 : 0);
    const fill = clip.box?.color ?? clip.background ?? "#0a0d12cc";
    const boxOpacity = clip.box?.opacity ?? 1;
    ctx.save();
    if (boxOpacity !== 1) ctx.globalAlpha = op * boxOpacity;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(bx, -h / 2, w, h, radius);
    ctx.fill();
    ctx.restore();
  }
  const eff = clip.effect;
  if (eff?.style === "highlight") {
    const fs = clip.fontSize;
    const n = lines.length;
    ctx.save();
    ctx.globalAlpha = op * (0.45 + 0.55 * eff.intensity);
    ctx.fillStyle = eff.color ?? "#ffd54a";
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const lw = lineWidth(ctx, line, ls);
      const y = (i - (n - 1) / 2) * lineStep;
      const h = fs * 1.08;
      ctx.beginPath();
      ctx.roundRect(alignLeft(clip.align, lw) - fs * 0.2, y - h / 2 + fs * 0.03, lw + fs * 0.4, h, h * 0.5 * eff.offset);
      ctx.fill();
    });
    ctx.restore();
  }
}

/**
 * Draw a text / caption / title clip at time `t`: keyframed transform, transition
 * opacity, the intro / loop / exit animation (whole block or staggered per line,
 * word, or letter — see text-anim.ts), typewriter and scramble reveals, word-wrap
 * (and explicit newlines), letter spacing, background panel, highlight, outline,
 * shadow, text effects, gradient fill, and karaoke highlighting.
 */
export function drawText(ctx: Ctx2D, clip: TextClip, t: number, opts: DrawOpts = {}): void {
  // A live counter (countdown / timer / count-up) draws its value at this frame.
  if (clip.counter) clip = { ...clip, text: counterText(clip, t) };
  const px = opts.pxScale ?? 1;
  // Keyframes (if any) override the static transform; opacity keyframes multiply
  // the transition ramp — all resolved by the shared PURE valueAt helper.
  const kfs = keyframeTransformState(clip, t);
  const op = transitionOpacity(clip, t) * kfs.opacityMul;
  if (op <= 0) return;
  const a = clip.anim;
  const perUnit = a.unit !== "whole";
  const whole = perUnit ? IDENTITY_UNIT_STATE : textUnitState(clip, t, 0, 1);
  if (!whole.visible || whole.opacity <= 0) return;

  ctx.save();
  // Block transform. For the legacy styles this is exactly the historical
  // translate(x+dx, y+dy) · rotate(kf) · scale(kf·kinetic) sequence.
  const combine = whole.rotation === 0 && !whole.baselineMask;
  ctx.translate(kfs.x + (whole.baselineMask ? 0 : whole.dx), kfs.y + (whole.baselineMask ? 0 : whole.dy));
  if (kfs.rotation !== 0) ctx.rotate(degToRad(kfs.rotation));
  if (combine) {
    const sx = kfs.scale * whole.scaleX;
    const sy = kfs.scale * whole.scaleY;
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
  } else if (kfs.scale !== 1) {
    ctx.scale(kfs.scale, kfs.scale);
  }
  ctx.globalAlpha = op * whole.opacity;
  ctx.font = textFont(clip);
  ctx.textAlign = clip.align;
  ctx.textBaseline = "middle";

  // Typewriter: reveal only the substring visible at this time (whole block).
  const tw = a.style === "typewriter" && !perUnit ? typewriterText(clip, t) : null;
  const rawShown = tw ? tw.text + (tw.caretVisible ? "|" : "") : clip.text;
  const upper = (s: string): string => (clip.uppercase ? s.toUpperCase() : s);
  const shownText = whole.scramble > 0 ? scrambleText(upper(rawShown), whole.scramble, t) : upper(rawShown);
  // Size the panel to the FULL text so it doesn't grow while typing.
  const fullText = upper(tw ? clip.text : rawShown);

  const ls = clip.letterSpacing ?? 0;
  const lineStep = clip.fontSize * (clip.lineHeight ?? 1.2);
  const split = (s: string): string[] => (clip.maxWidth ? wrapText(ctx, s, clip.maxWidth) : s.split("\n"));

  const karaokeOn = !!(clip.karaoke?.enabled && clip.words && clip.words.length > 0);
  const karaokeWords = karaokeOn ? clip.words! : [];
  const karaokeSpace = ctx.measureText(" ").width + ls;
  const karaokeLines = karaokeOn
    ? wrapKaraokeTokens(ctx, karaokeWords.map((w) => upper(w.text)), karaokeSpace, clip.maxWidth)
    : [];
  const shownLines = karaokeOn ? karaokeLines.map((l) => l.map((tk) => tk.text).join(" ")) : split(shownText);
  const fullLines = karaokeOn ? shownLines : split(fullText);

  const nFull = fullLines.length;
  const widest = fullLines.reduce((m, l) => Math.max(m, lineWidth(ctx, l, ls)), 0);
  const blockH = (nFull - 1) * lineStep + clip.fontSize;
  const block: BlockBox = { x: alignLeft(clip.align, widest), y: -blockH / 2, w: widest, h: blockH };

  // ---------------- per-unit (line / word / letter) animation ----------------
  if (perUnit && !karaokeOn) {
    const unit = a.unit as "line" | "word" | "letter";
    paintPanels(ctx, clip, fullLines, lineStep, ls, op * blockAlpha(clip, t));
    const units = layoutUnits(ctx, fullLines, unit, lineStep, ls, clip.align);
    const n = units.length;
    for (let i = 0; i < n; i++) {
      const u = units[i]!;
      const s = textUnitState(clip, t, i, n);
      if (!s.visible || s.opacity <= 0) continue;
      ctx.save();
      ctx.translate(u.cx, u.cy);
      if (s.baselineMask) {
        ctx.beginPath();
        ctx.rect(-u.w / 2 - clip.fontSize * 0.25, -lineStep / 2, u.w + clip.fontSize * 0.5, lineStep);
        ctx.clip();
      }
      ctx.translate(s.dx, s.dy);
      if (s.rotation !== 0) ctx.rotate(degToRad(s.rotation));
      if (s.scaleX !== 1 || s.scaleY !== 1) ctx.scale(s.scaleX, s.scaleY);
      if (s.revealFrom > 0 || s.revealTo < 1) {
        ctx.beginPath();
        ctx.rect(-u.w / 2 + s.revealFrom * u.w, -lineStep, Math.max(0, s.revealTo - s.revealFrom) * u.w, lineStep * 2);
        ctx.clip();
      }
      ctx.globalAlpha = op * s.opacity;
      if (s.blur > 0) ctx.filter = `blur(${(s.blur * px).toFixed(2)}px)`;
      const text = s.scramble > 0 ? scrambleText(u.text, s.scramble, t, i) : u.text;
      paintRuns(ctx, clip, [{ text, x: -u.w / 2, y: 0, align: "left" }], ls, {
        block,
        gradOrigin: { x: u.cx, y: u.cy },
        glitch: s.glitch,
        px,
      });
      ctx.restore();
    }
    ctx.restore();
    return;
  }

  // ---------------- whole-block animation ----------------
  if (!combine) {
    if (whole.baselineMask) {
      // Rise from behind the resting line box: clip first, then move the text.
      ctx.beginPath();
      ctx.rect(block.x - clip.fontSize * 0.3, block.y - lineStep * 0.1, block.w + clip.fontSize * 0.6, block.h + lineStep * 0.2);
      ctx.clip();
      ctx.translate(whole.dx, whole.dy);
    }
    if (whole.rotation !== 0) ctx.rotate(degToRad(whole.rotation));
    if (whole.scaleX !== 1 || whole.scaleY !== 1) ctx.scale(whole.scaleX, whole.scaleY);
  }
  if (whole.revealFrom > 0 || whole.revealTo < 1) {
    const pad = clip.fontSize * 0.3;
    ctx.beginPath();
    ctx.rect(
      block.x - pad + whole.revealFrom * (block.w + pad * 2),
      block.y - lineStep,
      Math.max(0, whole.revealTo - whole.revealFrom) * (block.w + pad * 2),
      block.h + lineStep * 2,
    );
    ctx.clip();
  }
  if (whole.blur > 0) ctx.filter = `blur(${(whole.blur * px).toFixed(2)}px)`;

  paintPanels(ctx, clip, fullLines, lineStep, ls, op * whole.opacity);

  if (karaokeOn) {
    // Karaoke fill: draw each word, highlighting the one active at this frame time
    // (per-word PNGs mirror this on export). Handles its own shadow.
    if (clip.outline && clip.outline.width > 0) {
      ctx.lineWidth = clip.outline.width * 2;
      ctx.strokeStyle = clip.outline.color;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      drawTextLines(ctx, shownLines, lineStep, ls, "stroke", clip.align);
    }
    drawKaraokeLines(ctx, karaokeLines, lineStep, clip, karaokeWords, t, op);
    ctx.restore();
    return;
  }

  const n = shownLines.length;
  const runs: TextRun[] = shownLines.map((line, i) => ({
    text: line,
    x: 0,
    y: (i - (n - 1) / 2) * lineStep,
    align: clip.align,
  }));
  paintRuns(ctx, clip, runs, ls, { block, gradOrigin: { x: 0, y: 0 }, glitch: whole.glitch, px });
  ctx.restore();
}

// ---- cursor / callout ------------------------------------------------------

/**
 * An arrow mouse-pointer at the interpolated cursor position, plus an expanding
 * ring for each active click (shared core helpers cursorPositionAt / cursorRipples).
 * The arrow is a small classic pointer polygon whose tip sits at (x, y).
 */
export function drawCursor(ctx: Ctx2D, clip: CursorClip, t: number): void {
  const { x, y } = cursorPositionAt(clip, t);

  const maxR = clip.size * 1.6;
  for (const rip of cursorRipples(clip, t)) {
    ctx.save();
    ctx.globalAlpha = rip.opacity;
    ctx.strokeStyle = clip.color;
    ctx.lineWidth = Math.max(2, clip.size * 0.08);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, rip.radiusFrac * maxR), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const s = clip.size;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, s);
  ctx.lineTo(s * 0.28, s * 0.75);
  ctx.lineTo(s * 0.46, s * 1.1);
  ctx.lineTo(s * 0.6, s * 1.04);
  ctx.lineTo(s * 0.42, s * 0.68);
  ctx.lineTo(s * 0.72, s * 0.68);
  ctx.closePath();
  ctx.fillStyle = clip.color;
  ctx.strokeStyle = "#0a0d12";
  ctx.lineWidth = Math.max(1, s * 0.04);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * A callout / highlight: optionally dim everything OUTSIDE the rect, then a bright
 * rounded border, then an optional label. Drawn in SCREEN coordinates using the
 * shared calloutScreenRect (which already accounts for any zoom, applied to the
 * content by the caller). Faithful: an overlay, no content change.
 */
export function drawCallout(ctx: Ctx2D, clip: CalloutClip, frameW: number, frameH: number): void {
  const r = calloutScreenRect(clip);

  if (clip.dim && clip.dimOpacity > 0) {
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.95, clip.dimOpacity).toFixed(3)})`;
    ctx.fillRect(0, 0, frameW, frameH);
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, clip.radius);
    ctx.fill();
    ctx.restore();
  }

  if (clip.borderWidth > 0) {
    ctx.save();
    ctx.strokeStyle = clip.color;
    ctx.lineWidth = clip.borderWidth;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, clip.radius);
    ctx.stroke();
    ctx.restore();
  }

  drawCalloutLabel(ctx, clip, frameW, frameH);
}

/**
 * Draw ONLY a callout's label pill (the text part) in screen coordinates. Factored
 * out of drawCallout so the ffmpeg EXPORT can rasterize just the label to a
 * transparent PNG overlay (the drawbox border/dim stay in the filtergraph). No-op
 * when there is no label.
 */
export function drawCalloutLabel(ctx: Ctx2D, clip: CalloutClip, frameW: number, frameH: number): void {
  if (!clip.label) return;
  const r = calloutScreenRect(clip);
  ctx.save();
  const fs = Math.max(18, Math.round(Math.min(frameW, frameH) * 0.03));
  ctx.font = `600 ${fs}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const padX = fs * 0.5;
  const padY = fs * 0.35;
  const m = ctx.measureText(clip.label);
  const boxW = m.width + padX * 2;
  const boxH = fs + padY * 2;
  const above = r.y - boxH - fs * 0.4;
  const by = above > 0 ? above : r.y + r.h + fs * 0.4;
  const bx = Math.max(0, Math.min(frameW - boxW, r.x));
  ctx.fillStyle = clip.color;
  ctx.beginPath();
  ctx.roundRect(bx, by, boxW, boxH, boxH * 0.28);
  ctx.fill();
  ctx.fillStyle = "#0a0d12";
  ctx.fillText(clip.label, bx + padX, by + boxH / 2);
  ctx.restore();
}

// ---- solid / shape ---------------------------------------------------------

/**
 * Clip the context to a directional transition REVEAL at fraction `f` (0..1) —
 * the canvas mirror of `transitionClipPath` (wipes reveal from an edge/corner/
 * center, circles open/close), in frame coordinates. No-op when fully revealed.
 */
export function clipTransitionReveal(ctx: Ctx2D, spec: TransitionSpec, f: number, W: number, H: number): void {
  if (f >= 1) return;
  ctx.beginPath();
  if (spec.kind === "circle") {
    const pct = (spec.circleClose ? 1 - f : f) * 0.75;
    ctx.arc(W / 2, H / 2, Math.max(0.5, pct * Math.hypot(W, H) / Math.SQRT2), 0, Math.PI * 2);
    ctx.clip();
    return;
  }
  const h = 1 - f;
  const hc = h / 2;
  // inset(top right bottom left) as fractions → the visible rect.
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  switch (spec.edge) {
    case "right":
      left = h;
      break;
    case "top":
      bottom = h;
      break;
    case "bottom":
      top = h;
      break;
    case "tl":
      right = h;
      bottom = h;
      break;
    case "tr":
      bottom = h;
      left = h;
      break;
    case "bl":
      top = h;
      right = h;
      break;
    case "br":
      top = h;
      left = h;
      break;
    case "center-h":
      left = hc;
      right = hc;
      break;
    case "center-v":
      top = hc;
      bottom = hc;
      break;
    case "rect":
      top = right = bottom = left = hc;
      break;
    case "left":
    default:
      right = h;
  }
  ctx.rect(left * W, top * H, Math.max(0, (1 - left - right) * W), Math.max(0, (1 - top - bottom) * H));
  ctx.clip();
}

/**
 * Paint an (optionally animated) gradient over the whole frame. `local` is seconds
 * since the clip started. Linear gradients sway (drift) or rotate (spin) their
 * angle; radial gradients breathe (pulse); aurora floats one soft blob per stop
 * over a static base gradient. Deterministic in `local`.
 */
export function paintBackgroundGradient(ctx: Ctx2D, g: BackgroundGradient, W: number, H: number, local: number): void {
  const u = local * g.speed;
  const stops = g.stops;
  const n = stops.length;
  const linear = (angleDeg: number, spread = 1): Gradient2D => {
    const th = degToRad(angleDeg);
    const half = ((Math.abs(W * Math.cos(th)) + Math.abs(H * Math.sin(th))) / 2) * spread || 1;
    const gr = ctx.createLinearGradient(
      W / 2 - Math.cos(th) * half,
      H / 2 - Math.sin(th) * half,
      W / 2 + Math.cos(th) * half,
      H / 2 + Math.sin(th) * half,
    );
    stops.forEach((c, i) => gr.addColorStop(i / (n - 1), c));
    return gr;
  };
  ctx.save();
  if (g.motion === "aurora") {
    ctx.fillStyle = linear(g.angle);
    ctx.fillRect(0, 0, W, H);
    const R = Math.max(W, H) * 0.62;
    for (let i = 0; i < n; i++) {
      const color = stops[(i + 1) % n]!;
      const cx = W * (0.5 + 0.38 * Math.sin(u * 0.35 + i * 2.1));
      const cy = H * (0.5 + 0.38 * Math.cos(u * 0.27 + i * 1.7));
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      rg.addColorStop(0, hexToRgba(color, 0.55));
      rg.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    return;
  }
  if (g.kind === "radial") {
    const pulse = g.motion === "pulse" ? 1 + 0.2 * Math.sin(u * 1.6) : 1;
    const r = (Math.hypot(W, H) / 2) * pulse;
    const rg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(1, r));
    stops.forEach((c, i) => rg.addColorStop(i / (n - 1), c));
    ctx.fillStyle = rg;
  } else {
    let angle = g.angle;
    if (g.motion === "drift") angle += 22 * Math.sin(u * 0.8);
    else if (g.motion === "spin") angle += u * 40;
    const spread = g.motion === "pulse" ? 1 + 0.25 * Math.sin(u * 1.6) : 1;
    ctx.fillStyle = linear(angle, spread);
  }
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/** Paint a subtle texture (dots / grid / lines / diagonal) over the frame. */
export function paintBackgroundPattern(ctx: Ctx2D, p: BackgroundPattern, W: number, H: number): void {
  const unit = Math.max(6, Math.min(W, H) * 0.04 * p.scale);
  ctx.save();
  ctx.globalAlpha = ctx.globalAlpha * p.opacity;
  ctx.fillStyle = p.color;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = Math.max(1, unit * 0.05);
  ctx.beginPath();
  if (p.kind === "dots") {
    const r = unit * 0.12;
    let row = 0;
    for (let y = unit / 2; y < H + unit; y += unit, row++) {
      const off = row % 2 === 0 ? 0 : unit / 2;
      for (let x = unit / 2 + off; x < W + unit; x += unit) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  } else if (p.kind === "grid" || p.kind === "lines") {
    for (let y = unit; y < H; y += unit) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    if (p.kind === "grid") {
      for (let x = unit; x < W; x += unit) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
    }
    ctx.stroke();
  } else {
    for (let d = -H; d < W; d += unit) {
      ctx.moveTo(d, H);
      ctx.lineTo(d + H, 0);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A full-frame solid / background fill: base color, optional (animated) gradient,
 * optional pattern — revealed by its transition (fades ramp opacity; slides move it;
 * wipes/circles reveal it directionally), so text-video scene changes preview and
 * export identically.
 */
export function drawSolid(ctx: Ctx2D, clip: SolidClip, frameW: number, frameH: number, t: number): void {
  const tm = transitionMotion(clip, t, frameW, frameH);
  const op =
    (tm.fadeOpacity ? transitionOpacity(clip, t) : clip.transform.opacity) * keyframeTransformState(clip, t).opacityMul;
  if (op <= 0 || tm.wipeFrac <= 0) return;
  ctx.save();
  ctx.globalAlpha = op;
  if (tm.dx !== 0 || tm.dy !== 0) ctx.translate(tm.dx, tm.dy);
  if (tm.scaleMul !== 1) {
    ctx.translate(frameW / 2, frameH / 2);
    ctx.scale(tm.scaleMul, tm.scaleMul);
    ctx.translate(-frameW / 2, -frameH / 2);
  }
  if (tm.wipeFrac < 1) clipTransitionReveal(ctx, transitionSpec(clip.transitionType ?? "crossfade"), tm.wipeFrac, frameW, frameH);
  ctx.fillStyle = clip.color;
  ctx.fillRect(0, 0, frameW, frameH);
  if (clip.gradient) paintBackgroundGradient(ctx, clip.gradient, frameW, frameH, Math.max(0, t - clip.start));
  if (clip.pattern) paintBackgroundPattern(ctx, clip.pattern, frameW, frameH);
  ctx.restore();
}

/** Trace (x,y,w,h) with corner radius `r` (clamped) so both fill and stroke can use it. */
function pathRoundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * Draw a vector SHAPE (rect / ellipse / line / arrow) centered on its transform:
 * keyframed transform + transition opacity. rect/ellipse honor fill (+fillOpacity)
 * and stroke; line/arrow draw a stroked segment (arrow adds a filled head) using
 * `w` as length and `strokeWidth` as thickness. Faithful: a synthetic overlay only.
 */
export function drawShape(ctx: Ctx2D, clip: ShapeClip, t: number, opts: DrawOpts = {}): void {
  // Motion, progress fills, and the graphics-pack geometries draw through the
  // motion-graphics path; the original four static shapes keep this exact code.
  if (clip.anim || clip.progress || clip.parts || !LEGACY_SHAPES.has(clip.shape)) {
    drawShapeAnimated(ctx, clip, t, opts);
    return;
  }
  const kfs = keyframeTransformState(clip, t);
  const op = transitionOpacity(clip, t) * kfs.opacityMul;
  if (op <= 0 || clip.w <= 0 || clip.h <= 0) return;
  ctx.save();
  ctx.translate(kfs.x, kfs.y);
  if (kfs.rotation !== 0) ctx.rotate(degToRad(kfs.rotation));
  if (kfs.scale !== 1) ctx.scale(kfs.scale, kfs.scale);

  const w = clip.w;
  const h = clip.h;
  const hasFill = clip.fill !== "";
  const hasStroke = clip.stroke !== "" && clip.strokeWidth > 0;

  if (clip.shape === "rect" || clip.shape === "ellipse") {
    if (clip.shape === "rect") pathRoundRect(ctx, -w / 2, -h / 2, w, h, clip.radius);
    else {
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    }
    if (hasFill) {
      ctx.globalAlpha = op * clip.fillOpacity;
      ctx.fillStyle = clip.fill;
      ctx.fill();
    }
    if (hasStroke) {
      ctx.globalAlpha = op;
      ctx.lineWidth = clip.strokeWidth;
      ctx.strokeStyle = clip.stroke;
      ctx.stroke();
    }
  } else {
    const color = clip.stroke !== "" ? clip.stroke : clip.fill !== "" ? clip.fill : "#ffffff";
    const thick = clip.strokeWidth > 0 ? clip.strokeWidth : 8;
    const half = w / 2;
    ctx.globalAlpha = op;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = thick;
    ctx.lineCap = "round";
    const headLen = clip.shape === "arrow" ? Math.max(thick * 3.2, 20) : 0;
    ctx.beginPath();
    ctx.moveTo(-half, 0);
    ctx.lineTo(half - headLen, 0);
    ctx.stroke();
    if (clip.shape === "arrow") {
      ctx.beginPath();
      ctx.moveTo(half, 0);
      ctx.lineTo(half - headLen, -headLen * 0.47);
      ctx.lineTo(half - headLen, headLen * 0.47);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---- whole-frame VFX -------------------------------------------------------

/**
 * Whole-frame VFX finishing pass, painted AFTER every clip so it sits over the
 * fully composited frame. Mirrors the ffmpeg finishing chain (vignette / noise /
 * screen-blended warm leak). Deterministic: the grain uses a seeded PRNG so a given
 * frame always renders identically.
 */
export function drawVfx(ctx: Ctx2D, vfx: Vfx, w: number, h: number): void {
  if (vfx.vignette > 0) {
    const cx = w / 2;
    const cy = h / 2;
    const inner = Math.min(w, h) * 0.35;
    const outer = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, vfx.vignette).toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  if (vfx.lightLeak) {
    const g = ctx.createLinearGradient(w, 0, w * 0.2, h);
    g.addColorStop(0, "rgba(255,176,96,0.42)");
    g.addColorStop(0.4, "rgba(255,120,80,0.16)");
    g.addColorStop(1, "rgba(255,120,80,0)");
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  if (vfx.grain > 0) {
    let seed = 0x9e3779b9 ^ (w * 73856093) ^ (h * 19349663);
    const rand = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 100000) / 100000;
    };
    const count = Math.floor(w * h * 0.03 * vfx.grain);
    ctx.save();
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rand() * w);
      const y = Math.floor(rand() * h);
      const v = rand() < 0.5 ? 255 : 0;
      const a = (0.06 + rand() * 0.14) * vfx.grain;
      ctx.fillStyle = `rgba(${v},${v},${v},${a.toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.restore();
  }
}

// ---- motion graphics: animated shapes, progress fills, graphics-pack geometry ----

/** Trace every polyline as one path (closed sub-paths are closed). */
function tracePolylines(ctx: Ctx2D, lines: Polyline[]): void {
  ctx.beginPath();
  for (const ln of lines) {
    const p = ln.pts;
    if (p.length < 2) continue;
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    if (ln.closed) ctx.closePath();
  }
}

/**
 * Trace only the [from, to] fraction (by arc length) of a set of polylines, treated
 * as ONE pen stroke in order — the draw-on / undraw / progress-ring primitive.
 */
function tracePartial(ctx: Ctx2D, lines: Polyline[], from: number, to: number): void {
  const total = polylineLength(lines);
  const a = Math.max(0, from) * total;
  const b = Math.min(1, to) * total;
  let acc = 0;
  ctx.beginPath();
  for (const ln of lines) {
    const p = ln.pts;
    let penDown = false;
    for (let i = 2; i < p.length; i += 2) {
      const x0 = p[i - 2]!;
      const y0 = p[i - 1]!;
      const x1 = p[i]!;
      const y1 = p[i + 1]!;
      const seg = Math.hypot(x1 - x0, y1 - y0);
      const s0 = acc;
      acc += seg;
      if (seg <= 0 || acc < a || s0 > b) {
        penDown = false;
        continue;
      }
      const u0 = Math.max(0, (a - s0) / seg);
      const u1 = Math.min(1, (b - s0) / seg);
      if (!penDown) {
        ctx.moveTo(x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0);
        penDown = true;
      }
      ctx.lineTo(x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1);
    }
  }
}

/** Clip to the leading `level` fraction of the w×h box along a progress direction. */
function clipProgressBox(
  ctx: Ctx2D,
  dir: "right" | "left" | "up" | "down",
  level: number,
  w: number,
  h: number,
  pad: number,
): void {
  const W = w + pad * 2;
  const H = h + pad * 2;
  const x0 = -w / 2 - pad;
  const y0 = -h / 2 - pad;
  ctx.beginPath();
  if (dir === "right") ctx.rect(x0, y0, W * level, H);
  else if (dir === "left") ctx.rect(x0 + W * (1 - level), y0, W * level, H);
  else if (dir === "up") ctx.rect(x0, y0 + H * (1 - level), W, H * level);
  else ctx.rect(x0, y0, W, H * level);
  ctx.clip();
}

/**
 * Draw a shape with MOTION (intro / exit / loop — `shapeAnimState`), an optional
 * PROGRESS fill (`shapeProgressLevel`: bars wipe, rings draw), and every
 * graphics-pack geometry (`shapeOutline`: star, heart, burst, bell, scribble, …).
 * Called by `drawShape` for any clip that has `anim` / `progress` or a new kind;
 * shares its transform order with the static path (keyframes → motion), so an
 * animated shape settles exactly onto its static pose.
 */
export function drawShapeAnimated(ctx: Ctx2D, clip: ShapeClip, t: number, opts: DrawOpts = {}): void {
  const px = opts.pxScale ?? 1;
  const kfs = keyframeTransformState(clip, t);
  const op = transitionOpacity(clip, t) * kfs.opacityMul;
  const w = clip.w;
  const h = clip.h;
  if (op <= 0 || w <= 0 || h <= 0) return;
  const m: ShapeMotionState = shapeAnimState(clip, t);
  if (!m.visible) return;

  const kind = clip.shape;
  const strokeOnly = isStrokeShape(kind);
  const thick = strokeOnly ? (clip.strokeWidth > 0 ? clip.strokeWidth : 8) : clip.strokeWidth;
  const pr = clip.progress;
  const level = shapeProgressLevel(clip, t);
  const drawStyle = !!pr && (pr.style === "draw" || strokeOnly);
  const drawFrom = m.drawFrom;
  const drawTo = drawStyle ? m.drawTo * level : m.drawTo;
  const knob = pr && pr.knob !== "" ? pr.knob : "";
  const knobR = drawStyle || strokeOnly ? Math.max(thick * 1.15, 5) : Math.max(Math.min(w, h) * 0.95, 5);

  ctx.save();
  ctx.translate(kfs.x + m.dx, kfs.y + m.dy);
  if (kfs.rotation !== 0) ctx.rotate(degToRad(kfs.rotation));
  if (kfs.scale !== 1) ctx.scale(kfs.scale, kfs.scale);
  if (m.swing !== 0) {
    ctx.translate(0, -h / 2);
    ctx.rotate(degToRad(m.swing));
    ctx.translate(0, h / 2);
  }
  if (m.rotation !== 0) ctx.rotate(degToRad(m.rotation));
  if (m.scale !== 1) ctx.scale(m.scale, m.scale);
  // Wipe reveal (left → right), padded so strokes / heads / knobs aren't shaved.
  if (m.revealFrom > 0 || m.revealTo < 1) {
    const pad = thick + knobR + 4;
    const span = w + pad * 2;
    const tall = Math.max(w, h) + pad * 2;
    ctx.beginPath();
    ctx.rect(-w / 2 - pad + m.revealFrom * span, -tall, Math.max(0, m.revealTo - m.revealFrom) * span, tall * 2);
    ctx.clip();
  }

  const baseAlpha = op * m.opacity;
  const outline = shapeOutline(kind, w, h, clip.radius, thick);
  const drawing = m.drawFrom > 0 || m.drawTo < 1 || m.fillAlpha < 1;
  const stretched = m.stretchX !== 1 || m.stretchY !== 1;
  // The body stretches (grow-x / grow-y / shrink-x); parts are revealed with it.
  ctx.save();
  if (stretched) {
    ctx.translate(m.originX, m.originY);
    ctx.scale(m.stretchX, m.stretchY);
    ctx.translate(-m.originX, -m.originY);
  }
  ctx.lineJoin = "round";

  if (strokeOnly) {
    const color = clip.stroke !== "" ? clip.stroke : clip.fill !== "" ? clip.fill : "#ffffff";
    ctx.globalAlpha = baseAlpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = thick;
    ctx.lineCap = "round";
    if (drawTo > drawFrom) {
      if (drawFrom <= 0 && drawTo >= 1) tracePolylines(ctx, outline);
      else tracePartial(ctx, outline, drawFrom, drawTo);
      ctx.stroke();
    }
    const head = arrowHead(kind, w, h, thick);
    if (head && drawFrom < 0.98) {
      const k = Math.max(0, Math.min(1, (drawTo - 0.85) / 0.15));
      if (k > 0) {
        ctx.save();
        ctx.translate(head[0]!, head[1]!);
        ctx.scale(k, k);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(head[2]! - head[0]!, head[3]! - head[1]!);
        ctx.lineTo(head[4]! - head[0]!, head[5]! - head[1]!);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  } else {
    const hasFill = clip.fill !== "";
    const hasStroke = clip.stroke !== "" && clip.strokeWidth > 0;
    // Full-shape path: native curves for the original rect/ellipse (crisp), the
    // sampled outline for everything else. A rect PROGRESS bar resizes (rounded
    // leading edge) instead of being clipped.
    const rectBar = kind === "rect" && !!pr && !drawStyle;
    const trace = (): void => {
      if (kind === "rect") {
        if (rectBar) {
          const dir = pr!.direction;
          const horiz = dir === "right" || dir === "left";
          const bw = horiz ? w * level : w;
          const bh = horiz ? h : h * level;
          const bx = dir === "left" ? w / 2 - bw : -w / 2;
          const by = dir === "up" ? h / 2 - bh : -h / 2;
          pathRoundRect(ctx, bx, by, bw, bh, clip.radius);
        } else pathRoundRect(ctx, -w / 2, -h / 2, w, h, clip.radius);
      } else if (kind === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else tracePolylines(ctx, outline);
    };
    ctx.save();
    if (pr && !drawStyle && !rectBar) clipProgressBox(ctx, pr.direction, level, w, h, thick + 2);
    const showBody = !(rectBar && level <= 0);
    if (showBody && hasFill && m.fillAlpha > 0) {
      ctx.globalAlpha = baseAlpha * clip.fillOpacity * m.fillAlpha;
      ctx.fillStyle = clip.fill;
      trace();
      ctx.fill();
    }
    if (showBody && m.shimmer >= 0 && m.shimmerAmount > 0 && hasFill) {
      // A glossy highlight sweeping across the shape (buttons, badges).
      ctx.save();
      trace();
      ctx.clip();
      const band = Math.max(w, h) * 0.3;
      const cx = -w / 2 - band + m.shimmer * (w + band * 2);
      const g = ctx.createLinearGradient(cx - band, -h / 2, cx + band, h / 2);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, `rgba(255,255,255,${(0.5 * m.shimmerAmount).toFixed(3)})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = baseAlpha * m.fillAlpha;
      ctx.fillStyle = g;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
    // Outline: the full stroke at rest; while drawing on / off (or as a progress
    // ring) only the visible span — in the fill color when there is no stroke, fading
    // out as the fill fades in so the hand-off is seamless.
    const partial = drawing || drawStyle;
    const strokeColor = hasStroke ? clip.stroke : hasFill ? clip.fill : "#ffffff";
    const strokeW = hasStroke ? clip.strokeWidth : Math.max(3, Math.min(w, h) * 0.045);
    const outlineAlpha = hasStroke ? 1 : drawing ? 1 - m.fillAlpha : 0;
    if (showBody && (hasStroke || partial) && outlineAlpha > 0 && drawTo > drawFrom) {
      ctx.globalAlpha = baseAlpha * outlineAlpha;
      ctx.lineWidth = strokeW;
      ctx.strokeStyle = strokeColor;
      ctx.lineCap = "round";
      if (!partial || (drawFrom <= 0 && drawTo >= 1)) trace();
      else tracePartial(ctx, outline, drawFrom, drawTo);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore(); // end of the body stretch

  // Text / icon parts ride the motion; while the body stretches they are revealed
  // with it, and they fade in with the fill after a draw-on.
  if (clip.parts && clip.parts.length > 0) {
    ctx.save();
    if (stretched) {
      const x0 = m.originX + (-w / 2 - m.originX) * m.stretchX;
      const x1 = m.originX + (w / 2 - m.originX) * m.stretchX;
      const y0 = m.originY + (-h / 2 - m.originY) * m.stretchY;
      const y1 = m.originY + (h / 2 - m.originY) * m.stretchY;
      const big = Math.max(w, h) * 4;
      ctx.beginPath();
      if (m.stretchY === 1) ctx.rect(x0, -big, Math.max(0, x1 - x0), big * 2);
      else if (m.stretchX === 1) ctx.rect(-big, y0, big * 2, Math.max(0, y1 - y0));
      else ctx.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
      ctx.clip();
    }
    drawShapeParts(ctx, clip, t, baseAlpha * m.fillAlpha, px);
    ctx.restore();
  }

  // Progress knob at the leading edge (bars) or the pen tip (rings / drawn paths).
  if (knob && pr) {
    let kx = 0;
    let ky = 0;
    if (drawStyle) [kx, ky] = pointAlong(outline, drawTo);
    else if (pr.direction === "right") kx = -w / 2 + level * w;
    else if (pr.direction === "left") kx = w / 2 - level * w;
    else if (pr.direction === "up") ky = h / 2 - level * h;
    else ky = -h / 2 + level * h;
    ctx.globalAlpha = baseAlpha;
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = knobR * 0.6 * px;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = knobR * 0.15 * px;
    ctx.fillStyle = knob;
    ctx.beginPath();
    ctx.arc(kx, ky, knobR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Parsed TextClips for shape text parts (cached per part object — parts are immutable doc data). */
const partTextCache = new WeakMap<object, TextClip>();

/** The text clip a text part draws as: shape-local (dx, dy), timed from the shape clip. */
export function shapePartTextClip(clip: ShapeClip, part: ShapePart & { kind: "text" }, index = 0): TextClip {
  let tc = partTextCache.get(part);
  if (!tc || tc.start !== clip.start || tc.duration !== clip.duration) {
    tc = TextClipSchema.parse({
      id: `${clip.id}-part${index}`,
      kind: "text",
      start: clip.start,
      duration: clip.duration,
      text: part.text,
      fontFamily: part.fontFamily,
      fontSize: part.fontSize,
      fontWeight: part.fontWeight,
      italic: part.italic,
      color: part.color,
      align: part.align,
      letterSpacing: part.letterSpacing,
      uppercase: part.uppercase,
      transform: { x: part.dx, y: part.dy },
      ...(part.anim ? { anim: part.anim } : {}),
      ...(part.counter ? { counter: part.counter } : {}),
      ...(part.shadow ? { shadow: part.shadow } : {}),
      ...(part.outline ? { outline: part.outline } : {}),
    });
    partTextCache.set(part, tc);
  }
  return tc;
}

/** Draw a shape's text / icon parts in shape-local coordinates at `alpha`. */
function drawShapeParts(ctx: Ctx2D, clip: ShapeClip, t: number, alpha: number, px: number): void {
  if (alpha <= 0) return;
  (clip.parts ?? []).forEach((part, i) => {
    ctx.save();
    if (part.kind === "icon") {
      const lines = shapeOutline(part.shape, part.w, part.h, 0, part.strokeWidth || 6);
      ctx.translate(part.dx, part.dy);
      ctx.globalAlpha = alpha;
      if (isStrokeShape(part.shape)) {
        ctx.strokeStyle = part.color;
        ctx.fillStyle = part.color;
        ctx.lineWidth = part.strokeWidth || Math.max(3, Math.min(part.w, part.h) * 0.14);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        tracePolylines(ctx, lines);
        ctx.stroke();
        const head = arrowHead(part.shape, part.w, part.h, ctx.lineWidth);
        if (head) {
          ctx.beginPath();
          ctx.moveTo(head[0]!, head[1]!);
          ctx.lineTo(head[2]!, head[3]!);
          ctx.lineTo(head[4]!, head[5]!);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        ctx.fillStyle = part.color;
        if (part.shape === "rect") pathRoundRect(ctx, -part.w / 2, -part.h / 2, part.w, part.h, Math.min(part.w, part.h) * 0.2);
        else if (part.shape === "ellipse") {
          ctx.beginPath();
          ctx.ellipse(0, 0, part.w / 2, part.h / 2, 0, 0, Math.PI * 2);
        } else tracePolylines(ctx, lines);
        ctx.fill();
      }
    } else {
      const tc = shapePartTextClip(clip, part, i);
      drawText(ctx, alpha >= 1 ? tc : { ...tc, transform: { ...tc.transform, opacity: Math.max(0, Math.min(1, alpha)) } }, t, { pxScale: px });
    }
    ctx.restore();
  });
}
