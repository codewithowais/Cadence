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
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  activeClipsAt,
  cssFilter,
  emphasisScale,
  fontWeightToCss,
  imageMotion,
  sourceTimeAt,
  textKinetic,
  transitionMotion,
  transitionOpacity,
  type EditDoc,
  type ImageClip,
  type RenderedFrame,
  type RenderEngine,
  type SolidClip,
  type TextClip,
  type VideoClip,
  type Vfx,
} from "@cadence/core";

const degToRad = (deg: number): number => (deg * Math.PI) / 180;

function drawText(ctx: SKRSContext2D, clip: TextClip): void {
  const op = transitionOpacity(clip, clipTimeCache);
  if (op <= 0) return;
  // Kinetic intro: slide from an offset and scale up, resolved by core (shared
  // with the Stage preview + export so all three agree).
  const kin = textKinetic(clip, clipTimeCache);
  const effScale = clip.transform.scale * kin.scaleMul;
  ctx.save();
  ctx.translate(clip.transform.x + kin.dx, clip.transform.y + kin.dy);
  if (clip.transform.rotation !== 0) ctx.rotate(degToRad(clip.transform.rotation));
  if (effScale !== 1) ctx.scale(effScale, effScale);
  ctx.globalAlpha = op;
  ctx.font = `${fontWeightToCss(clip.fontWeight)} ${clip.fontSize}px ${clip.fontFamily}`;
  ctx.textAlign = clip.align;
  ctx.textBaseline = "middle";

  if (clip.background) {
    const m = ctx.measureText(clip.text);
    const padX = clip.fontSize * 0.4;
    const padY = clip.fontSize * 0.28;
    const w = m.width + padX * 2;
    const h = clip.fontSize + padY * 2;
    const bx = clip.align === "center" ? -w / 2 : clip.align === "right" ? -w + padX : -padX;
    ctx.fillStyle = clip.background;
    ctx.beginPath();
    ctx.roundRect(bx, -h / 2, w, h, h * 0.28);
    ctx.fill();
  }

  // Stroked outline first (under the fill), for readability over busy footage.
  if (clip.outline && clip.outline.width > 0) {
    ctx.lineWidth = clip.outline.width * 2; // half sits under the fill → visible width
    ctx.strokeStyle = clip.outline.color;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(clip.text, 0, 0);
  }

  ctx.fillStyle = clip.color;
  ctx.fillText(clip.text, 0, 0);
  ctx.restore();
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
  const op = tm.fadeOpacity ? transitionOpacity(clip, clipTimeCache) : clip.transform.opacity;
  if (op <= 0 || tm.wipeFrac <= 0) return;

  const motion = clip.kind === "image" ? imageMotion(clip, clipTimeCache) : null;
  // Punch-in emphasis pulses a video clip's scale up over a sub-range (core helper).
  const emphasis = clip.kind === "video" ? emphasisScale(clip, clipTimeCache) : 1;
  // tm.scaleMul carries the "zoom" transition's scale-in (1 for every other type).
  const effScale = clip.transform.scale * (motion ? motion.scale : 1) * emphasis * tm.scaleMul;
  const panX = motion ? motion.panXFrac * frameW : 0;
  const panY = motion ? motion.panYFrac * frameH : 0;

  ctx.save();
  // Slide transition offsets the whole frame (composition px, pre-scale).
  ctx.translate(clip.transform.x + panX + tm.dx, clip.transform.y + panY + tm.dy);
  if (clip.transform.rotation !== 0) ctx.rotate(degToRad(clip.transform.rotation));
  if (effScale !== 1) ctx.scale(effScale, effScale);
  ctx.globalAlpha = op;

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
  ctx.roundRect(-frameW / 2, -frameH / 2, frameW, frameH, 0);
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
  ctx.restore();
}

function drawSolid(ctx: SKRSContext2D, clip: SolidClip, frameW: number, frameH: number): void {
  const op = transitionOpacity(clip, clipTimeCache);
  if (op <= 0) return;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.fillStyle = clip.color;
  ctx.fillRect(0, 0, frameW, frameH);
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

    for (const { clip } of activeClipsAt(doc, timeSec)) {
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
        case "audio":
          break;
      }
    }

    // Whole-frame finishing overlays (vignette / grain / light-leak), over everything.
    drawVfx(ctx, doc.vfx, width, height);

    const data = canvas.toBuffer("image/png");
    return { width, height, format: "png", data };
  }
}
