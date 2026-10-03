/**
 * VERIFY — render/engine debt (Cycle J, S7.x). Kept in its own module so the big
 * verify.ts only gains ONE import + ONE call (merge-friendly). Every check fails
 * loudly via process.exit(1), like the main gate.
 *
 *   71 export z-order: shapes/text/layers composite in TRACK order (a shape above
 *      text covers it; text above a shape stays readable); hidden text exports nothing;
 *      a mid-stack adjustment grades only what is beneath it — plan + a real encode
 *   72 karaoke styles + 6 caption presets: pop/underline/glow render a distinct active
 *      word on the shared canvas; every preset applies + renders; set_caption_preset
 *      tool + stub routing; a REAL export shows the highlight color stepping word to word
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  BUNDLED_LUTS,
  BUNDLED_LUT_SIZE,
  bundledLut,
  lutApprox,
  lutSvgFilter,
  lutToCube,
  parseCube,
  parseEditDoc,
  sampleLut,
  sourceSpanSec,
  sourceTimeAt,
  type EditDoc,
  type TextClip,
  type VideoClip,
} from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";
import type { Transcript } from "@cadence/understanding";
import { addCaptions, applyCaptionPreset, CAPTION_PRESETS, DIRECTOR_TOOLS, ProjectState, setSpeedRamp, StubDirector } from "@cadence/director";
import {
  buildExportPlan,
  bundledLutFile,
  rampSegmentBounds,
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

// ---------------------------------------------------------------------------
// 72 · karaoke styles + caption presets
// ---------------------------------------------------------------------------

function karaokeBase(): { doc: EditDoc; transcript: Transcript } {
  const doc = parseEditDoc({
    version: 1,
    meta: { title: "k", width: 640, height: 480, fps: 30, background: "#101418" },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 30 }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 3, sourceIn: 0, mediaId: "v", transform: { x: 320, y: 240 } }] }],
  });
  const transcript: Transcript = {
    mediaId: "v", durationSec: 3, language: "en",
    segments: [{ id: "s0", start: 0, end: 3, text: "grow fast now", words: [
      { text: "grow", start: 0, end: 1 }, { text: "fast", start: 1, end: 2 }, { text: "now", start: 2, end: 3 },
    ] }],
    words: [],
  };
  return { doc, transcript };
}

const hexToRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Centroid x + count of pixels within `tol` of the highlight color. */
function colorCentroid(px: Uint8ClampedArray, w: number, h: number, hex: string, tol = 40): { n: number; cx: number } {
  const [tr, tg, tb] = hexToRgb(hex);
  let n = 0;
  let sx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(px[i]! - tr) < tol && Math.abs(px[i + 1]! - tg) < tol && Math.abs(px[i + 2]! - tb) < tol) {
        n++;
        sx += x;
      }
    }
  }
  return { n, cx: n ? sx / n : -1 };
}

