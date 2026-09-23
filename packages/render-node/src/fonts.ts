/**
 * Register the bundled font library (FONT_LIBRARY, vendored into
 * apps/web/public/fonts by scripts/sync-fonts.ts) with Skia, so the node canvas —
 * and therefore the ffmpeg export, which rasterizes text through it — draws the
 * SAME faces the browser preview loads via @font-face. Idempotent and never throws:
 * if the font directory can't be found, text falls back to each stack's generic
 * family (the historical behavior).
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts } from "@napi-rs/canvas";
import { FONT_LIBRARY, fontFilePath, fontFiles } from "@cadence/core";

let registered: { dir: string | null; count: number } | null = null;

/** Where the vendored fonts live: env override, then the known repo/app layouts. */
export function bundledFontsDir(): string | null {
  const candidates: string[] = [];
  const env = process.env.CADENCE_FONTS_DIR?.trim();
  if (env) candidates.push(env);
  candidates.push(resolve(process.cwd(), "public/fonts"), resolve(process.cwd(), "apps/web/public/fonts"));
  try {
    // packages/render-node/src → repo root → apps/web/public/fonts (tsx / node runs).
    candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/fonts"));
  } catch {
    /* bundled server chunk: import.meta.url may not be a file URL */
  }
  return candidates.find((d) => existsSync(resolve(d, "inter"))) ?? null;
}

/**
 * Register every bundled face with Skia (latin subset — one file per weight/style
 * so family matching is unambiguous). Returns how many files were registered.
 */
export function registerBundledFonts(): { dir: string | null; count: number } {
  if (registered) return registered;
  const dir = bundledFontsDir();
  let count = 0;
  if (dir) {
    for (const face of FONT_LIBRARY) {
      for (const { weight, style } of fontFiles(face)) {
        const file = resolve(dir, fontFilePath(face, "latin", weight, style));
        if (!existsSync(file)) continue;
        try {
          if (GlobalFonts.registerFromPath(file, face.family)) count++;
        } catch {
          /* a bad file must never break rendering */
        }
      }
    }
  }
  registered = { dir, count };
  return registered;
}
