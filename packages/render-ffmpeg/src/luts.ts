/**
 * Bundled-LUT materialization for the export. A `ColorGrade.lut` of `bundled:<key>`
 * names a built-in look (core/lut.ts) with no file behind it; ffmpeg's `lut3d` needs
 * a real `.cube`, so we write the generated table once into a private temp dir and
 * hand the pure planner that path. Deterministic content ⇒ the file is reusable
 * across exports (rewritten only when absent). Impure (fs) — kept out of plan.ts.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledLut, findBundledLut, lutToCube, isBundledLut } from "@cadence/core";
import type { ResolveMediaPath } from "./plan";

/** Write (once) and return the on-disk `.cube` for a `bundled:<key>` id. Throws on an unknown key. */
export function bundledLutFile(id: string): string {
  const spec = findBundledLut(id);
  const lut = bundledLut(id);
  if (!spec || !lut) throw new Error(`Unknown bundled LUT "${id}".`);
  const dir = join(tmpdir(), "cadence-bundled-luts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${spec.key}-v1.cube`);
  if (!existsSync(file)) writeFileSync(file, lutToCube(lut), "utf8");
  return file;
}

/** Wrap a media-path resolver so `bundled:<key>` LUT ids resolve to a generated `.cube`. */
export function withBundledLuts(resolve: ResolveMediaPath): ResolveMediaPath {
  return (idOrPath: string): string => (isBundledLut(idOrPath) ? bundledLutFile(idOrPath) : resolve(idOrPath));
}
