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
  textKinetic,
  transitionOpacity,
  typewriterText,
  valueAt,
} from "./grade";
import type {
  CalloutClip,
  CaptionWord,
  CursorClip,
  ImageClip,
  ShapeClip,
  SolidClip,
  TextClip,
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

/** The CSS/canvas `font` shorthand for a text clip (weight + optional italic). */
export function textFont(clip: TextClip): string {
  const style = clip.italic ? "italic " : "";
  return `${style}${fontWeightToCss(clip.fontWeight)} ${clip.fontSize}px ${clip.fontFamily}`;
}

/**
 * Draw a text / caption / title clip at time `t`: keyframed transform, transition
 * opacity, kinetic intro, typewriter reveal, word-wrap, letter spacing, background
 * panel, outline, shadow, and karaoke highlighting.
 */
export function drawText(ctx: Ctx2D, clip: TextClip, t: number): void {
  // Keyframes (if any) override the static transform; opacity keyframes multiply
  // the transition ramp — all resolved by the shared PURE valueAt helper.
  const kfs = keyframeTransformState(clip, t);
  const op = transitionOpacity(clip, t) * kfs.opacityMul;
  if (op <= 0) return;
  const kin = textKinetic(clip, t);
  const effScale = kfs.scale * kin.scaleMul;
  ctx.save();
  ctx.translate(kfs.x + kin.dx, kfs.y + kin.dy);
  if (kfs.rotation !== 0) ctx.rotate(degToRad(kfs.rotation));
  if (effScale !== 1) ctx.scale(effScale, effScale);
  ctx.globalAlpha = op;
  ctx.font = textFont(clip);
  ctx.textAlign = clip.align;
  ctx.textBaseline = "middle";

  // Typewriter: reveal only the substring visible at this time (shared core
  // helper), and optionally a blinking caret.
  const tw = clip.anim.style === "typewriter" ? typewriterText(clip, t) : null;
  const rawShown = tw ? tw.text + (tw.caretVisible ? "|" : "") : clip.text;
  const upper = (s: string): string => (clip.uppercase ? s.toUpperCase() : s);
  const shownText = upper(rawShown);
  // Size the panel to the FULL text so it doesn't grow while typing.
  const fullText = upper(tw ? clip.text : rawShown);

  const ls = clip.letterSpacing ?? 0;
  const lineStep = clip.fontSize * (clip.lineHeight ?? 1.2);

  // Karaoke: word-by-word highlight. Active only when enabled AND the clip carries
  // per-word timings; otherwise every path below is byte-identical to a static
  // caption.
  const karaokeOn = !!(clip.karaoke?.enabled && clip.words && clip.words.length > 0);
  const karaokeWords = karaokeOn ? clip.words! : [];
  const karaokeSpace = ctx.measureText(" ").width + ls;
  const karaokeLines = karaokeOn
    ? wrapKaraokeTokens(ctx, karaokeWords.map((w) => upper(w.text)), karaokeSpace, clip.maxWidth)
    : [];
  const shownLines = karaokeOn
    ? karaokeLines.map((l) => l.map((tk) => tk.text).join(" "))
    : clip.maxWidth
      ? wrapText(ctx, shownText, clip.maxWidth)
      : [shownText];
  const fullLines = karaokeOn
    ? shownLines
    : clip.maxWidth
      ? wrapText(ctx, fullText, clip.maxWidth)
      : [fullText];

  // --- Background panel (pill / box). `box` supersedes the legacy `background`
  // pill; with neither, nothing is drawn.
  const boxStyle = clip.box?.style ?? (clip.background ? "pill" : "none");
  if (boxStyle !== "none") {
    const padX = clip.box?.padX ?? clip.fontSize * 0.4;
    const padY = clip.box?.padY ?? clip.fontSize * 0.28;
    const nFull = fullLines.length;
    const widest = fullLines.reduce((m, l) => Math.max(m, lineWidth(ctx, l, ls)), 0);
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

  // Stroked outline first (under the fill), for readability over busy footage.
  if (clip.outline && clip.outline.width > 0) {
    ctx.lineWidth = clip.outline.width * 2; // half sits under the fill → visible width
    ctx.strokeStyle = clip.outline.color;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    drawTextLines(ctx, shownLines, lineStep, ls, "stroke", clip.align);
  }

  if (karaokeOn) {
    drawKaraokeLines(ctx, karaokeLines, lineStep, clip, karaokeWords, t, op);
    ctx.restore();
    return;
  }

  if (clip.shadow) {
    ctx.shadowColor = clip.shadow.color;
    ctx.shadowBlur = clip.shadow.blur;
    ctx.shadowOffsetX = clip.shadow.offsetX;
    ctx.shadowOffsetY = clip.shadow.offsetY;
  }

  ctx.fillStyle = clip.color;
  drawTextLines(ctx, shownLines, lineStep, ls, "fill", clip.align);
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

/** A full-frame solid color fill (backgrounds, letterbox, fades to/from black). */
export function drawSolid(ctx: Ctx2D, clip: SolidClip, frameW: number, frameH: number, t: number): void {
  // A solid fills the frame, so only its (keyframed) opacity is meaningful here.
  const op = transitionOpacity(clip, t) * keyframeTransformState(clip, t).opacityMul;
  if (op <= 0) return;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.fillStyle = clip.color;
  ctx.fillRect(0, 0, frameW, frameH);
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
export function drawShape(ctx: Ctx2D, clip: ShapeClip, t: number): void {
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
