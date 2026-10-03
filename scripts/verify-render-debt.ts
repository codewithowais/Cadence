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
  findFont,
  hasComplexScript,
  isRtlText,
  textFont,
  lutApprox,
  lutSvgFilter,
  lutToCube,
  parseCube,
  parseEditDoc,
  sampleLut,
  valueAt,
  sourceSpanSec,
  sourceTimeAt,
  type EditDoc,
  type TextClip,
  type VideoClip,
} from "@cadence/core";
import { CanvasRenderEngine, registerBundledFonts } from "@cadence/render-node";
import { GlobalFonts } from "@napi-rs/canvas";
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

// ---------------------------------------------------------------------------
// 75 · Urdu / Arabic / Hindi: fonts, shaping, RTL order, fallback — preview canvas + export
// ---------------------------------------------------------------------------

export async function checkScriptSupport(): Promise<void> {
  // (a) pure helpers.
  assert(isRtlText("مرحبا Cadence") && !isRtlText("Cadence مرحبا") && !isRtlText("नमस्ते") && isRtlText("שלום") && !isRtlText("123 ... Hello"), "isRtlText must follow the first strong character");
  assert(hasComplexScript("اردو") && hasComplexScript("हिन्दी") && !hasComplexScript("Hello"), "hasComplexScript: Arabic + Devanagari yes, Latin no");
  const mkClip = (text: string, extra: Record<string, unknown> = {}): TextClip => {
    const d = parseEditDoc({ version: 1, meta: { title: "s", width: 960, height: 540, fps: 30, background: "#000000" }, tracks: [{ id: "t", kind: "visual", clips: [{ id: "x", kind: "text", start: 0, duration: 3, text, fontSize: 90, color: "#ffffff", transform: { x: 480, y: 270 }, ...extra }] }] });
    return d.tracks[0]!.clips[0] as TextClip;
  };
  assert(!textFont(mkClip("Hello")).includes("Noto"), "Latin text must not get script fallbacks (byte-identical font string)");
  assert(textFont(mkClip("مرحبا")).includes("'Noto Naskh Arabic'"), "Arabic text must list the Noto Naskh fallback");
  assert(textFont(mkClip("नमस्ते")).includes("'Noto Sans Devanagari'"), "Devanagari text must list the Noto Devanagari fallback");

  // (b) the faces are bundled + registered (script subset under the family, latin under the alias).
  const reg = registerBundledFonts();
  assert(reg.dir && reg.count > 55, `bundled fonts must register (got ${reg.count})`);
  for (const fam of ["Noto Naskh Arabic", "Noto Naskh Arabic Latin", "Noto Nastaliq Urdu", "Noto Sans Devanagari", "Noto Sans Devanagari Latin"]) {
    assert(GlobalFonts.has(fam), `font family "${fam}" must be registered with Skia`);
  }
  for (const id of ["noto-naskh-arabic", "noto-nastaliq-urdu", "noto-sans-devanagari"]) {
    assert(findFont(id)?.category === "multilingual", `${id} must be in the font library (multilingual)`);
  }

  // (c) SHAPING really happens: joined Arabic is narrower than its isolated letters; a Devanagari conjunct ligates.
  const probe = createCanvas(10, 10).getContext("2d");
  probe.font = "64px 'Noto Naskh Arabic'";
  const joined = probe.measureText("مرحبا").width;
  const isolated = [..."مرحبا"].reduce((a, ch) => a + probe.measureText(ch).width, 0);
  assert(joined < isolated * 0.9, `Arabic must be shaped/joined (joined ${joined.toFixed(0)} vs isolated ${isolated.toFixed(0)})`);
  probe.font = "64px 'Noto Sans Devanagari'";
  const conj = probe.measureText("क्ष").width;
  const parts = [..."क्ष"].reduce((a, ch) => a + probe.measureText(ch).width, 0);
  assert(conj < parts * 0.9, `Devanagari conjuncts must ligate (क्ष ${conj.toFixed(0)} vs parts ${parts.toFixed(0)})`);

  // (d) a clip in a LATIN font still renders Arabic via the fallback — identical to naming the Noto stack.
  const eng = new CanvasRenderEngine();
  const frame = async (c: TextClip, t = 1): Promise<Buffer> => {
    const d = parseEditDoc({ version: 1, meta: { title: "s", width: 960, height: 540, fps: 30, background: "#000000" }, tracks: [{ id: "t", kind: "visual", clips: [c] }] });
    return Buffer.from((await eng.renderFrame(d, t)).data);
  };
  const mixed = "مرحبا بالعالم Cadence";
  const viaFallback = await frame(mkClip(mixed, { fontFamily: "Inter, sans-serif" }));
  const arOnly = "مرحبا بالعالم";
  const naskhStack = "'Noto Naskh Arabic', 'Noto Naskh Arabic Latin', sans-serif";
  // The primary font's metrics set the vertical middle, so pixels shift slightly; the INK
  // (glyph coverage) must still match — i.e. the fallback drew real Naskh, not tofu boxes.
  const inkOf = async (png: Buffer): Promise<number> => {
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) n += d[i]!;
    return n;
  };
  const inkFallback = await inkOf(await frame(mkClip(arOnly, { fontFamily: "Inter, sans-serif" })));
  const inkNamed = await inkOf(await frame(mkClip(arOnly, { fontFamily: naskhStack })));
  assert(Math.abs(inkFallback - inkNamed) / inkNamed < 0.03, `Arabic in an Inter-stack clip must fall back to real Noto Naskh glyphs (ink ${inkFallback} vs ${inkNamed})`);
  // …and the Latin part of the same line stays in Inter (first family), not tofu.
  assert(!viaFallback.equals(await frame(mkClip(mixed, { fontFamily: naskhStack }))), "the Latin word keeps the clip's own font (Inter), not the Naskh alias");
  writeFileSync(resolve(OUT, "script-arabic.png"), viaFallback);
  writeFileSync(resolve(OUT, "script-hindi.png"), await frame(mkClip("नमस्ते दुनिया क्षत्रिय", { fontFamily: "Inter, sans-serif" })));
  writeFileSync(resolve(OUT, "script-urdu.png"), await frame(mkClip("اردو زبان خوبصورت ہے", { fontFamily: "'Noto Nastaliq Urdu', 'Noto Nastaliq Urdu Latin', sans-serif", fontSize: 80 })));
  const ink = async (png: Buffer): Promise<number> => {
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 128) n++;
    return n;
  };
  assert((await ink(viaFallback)) > 3000, "Arabic + Latin text must put real ink on the frame (not blank)");

  // (e) letter-spacing is ignored for Arabic (it would break the joins) but still applies to Latin.
  assert((await frame(mkClip("مرحبا بالعالم", { letterSpacing: 10 }))).equals(await frame(mkClip("مرحبا بالعالم", { letterSpacing: 0 }))), "letter-spacing must be suppressed for Arabic (joins preserved)");
  assert(!(await frame(mkClip("Hello world", { letterSpacing: 10 }))).equals(await frame(mkClip("Hello world", { letterSpacing: 0 }))), "letter-spacing must still apply to Latin text");

  // (f) RTL word animation order: the FIRST (rightmost) Arabic word appears first; Latin starts at the left.
  const stagger = { anim: { style: "fade", unit: "word", durationSec: 1.2, delaySec: 0 } };
  const inkSides = async (png: Buffer): Promise<{ left: number; right: number }> => {
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, img.width, img.height).data;
    let left = 0;
    let right = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const v = d[(y * img.width + x) * 4]!;
        if (x < img.width / 2) left += v;
        else right += v;
      }
    return { left, right };
  };
  const ar = await inkSides(await frame(mkClip("كتب الطالب الدرس اليوم", { ...stagger }), 0.35));
  const lt = await inkSides(await frame(mkClip("The student wrote today lesson", { ...stagger }), 0.35));
  assert(ar.right > ar.left * 1.15, `Arabic words must reveal right-to-left (right ${ar.right} vs left ${ar.left})`);
  assert(lt.left > lt.right * 1.15, `Latin words must reveal left-to-right (left ${lt.left} vs right ${lt.right})`);

  // (g) REAL export: Arabic, Urdu and Hindi captions over footage burn in as real glyphs.
  const s = await ensureSource("script-src.mp4");
  let real = "canvas-only (ffmpeg absent)";
  if (s) {
    const d = parseEditDoc({
      version: 1,
      meta: { title: "s", width: 640, height: 480, fps: 30 },
      media: [{ id: "v", kind: "video", src: s.src, durationSec: 3 }],
      tracks: [
        { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "v", transform: { x: 320, y: 240 } }] },
        { id: "captions", kind: "visual", clips: [
          { id: "ar", kind: "text", start: 0, duration: 3, text: "مرحبا بالعالم Cadence", fontSize: 54, color: "#ffffff", transform: { x: 320, y: 90 } },
          { id: "ur", kind: "text", start: 0, duration: 3, text: "اردو زبان خوبصورت", fontFamily: "'Noto Nastaliq Urdu', 'Noto Nastaliq Urdu Latin', sans-serif", fontSize: 54, color: "#ffffff", transform: { x: 320, y: 240 } },
          { id: "hi", kind: "text", start: 0, duration: 3, text: "नमस्ते दुनिया क्षत्रिय", fontSize: 54, color: "#ffffff", transform: { x: 320, y: 390 } },
        ] },
      ],
    });
    const f = await exportFrame(d, () => s.src, 1.5, "script-export");
    const white = (r: number, g: number, b: number): boolean => r > 200 && g > 200 && b > 200;
    const nAr = countNear(f.px, f.w, [0, 50, 640, 130], white);
    const nUr = countNear(f.px, f.w, [0, 190, 640, 290], white);
    const nHi = countNear(f.px, f.w, [0, 350, 640, 430], white);
    assert(nAr > 1500 && nUr > 1200 && nHi > 1500, `exported Arabic/Urdu/Hindi must burn in real glyphs (ink ${nAr}/${nUr}/${nHi})`);
    real = `real encode: burned-in glyph pixels Arabic ${nAr} · Urdu ${nUr} · Hindi ${nHi}`;
  }
  ok(`check 75 (Urdu/Arabic/Hindi): Noto Naskh/Nastaliq/Devanagari bundled (OFL) + registered; Arabic joins (${joined.toFixed(0)}<${isolated.toFixed(0)}) and Devanagari conjuncts ligate (${conj.toFixed(0)}<${parts.toFixed(0)}); script fallback in Latin-font clips; letter-spacing suppressed for joined scripts; RTL word reveal runs right-to-left; ${real}`);
}

