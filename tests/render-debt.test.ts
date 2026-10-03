/**
 * Render/engine debt (Cycle J): pure, ffmpeg-free unit tests for the helpers behind
 * z-order export, LUTs, speed-ramp segmentation, script/RTL handling, handwriting
 * state and caption presets. (The verify gate additionally encodes real files.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUNDLED_LUTS,
  bundledLut,
  hasComplexScript,
  isRtlText,
  lutApprox,
  lutToCube,
  parseCube,
  parseEditDoc,
  sampleLut,
  scriptFallbackFamilies,
  textUnitState,
  withFallbackFamilies,
  type TextClip,
} from "@cadence/core";
import { CAPTION_PRESETS, addCaptions, applyCaptionPreset } from "@cadence/director";
import { buildExportPlan, rampSegmentBounds, baseTransformKeyframeFilters, zOrderedOverlayItems } from "@cadence/render-ffmpeg";

const resolve = (id: string): string => `/media/${id}.mp4`;

test("z-order: items sort by track order, and a topmost adjustment stays final", () => {
  const doc = parseEditDoc({
    version: 1,
    meta: { width: 640, height: 480 },
    media: [{ id: "v", kind: "video", src: "v.mp4" }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 3, mediaId: "v" }] },
      { id: "s", kind: "visual", clips: [{ id: "shape", kind: "shape", start: 0, duration: 3 }] },
      { id: "t", kind: "visual", clips: [{ id: "text", kind: "text", start: 0, duration: 3, text: "x" }] },
      { id: "adjustments", kind: "visual", clips: [{ id: "adj", kind: "adjustment", start: 0, duration: 3, grade: { saturation: 0 } }] },
    ],
  });
  const shape = doc.tracks[1]!.clips[0] as never;
  const text = doc.tracks[2]!.clips[0] as never;
  const adj = doc.tracks[3]!.clips[0] as never;
  const items = zOrderedOverlayItems(doc, { layers: [], texts: [text], shapes: [shape], adjustments: [adj] });
  assert.deepEqual(items.map((i) => i.kind), ["shape", "text"]);
  const plan = buildExportPlan(doc, resolve, "/o.mp4", new Map([["text", "/t.png"]]), undefined, undefined, new Map([["shape", "/s.png"]])).filterComplex;
  assert.ok(plan.indexOf("vshape0") < plan.indexOf("vtext0"));
  assert.ok(plan.indexOf("vtext0") < plan.indexOf("vadj0"));
});

test(".cube parse/serialize round-trips and rejects bad input", () => {
  for (const spec of BUNDLED_LUTS) {
    const lut = bundledLut(`bundled:${spec.key}`)!;
    const back = parseCube(lutToCube(lut));
    assert.equal(back.size, lut.size);
    const a = sampleLut(lut, 0.3, 0.6, 0.2);
    const b = sampleLut(back, 0.3, 0.6, 0.2);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i]! - b[i]!) < 1e-4);
    assert.ok(lutApprox(lut).meanError < 0.06, `${spec.key} preview fit`);
  }
  assert.throws(() => parseCube("LUT_1D_SIZE 2\n0 0 0\n1 1 1"));
  assert.throws(() => parseCube("LUT_3D_SIZE 2\n0 0 0"));
  assert.throws(() => parseCube("junk"));
});

test("speed-ramp segmentation lands on every control point; 2-point ramps keep 8 even segments", () => {
  const montage: [number, number][] = [[0, 3], [0.14, 0.6], [0.3, 3], [0.46, 0.6], [0.62, 3], [0.78, 0.6], [1, 3]];
  const b = rampSegmentBounds(montage, 3);
  for (const [p] of montage) assert.ok(b.some((x) => Math.abs(x - p) < 1e-5), `boundary at ${p}`);
  assert.equal(rampSegmentBounds([[0, 0.4], [1, 2.5]]).length - 1, 8);
  assert.ok(b.length - 1 <= 40);
});

test("script helpers: RTL by first strong char, complex scripts, fallback families", () => {
  assert.equal(isRtlText("مرحبا Cadence"), true);
  assert.equal(isRtlText("Cadence مرحبا"), false);
  assert.equal(hasComplexScript("हिन्दी"), true);
  assert.equal(hasComplexScript("plain"), false);
  assert.deepEqual(scriptFallbackFamilies("plain"), []);
  assert.ok(withFallbackFamilies("Inter, sans-serif", scriptFallbackFamilies("اردو")).startsWith("Inter, 'Noto Naskh Arabic'"));
  assert.equal(withFallbackFamilies("'Noto Naskh Arabic', 'Noto Naskh Arabic Latin', serif", scriptFallbackFamilies("اردو")), "'Noto Naskh Arabic', 'Noto Naskh Arabic Latin', serif");
});

test("handwrite: pen traces the outline first, then the fill arrives; settled = identity", () => {
  const doc = parseEditDoc({
    version: 1,
    tracks: [{ id: "t", kind: "visual", clips: [{ id: "x", kind: "text", start: 0, duration: 4, text: "hi", anim: { style: "handwrite", unit: "whole", durationSec: 2 } }] }],
  });
  const clip = doc.tracks[0]!.clips[0] as TextClip;
  const early = textUnitState(clip, 0.4);
  const late = textUnitState(clip, 1.9);
  const done = textUnitState(clip, 3);
  assert.ok(early.strokeReveal < 1 && early.fillMul === 0);
  assert.ok(late.fillMul > 0 && late.fillMul <= 1);
  assert.equal(done.strokeReveal, 1);
  assert.equal(done.fillMul, 1);
});

test("caption presets: 6 distinct looks apply on captions with karaoke", () => {
  const base = parseEditDoc({
    version: 1,
    meta: { width: 640, height: 480 },
    media: [{ id: "v", kind: "video", src: "v.mp4", durationSec: 5 }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 3, mediaId: "v" }] }],
  });
  const withCaps = addCaptions(base, {
    mediaId: "v", durationSec: 3, language: "en", words: [],
    segments: [{ id: "s", start: 0, end: 3, text: "grow fast now", words: [{ text: "grow", start: 0, end: 1 }, { text: "fast", start: 1, end: 2 }, { text: "now", start: 2, end: 3 }] }],
  });
  const looks = new Set<string>();
  for (const p of CAPTION_PRESETS) {
    const d = applyCaptionPreset(withCaps, p.key);
    const cap = d.tracks.find((t) => t.id === "captions")!.clips[0] as TextClip;
    assert.equal(cap.karaoke?.enabled, true);
    looks.add(`${cap.fontFamily}|${cap.karaoke?.style}|${cap.karaoke?.highlight}`);
  }
  assert.equal(looks.size, 6);
});

test("base-clip keyframe chain is empty without keyframes and complete with them", () => {
  const none = baseTransformKeyframeFilters({ duration: 2, transform: { x: 320, y: 240 } }, 640, 480, "#000000");
  assert.deepEqual(none, []);
  const kf = baseTransformKeyframeFilters(
    { duration: 2, transform: { x: 320, y: 240 }, keyframes: [{ prop: "x", t: 0, value: 320, easing: "linear" }, { prop: "x", t: 1, value: 480, easing: "linear" }] },
    640,
    480,
    "#101820",
  );
  assert.ok(kf.some((f) => f.startsWith("pad=")) && kf.some((f) => f.startsWith("crop=640:480:x=")));
});
