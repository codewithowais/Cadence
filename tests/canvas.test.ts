/**
 * Custom ratio — canvas size/ratio parsing + validation, the backward-compatible
 * `meta.canvas` schema, Fit/Fill, setCanvasSize / magicResize ops, the Director tools +
 * StubDirector phrases, and the ffmpeg plan (scale/pad and blurred-background split).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANVAS_MAX,
  CANVAS_MIN,
  CANVAS_PRESETS,
  EditDoc as EditDocSchema,
  groupedPresets,
  linkedSize,
  mediaFitRect,
  normalizeDim,
  parseEditDoc,
  parseRatio,
  parseSizeText,
  ratioLabel,
  safeZoneRect,
  sizeForRatio,
  swapOrientation,
  validateCanvasSize,
  type EditDoc,
} from "@cadence/core";
import {
  DIRECTOR_TOOLS,
  ProjectState,
  StubDirector,
  magicResize,
  magicTargets,
  parseCanvasRequest,
  parseMagicResize,
  setCanvasFit,
  setCanvasSize,
} from "@cadence/director";
import { buildExportPlan } from "@cadence/render-ffmpeg";

function baseDoc(extra: Record<string, unknown> = {}): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "Canvas", width: 1920, height: 1080, fps: 30, ...extra },
    media: [{ id: "m1", kind: "video", src: "/media/m1.mp4", durationSec: 30, width: 1920, height: 1080 }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 5, mediaId: "m1", sourceIn: 0, transform: { x: 960, y: 540 } }] },
      { id: "titles", kind: "visual", clips: [{ id: "t0", kind: "text", start: 0, duration: 4, text: "HELLO", fontSize: 80, color: "#ffffff", transform: { x: 960, y: 900 } }] },
    ],
  });
}

test("bounds: even, clamped to 64..7680", () => {
  assert.equal(normalizeDim(1081), 1082);
  assert.equal(normalizeDim(10), CANVAS_MIN);
  assert.equal(normalizeDim(99999), CANVAS_MAX);
  assert.equal(validateCanvasSize(0, 100).ok, false);
  assert.equal(validateCanvasSize(NaN, 100).ok, false);
  const v = validateCanvasSize(1081, 9000);
  assert.deepEqual([v.ok, v.width, v.height], [true, 1082, CANVAS_MAX]);
  assert.ok(v.issues.length === 2);
});

test("ratio parsing: 21:9, 1.91:1, 7:5, 16/9, bare 2.39, junk", () => {
  assert.deepEqual(parseRatio("21:9"), { w: 21, h: 9 });
  assert.deepEqual(parseRatio("1.91:1"), { w: 1.91, h: 1 });
  assert.deepEqual(parseRatio("7 : 5"), { w: 7, h: 5 });
  assert.deepEqual(parseRatio("16/9"), { w: 16, h: 9 });
  assert.deepEqual(parseRatio("2.39"), { w: 2.39, h: 1 });
  assert.equal(parseRatio("0:5"), null);
  assert.equal(parseRatio("100:1"), null);
  assert.equal(parseRatio("abc"), null);
});

test("size text + sizing from a ratio", () => {
  assert.deepEqual(parseSizeText("1080 by 1350"), { kind: "size", width: 1080, height: 1350 });
  assert.deepEqual(parseSizeText("1080×1350 px"), { kind: "size", width: 1080, height: 1350 });
  assert.deepEqual(parseSizeText("make it 3:2"), { kind: "ratio", w: 3, h: 2 });
  assert.equal(parseSizeText("hello"), null);
  assert.deepEqual(sizeForRatio({ w: 4, h: 5 }), { width: 1080, height: 1350 });
  assert.deepEqual(sizeForRatio({ w: 9, h: 16 }), { width: 1080, height: 1920 });
  assert.deepEqual(sizeForRatio({ w: 3, h: 2 }, { width: 1500 }), { width: 1500, height: 1000 });
  const s = sizeForRatio({ w: 7, h: 5 });
  assert.equal(s.height, 1080);
  assert.ok(s.width % 2 === 0);
});

test("ratio labels, link-lock and rotate", () => {
  assert.equal(ratioLabel(1920, 1080), "16:9");
  assert.equal(ratioLabel(1080, 1920), "9:16");
  assert.equal(ratioLabel(1200, 628), "1.91:1");
  assert.equal(ratioLabel(1512, 1080), "7:5");
  assert.deepEqual(swapOrientation(1920, 1080), { width: 1080, height: 1920 });
  assert.deepEqual(linkedSize({ width: 1920, height: 1080 }, { width: 960 }), { width: 960, height: 540 });
  assert.deepEqual(linkedSize({ width: 1920, height: 1080 }, { height: 540 }), { width: 960, height: 540 });
});

test("preset catalogue: every preset valid + even, ids unique, grouped", () => {
  const ids = new Set<string>();
  for (const p of CANVAS_PRESETS) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    const v = validateCanvasSize(p.width, p.height);
    assert.ok(v.ok && v.width === p.width && v.height === p.height, `${p.id} must already be valid/even`);
  }
  const groups = groupedPresets();
  assert.ok(groups.length >= 10);
  for (const need of ["YouTube", "Instagram", "Facebook", "LinkedIn", "Pinterest", "Snapchat", "Twitch", "Print"]) {
    assert.ok(groups.some((g) => g.platform === need), `missing group ${need}`);
  }
});

test("migration: an old doc (no meta.canvas) still parses, unchanged", () => {
  const old = { version: 1, meta: { title: "old", width: 1280, height: 720 }, media: [], tracks: [] };
  const d = parseEditDoc(old);
  assert.equal(d.meta.canvas, undefined);
  assert.equal("canvas" in d.meta, false, "no key emitted → byte-identical re-serialization");
  const again = parseEditDoc(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(again, d);
  // And a doc WITH canvas round-trips with defaults filled.
  const withCanvas = parseEditDoc({ ...old, meta: { ...old.meta, canvas: { fit: "fit" } } });
  assert.equal(withCanvas.meta.canvas?.fill, "blur");
  assert.equal(withCanvas.meta.canvas?.linked, true);
  assert.deepEqual(withCanvas.meta.canvas?.customPresets, []);
  assert.ok(EditDocSchema.safeParse(JSON.parse(JSON.stringify(withCanvas))).success);
  assert.equal(EditDocSchema.safeParse({ ...old, meta: { ...old.meta, canvas: { fit: "stretch" } } }).success, false, "stretch is never a fit mode");
});

test("mediaFitRect: fill covers, fit contains, never stretches", () => {
  const fill = mediaFitRect("fill", 1920, 1080, 1080, 1920);
  assert.ok(fill.w >= 1080 && fill.h >= 1920);
  assert.ok(Math.abs(fill.w / fill.h - 1920 / 1080) < 1e-9);
  const fit = mediaFitRect("fit", 1920, 1080, 1080, 1920);
  assert.equal(fit.w, 1080);
  assert.ok(Math.abs(fit.h - 607.5) < 1e-6);
  assert.ok(Math.abs(fit.y - (1920 - 607.5) / 2) < 1e-6);
  const same = mediaFitRect("fit", undefined, undefined, 640, 360);
  assert.deepEqual([same.x, same.y, same.w, same.h], [0, 0, 640, 360]);
});

test("safe zones are fractions of the frame", () => {
  const r = safeZoneRect("tiktok", 1080, 1920)!;
  assert.ok(r.x > 0 && r.y > 0 && r.x + r.w < 1080 && r.y + r.h < 1920);
  assert.equal(safeZoneRect("off", 1080, 1920), null);
});

test("setCanvasSize: ratio, WxH, relayout by fractions, target stays in aspect", () => {
  const doc = parseEditDoc({ ...baseDoc(), quality: { preset: "high", targetWidth: 2560, targetHeight: 1440 } });
  const r = setCanvasSize(doc, { ratio: "3:2" });
  assert.deepEqual([r.width, r.height], [1620, 1080]);
  assert.equal(r.doc.meta.canvas?.ratio, "3:2");
  // The old 16:9 export target must not survive into a 3:2 frame (it would distort).
  assert.equal(r.doc.quality.targetWidth, undefined);
  const t = r.doc.tracks[1]!.clips[0]!;
  assert.equal(t.kind, "text");
  if (t.kind === "text") {
    assert.ok(Math.abs(t.transform.x - 810) < 1e-6, "x kept at the same fraction");
    assert.ok(Math.abs(t.fontSize - 80 * Math.min(1620 / 1920, 1)) < 0.2, "font follows the smaller axis");
  }
  const v = r.doc.tracks[0]!.clips[0]!;
  assert.equal(v.kind, "video");
  if (v.kind === "video") assert.deepEqual([v.transform.x, v.transform.y], [810, 540]);

  const big = setCanvasSize(doc, { width: 1081, height: 1351 });
  assert.deepEqual([big.width, big.height], [1082, 1352]);
  assert.ok(big.notes.length === 2);

  // Same-aspect resize scales the export target along.
  const scaled = setCanvasSize(doc, { width: 960, height: 540 });
  assert.equal(scaled.doc.quality.targetWidth, 1280);

  assert.throws(() => setCanvasSize(doc, { ratio: "wat" }), /not a usable ratio/);
  assert.throws(() => setCanvasSize(doc, {}), /size/);
});

test("setCanvasSize keeps the named-aspect dims (21:9 → 2560×1080)", () => {
  assert.deepEqual([setCanvasSize(baseDoc(), { ratio: "21:9" }).width, setCanvasSize(baseDoc(), { ratio: "21:9" }).height], [2560, 1080]);
  assert.equal(setCanvasSize(baseDoc(), { presetId: "ig-post-pt" }).doc.meta.canvas?.presetId, "ig-post-pt");
});

test("setCanvasFit persists fit/fill/color without touching size", () => {
  const d = setCanvasFit(baseDoc(), { fit: "fit", fill: "solid", fillColor: "#112233" });
  assert.equal(d.meta.width, 1920);
  assert.deepEqual([d.meta.canvas?.fit, d.meta.canvas?.fill, d.meta.canvas?.fillColor], ["fit", "solid", "#112233"]);
});

test("magicResize makes one valid, retitled doc per size", () => {
  const targets = magicTargets("social");
  assert.ok(targets.length >= 5);
  const variants = magicResize(baseDoc(), targets, { fit: "fit", fill: "blur" });
  assert.equal(variants.length, targets.length);
  for (const v of variants) {
    assert.deepEqual([v.doc.meta.width, v.doc.meta.height], [v.width, v.height]);
    assert.ok(v.doc.meta.title.includes(`${v.width}×${v.height}`));
    assert.equal(v.doc.meta.canvas?.fit, "fit");
    assert.ok(EditDocSchema.safeParse(JSON.parse(JSON.stringify(v.doc))).success);
  }
  assert.deepEqual(magicTargets(["nope", "tiktok"]).map((t) => t.id), ["tiktok"]);
});

test("ffmpeg plan: fill is the legacy cover; fit solid pads; fit blur splits + overlays", () => {
  const out = (d: EditDoc) => buildExportPlan(d, (id) => `/media/${id}.mp4`, "/out/x.mp4", new Map());
  const fill = out(setCanvasSize(baseDoc(), { width: 1080, height: 1920 }).doc).filterComplex;
  assert.match(fill, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/);
  assert.doesNotMatch(fill, /pad=|boxblur/);

  const solid = out(setCanvasSize(baseDoc(), { width: 1080, height: 1920, fit: "fit", fill: "solid", fillColor: "#102030" }).doc).filterComplex;
  assert.match(solid, /scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=0x102030/);
  assert.doesNotMatch(solid, /force_original_aspect_ratio=increase/);

  const blur = out(setCanvasSize(baseDoc(), { width: 1080, height: 1920, fit: "fit", fill: "blur" }).doc).filterComplex;
  assert.match(blur, /split\[v0fa\]\[v0fb\]/);
  assert.match(blur, /\[v0fa\]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=\d+:2\[v0bg\]/);
  assert.match(blur, /\[v0fb\]scale=1080:1920:force_original_aspect_ratio=decrease\[v0fg\]/);
  assert.match(blur, /\[v0bg\]\[v0fg\]overlay=\(W-w\)\/2:\(H-h\)\/2,setsar=1/);
  assert.doesNotMatch(blur, /@fitblur/);
});

test("Director tools: registered, validated and committed", async () => {
  assert.ok("set_canvas_size" in DIRECTOR_TOOLS && "magic_resize" in DIRECTOR_TOOLS);
  const project = new ProjectState({ doc: baseDoc() });
  const tool = DIRECTOR_TOOLS.set_canvas_size;
  assert.equal(tool.inputSchema.safeParse({}).success, false);
  const res = await tool.execute({ ratio: "7:5" }, { project });
  assert.match(res.summary, /7:5/);
  assert.equal(project.doc.meta.canvas?.ratio, "7:5");
  await tool.execute({ fit: "fit", fill: "blur" }, { project });
  assert.equal(project.doc.meta.canvas?.fit, "fit");
  const m = await DIRECTOR_TOOLS.magic_resize.execute({ social: true }, { project });
  assert.match(m.summary, /Magic resize/);
  assert.ok((project.doc.meta.canvas?.magicTargets?.length ?? 0) >= 5);
  await assert.rejects(() => DIRECTOR_TOOLS.magic_resize.execute({ targets: ["zzz"] }, { project }), /known presets/);
});

test("parsers: ratios, sizes, fit words, magic resize; timestamps are not ratios", () => {
  assert.deepEqual(parseCanvasRequest("make it 21:9"), { kind: "size", input: { ratio: "21:9" } });
  assert.deepEqual(parseCanvasRequest("make it 1080 by 1350"), { kind: "size", input: { width: 1080, height: 1350 } });
  assert.deepEqual(parseCanvasRequest("make it 1.91:1"), { kind: "size", input: { ratio: "1.91:1" } });
  assert.equal(parseCanvasRequest("add a marker at 1:30"), null);
  assert.equal(parseCanvasRequest("cut from 0:30 to 1:00"), null);
  assert.equal(parseCanvasRequest("make it vertical"), null, "named aspects stay on the reframe tool");
  const fit = parseCanvasRequest("fit the whole video with a blurred background");
  assert.deepEqual(fit, { kind: "fit", input: { fit: "fit", fill: "blur" } });
  assert.deepEqual(parseCanvasRequest("use black bars"), { kind: "fit", input: { fit: "fit", fill: "solid", fillColor: "#000000" } });
  assert.deepEqual(parseCanvasRequest("fill the frame"), { kind: "fit", input: { fit: "fill" } });
  assert.deepEqual(parseMagicResize("resize for all social platforms"), { social: true });
  assert.deepEqual(parseMagicResize("magic resize this"), { social: true });
  assert.equal(parseMagicResize("resize for tiktok"), null);
  const multi = parseMagicResize("resize for tiktok, instagram and youtube");
  assert.ok(multi?.targets?.includes("tiktok") && multi.targets.includes("ig-post-pt") && multi.targets.includes("yt-video"));
});

test("StubDirector: canvas phrases route to the new tools", async () => {
  const run = async (q: string) => {
    const project = new ProjectState({ doc: baseDoc() });
    return new StubDirector().interpret(q, project);
  };
  const a = await run("make it 21:9");
  assert.deepEqual(a.toolCalls.map((c) => c.name), ["set_canvas_size"]);
  assert.deepEqual([a.doc.meta.width, a.doc.meta.height], [2560, 1080]);
  const b = await run("make it 1080 by 1350");
  assert.deepEqual(b.toolCalls.map((c) => c.name), ["set_canvas_size"]);
  assert.deepEqual([b.doc.meta.width, b.doc.meta.height], [1080, 1350]);
  const c = await run("make it 3:2");
  assert.deepEqual([c.doc.meta.width, c.doc.meta.height], [1620, 1080]);
  const d = await run("resize for all social platforms");
  assert.deepEqual(d.toolCalls.map((x) => x.name), ["magic_resize"]);
  assert.ok((d.doc.meta.canvas?.magicTargets?.length ?? 0) >= 5);
  assert.equal(d.doc.meta.width, 1920, "magic resize leaves the working doc's size alone");
  const e = await run("make it vertical and fit the whole video with a blurred background");
  assert.deepEqual(e.toolCalls.map((x) => x.name).sort(), ["reframe", "set_canvas_size"]);
  assert.equal(e.doc.meta.canvas?.fit, "fit");
  assert.equal(e.doc.meta.height, 1920);
  // Existing behavior untouched.
  const f = await run("make it vertical");
  assert.deepEqual(f.toolCalls.map((x) => x.name), ["reframe"]);
  const g = await run("reframe to 1600x900");
  assert.deepEqual([g.doc.meta.width, g.doc.meta.height], [1600, 900]);
});
