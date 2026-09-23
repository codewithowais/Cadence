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
  calloutTransform,
  cssFilter,
  drawCallout,
  drawCalloutLabel,
  drawCursor,
  drawShape,
  drawSolid,
  drawText,
  drawVfx,
  emphasisScale,
  imageMotion,
  keyframeTransformState,
  sourceTimeAt,
  transitionMotion,
  transitionOpacity,
  type AdjustmentClip,
  type CalloutClip,
  type Clip,
  type CursorClip,
  type EditDoc,
  type ImageClip,
  type Mask,
  type RenderedFrame,
  type RenderEngine,
  type ShapeClip,
  type TextClip,
  type VideoClip,
} from "@cadence/core";

const degToRad = (deg: number): number => (deg * Math.PI) / 180;

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
  const kfs = keyframeTransformState(clip, clipTimeCache);
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
      drawText(ctx, clip, clipTimeCache);
      break;
    case "image":
    case "video": {
      const asset = doc.media.find((m) => m.id === clip.mediaId);
      drawMedia(ctx, clip, asset?.label ?? asset?.src ?? clip.mediaId, tintFor(clip.mediaId), width, height);
      break;
    }
    case "solid":
      drawSolid(ctx, clip, width, height, clipTimeCache);
      break;
    case "shape":
      drawShape(ctx, clip, clipTimeCache);
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
    for (const c of cursors) drawCursor(ctx, c, timeSec);

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
  drawText(ctx, clip, textRestTime(clip));
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
  // Render at the clip MIDPOINT — the full-opacity plateau between transition-in and
  // transition-out (like renderCalloutLabelPng). Rendering exactly at clip end would
  // land on the zero-opacity edge whenever transitionOutSec>0, making drawShape early-
  // return a BLANK PNG → the shape would be invisible for its whole span on export
  // (the export overlays one static PNG per shape). The preview still fades per-frame.
  drawShape(ctx, clip, clip.start + clip.duration / 2);
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
    drawText(ctx, clip, (w.start + w.end) / 2);
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
  drawCalloutLabel(ctx, clip, width, height);
  return canvas.toBuffer("image/png");
}
