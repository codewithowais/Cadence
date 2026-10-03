/**
 * VERIFY — render/engine debt (Cycle J, S7.x). Kept in its own module so the big
 * verify.ts only gains ONE import + ONE call (merge-friendly). Every check fails
 * loudly via process.exit(1), like the main gate.
 *
 *   71 export z-order: shapes/text/layers composite in TRACK order (a shape above
 *      text covers it; text above a shape stays readable); hidden text exports nothing;
 *      a mid-stack adjustment grades only what is beneath it — plan + a real encode
 */
import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { parseEditDoc, type EditDoc } from "@cadence/core";
import {
  buildExportPlan,
  detectFfmpeg,
  resolveFfmpegBin,
  runExport,
  zOrderedOverlayItems,
} from "@cadence/render-ffmpeg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", ".cadence", "render-debt");

function fail(msg: string): never {
  console.error(`\n\x1b[31m✖ VERIFY FAILED:\x1b[0m ${msg}\n`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}
const ok = (line: string): void => console.log(`  \x1b[32m✔\x1b[0m ${line}`);

/** Synthesize a short source clip with ffmpeg lavfi (null when ffmpeg is absent). */
async function ensureSource(name: string): Promise<{ bin: string; src: string } | null> {
  const info = await detectFfmpeg();
  if (!info.available) return null;
  const bin = resolveFfmpegBin();
  mkdirSync(OUT, { recursive: true });
  const src = resolve(OUT, name);
  const r = spawnSync(
    bin,
    ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=0x303a44:s=640x480:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src],
    { encoding: "utf8" },
  );
  assert(r.status === 0, `render-debt: could not synthesize source (${(r.stderr || "").slice(-200)})`);
  return { bin, src };
}

/** Export `doc` for real, then grab the frame at `t` as RGBA pixels. */
export async function exportFrame(
  doc: EditDoc,
  resolveMedia: (id: string) => string,
  t: number,
  tag: string,
): Promise<{ w: number; h: number; px: Uint8ClampedArray }> {
  const bin = resolveFfmpegBin();
  mkdirSync(OUT, { recursive: true });
  const outFile = resolve(OUT, `${tag}.mp4`);
  rmSync(outFile, { force: true });
  await runExport(doc, { outFile, resolveMediaPath: resolveMedia });
  const png = resolve(OUT, `${tag}.png`);
  const r = spawnSync(bin, ["-hide_banner", "-y", "-ss", String(t), "-i", outFile, "-frames:v", "1", png], { encoding: "utf8" });
  assert(r.status === 0, `render-debt[${tag}]: could not extract a frame (${(r.stderr || "").slice(-200)})`);
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, px: ctx.getImageData(0, 0, img.width, img.height).data };
}

/** Count pixels in the rect that are near-white (text glyphs). */
export function countNear(px: Uint8ClampedArray, w: number, rect: [number, number, number, number], pred: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = rect[1]; y < rect[3]; y++) {
    for (let x = rect[0]; x < rect[2]; x++) {
      const i = (y * w + x) * 4;
      if (pred(px[i]!, px[i + 1]!, px[i + 2]!)) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 71 · export z-order
// ---------------------------------------------------------------------------

function zDoc(order: ("text" | "shape")[], opts: { hiddenText?: boolean } = {}): EditDoc {
  const textTrack = {
    id: "t_text",
    kind: "visual" as const,
    ...(opts.hiddenText ? { hidden: true } : {}),
    clips: [{ id: "txt", kind: "text" as const, start: 0, duration: 3, text: "ZORDER", fontSize: 150, fontWeight: "bold" as const, color: "#ffffff", transform: { x: 320, y: 240 } }],
  };
  const shapeTrack = {
    id: "t_shape",
    kind: "visual" as const,
    clips: [{ id: "shp", kind: "shape" as const, shape: "rect" as const, start: 0, duration: 3, w: 560, h: 260, fill: "#d62828", transform: { x: 320, y: 240 } }],
  };
  return parseEditDoc({
    version: 1,
    meta: { title: "z", width: 640, height: 480, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "v", transform: { x: 320, y: 240 } }] },
      ...order.map((k) => (k === "text" ? textTrack : shapeTrack)),
    ],
  });
}

function ovMaps(doc: EditDoc): { text: Map<string, string>; shape: Map<string, string> } {
  const text = new Map<string, string>();
  const shape = new Map<string, string>();
  for (const t of doc.tracks) for (const c of t.clips) {
    if (c.kind === "text") text.set(c.id, `/ov/${c.id}.png`);
    if (c.kind === "shape") shape.set(c.id, `/ov/${c.id}.png`);
  }
  return { text, shape };
}