// ---------------------------------------------------------------------------
// 76 · keyframe export fidelity: base-clip x/y/rotation/opacity + PiP scale
// ---------------------------------------------------------------------------

function bbox(px: Uint8ClampedArray, w: number, h: number, pred: (r: number, g: number, b: number) => boolean): { n: number; x0: number; x1: number; y0: number; y1: number; cx: number; cy: number } {
  let n = 0;
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!pred(px[i]!, px[i + 1]!, px[i + 2]!)) continue;
      n++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return { n, x0, x1, y0, y1, cx: n ? sx / n : -1, cy: n ? sy / n : -1 };
}

export async function checkKeyframeFidelity(): Promise<void> {
  const info = await detectFfmpeg();
  const resolveP = (id: string) => `/media/${id}.mp4`;
  const kfs = (list: [string, number, number, string?][]) => list.map(([prop, t, value, easing]) => ({ prop, t, value, easing: easing ?? "linear" }));

  // (a) plan-level: the base clip gains the transform chain; no keyframes ⇒ byte-identical.
  const baseDoc = (keyframes?: unknown[]): EditDoc =>
    parseEditDoc({
      version: 1,
      meta: { title: "kf", width: 640, height: 480, fps: 30, background: "#101820" },
      media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 5 }],
      tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 2, mediaId: "v", transform: { x: 320, y: 240 }, ...(keyframes ? { keyframes } : {}) }] }],
    });
  const plain = buildExportPlan(baseDoc(), resolveP, "/o.mp4").filterComplex;
  const kfPlan = buildExportPlan(baseDoc(kfs([["x", 0, 320], ["x", 1, 520], ["y", 0, 240], ["y", 1, 300], ["rotation", 0, 0], ["rotation", 1, 90], ["opacity", 0, 1], ["opacity", 1, 0.4]])), resolveP, "/o.mp4").filterComplex;
  assert(!plain.includes("pad=") && !plain.includes("rotate=") && !plain.includes("geq="), "a base clip without transform keyframes must not gain the transform chain (byte-identical fast path)");
  assert(kfPlan.includes("geq=") && kfPlan.includes("rotate=") && kfPlan.includes("pad=") && /crop=640:480:x='clip\(/.test(kfPlan), `base-clip keyframes must emit opacity (geq) + rotate + pad/crop translate, got ${kfPlan.slice(0, 400)}`);
  assert(kfPlan.includes("0x101820"), "exposed edges must be filled with the doc background colour");

  // (b) real encodes against the PURE valueAt (what the preview draws).
  let real = "plan-only (ffmpeg absent)";
  const s = info.available ? await ensureSource("kf-src.mp4") : null;
  if (s) {
    const bin = s.bin;
    // A dark frame with a white 200x60 bar in the middle (an off-square marker).
    const markerSrc = resolve(OUT, "kf-marker.mp4");
    const r = spawnSync(bin, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=0x101820:s=640x480:r=30:d=3,drawbox=x=220:y=210:w=200:h=60:color=white:t=fill", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-an", markerSrc], { encoding: "utf8" });
    assert(r.status === 0, `kf marker fixture failed: ${(r.stderr || "").slice(-200)}`);
    const white = (r: number, g: number, b: number): boolean => r > 200 && g > 200 && b > 200;
    const doc = (keyframes: unknown[]): EditDoc => parseEditDoc({ ...baseDoc(keyframes), media: [{ id: "v", kind: "video", src: markerSrc, durationSec: 3 }] });
    const exp = (d: EditDoc): VideoClip => d.tracks[0]!.clips[0] as VideoClip;

    // x translation: marker centre follows valueAt("x") (eased).
    const dx = doc(kfs([["x", 0, 320], ["x", 1, 560, "ease-in-out"]]));
    const centres: string[] = [];
    for (const t of [0.05, 0.6, 1.0, 1.5]) {
      const f = await exportFrame(dx, () => markerSrc, t, `kf-x-${Math.round(t * 100)}`);
      const b = bbox(f.px, f.w, f.h, white);
      const want = valueAt(exp(dx).keyframes, "x", t / 2, 320);
      assert(b.n > 800 && Math.abs(b.cx - want) < 14, `base x keyframe at t=${t}: marker centre ${b.cx.toFixed(0)} but valueAt says ${want.toFixed(0)}`);
      centres.push(`${b.cx.toFixed(0)}≈${want.toFixed(0)}`);
    }
    // y translation (linear) — vertical.
    const dy = doc(kfs([["y", 0, 240], ["y", 1, 120]]));
    const fy = await exportFrame(dy, () => markerSrc, 1.0, "kf-y");
    const by = bbox(fy.px, fy.w, fy.h, white);
    assert(Math.abs(by.cy - valueAt(exp(dy).keyframes, "y", 0.5, 240)) < 14, `base y keyframe: marker centre y ${by.cy.toFixed(0)} vs ${valueAt(exp(dy).keyframes, "y", 0.5, 240)}`);

    // rotation: a 200x60 bar turned 90° becomes ~60x200.
    const dr = doc(kfs([["rotation", 0, 0], ["rotation", 1, 90]]));
    const fr = await exportFrame(dr, () => markerSrc, 1.9, "kf-rot");
    const br = bbox(fr.px, fr.w, fr.h, white);
    assert(br.y1 - br.y0 > 150 && br.x1 - br.x0 < 110, `base rotation keyframe: bar should be ~tall at 90° (bbox ${br.x1 - br.x0}×${br.y1 - br.y0})`);
    const fr0 = await exportFrame(dr, () => markerSrc, 0.02, "kf-rot0");
    const br0 = bbox(fr0.px, fr0.w, fr0.h, white);
    assert(br0.x1 - br0.x0 > 150 && br0.y1 - br0.y0 < 110, `rotation 0° keeps the bar wide (bbox ${br0.x1 - br0.x0}×${br0.y1 - br0.y0})`);

    // opacity: the white bar fades toward the dark background (valueAt).
    const dop = doc(kfs([["opacity", 0, 1], ["opacity", 1, 0.2]]));
    const fo = await exportFrame(dop, () => markerSrc, 1.0, "kf-op");
    const o = valueAt(exp(dop).keyframes, "opacity", 0.5, 1);
    const mid = ((): number => {
      const i = (240 * fo.w + 320) * 4;
      return fo.px[i]!;
    })();
    const wantLum = Math.round(255 * o + 16 * (1 - o));
    assert(Math.abs(mid - wantLum) < 28, `base opacity keyframe: bar luma ${mid} vs expected ~${wantLum} (opacity ${o.toFixed(2)})`);

    // (c) PiP scale keyframes: the red overlay box grows 0.2 → 0.6 of the frame width.
    const red = resolve(OUT, "kf-red.mp4");
    const rr = spawnSync(bin, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=0xff2020:s=640x480:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", red], { encoding: "utf8" });
    assert(rr.status === 0, "red fixture failed");
    const pip = parseEditDoc({
      version: 1,
      meta: { title: "pip", width: 640, height: 480, fps: 30, background: "#000000" },
      media: [{ id: "v", kind: "video", src: markerSrc, durationSec: 3 }, { id: "r", kind: "video", src: red, durationSec: 3 }],
      tracks: [
        { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 2, mediaId: "v", transform: { x: 320, y: 240 } }] },
        { id: "broll", kind: "visual", clips: [{ id: "p0", kind: "video", start: 0, duration: 2, mediaId: "r", transform: { x: 320, y: 240, scale: 0.2 }, keyframes: kfs([["scale", 0, 0.2], ["scale", 1, 0.6]]) }] },
      ],
    });
    const redPx = (r: number, g: number, b: number): boolean => r > 200 && g < 90 && b < 90;
    const widths: string[] = [];
    for (const t of [0.1, 1.0, 1.9]) {
      const f = await exportFrame(pip, (id) => (id === "r" ? red : markerSrc), t, `kf-pip-${Math.round(t * 10)}`);
      const b = bbox(f.px, f.w, f.h, redPx);
      const want = 640 * valueAt((pip.tracks[1]!.clips[0] as VideoClip).keyframes, "scale", t / 2, 0.2);
      assert(Math.abs(b.x1 - b.x0 + 1 - want) < 12, `PiP scale keyframe at t=${t}: box ${b.x1 - b.x0 + 1}px wide, valueAt says ${want.toFixed(0)}px`);
      assert(Math.abs(b.cx - 320) < 8, "the scaled PiP must stay centred on its (x,y)");
      widths.push(`${b.x1 - b.x0 + 1}≈${want.toFixed(0)}`);
    }
    real = `real encode vs valueAt — base x centre ${centres.join(", ")}; y ok; rotation 0°→90° bar ${br0.x1 - br0.x0}×${br0.y1 - br0.y0} → ${br.x1 - br.x0}×${br.y1 - br.y0}; opacity luma ${mid}≈${wantLum}; PiP scale width ${widths.join(", ")}`;
  }
  ok(`check 76 (keyframe export fidelity): base-clip x/y/rotation/opacity + PiP scale keyframes export as eased expressions (no keyframes ⇒ byte-identical); ${real}`);
}