export async function checkKaraokePresets(): Promise<void> {
  const engine = new CanvasRenderEngine();
  const { doc: base, transcript } = karaokeBase();
  const frame = async (d: EditDoc, t: number): Promise<Buffer> => Buffer.from((await engine.renderFrame(d, t)).data);

  // (a) the three NEW styles each render a distinct active word, and differ from "color".
  const styled = (style: string): EditDoc => addCaptions(base, transcript, { karaoke: true, karaokeStyle: style as never });
  const colorAt = await frame(styled("color"), 1.5);
  for (const style of ["pop", "underline", "glow"]) {
    const d = styled(style);
    const cap = d.tracks.find((t) => t.id === "captions")!.clips[0] as TextClip;
    assert(cap.karaoke?.style === style, `karaoke style ${style} must round-trip through the schema`);
    const a = await frame(d, 0.5);
    const b = await frame(d, 1.5);
    assert(!a.equals(b), `karaoke ${style}: different active words must render distinct pixels`);
    assert(!b.equals(colorAt), `karaoke ${style}: must look different from the plain color style`);
  }

  // (b) all 6 presets apply (style + karaoke + anim), parse, and render at an active-word time.
  assert(CAPTION_PRESETS.length === 6, `expected 6 caption presets, got ${CAPTION_PRESETS.length}`);
  const seen = new Set<string>();
  const captioned = addCaptions(base, transcript);
  for (const p of CAPTION_PRESETS) {
    const d = applyCaptionPreset(captioned, p.key);
    const cap = d.tracks.find((t) => t.id === "captions")!.clips[0] as TextClip;
    assert(cap.karaoke?.enabled === true, `preset ${p.key} must enable karaoke`);
    assert((cap.words?.length ?? 0) === 3, `preset ${p.key} must keep per-word timing`);
    const f = await frame(d, 1.5);
    assert(f.length > 1000, `preset ${p.key} must render`);
    seen.add(`${cap.fontFamily}|${cap.karaoke?.style}|${cap.karaoke?.highlight}`);
  }
  assert(seen.size === 6, `the 6 presets must be visually distinct (font+style+color), got ${seen.size}`);
  let threw = false;
  try {
    applyCaptionPreset(captioned, "nope");
  } catch {
    threw = true;
  }
  assert(threw, "an unknown preset must throw a helpful error");

  // (c) Director tool + StubDirector routing.
  const mk = (): ProjectState => {
    const p = new ProjectState({ media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 30 }] });
    p.setDoc(base);
    p.setTranscript(transcript);
    return p;
  };
  const project = mk();
  await DIRECTOR_TOOLS.add_captions!.execute({ karaoke: true }, { project });
  await DIRECTOR_TOOLS.set_caption_preset!.execute({ preset: "hormozi" }, { project });
  const tc = project.doc.tracks.find((t) => t.id === "captions")!.clips[0] as TextClip;
  assert(tc.karaoke?.style === "pop" && tc.karaoke.highlight === "#ffe14a", "set_caption_preset hormozi → yellow pop karaoke");
  const r = await new StubDirector().interpret("add hormozi style captions", mk());
  assert(r.toolCalls.some((c) => c.name === "set_caption_preset"), "StubDirector must route 'hormozi captions' to set_caption_preset");
  assert(r.toolCalls.some((c) => c.name === "add_captions"), "…and add the karaoke captions first");

  // (d) REAL export: the highlight color moves word → word, and Hormozi's pop is exported.
  const s = await ensureSource("karaoke-src.mp4");
  let real = "plan-only (ffmpeg absent)";
  if (s) {
    const d = parseEditDoc({ ...applyCaptionPreset(captioned, "hormozi"), media: [{ id: "v", kind: "video", src: s.src, durationSec: 30 }] });
    const resolveMedia = (): string => s.src;
    const e0 = await exportFrame(d, resolveMedia, 0.5, "karaoke-w0");
    const e2 = await exportFrame(d, resolveMedia, 2.5, "karaoke-w2");
    const c0 = colorCentroid(e0.px, e0.w, e0.h, "#ffe14a");
    const c2 = colorCentroid(e2.px, e2.w, e2.h, "#ffe14a");
    assert(c0.n > 150 && c2.n > 150, `exported karaoke must show the highlight color (n=${c0.n}/${c2.n})`);
    assert(c2.cx > c0.cx + 40, `highlight must step left→right across words on export (cx ${c0.cx.toFixed(0)} → ${c2.cx.toFixed(0)})`);
    real = `real encode: highlight centroid x ${c0.cx.toFixed(0)} → ${c2.cx.toFixed(0)}`;
  }
  ok(`check 72 (karaoke styles + presets): pop/underline/glow styles distinct on the shared canvas; 6 caption presets apply+render distinct; set_caption_preset tool + stub routing; ${real}`);
}

// ---------------------------------------------------------------------------
// 73 · speed-ramp presets (montage / hero-time / bullet-time / flash-in)
// ---------------------------------------------------------------------------

