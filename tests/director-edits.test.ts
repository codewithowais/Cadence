/**
 * @cadence/director — pure edit-doc transforms. reframe, applyLook, setQuality
 * (long-edge 4K invariant), addCaptions sync, fillerCut, and buildHighlightDoc.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reframe,
  applyLook,
  setQuality,
  addCaptions,
  fillerCut,
  buildHighlightDoc,
} from "@cadence/director";
import { parseEditDoc, docDurationSec, type EditDoc, type MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

function landscapeVideoDoc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080 },
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 10, mediaId: "m", transform: { x: 960, y: 540 } }] },
      { id: "titles", kind: "visual", clips: [{ id: "t", kind: "text", start: 0, duration: 3, text: "Hi", transform: { x: 192, y: 108 } }] },
    ],
  });
}

test("reframe resizes the composition and re-anchors clips", () => {
  const out = reframe(landscapeVideoDoc(), "9:16");
  assert.equal(out.meta.width, 1080);
  assert.equal(out.meta.height, 1920);
  const vid = out.tracks.find((t) => t.id === "video")!.clips[0]!;
  // Media is frame-cover: centered in the new frame.
  assert.equal(vid.kind === "video" && vid.transform.x, 540);
  assert.equal(vid.kind === "video" && vid.transform.y, 960);
  // Text keeps its RELATIVE position (was at 10% x, 10% y).
  const txt = out.tracks.find((t) => t.id === "titles")!.clips[0]!;
  assert.ok(txt.kind === "text" && Math.abs(txt.transform.x - 108) < 1e-6, "text re-anchored proportionally in x");
  assert.ok(txt.kind === "text" && Math.abs(txt.transform.y - 192) < 1e-6, "text re-anchored proportionally in y");
});

test("applyLook sets the color grade on every visual media clip", () => {
  const out = applyLook(landscapeVideoDoc(), "warm");
  const vid = out.tracks.find((t) => t.id === "video")!.clips[0]!;
  assert.equal(vid.kind === "video" && vid.look.warmth, 0.5);
  assert.equal(vid.kind === "video" && vid.look.saturation, 1.08);
  // "none" resets to a neutral grade.
  const neutral = applyLook(out, "none").tracks.find((t) => t.id === "video")!.clips[0]!;
  assert.equal(neutral.kind === "video" && neutral.look.warmth, 0);
  assert.equal(neutral.kind === "video" && neutral.look.saturation, 1);
});

test("setQuality ultra anchors 4K to the LONG edge — landscape → 3840×2160", () => {
  const out = setQuality(parseEditDoc({ version: 1, meta: { width: 1920, height: 1080 }, tracks: [] }), "ultra");
  assert.equal(out.quality.preset, "ultra");
  assert.equal(out.quality.targetWidth, 3840);
  assert.equal(out.quality.targetHeight, 2160);
});

test("setQuality ultra on a reframed vertical doc → 2160×3840 (no overshoot)", () => {
  const vertical = reframe(parseEditDoc({ version: 1, meta: { width: 1920, height: 1080 }, tracks: [] }), "9:16");
  const out = setQuality(vertical, "ultra");
  assert.equal(out.quality.targetWidth, 2160);
  assert.equal(out.quality.targetHeight, 3840);
});

test("setQuality standard leaves the resolution unchanged (scale 1)", () => {
  const out = setQuality(parseEditDoc({ version: 1, meta: { width: 1280, height: 720 }, tracks: [] }), "standard");
  assert.equal(out.quality.targetWidth, 1280);
  assert.equal(out.quality.targetHeight, 720);
  assert.equal(out.quality.sharpen, 0);
});

function transcript(segments: Transcript["segments"]): Transcript {
  const words = segments.flatMap((s) => s.words);
  const durationSec = segments.reduce((m, s) => Math.max(m, s.end), 0);
  return { mediaId: "m", durationSec, language: "en", segments, words };
}

test("addCaptions maps transcript segments to synced timeline captions", () => {
  const doc = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    // Clip plays source [5,15) starting at timeline t=0 (sourceIn 5).
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 10, mediaId: "m", sourceIn: 5 }] }],
  });
  const t = transcript([
    { id: "s0", text: "hello there", start: 6, end: 8, words: [{ text: "hello", start: 6, end: 7 }, { text: "there", start: 7, end: 8 }] },
    // This segment is outside the clip's source range [5,15) → dropped.
    { id: "s1", text: "way later", start: 40, end: 42, words: [{ text: "way", start: 40, end: 41 }, { text: "later", start: 41, end: 42 }] },
  ]);
  const out = addCaptions(doc, t);
  const caps = out.tracks.find((t2) => t2.id === "captions")!;
  assert.equal(caps.clips.length, 1, "only the in-range segment becomes a caption");
  const cap = caps.clips[0]!;
  // Timeline start = clip.start + (segStart - sourceIn) = 0 + (6 - 5) = 1.
  assert.equal(cap.start, 1);
  assert.equal(cap.duration, 2);
  assert.equal(cap.kind === "text" && cap.text, "hello there");
});

test("addCaptions is idempotent — re-running replaces the captions track", () => {
  const doc = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 10, mediaId: "m" }] }],
  });
  const t = transcript([{ id: "s0", text: "hi", start: 1, end: 3, words: [{ text: "hi", start: 1, end: 3 }] }]);
  const once = addCaptions(doc, t);
  const twice = addCaptions(once, t);
  assert.equal(twice.tracks.filter((x) => x.id === "captions").length, 1);
});

test("fillerCut drops filler-heavy segments and keeps clean ones", () => {
  const media: MediaAsset = { id: "m", kind: "video", src: "a.mp4", width: 1920, height: 1080 };
  const t = transcript([
    // 4/4 words are fillers → dropped (>= 0.45 threshold).
    { id: "s0", text: "um uh like so", start: 0, end: 2, words: [
      { text: "um", start: 0, end: 0.5 }, { text: "uh", start: 0.5, end: 1 },
      { text: "like", start: 1, end: 1.5 }, { text: "so", start: 1.5, end: 2 },
    ] },
    // real content → kept.
    { id: "s1", text: "the important point here", start: 2, end: 4, words: [
      { text: "the", start: 2, end: 2.5 }, { text: "important", start: 2.5, end: 3 },
      { text: "point", start: 3, end: 3.5 }, { text: "here", start: 3.5, end: 4 },
    ] },
  ]);
  const { doc, kept, dropped } = fillerCut(media, t);
  assert.equal(kept, 1);
  assert.equal(dropped, 1);
  const clips = doc.tracks.find((x) => x.id === "video")!.clips;
  assert.equal(clips.length, 1);
  // The kept clip pulls from the clean segment's source start.
  assert.equal(clips[0]!.kind === "video" && clips[0]!.sourceIn, 2);
});

test("buildHighlightDoc respects target duration and keeps word-accurate sourceIn", () => {
  const media: MediaAsset = { id: "m", kind: "video", src: "a.mp4", durationSec: 60, width: 1920, height: 1080 };
  const seg = (id: string, start: number, score: number) => ({
    id, text: id, start, end: start + 2, score,
    words: [{ text: id, start, end: start + 2 }],
  });
  // Highest-scoring segments are at 5s and 15s; the 0s/10s ones score lower.
  const t = transcript([seg("a", 0, 0.1), seg("b", 5, 0.9), seg("c", 10, 0.2), seg("d", 15, 0.8)]);
  const doc = buildHighlightDoc(media, t, { targetSec: 4 });
  const clips = doc.tracks.find((x) => x.id === "video")!.clips;
  assert.equal(clips.length, 2, "picks segments until the ~4s target is met");
  // Restored to chronological order; sourceIn equals the picked segments' starts.
  const sources = clips.map((c) => (c.kind === "video" ? c.sourceIn : -1));
  assert.deepEqual(sources, [5, 15]);
  // Clips are laid back-to-back with no gaps: total video duration == sum of picks.
  const videoEnd = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  assert.equal(videoEnd, 4);
  assert.ok(docDurationSec(doc) >= 4);
});