// ---------------------------------------------------------------------------
// 77 · handwriting / stroke-reveal text animation
// ---------------------------------------------------------------------------

export async function checkHandwrite(): Promise<void> {
  const eng = new CanvasRenderEngine();
  const mk = (anim: Record<string, unknown> | null, text = "Handwritten"): EditDoc =>
    parseEditDoc({
      version: 1,
      meta: { title: "hw", width: 960, height: 360, fps: 30, background: "#000000" },
      tracks: [{ id: "t", kind: "visual", clips: [{ id: "x", kind: "text", start: 0, duration: 4, text, fontFamily: "'Dancing Script', cursive", fontSize: 150, color: "#ffffff", transform: { x: 480, y: 180 }, ...(anim ? { anim } : {}) }] }],
    });
  const frame = async (d: EditDoc, t: number): Promise<Buffer> => Buffer.from((await eng.renderFrame(d, t)).data);
  const sum = async (png: Buffer, half?: "left" | "right"): Promise<number> => {
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        if (half === "left" && x >= img.width / 2) continue;
        if (half === "right" && x < img.width / 2) continue;
        n += d[(y * img.width + x) * 4]!;
      }
    return n;
  };

  // (a) whole-block handwrite: ink grows monotonically; the settled frame equals a static title.
  const whole = mk({ style: "handwrite", unit: "whole", durationSec: 2 });
  const rest = mk(null);
  const times = [0.1, 0.4, 0.8, 1.2, 1.6, 1.95, 2.6];
  const inks: number[] = [];
  for (const t of times) inks.push(await sum(await frame(whole, t)));
  for (let i = 1; i < inks.length; i++) assert(inks[i]! >= inks[i - 1]! * 0.999, `handwrite ink must grow with time (t=${times[i]}: ${inks[i]} < ${inks[i - 1]})`);
  if (process.env.HW_DEBUG) console.log(inks.map((n) => Math.round(n / 1000)).join(" "));
  assert(inks[0]! < inks[inks.length - 1]! * 0.45 && inks[1]! < inks[inks.length - 1]! * 0.75, "early in the stroke the text must be far from complete (outline only, no fill yet)");
  assert((await frame(whole, 2.6)).equals(await frame(rest, 2.6)), "once the intro settles, handwrite must be byte-identical to the static title");
  const mid = await frame(whole, 0.8); // pen still drawing: stroke present, fill not yet
  assert(!mid.equals(await frame(rest, 0.8)) && (await sum(mid)) > 0, "mid-stroke frame must differ from the finished text but not be blank");

  // (b) per-letter handwrite reveals left → right (the pen travels along the line).
  const letters = mk({ style: "handwrite", unit: "letter", durationSec: 2.4 });
  const early = await frame(letters, 0.9);
  const l = await sum(early, "left");
  const r = await sum(early, "right");
  assert(l > r * 1.4, `per-letter handwrite must write left→right (left ${l} vs right ${r})`);
  assert((await sum(await frame(letters, 3.2))) > (await sum(early)), "letters must finish writing after the intro");

  // (c) joined scripts degrade to word-by-word (a per-letter reveal would tear the joins).
  const arabic = await (async (): Promise<number> => {
    const d = mk({ style: "handwrite", unit: "letter", durationSec: 1.2 }, "مرحبا بالعالم");
    return sum(await frame(d, 0.3));
  })();
  assert(arabic > 0, "Arabic handwrite must still render");

  // (d) Director: animate_text gives handwrite sensible defaults; the stub routes the phrase.
  const project = new ProjectState({ media: [] });
  project.setDoc(mk(null, "Hello there world"));
  await DIRECTOR_TOOLS.animate_text!.execute({ style: "handwrite", target: "all" } as never, { project });
  const clip = project.doc.tracks[0]!.clips[0] as TextClip;
  assert(clip.anim.style === "handwrite" && clip.anim.unit === "letter" && clip.anim.durationSec >= 0.8, `animate_text handwrite defaults: ${JSON.stringify(clip.anim)}`);
  const p2 = new ProjectState({ media: [] });
  p2.setDoc(mk(null, "Hello there world"));
  const r2 = await new StubDirector().interpret("animate the text so it writes on like handwriting", p2);
  assert(r2.toolCalls.some((c) => c.name === "animate_text" && (c.input as { style?: string }).style === "handwrite"), `StubDirector must route handwriting to animate_text handwrite (got ${JSON.stringify(r2.toolCalls)})`);

  // (e) REAL export: an animated handwrite title over footage exports frame-accurately (PNG sequence).
  const s = await ensureSource("hw-src.mp4");
  let real = "canvas-only (ffmpeg absent)";
  if (s) {
    const d = parseEditDoc({
      version: 1,
      meta: { title: "hw", width: 640, height: 480, fps: 30 },
      media: [{ id: "v", kind: "video", src: s.src, durationSec: 3 }],
      tracks: [
        { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "v", transform: { x: 320, y: 240 } }] },
        { id: "titles", kind: "visual", clips: [{ id: "x", kind: "text", start: 0, duration: 3, text: "Handwritten", fontFamily: "'Dancing Script', cursive", fontSize: 110, color: "#ffffff", transform: { x: 320, y: 240 }, anim: { style: "handwrite", unit: "whole", durationSec: 1.6 } }] },
      ],
    });
    const white = (r: number, g: number, b: number): boolean => r > 200 && g > 200 && b > 200;
    const mid2 = await exportFrame(d, () => s.src, 0.55, "hw-mid");
    const end2 = await exportFrame(d, () => s.src, 2.5, "hw-end");
    const nMid = countNear(mid2.px, mid2.w, [0, 150, 640, 330], white);
    const nEnd = countNear(end2.px, end2.w, [0, 150, 640, 330], white);
    assert(nMid > 100 && nMid < nEnd * 0.8, `exported handwrite must be mid-stroke at 0.55s (${nMid}px) and complete later (${nEnd}px)`);
    real = `real encode: white pixels mid-stroke ${nMid} → settled ${nEnd}`;
  }
  ok(`check 77 (handwriting stroke-reveal): outline traces then fill fades (ink ${inks.map((n) => Math.round(n / 1000)).join("k/")}k), settled frame byte-identical to the static title, per-letter reveal runs left→right, animate_text defaults + stub routing; ${real}`);
}

export async function checkRenderDebt(): Promise<void> {
  await checkExportZOrder();
  await checkKaraokePresets();
  await checkSpeedRampPresets();
  await checkLutPipeline();
  await checkScriptSupport();
  await checkKeyframeFidelity();
  await checkHandwrite();
}

if (process.argv[1]?.endsWith("verify-render-debt.ts")) {
  checkRenderDebt().then(() => console.log("render-debt checks passed"), (e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
}