export async function checkSpeedRampPresets(): Promise<void> {
  const resolveP = (id: string) => `/media/${id}.mp4`;
  const names = ["montage", "hero-time", "bullet-time", "flash-in"] as const;
  const mk = (): EditDoc =>
    parseEditDoc({
      version: 1,
      meta: { title: "ramp", width: 640, height: 480, fps: 30 },
      media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 6 }],
      tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "v", sourceIn: 0, transform: { x: 320, y: 240 } }] }],
    });

  // (a) engine: every preset applies (+ tool/stub), source-time is monotonic, and the
  //     export segments land ON the control points (montage keeps all 3 whips).
  const bounds: Record<string, number> = {};
  for (const name of names) {
    const d = setSpeedRamp(mk(), { preset: name });
    const clip = d.tracks[0]!.clips[0] as VideoClip;
    assert(clip.speedRamp && clip.speedRamp.length >= 3, `${name}: ramp must be set`);
    let prev = -1;
    for (let i = 0; i <= 30; i++) {
      const st = sourceTimeAt(clip, (3 * i) / 30);
      assert(st >= prev - 1e-9, `${name}: source time must be monotonic`);
      prev = st;
    }
    const span = sourceSpanSec(clip);
    assert(span <= 6.001, `${name}: ramp consumes ${span.toFixed(2)}s of source (fixture is 6s)`);
    const b = rampSegmentBounds(clip.speedRamp, clip.duration);
    bounds[name] = b.length - 1;
    for (const [p] of clip.speedRamp) assert(b.some((x) => Math.abs(x - p) < 1e-5), `${name}: a segment boundary must sit on control point ${p}`);
    const plan = buildExportPlan(d, resolveP, "/out/r.mp4");
    const segs = (plan.filterComplex.match(/setpts=\(PTS-STARTPTS\)\//g) ?? []).length;
    assert(segs === b.length - 1, `${name}: export must emit ${b.length - 1} segments, got ${segs}`);
    assert(new RegExp(`concat=n=${b.length - 1}:v=1:a=0\\[v0\\]`).test(plan.filterComplex), `${name}: concat count must match segment count`);
  }
  assert(bounds.montage! > 8, `montage must segment finer than the old uniform 8 (got ${bounds.montage})`);
  // A plain 2-point ramp keeps the historical 8 uniform segments (byte-identical).
  assert(rampSegmentBounds([[0, 0.4], [1, 2.5]]).length - 1 === 8, "2-point ramps keep the 8 even segments");

  // (b) tool + stub routing.
  const project = new ProjectState({ media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 6 }] });
  project.setDoc(mk());
  await DIRECTOR_TOOLS.set_speed_ramp!.execute({ preset: "flash-in" }, { project });
  assert(((project.doc.tracks[0]!.clips[0] as VideoClip).speedRamp?.[0]?.[1] ?? 0) === 4, "set_speed_ramp flash-in → starts at 4x");
  for (const [phrase, preset] of [["add a bullet time speed ramp", "bullet-time"], ["hero time slow motion on the clip", "hero-time"], ["montage speed ramp", "montage"], ["flash in at the start", "flash-in"]] as const) {
    const p = new ProjectState({ media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 6 }] });
    p.setDoc(mk());
    const r = await new StubDirector().interpret(phrase, p);
    const call = r.toolCalls.find((c) => c.name === "set_speed_ramp");
    assert(call && (call.input as { preset?: string }).preset === preset, `StubDirector: "${phrase}" must route to set_speed_ramp ${preset} (got ${JSON.stringify(r.toolCalls.map((c) => c.name))})`);
  }

  // (c) REAL encode: the exported picture follows the curve. The source encodes its own
  //     time as luminance (lum = 255·T/6), so the luma of the exported frame at timeline
  //     t reads back the SOURCE time the export actually played.
  const info = await detectFfmpeg();
  let real = "plan-only (ffmpeg absent)";
  if (info.available) {
    const bin = resolveFfmpegBin();
    mkdirSync(OUT, { recursive: true });
    const src = resolve(OUT, "ramp-time-src.mp4");
    const r = spawnSync(bin, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=black:s=640x480:r=30:d=6,format=gray,geq=lum='255*T/6'", "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", "-an", src], { encoding: "utf8" });
    assert(r.status === 0, `ramp fixture failed: ${(r.stderr || "").slice(-200)}`);
    let worst = 0;
    for (const name of ["montage", "hero-time"] as const) {
      const d = parseEditDoc({ ...setSpeedRamp(mk(), { preset: name }), media: [{ id: "v", kind: "video", src, durationSec: 6 }] });
      const clip = d.tracks[0]!.clips[0] as VideoClip;
      for (const t of [0.4, 1.0, 1.6, 2.2, 2.7]) {
        const f = await exportFrame(d, () => src, t, `ramp-${name}-${Math.round(t * 10)}`);
        const lum = countMean(f.px, f.w, [200, 150, 440, 330]);
        const est = (lum / 255) * 6;
        const want = sourceTimeAt(clip, t);
        worst = Math.max(worst, Math.abs(est - want));
        if (process.env.RAMP_DEBUG) console.log(`    ${name} t=${t}: export source ${est.toFixed(2)}s vs curve ${want.toFixed(2)}s`);
        assert(Math.abs(est - want) < 0.3, `${name}: at t=${t}s the export played source ${est.toFixed(2)}s but the curve says ${want.toFixed(2)}s`);
      }
    }
    real = `real encode: exported source-time tracks the curve within ${worst.toFixed(2)}s (montage + hero-time)`;
  }
  ok(`check 73 (speed-ramp presets): montage/hero-time/bullet-time/flash-in apply, monotonic, segment boundaries on every control point (montage → ${bounds.montage} segments vs the old uniform 8); set_speed_ramp tool + stub routing; ${real}`);
}

