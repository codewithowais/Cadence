/**
 * Browser-side color-emoji sprites for the shared canvas `drawText`.
 *
 * Importing this module registers an EmojiImageProvider (see @cadence/core
 * emoji-draw) that LAZILY loads Twemoji SVGs from /emoji/<hex>.svg (CC-BY 4.0, see
 * public/emoji/ATTRIBUTION.md), rasterized at a power-of-two bucket by stamping a
 * width/height onto the SVG — the same rule render-node uses, so the preview and
 * the export draw the same artwork. A sprite that isn't loaded yet returns null
 * (the draw falls back to the platform glyph for that frame) and subscribers are
 * notified when it arrives so the canvas redraws.
 */
import { emojiBucket, setEmojiImageProvider, type EmojiImageProvider } from "@cadence/core";

type Entry = { state: "loading" } | { state: "missing" } | { state: "ready"; img: HTMLImageElement };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let queued = false;

function notify(): void {
  if (queued) return;
  queued = true;
  const run = (): void => {
    queued = false;
    for (const l of [...listeners]) l();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** Subscribe to "a sprite finished loading"; returns the unsubscribe. */
export function onEmojiLoaded(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The public URL of a sprite. */
export const emojiSpriteUrl = (name: string): string => `/emoji/${name}.svg`;

async function load(key: string, name: string, bucket: number): Promise<void> {
  try {
    const res = await fetch(emojiSpriteUrl(name));
    if (!res.ok) {
      cache.set(key, { state: "missing" });
      return notify();
    }
    const svg = (await res.text()).replace("<svg ", `<svg width="${bucket}" height="${bucket}" `);
    const img = new Image();
    img.decoding = "async";
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    cache.set(key, { state: "ready", img });
  } catch {
    cache.set(key, { state: "missing" });
  }
  notify();
}

const provider: EmojiImageProvider = {
  image(names, px) {
    const bucket = emojiBucket(px);
    for (const name of names) {
      const key = `${name}@${bucket}`;
      const e = cache.get(key);
      if (!e) {
        cache.set(key, { state: "loading" });
        void load(key, name, bucket);
        return null;
      }
      if (e.state === "ready") return e.img;
      if (e.state === "loading") return null;
    }
    return null;
  },
};

if (typeof window !== "undefined") setEmojiImageProvider(provider);

/** Kick off loading sprites (e.g. for the picker's visible cells) without drawing. */
export function preloadEmoji(names: readonly string[], px = 64): void {
  provider.image(names, px);
}

/**
 * Draw one emoji onto a 2D context (picker tiles / chips), loading lazily. Returns
 * true when the sprite was drawn; false means "not ready yet / no art" so the caller
 * can fall back to the platform glyph and retry on `onEmojiLoaded`.
 */
export function drawEmojiSprite(
  ctx: CanvasRenderingContext2D,
  emojiNames: readonly string[],
  x: number,
  y: number,
  size: number,
  devicePx = size,
): boolean {
  const img = provider.image(emojiNames, devicePx) as HTMLImageElement | null;
  if (!img) return false;
  ctx.drawImage(img, x, y, size, size);
  return true;
}