export async function checkExportZOrder(): Promise<void> {
  const resolveP = (id: string) => `/media/${id}.mp4`;
  const planOf = (doc: EditDoc): string => {
    const m = ovMaps(doc);
    return buildExportPlan(doc, resolveP, "/out/z.mp4", m.text, undefined, undefined, m.shape).filterComplex;
  };

  // (a) plan order follows TRACK order in both directions.
  const textOverShape = planOf(zDoc(["shape", "text"]));
  const shapeOverText = planOf(zDoc(["text", "shape"]));
  assert(textOverShape.indexOf("vshape0") < textOverShape.indexOf("vtext0"), "shape track below text track must composite FIRST (text on top)");
  assert(shapeOverText.indexOf("vtext0") < shapeOverText.indexOf("vshape0"), "text track below shape track must composite FIRST (shape on top) — the old fixed text→shape order broke this only one way");
  assert(shapeOverText.indexOf("vtext0") < shapeOverText.indexOf("vshape0"), "z-order: shape above text");

  // (b) zOrderedOverlayItems is a pure sort by (track, start).
  const d = zDoc(["text", "shape"]);
  const items = zOrderedOverlayItems(d, { layers: [], texts: [d.tracks[1]!.clips[0] as never], shapes: [d.tracks[2]!.clips[0] as never], adjustments: [] });
  assert(items.map((i) => i.kind).join() === "text,shape", `z items should be text,shape — got ${items.map((i) => i.kind).join()}`);

  // (c) a hidden text track exports nothing.
  const hidden = planOf(zDoc(["shape", "text"], { hiddenText: true }));
  assert(!hidden.includes("vtext"), "a hidden text track must not be overlaid on export");

  // (d) an adjustment BELOW a caption track grades only what is beneath it (inline in
  //     z-order, before the text overlay); on top it stays the final grade.
  const adjBelow = parseEditDoc({
    version: 1,
    meta: { title: "adj", width: 640, height: 480, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "v", transform: { x: 320, y: 240 } }] },
      { id: "adjustments", kind: "visual", clips: [{ id: "a0", kind: "adjustment", start: 0, duration: 3, grade: { saturation: 0 } }] },
      { id: "captions", kind: "visual", clips: [{ id: "txt", kind: "text", start: 0, duration: 3, text: "cap", transform: { x: 320, y: 400 } }] },
    ],
  });
  const m = ovMaps(adjBelow);
  const fcBelow = buildExportPlan(adjBelow, resolveP, "/out/a.mp4", m.text).filterComplex;
  assert(fcBelow.indexOf("vadj0") !== -1 && fcBelow.indexOf("vadj0") < fcBelow.indexOf("vtext0"), "adjustment under captions must grade BEFORE the caption overlay (captions stay ungraded)");
  const adjTop = parseEditDoc({ ...adjBelow, tracks: [adjBelow.tracks[0], adjBelow.tracks[2], adjBelow.tracks[1]] });
  const fcTop = buildExportPlan(adjTop, resolveP, "/out/a.mp4", ovMaps(adjTop).text).filterComplex;
  assert(fcTop.indexOf("vtext0") < fcTop.indexOf("vadj0"), "a topmost adjustment stays the final grade (after text) — historical behavior");

  // (e) REAL encode: red rect ABOVE white text hides the glyphs; text ABOVE the rect shows them.
  const s = await ensureSource("z-src.mp4");
  let real = "plan-only (ffmpeg absent)";
  if (s) {
    const resolveMedia = (): string => s.src;
    const white = (r: number, g: number, b: number): boolean => r > 220 && g > 220 && b > 220;
    const rect: [number, number, number, number] = [60, 150, 580, 330];
    const a = await exportFrame(zDoc(["text", "shape"]), resolveMedia, 1, "z-shape-over-text");
    const b = await exportFrame(zDoc(["shape", "text"]), resolveMedia, 1, "z-text-over-shape");
    const wa = countNear(a.px, a.w, rect, white);
    const wb = countNear(b.px, b.w, rect, white);
    assert(wa < 200, `shape ABOVE text must cover the glyphs, but ${wa} white pixels leaked`);
    assert(wb > 2500, `text ABOVE a shape must stay readable, only ${wb} white pixels`);
    real = `real encode: glyph pixels ${wa} (covered) vs ${wb} (on top)`;
  }
  ok(`check 71 (export z-order): text/shape/layer overlays composite in TRACK order both ways; hidden text track skipped; mid-stack adjustment grades only what is beneath (topmost stays final); ${real}`);
}

export async function checkRenderDebt(): Promise<void> {
  await checkExportZOrder();
}

if (process.argv[1]?.endsWith("verify-render-debt.ts")) {
  checkRenderDebt().then(() => console.log("render-debt checks passed"), (e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
}
