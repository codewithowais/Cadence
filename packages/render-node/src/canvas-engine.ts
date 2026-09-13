/**
 * Headless RenderEngine backed by @napi-rs/canvas (Skia).
 *
 * Runs in plain Node — no browser, no WebCodecs, no system ffmpeg — so it powers
 * the verify gate and offline development. It implements the engine-agnostic
 * `RenderEngine` contract from @cadence/core, so swapping in an Omniclip/WebCodecs
 * or MLT/ffmpeg backend later requires no change to the Director or edit-doc.
 *
 * NOTE (Phase 0/1): video/image clips are drawn as labeled placeholder tiles.
 * Real media decode/draw is a later slice; the point today is that ANY valid
 * edit-doc renders a real frame — with looks, crossfades and Ken Burns motion —
 * that we can assert on and that matches the browser preview.
 */
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  activeClipsAt,
  blendCompositeOperation,
  calloutScreenRect,
  calloutTransform,
  clipProgress,
  cssFilter,
  cursorPositionAt,
  cursorRipples,
  emphasisScale,
  fontWeightToCss,
  imageMotion,
  sourceTimeAt,
  textKinetic,
  transitionMotion,
  transitionOpacity,
  typewriterText,
  valueAt,
  type AdjustmentClip,
  type CalloutClip,
  type CaptionWord,
  type Clip,
  type CursorClip,
  type EditDoc,
  type ImageClip,
  type Mask,
  type RenderedFrame,
  type RenderEngine,
  type ShapeClip,
  type SolidClip,
  type TextClip,
  type VideoClip,
  type Vfx,
} from "@cadence/core";

const degToRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Resolve a visual clip's keyframed transform at the active time via the shared
 * PURE `valueAt` helper (so canvas, Stage, and export agree). Each field falls
 * back to the clip's static transform value when it has no keyframe for that
 * prop, so this is always safe to call. `opacityMul` is the keyframed opacity as
 * a MULTIPLIER on the base opacity, so it composes with the transition ramps.
 */
function keyframeTransformState(
  clip: VideoClip | ImageClip | TextClip | SolidClip | ShapeClip,
): { x: number; y: number; scale: number; rotation: number; opacityMul: number } {
  const kf = clip.keyframes;
  const prog = clipProgress(clip, clipTimeCache);
  const base = clip.transform.opacity || 1;
  return {
    x: valueAt(kf, "x", prog, clip.transform.x),
    y: valueAt(kf, "y", prog, clip.transform.y),
    scale: valueAt(kf, "scale", prog, clip.transform.scale),
    rotation: valueAt(kf, "rotation", prog, clip.transform.rotation),
    opacityMul: valueAt(kf, "opacity", prog, clip.transform.opacity) / base,
  };
}

/**
 * Word-wrap `text` into lines no wider than `maxWidth` (composition px), by whole
 * words. Deterministic; measured with the ctx's current font. A word longer than
 * `maxWidth` is left on its own line (never broken mid-word). Returns [text] when
 * there is nothing to wrap.
 */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [text];
  const lines: string[] = [];
  let cur = words[0]!;
  for (let i = 1; i < words.length; i++) {
    const test = `${cur} ${words[i]}`;
    if (ctx.measureText(test).width <= maxWidth) cur = test;
    else {
      lines.push(cur);
      cur = words[i]!;
    }
  }
  lines.push(cur);
  return lines;
}

