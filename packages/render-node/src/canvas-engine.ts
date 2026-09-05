/**
 * Headless RenderEngine backed by @napi-rs/canvas (Skia).
 *
 * Runs in plain Node — no browser, no WebCodecs, no system ffmpeg — so it powers
 * the verify gate and offline development. It implements the engine-agnostic
 * `RenderEngine` contract from @cadence/core, so swapping in an Omniclip/WebCodecs
 * or MLT/ffmpeg backend later requires no change to the Director or edit-doc.
 *
 * NOTE (Phase 0): video/image clips are drawn as labeled placeholder tiles.
 * Real media decode/draw is a later vertical slice; the point today is that ANY
 * valid edit-doc renders a real frame that we can assert on.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  activeClipsAt,
  type EditDoc,
  type ImageClip,
  type RenderedFrame,
  type RenderEngine,
  type TextClip,
  type Transform,
  type VideoClip,
} from "@cadence/core";

const degToRad = (deg: number): number => (deg * Math.PI) / 180;

/** Apply a clip transform to the context. Caller must save()/restore() around this. */
function applyTransform(ctx: SKRSContext2D, t: Transform): void {
  ctx.translate(t.x, t.y);
  if (t.rotation !== 0) ctx.rotate(degToRad(t.rotation));
  if (t.scale !== 1) ctx.scale(t.scale, t.scale);
  ctx.globalAlpha = t.opacity;
}

function drawText(ctx: SKRSContext2D, clip: TextClip): void {
  ctx.save();
  applyTransform(ctx, clip.transform);
  ctx.font = `${clip.fontSize}px ${clip.fontFamily}`;
  ctx.fillStyle = clip.color;
  ctx.textAlign = clip.align;
  ctx.textBaseline = "middle";
  ctx.fillText(clip.text, 0, 0);
  ctx.restore();
}

/** Placeholder tile for a media clip until real decode lands. */
function drawMediaPlaceholder(
  ctx: SKRSContext2D,
  clip: VideoClip | ImageClip,
  label: string,
  fill: string,
): void {
  const w = 640;
  const h = 360;
  ctx.save();
  applyTransform(ctx, clip.transform);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, 16);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "28px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

/** Deterministic-ish tint from a string so different media read differently. */
function tintFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffff;
  const hex = (hash & 0x7f7f7f).toString(16).padStart(6, "0");
  return `#${hex}`;
}

export class CanvasRenderEngine implements RenderEngine {
  async renderFrame(doc: EditDoc, timeSec: number): Promise<RenderedFrame> {
    const { width, height, background } = doc.meta;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Background.
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    // Paint active visual clips bottom-to-top.
    for (const { clip } of activeClipsAt(doc, timeSec)) {
      switch (clip.kind) {
        case "text":
          drawText(ctx, clip);
          break;
        case "image": {
          const asset = doc.media.find((m) => m.id === clip.mediaId);
          drawMediaPlaceholder(ctx, clip, asset?.label ?? asset?.src ?? clip.mediaId, tintFor(clip.mediaId));
          break;
        }
        case "video": {
          const asset = doc.media.find((m) => m.id === clip.mediaId);
          drawMediaPlaceholder(ctx, clip, asset?.label ?? asset?.src ?? clip.mediaId, tintFor(clip.mediaId));
          break;
        }
        case "audio":
          // No visual representation.
          break;
      }
    }

    const data = canvas.toBuffer("image/png");
    return { width, height, format: "png", data };
  }
}