/** Mean red-channel value over a rect (the fixture is gray, so R == luminance). */
function countMean(px: Uint8ClampedArray, w: number, rect: [number, number, number, number]): number {
  let sum = 0;
  let n = 0;
  for (let y = rect[1]; y < rect[3]; y++) {
    for (let x = rect[0]; x < rect[2]; x++) {
      sum += px[(y * w + x) * 4]!;
      n++;
    }
  }
  return sum / Math.max(1, n);
}

// ---------------------------------------------------------------------------
// 74 · LUT: .cube parse + bundled looks + preview approximation + exact export
// ---------------------------------------------------------------------------

export async function checkLutPipeline(): Promise<void> {
  // (a) parse / serialize round-trip + malformed input is rejected loudly.
  const teal = bundledLut("bundled:teal-orange")!;
  assert(teal && teal.size === BUNDLED_LUT_SIZE, "bundled teal-orange LUT must build");
  const again = parseCube(lutToCube(teal));
  let maxDiff = 0;
  for (let i = 0; i < teal.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(teal.data[i]! - again.data[i]!));
  assert(again.size === teal.size && maxDiff < 1e-5, `.cube round-trip drifted (${maxDiff})`);
  const expectThrow = (text: string, what: string): void => {
    let threw = false;
    try {
      parseCube(text);
    } catch {
      threw = true;
    }
    assert(threw, `parseCube must reject ${what}`);
  };
  expectThrow("LUT_1D_SIZE 2\n0 0 0\n1 1 1\n", "a 1-D LUT");
  expectThrow("LUT_3D_SIZE 2\n0 0 0\n1 0 0\n", "a truncated table");
  expectThrow("0 0 0\n", "a file with no LUT_3D_SIZE");
  const withComments = parseCube('# comment\nTITLE "x"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n' + "0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
  const idc = sampleLut(withComments, 0.25, 0.5, 0.75);
  assert(Math.abs(idc[0] - 0.25) < 1e-6 && Math.abs(idc[1] - 0.5) < 1e-6 && Math.abs(idc[2] - 0.75) < 1e-6, "an identity .cube must sample as identity (trilinear)");

  // (b) all 6 bundled looks are distinct, in range, and the preview approximation is close.
  assert(BUNDLED_LUTS.length === 6, `expected 6 bundled looks, got ${BUNDLED_LUTS.length}`);
  const errs: string[] = [];
  const probe = sampleLut(bundledLut("bundled:kodak-warm")!, 0.4, 0.5, 0.6);
  for (const spec of BUNDLED_LUTS) {
    const lut = bundledLut(`bundled:${spec.key}`)!;
    for (const v of lut.data) assert(v >= 0 && v <= 1, `${spec.key}: LUT values must stay in 0..1`);
    const ap = lutApprox(lut);
    assert(ap.meanError < 0.06, `${spec.key}: preview approximation too far from the LUT (mean err ${ap.meanError.toFixed(3)})`);
    errs.push(`${spec.key} ${ap.meanError.toFixed(3)}`);
    const svg = lutSvgFilter("t", ap);
    assert(svg.includes("<feColorMatrix") && svg.includes("<feFuncR"), `${spec.key}: SVG filter must carry a matrix + curves`);
    const o = sampleLut(lut, 0.4, 0.5, 0.6);
    assert(Math.abs(o[0] - probe[0]) + Math.abs(o[1] - probe[1]) + Math.abs(o[2] - probe[2]) > 0 || spec.key === "kodak-warm", `${spec.key}: must differ from kodak-warm`);
  }

  // (c) canvas: a bundled LUT on a clip changes the frame, and the tile colour equals the LUT of the original.
  const mk = (lut?: string): EditDoc =>
    parseEditDoc({
      version: 1,
      meta: { title: "lut", width: 320, height: 180, fps: 30, background: "#000000" },
      media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
      tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 2, mediaId: "v", transform: { x: 160, y: 90 }, look: lut ? { lut } : {} }] }],
    });
  const eng = new CanvasRenderEngine();
  const centre = (png: Buffer): Promise<[number, number, number]> => pixelAt(png, 20, 20);
  const plainPx = await centre(Buffer.from((await eng.renderFrame(mk(), 0.5)).data));
  const lutPx = await centre(Buffer.from((await eng.renderFrame(mk("bundled:teal-orange"), 0.5)).data));
  assert(plainPx.join() !== lutPx.join(), "a bundled LUT must change the canvas frame");
  const expect1 = sampleLut(teal, plainPx[0] / 255, plainPx[1] / 255, plainPx[2] / 255).map((v) => Math.round(v * 255));
  assert(expect1.every((v, i) => Math.abs(v - lutPx[i]!) <= 3), `canvas LUT pixel ${lutPx} must equal the exact LUT of ${plainPx} = ${expect1}`);
  // adjustment layer + LUT grades the whole frame exactly
  const adj = parseEditDoc({ ...mk(), tracks: [...mk().tracks, { id: "adjustments", kind: "visual", clips: [{ id: "a0", kind: "adjustment", start: 0, duration: 2, grade: { lut: "bundled:noir" } }] }] });
  const adjPx = await centre(Buffer.from((await eng.renderFrame(adj, 0.5)).data));
  assert(Math.abs(adjPx[0] - adjPx[1]) <= 2 && Math.abs(adjPx[1] - adjPx[2]) <= 2, `an adjustment layer with the noir LUT must desaturate the frame (got ${adjPx})`);

  // (d) tool + stub + the bare-key shorthand.
  const project = new ProjectState({ media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 5 }] });
  project.setDoc(mk());
  await DIRECTOR_TOOLS.apply_lut!.execute({ lut: "film-fade" }, { project });
  assert((project.doc.tracks[0]!.clips[0] as VideoClip).look.lut === "bundled:film-fade", "apply_lut with a bare key → bundled:<key>");
  const p2 = new ProjectState({ media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 5 }] });
  p2.setDoc(mk());
  const r = await new StubDirector().interpret("give it a teal and orange look", p2);
  assert(r.toolCalls.some((c) => c.name === "apply_lut"), `StubDirector must route 'teal and orange' to apply_lut (got ${r.toolCalls.map((c) => c.name)})`);

  // (e) plan: lut3d with the materialized file; REAL encode matches the exact LUT.
  const resolveP = (id: string): string => (id.startsWith("bundled:") ? bundledLutFile(id) : `/media/${id}.mp4`);
  const plan = buildExportPlan(mk("bundled:teal-orange"), resolveP, "/out/l.mp4");
  assert(/lut3d=file=[^,;\[]*teal-orange-v1\.cube/.test(plan.filterComplex), `bundled LUT must export as lut3d on a materialized .cube, got ${plan.filterComplex.slice(0, 300)}`);
  const s = await ensureSource("lut-src.mp4");
  let real = "plan-only (ffmpeg absent)";
  if (s) {
    const flat = (lut: string | undefined): EditDoc => parseEditDoc({ ...mk(lut), media: [{ id: "v", kind: "video", src: s.src, durationSec: 3 }] });
    const base = await exportFrame(flat(undefined), () => s.src, 1, "lut-none");
    const px0 = pxOf(base, 160, 90);
    const teal1 = pxOf(await exportFrame(flat("bundled:teal-orange"), () => s.src, 1, "lut-bundled"), 160, 90);
    const exp = sampleLut(teal, px0[0] / 255, px0[1] / 255, px0[2] / 255).map((v) => Math.round(v * 255));
    assert(exp.every((v, i) => Math.abs(v - teal1[i]!) <= 10), `real export: bundled LUT pixel ${teal1} must match the exact LUT ${exp} of ${px0}`);
    assert(teal1.join() !== px0.join(), "real export must actually grade the frame");
    // an IMPORTED .cube file (invert) through the same lut3d path
    const inv = ["LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r2 = 0; r2 < 2; r2++) inv.push(`${1 - r2} ${1 - g} ${1 - b}`);
    const cubePath = resolve(OUT, "invert.cube");
    writeFileSync(cubePath, inv.join("\n") + "\n");
    const imp = parseEditDoc({ ...flat(undefined), tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 2, mediaId: "v", transform: { x: 160, y: 90 }, look: { lut: cubePath } }] }] });
    const invPx = pxOf(await exportFrame(imp, (id) => (id === cubePath ? cubePath : s.src), 1, "lut-import"), 160, 90);
    assert(invPx.every((v, i) => Math.abs(v - (255 - px0[i]!)) <= 10), `imported invert.cube must invert the frame: got ${invPx}, want ${px0.map((v) => 255 - v)}`);
    real = `real encode: bundled teal-orange ${px0}→${teal1} (exact LUT ${exp}); imported invert.cube ${px0}→${invPx}`;
  }
  ok(`check 74 (LUT pipeline): .cube parse/serialize round-trips + rejects 1-D/truncated; 6 bundled looks (preview-fit mean err ${errs.join(", ")}); canvas applies the exact LUT (clip tile + adjustment layer); apply_lut tool + stub routing; ${real}`);
}

function pxOf(f: { w: number; px: Uint8ClampedArray }, x: number, y: number): [number, number, number] {
  const i = (y * f.w + x) * 4;
  return [f.px[i]!, f.px[i + 1]!, f.px[i + 2]!];
}

async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

export async function checkRenderDebt(): Promise<void> {
  await checkExportZOrder();
  await checkKaraokePresets();
  await checkSpeedRampPresets();
  await checkLutPipeline();
}

if (process.argv[1]?.endsWith("verify-render-debt.ts")) {
  checkRenderDebt().then(() => console.log("render-debt checks passed"), (e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
}