/** Width of one line accounting for extra letter spacing (0 = native measure). */
function lineWidth(ctx: SKRSContext2D, line: string, letterSpacing: number): number {
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
  ctx: SKRSContext2D,
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
 * Deterministic; measured with the ctx's current font — mirrors `wrapText` so the
 * karaoke layout matches the static caption's wrapping.
 */
function wrapKaraokeTokens(
  ctx: SKRSContext2D,
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
 * at full opacity; upcoming (not-yet-spoken) words are drawn slightly dimmer, so the
 * read-along progression is visible. Called per frame, so this animates for free in
 * preview + canvas + (via per-word PNGs) export. Text baseline is "middle"; y is the
 * line center. Intra-word letter spacing is not applied here (a documented karaoke
 * limitation); inter-word spacing includes `letterSpacing`.
 */
function drawKaraokeLines(
  ctx: SKRSContext2D,
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

function drawText(ctx: SKRSContext2D, clip: TextClip): void {
  // Keyframes (if any) override the static transform; opacity keyframes multiply
  // the transition ramp — all resolved by the shared PURE valueAt helper.
  const kfs = keyframeTransformState(clip);
  const op = transitionOpacity(clip, clipTimeCache) * kfs.opacityMul;
  if (op <= 0) return;
  // Kinetic intro: slide from an offset and scale up, resolved by core (shared
  // with the Stage preview + export so all three agree).
  const kin = textKinetic(clip, clipTimeCache);
  const effScale = kfs.scale * kin.scaleMul;
  ctx.save();
  ctx.translate(kfs.x + kin.dx, kfs.y + kin.dy);
  if (kfs.rotation !== 0) ctx.rotate(degToRad(kfs.rotation));
  if (effScale !== 1) ctx.scale(effScale, effScale);
  ctx.globalAlpha = op;
  // weight + optional italic (italic prefix is absent by default → font string is
  // byte-identical to the historical one, so the default look is unchanged).
  const style = clip.italic ? "italic " : "";
  ctx.font = `${style}${fontWeightToCss(clip.fontWeight)} ${clip.fontSize}px ${clip.fontFamily}`;
  ctx.textAlign = clip.align;
  ctx.textBaseline = "middle";

  // Typewriter: reveal only the substring visible at this time (shared core
  // helper), and optionally a blinking caret — mirrors the export's drawtext slices.
  const tw = clip.anim.style === "typewriter" ? typewriterText(clip, clipTimeCache) : null;
  const rawShown = tw ? tw.text + (tw.caretVisible ? "|" : "") : clip.text;
  const upper = (s: string): string => (clip.uppercase ? s.toUpperCase() : s);
  const shownText = upper(rawShown);
  // Size the panel to the FULL text so it doesn't grow while typing.
  const fullText = upper(tw ? clip.text : rawShown);

  const ls = clip.letterSpacing ?? 0;
  const lineStep = clip.fontSize * (clip.lineHeight ?? 1.2);

  // Karaoke: word-by-word highlight. Active only when enabled AND the clip carries
  // per-word timings; otherwise every path below is byte-identical to a static
  // caption. Typewriter + karaoke don't combine (karaoke shows the whole line and
  // highlights the spoken word), so karaoke ignores the typewriter substring.
  const karaokeOn = !!(clip.karaoke?.enabled && clip.words && clip.words.length > 0);
  const karaokeWords = karaokeOn ? clip.words! : [];
  const karaokeSpace = ctx.measureText(" ").width + ls;
  const karaokeLines = karaokeOn
    ? wrapKaraokeTokens(ctx, karaokeWords.map((w) => upper(w.text)), karaokeSpace, clip.maxWidth)
    : [];
  // For karaoke, the panel/outline size to the joined words (so they wrap identically
  // to the drawn tokens); otherwise use the normal shown/full text.
  const shownLines = karaokeOn
    ? karaokeLines.map((l) => l.map((t) => t.text).join(" "))
    : clip.maxWidth
      ? wrapText(ctx, shownText, clip.maxWidth)
      : [shownText];
  const fullLines = karaokeOn
    ? shownLines
    : clip.maxWidth
      ? wrapText(ctx, fullText, clip.maxWidth)
      : [fullText];

  // --- Background panel (pill / box). `box` supersedes the legacy `background`
  // pill; with neither, nothing is drawn (unchanged). Defaults reproduce the exact
  // historical pill geometry for a single-line caption so the default is unchanged.
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

  // Karaoke fill: draw each word, highlighting the one active at this frame time
  // (per-word PNGs mirror this on export). Handles its own shadow so highlight
  // pills/boxes don't inherit the text shadow.
  if (karaokeOn) {
    drawKaraokeLines(ctx, karaokeLines, lineStep, clip, karaokeWords, clipTimeCache, op);
    ctx.restore();
    return;
  }

  // Optional drop shadow on the fill (cleared implicitly at ctx.restore()).
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

/**
 * An arrow mouse-pointer at the interpolated cursor position, plus an expanding
 * ring for each active click (shared core helpers cursorPositionAt / cursorRipples).
 * The arrow is a small classic pointer polygon whose tip sits at (x, y).
 */
function drawCursor(ctx: SKRSContext2D, clip: CursorClip, frameW: number, frameH: number): void {
  const { x, y } = cursorPositionAt(clip, clipTimeCache);

  // Click ripples first, so the pointer sits on top of them.
  const maxR = clip.size * 1.6;
  for (const rip of cursorRipples(clip, clipTimeCache)) {
    ctx.save();
    ctx.globalAlpha = rip.opacity;
    ctx.strokeStyle = clip.color;
    ctx.lineWidth = Math.max(2, clip.size * 0.08);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, rip.radiusFrac * maxR), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Arrow pointer: a classic pointer whose tip is the hotspot at (x, y).
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
  void frameW;
  void frameH;
}

/**
 * A callout / highlight: optionally dim everything OUTSIDE the rect, then a bright
 * rounded border, then an optional label. Drawn in SCREEN coordinates using the
 * shared calloutScreenRect (which already accounts for any zoom, applied to the
 * content by the caller). Faithful: an overlay, no content change.
 */
function drawCallout(ctx: SKRSContext2D, clip: CalloutClip, frameW: number, frameH: number): void {
  const r = calloutScreenRect(clip);

  if (clip.dim && clip.dimOpacity > 0) {
    // Dim the frame, then punch the rect back to clear via destination-out.
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
 * transparent PNG overlay (the drawbox border/dim stay in the filtergraph) — the
 * label needs a real font, which the bundled ffmpeg (no libfreetype/drawtext) can't
 * render. No-op when there is no label. Shared drawing ⇒ preview == export.
 */
function drawCalloutLabel(ctx: SKRSContext2D, clip: CalloutClip, frameW: number, frameH: number): void {
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
  // Prefer above the rect; drop below when there's no room at the top.
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

/**
 * Clip the context to a mask shape (in composition coords), so subsequent drawing
 * is revealed only inside the shape (or outside it when `invert`). Approximation of
 * the export's geq alpha: rect/ellipse + invert are exact; feather is drawn as a
 * hard edge on the canvas (the export feathers). Call INSIDE a ctx.save() block,
 * before the clip's own translate/scale.
 */
function applyMaskClip(ctx: SKRSContext2D, mask: Mask, frameW: number, frameH: number): void {
  ctx.beginPath();
  if (mask.invert) ctx.rect(0, 0, frameW, frameH); // outer path for the even-odd cut-out
  if (mask.shape === "ellipse") {
    const cx = mask.x + mask.w / 2;
    const cy = mask.y + mask.h / 2;
    ctx.ellipse(cx, cy, Math.max(1, mask.w / 2), Math.max(1, mask.h / 2), 0, 0, Math.PI * 2);
  } else {
    ctx.rect(mask.x, mask.y, mask.w, mask.h);
  }
  ctx.clip(mask.invert ? "evenodd" : "nonzero");
}

function drawMedia(
  ctx: SKRSContext2D,
  clip: VideoClip | ImageClip,
  label: string,
  fill: string,
  frameW: number,
  frameH: number,
): void {
  // Transition motion (slide/wipe) + whether opacity should ramp (crossfade /
  // dip-to-black do; slide/wipe stay opaque) — shared core helper.
  const tm = transitionMotion(clip, clipTimeCache, frameW, frameH);
  // Keyframes (if any) override the static transform; opacity keyframes multiply
  // the transition ramp — all resolved by the shared PURE valueAt helper.
  const kfs = keyframeTransformState(clip);
  const op = (tm.fadeOpacity ? transitionOpacity(clip, clipTimeCache) : clip.transform.opacity) * kfs.opacityMul;
  if (op <= 0 || tm.wipeFrac <= 0) return;

  const motion = clip.kind === "image" ? imageMotion(clip, clipTimeCache) : null;
  // Punch-in emphasis pulses a video clip's scale up over a sub-range (core helper).
  const emphasis = clip.kind === "video" ? emphasisScale(clip, clipTimeCache) : 1;
  // tm.scaleMul carries the "zoom" transition's scale-in (1 for every other type).
  const effScale = kfs.scale * (motion ? motion.scale : 1) * emphasis * tm.scaleMul;
  const panX = motion ? motion.panXFrac * frameW : 0;
  const panY = motion ? motion.panYFrac * frameH : 0;

  ctx.save();
  // Mask (if any) clips in COMPOSITION coords, before the clip's own transform —
  // reveal only inside the shape (or outside when inverted). Shared shape with the
  // export's geq alpha; feather is a hard edge here (documented approximation).
  if (clip.mask) applyMaskClip(ctx, clip.mask, frameW, frameH);
  // Slide transition offsets the whole frame (composition px, pre-scale).
  ctx.translate(kfs.x + panX + tm.dx, kfs.y + panY + tm.dy);
  if (kfs.rotation !== 0) ctx.rotate(degToRad(kfs.rotation));
  if (effScale !== 1) ctx.scale(effScale, effScale);
  ctx.globalAlpha = op;
  // Blend mode: how this clip composites over what's already painted beneath.
  // Shared with the export's blend=all_mode= (screen/multiply/overlay/soft-light/add).
  if (clip.blendMode && clip.blendMode !== "normal") {
    ctx.globalCompositeOperation = blendCompositeOperation(clip.blendMode);
  }

  // Wipe transition: reveal the frame left→right by clipping to a growing rect.
  if (tm.wipeFrac < 1) {
    ctx.beginPath();
    ctx.rect(-frameW / 2, -frameH / 2, frameW * tm.wipeFrac, frameH);
    ctx.clip();
  }

  // Look / color grade — applies to the tile now, to real pixels later.
  ctx.filter = cssFilter(clip.look);
  ctx.fillStyle = fill;
  ctx.beginPath();
  if (clip.chroma) {
    // Chroma key approximation: the keyed background is dropped, so the layer
    // BENEATH shows through. On the placeholder tile we draw only a centered
    // "subject" band instead of the full frame (the export uses real chromakey).
    const sw = frameW * 0.5;
    ctx.roundRect(-sw / 2, -frameH / 2, sw, frameH, 0);
  } else {
    ctx.roundRect(-frameW / 2, -frameH / 2, frameW, frameH, 0);
  }
  ctx.fill();
  ctx.filter = "none";

  // Warmth overlay (soft-light) for the warm look.
  if (clip.look.warmth > 0) {
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = op * clip.look.warmth * 0.6;
    ctx.fillStyle = "#ff8a3d";
    ctx.fillRect(-frameW / 2, -frameH / 2, frameW, frameH);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = op;
  }

  ctx.fillStyle = "#ffffff";
  ctx.font = "40px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 0, 0);
  // Speed retime: show which SOURCE moment maps here (pure sourceTimeAt), so the
  // placeholder tile agrees with the Stage's seek and the export's setpts.
  if (clip.kind === "video" && (clip.speed ?? 1) !== 1) {
    ctx.font = "26px sans-serif";
    ctx.fillText(
      `${clip.speed}× · src ${sourceTimeAt(clip, clipTimeCache).toFixed(2)}s`,
      0,
      44,
    );
  }

  // Region blur/pixelate approximation: obscure a rectangle (hide a face/plate).
  // Region coords are composition px; here they're drawn relative to the frame's
  // centered local space (exact for a centered full-frame clip — the common case;
  // the export crops+blurs/pixelizes the real region). Faithful: obscures only.
  if (clip.regionFx) {
    const rf = clip.regionFx;
    const lx = rf.x - frameW / 2;
    const ly = rf.y - frameH / 2;
    ctx.globalAlpha = op;
    if (rf.type === "pixelate") {
      // A mosaic of blocks sampled from the tile tint — a coarse pixelation look.
      const block = Math.max(6, Math.round(12 + rf.amount * 48));
      for (let by = 0; by < rf.h; by += block) {
        for (let bx = 0; bx < rf.w; bx += block) {
          const shade = ((bx / block + by / block) % 2 === 0) ? 0.35 : 0.55;
          ctx.fillStyle = `rgba(20,24,30,${shade.toFixed(2)})`;
          ctx.fillRect(lx + bx, ly + by, Math.min(block, rf.w - bx), Math.min(block, rf.h - by));
        }
      }
    } else {
      // Blur: a frosted translucent panel over the region.
      ctx.fillStyle = "rgba(230,235,240,0.55)";
      ctx.fillRect(lx, ly, rf.w, rf.h);
    }
  }
  ctx.restore();
}

function drawSolid(ctx: SKRSContext2D, clip: SolidClip, frameW: number, frameH: number): void {
  // A solid fills the frame, so only its (keyframed) opacity is meaningful here.
  const op = transitionOpacity(clip, clipTimeCache) * keyframeTransformState(clip).opacityMul;
  if (op <= 0) return;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.fillStyle = clip.color;
  ctx.fillRect(0, 0, frameW, frameH);
  ctx.restore();
}

/** A rounded-rectangle sub-path centered logic is done by the caller; this traces
 * (x,y,w,h) with corner radius `r` (clamped) so both fill and stroke can use it. */
function pathRoundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
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
 * Draw a vector SHAPE (rect / ellipse / line / arrow) centered on its transform.
 * Mirrors drawText/drawSolid: keyframed transform + transition opacity, so the
 * canvas preview, the node render, and (via renderShapeClipPng → PNG overlay) the
 * ffmpeg export all agree. rect/ellipse honor fill (+fillOpacity) and stroke;
 * line/arrow draw a stroked segment (arrow adds a filled head) using `w` as length
 * and `strokeWidth` as thickness. Faithful: a synthetic overlay only.
 */
function drawShape(ctx: SKRSContext2D, clip: ShapeClip): void {
  const kfs = keyframeTransformState(clip);
  const op = transitionOpacity(clip, clipTimeCache) * kfs.opacityMul;
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
    // line / arrow: horizontal segment of length `w`, thickness `strokeWidth`.
    const color = clip.stroke !== "" ? clip.stroke : clip.fill !== "" ? clip.fill : "#ffffff";
    const thick = clip.strokeWidth > 0 ? clip.strokeWidth : 8;
    const half = w / 2;
    ctx.globalAlpha = op;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = thick;
    ctx.lineCap = "round";
    // Arrow head ≈ 3.2× stroke long, ~50° tip (half-width = headLen·tan25° ≈ 0.47).
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

/**
 * Whole-frame VFX finishing pass, painted AFTER every clip so it sits over the
 * fully composited frame. Mirrors the ffmpeg finishing chain (vignette / noise /
 * screen-blended warm leak) so the preview matches the export. Deterministic: the
 * grain uses a seeded PRNG so a given frame always renders identically.
 */
function drawVfx(ctx: SKRSContext2D, vfx: Vfx, w: number, h: number): void {
  // --- vignette: radial gradient, clear center → dark edges ---
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

  // --- warm light-leak: a diagonal warm gradient, screen-blended over a corner ---
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

  // --- film grain: seeded procedural noise (deterministic per frame size) ---
  if (vfx.grain > 0) {
    let seed = 0x9e3779b9 ^ (w * 73856093) ^ (h * 19349663);
    const rand = (): number => {
      // xorshift32 → 0..1
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

/** Deterministic-ish tint from a string so different media read differently. */
function tintFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffff;
  const hex = (hash & 0x7f7f7f).toString(16).padStart(6, "0");
  return `#${hex}`;
}

/** Draw one non-overlay clip (text / image / video / solid). Audio is silent. */
function drawContentClip(ctx: SKRSContext2D, clip: Clip, doc: EditDoc, width: number, height: number): void {
  switch (clip.kind) {
    case "text":
      drawText(ctx, clip);
      break;
    case "image":
    case "video": {
      const asset = doc.media.find((m) => m.id === clip.mediaId);
      drawMedia(ctx, clip, asset?.label ?? asset?.src ?? clip.mediaId, tintFor(clip.mediaId), width, height);
      break;
    }
    case "solid":
      drawSolid(ctx, clip, width, height);
      break;
    case "shape":
      drawShape(ctx, clip);
      break;
    case "audio":
    case "cursor":
    case "callout":
    case "adjustment":
      // Overlays / non-content clips: drawn elsewhere (cursor/callout) or applied as
      // a post-composite pass (adjustment); audio is silent on the canvas.
      break;
  }
}

/**
 * Apply an ADJUSTMENT LAYER's grade to the WHOLE frame — a post-composite pass that
 * grades everything already painted beneath it (the canvas mirror of the ffmpeg
 * `enable`-gated grade chain). The caller only invokes this while the clip is active
 * at the frame time, so the window gating is inherent. Re-draws the composited
 * canvas through the shared `cssFilter(grade)` (brightness/contrast/saturation/hue/
 * warmth), then the warm soft-light overlay (mirroring drawMedia) and any Vfx. The
 * clip's LUT is EXPORT-ONLY, so it is skipped here gracefully (documented, exactly
 * like per-clip LUTs / curves). No-op when the grade is neutral and there is no Vfx.
 */
function applyAdjustment(
  ctx: SKRSContext2D,
  srcCanvas: Canvas,
  clip: AdjustmentClip,
  w: number,
  h: number,
): void {
  const grade = clip.grade;
  const filter = cssFilter(grade);
  if (filter !== "none") {
    // Snapshot the current composite, then redraw it through the grade filter. A
    // second canvas is needed because reading and writing the same canvas is unsafe.
    const tmp = createCanvas(w, h);
    tmp.getContext("2d").drawImage(srcCanvas, 0, 0);
    ctx.save();
    ctx.filter = filter;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp, 0, 0);
    ctx.filter = "none";
    ctx.restore();
  }
  // Warm soft-light overlay for the warmth field — mirrors drawMedia's warm wash so
  // an adjustment's warmth reads the same as a per-clip warm look.
  if (grade.warmth > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = Math.min(1, grade.warmth * 0.6);
    ctx.fillStyle = "#ff8a3d";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  // Optional whole-frame Vfx (vignette / grain / light-leak), gated to this window.
  if (clip.vfx) drawVfx(ctx, clip.vfx, w, h);
}

// The active render time, so draw helpers can read it without threading it
// through every call. Set at the top of renderFrame (single-threaded).
let clipTimeCache = 0;

export class CanvasRenderEngine implements RenderEngine {
  async renderFrame(doc: EditDoc, timeSec: number): Promise<RenderedFrame> {
    clipTimeCache = timeSec;
    const { width, height, background } = doc.meta;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const active = activeClipsAt(doc, timeSec).map(({ clip }) => clip);
    const callouts = active.filter((c): c is CalloutClip => c.kind === "callout");
    const cursors = active.filter((c): c is CursorClip => c.kind === "cursor");
    // Adjustment layers grade the composite AFTER everything is drawn (post-pass);
    // they are not "content", so keep them out of the content draw.
    const adjustments = active.filter((c): c is AdjustmentClip => c.kind === "adjustment");
    const content = active.filter(
      (c) => c.kind !== "callout" && c.kind !== "cursor" && c.kind !== "adjustment",
    );

    // A callout with zoom magnifies the composited CONTENT toward its rect. Apply
    // that transform (scale about the rect center, shared core helper) around the
    // content draw only; the callout border/dim/label and the cursor stay in
    // screen space so they frame/point at the final pixels.
    const zoomCallout = callouts.find((c) => c.zoom > 1);
    if (zoomCallout) {
      const t = calloutTransform(zoomCallout);
      ctx.save();
      ctx.translate(t.tx, t.ty);
      ctx.scale(t.scale, t.scale);
    }
    for (const clip of content) drawContentClip(ctx, clip as Clip, doc, width, height);
    if (zoomCallout) ctx.restore();

    // Callouts (dim + border + label), then cursors, over the content.
    for (const c of callouts) drawCallout(ctx, c, width, height);
    for (const c of cursors) drawCursor(ctx, c, width, height);

    // Adjustment layers: grade the whole composite, gated to each active clip's
    // window (only active ones reach here). Applied in start order, after all
    // content + overlays and before the whole-doc finishing pass. No-op when none.
    adjustments.sort((a, b) => a.start - b.start);
    for (const adj of adjustments) applyAdjustment(ctx, canvas, adj, width, height);

    // Whole-frame finishing overlays (vignette / grain / light-leak), over everything.
    drawVfx(ctx, doc.vfx, width, height);

    const data = canvas.toBuffer("image/png");
    return { width, height, format: "png", data };
  }
}

// --- text overlay rasterizers (for the ffmpeg export) -----------------------
//
// The bundled ffmpeg (ffmpeg-static) has NO drawtext filter (no libfreetype), so
// captions/titles/kinetic titles and callout labels can't be burned in via
// drawtext. Instead the export rasterizes each text-bearing clip to a transparent,
// composition-sized PNG here — REUSING the exact canvas drawText/drawCalloutLabel
// that render the preview — and overlays those PNGs in the filtergraph. That both
// works with ANY ffmpeg build and gives perfect preview↔export text parity.

/**
 * The "resting" time within a text clip's span at which we rasterize it for export:
 * far enough in that any intro animation (kinetic slide/scale, typewriter reveal)
 * has settled AND the transition opacity is full. Export renders animated text at
 * this resting/final state (a static PNG); the live preview still animates. Chosen
 * as the clip midpoint, but never before the intro animation finishes.
 */
function textRestTime(clip: TextClip): number {
  const animDur = clip.anim.style !== "none" ? clip.anim.durationSec : 0;
  const span = Math.max(0, clip.duration);
  const settle = Math.min(Math.max(span * 0.5, animDur + 0.05), Math.max(0, span - 1e-3));
  return clip.start + settle;
}

/**
 * Rasterize ONE text clip (caption / title / kinetic title / typewriter) to a
 * transparent, composition-sized PNG at its resting state, using the SAME canvas
 * drawText as the preview — so the exported text matches the preview exactly, with
 * its font, size, color, alignment, pill background and outline. Returns raw PNG
 * bytes. Server-only (native Skia canvas). Animated text is captured at rest (see
 * textRestTime); the export overlays this static PNG time-gated to the clip span.
 */
export function renderTextClipPng(doc: EditDoc, clip: TextClip): Buffer {
  const { width, height } = doc.meta;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // Transparent ground (no background fill) so only the glyphs/pill carry alpha.
  clipTimeCache = textRestTime(clip);
  drawText(ctx, clip);
  return canvas.toBuffer("image/png");
}

/**
 * Rasterize a SHAPE clip to a transparent composition-sized PNG for the ffmpeg
 * export overlay (mirrors renderTextClipPng). Rendered at the clip's RESTING state
 * (transitions/keyframes settled — one static PNG over the clip span), so an animated
 * shape exports as its settled frame while the preview still animates (the same
 * documented limitation as text). Transparent ground → only the shape carries alpha.
 */
export function renderShapeClipPng(doc: EditDoc, clip: ShapeClip): Buffer {
  const { width, height } = doc.meta;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // Resting time = clip end (after any transition-in), matching textRestTime intent.
  clipTimeCache = clip.start + clip.duration;
  drawShape(ctx, clip);
  return canvas.toBuffer("image/png");
}

/**
 * Whether a text clip is a KARAOKE caption (highlight enabled AND per-word timings
 * present). Only such clips get the per-word PNG sequence on export; everything else
 * uses the single-PNG path (renderTextClipPng). Exported so the ffmpeg driver can
 * decide which clips to sequence without re-implementing the check.
 */
export function isKaraokeClip(clip: TextClip): boolean {
  return !!(clip.karaoke?.enabled && clip.words && clip.words.length > 0);
}

/**
 * Rasterize a KARAOKE caption to ONE transparent, composition-sized PNG PER WORD:
 * the PNG for word `i` is rendered at that word's active time (its [start,end]
 * midpoint) via the SAME canvas drawText the preview uses, so it shows word `i`
 * highlighted and the rest in the base color. The ffmpeg export overlays each PNG
 * gated to `words[i].[start,end]`, so the highlight steps word-by-word on export too
 * (preview↔export parity). Returns one Buffer per `clip.words` entry; empty when the
 * clip is not karaoke. Server-only (native Skia canvas).
 */
export function renderKaraokeWordPngs(doc: EditDoc, clip: TextClip): Buffer[] {
  if (!isKaraokeClip(clip)) return [];
  const { width, height } = doc.meta;
  const words = clip.words!;
  return words.map((w) => {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    // Render at the word's active midpoint so drawText highlights exactly this word.
    clipTimeCache = (w.start + w.end) / 2;
    drawText(ctx, clip);
    return canvas.toBuffer("image/png");
  });
}

/**
 * Rasterize ONE callout's LABEL (only) to a transparent, composition-sized PNG,
 * reusing the canvas label drawing. The callout's drawbox border + outside-dim stay
 * in the ffmpeg filtergraph (drawbox needs no font); only the label needs a real
 * font, so it becomes a PNG overlay. Returns null when the callout has no label.
 */
export function renderCalloutLabelPng(doc: EditDoc, clip: CalloutClip): Buffer | null {
  if (!clip.label) return null;
  const { width, height } = doc.meta;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  clipTimeCache = clip.start + Math.max(0, clip.duration) / 2;
  drawCalloutLabel(ctx, clip, width, height);
  return canvas.toBuffer("image/png");
}
