/**
 * Node-side color-emoji sprites for the shared canvas `drawText`.
 *
 * Registers an EmojiImageProvider (see @cadence/core emoji-draw) that reads the
 * vendored Twemoji SVGs (apps/web/public/emoji, CC-BY 4.0 — see ATTRIBUTION.md)
 * synchronously from disk and rasterizes them with Skia at a power-of-two size
 * bucket, so the exported PNG overlays / node frames show the same artwork the
 * browser preview draws (no dependency on system emoji fonts). Importing this
 * module registers the provider (idempotent). Never throws: a missing sprite
 * directory just means emoji fall back to the platform glyph.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Image } from "@napi-rs/canvas";
import { emojiBucket, setEmojiImageProvider, type EmojiImageProvider } from "@cadence/core";

let dir: string | null | undefined;

/** Where the vendored sprites live: env override, then the known repo/app layouts. */
export function bundledEmojiDir(): string | null {
  if (dir !== undefined) return dir;
  const candidates: string[] = [];
  const env = process.env.CADENCE_EMOJI_DIR?.trim();
  if (env) candidates.push(env);
  candidates.push(resolve(process.cwd(), "public/emoji"), resolve(process.cwd(), "apps/web/public/emoji"));
  try {
    candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/emoji"));
  } catch {
    /* bundled server chunk: import.meta.url may not be a file URL */
  }
  // turbopackIgnore: runtime lookup of the vendored dir, not a static asset reference.
  dir = candidates.find((d) => existsSync(/* turbopackIgnore: true */ resolve(d, "ATTRIBUTION.md"))) ?? null;
  return dir;
}

const cache = new Map<string, Image | null>();
const MAX = 300;

function load(name: string, bucket: number): Image | null {
  const key = `${name}@${bucket}`;
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    cache.delete(key);
    cache.set(key, hit); // LRU touch
    return hit;
  }
  let img: Image | null = null;
  const d = bundledEmojiDir();
  if (d) {
    const file = resolve(/* turbopackIgnore: true */ d, `${name}.svg`);
    if (existsSync(/* turbopackIgnore: true */ file)) {
      try {
        const svg = readFileSync(/* turbopackIgnore: true */ file, "utf8").replace("<svg ", `<svg width="${bucket}" height="${bucket}" `);
        const im = new Image();
        im.src = Buffer.from(svg);
        if (im.width > 0) img = im;
      } catch {
        img = null;
      }
    }
  }
  cache.set(key, img);
  if (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  return img;
}

const provider: EmojiImageProvider = {
  image(names, px) {
    const bucket = emojiBucket(px);
    for (const n of names) {
      const im = load(n, bucket);
      if (im) return im;
    }
    return null;
  },
};

/** Register the disk provider with the shared drawing code (idempotent). */
export function registerNodeEmoji(): void {
  setEmojiImageProvider(provider);
}

registerNodeEmoji();
