/**
 * Timeline upgrade + drag-and-drop (Cycle J) — pure logic: the adaptive ruler,
 * timecode, auto-scroll, and every drop / move op (insert vs overwrite, group
 * moves, palette drops, collision handling).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { docDurationSec, parseEditDoc, type Clip, type EditDoc, type MediaAsset } from "@cadence/core";
import {
  addMediaAsOverlay,
  carveRange,
  dropItemIntoDoc,
  insertMediaAt,
  laneAtOffset,
  magneticTrackId,
  moveClipsGroup,
  nearestFreeStart,
  payloadClipKind,
  payloadDurationSec,
  placeClip,
  previewDrop,
  reorderBlock,
} from "../apps/web/src/lib/timeline-dnd.ts";
import {
  edgeScrollSpeed,
  fmtTimecode,
  followScrollTarget,
  nextTrackHeight,
  rulerSteps,
  rulerTicks,
} from "../apps/web/src/lib/timeline-ruler.ts";

function baseDoc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "dnd", width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "m", kind: "video", src: "/media/m.mp4", durationSec: 60 },
      { id: "song", kind: "audio", src: "/media/song.mp3", durationSec: 60 },
    ],
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [
          { id: "a", kind: "video", start: 0, duration: 4, mediaId: "m", sourceIn: 0, transform: { x: 960, y: 540 } },
          { id: "b", kind: "video", start: 4, duration: 4, mediaId: "m", sourceIn: 20, transform: { x: 960, y: 540 } },
          { id: "c", kind: "video", start: 8, duration: 4, mediaId: "m", sourceIn: 40, transform: { x: 960, y: 540 } },
        ],
      },
      {
        id: "broll",
        kind: "visual",
        clips: [{ id: "p1", kind: "video", start: 2, duration: 3, mediaId: "m", sourceIn: 5, transform: { x: 960, y: 540, scale: 0.4 } }],
      },
      { id: "layer-1", kind: "visual", clips: [] },
      { id: "titles", kind: "visual", clips: [{ id: "t1", kind: "text", start: 1, duration: 2, text: "hi" }] },
      { id: "music", kind: "audio", clips: [{ id: "mus", kind: "audio", start: 0, duration: 12, mediaId: "song" }] },
    ],
  });
}

const lane = (d: EditDoc, id: string): Clip[] => d.tracks.find((t) => t.id === id)!.clips;
const mainEnd = (d: EditDoc): number => Math.max(...lane(d, "video").map((c) => c.start + c.duration));
const span = (d: EditDoc, id: string) => lane(d, id).map((c) => [c.id, c.start, c.duration]);
const media = (id: string, kind: MediaAsset["kind"], dur?: number): MediaAsset =>
  ({ id, kind, src: `/media/${id}`, durationSec: dur, label: id }) as MediaAsset;

// ---- ruler ------------------------------------------------------------------------

test("fmtTimecode is MM:SS:FF and floors frames", () => {
  assert.equal(fmtTimecode(0, 30), "00:00:00");
  assert.equal(fmtTimecode(3.5, 30), "00:03:15");
  assert.equal(fmtTimecode(61.04, 30), "01:01:01");
  assert.equal(fmtTimecode(3600 + 5, 24), "1:00:05:00");
  assert.equal(fmtTimecode(-4, 30), "00:00:00");
});

test("rulerTicks adapt: coarser when zoomed out, frame-accurate when zoomed in", () => {
  const out = rulerSteps(10, 30).major; // 10 px/s → needs ≥ 84px between labels
  const inn = rulerSteps(2000, 30).major;
  assert.ok(out >= 10, `zoomed out major step ${out}`);
  assert.ok(inn < 0.5, `zoomed in major step ${inn}`);
  const ticks = rulerTicks(100, 20, 30);
  const majors = ticks.filter((t) => t.major);
  assert.ok(majors.length >= 3 && majors.every((t) => t.label), "major ticks carry timecode labels");
  assert.ok(ticks.some((t) => !t.major), "minor ticks subdivide the majors");
  assert.equal(majors[0]!.label, "0:00");
  // Frame labels at high zoom include the frame field.
  const fine = rulerTicks(3000, 4, 30, 0, 1).filter((t) => t.major);
  assert.ok(fine.every((t) => /^\d+:\d\d:\d\d$/.test(t.label!)), fine.map((t) => t.label).join(","));
  // Windowing renders only what is asked.
  const win = rulerTicks(100, 600, 30, 100, 110);
  assert.ok(win.length > 0 && win.every((t) => t.t >= 99 && t.t <= 111));
  assert.ok(rulerTicks(0, 10, 30).length === 0);
});

test("edgeScrollSpeed ramps near the edges and is zero in the dead zone", () => {
  assert.equal(edgeScrollSpeed(500, 0, 1000), 0);
  assert.ok(edgeScrollSpeed(990, 0, 1000) > edgeScrollSpeed(960, 0, 1000));
  assert.ok(edgeScrollSpeed(10, 0, 1000) < 0);
  assert.ok(edgeScrollSpeed(-50, 0, 1000) <= edgeScrollSpeed(10, 0, 1000), "past the edge scrolls at least as fast");
  assert.equal(edgeScrollSpeed(50, 0, 80), 0, "tiny viewport never auto-scrolls");
});

test("followScrollTarget only scrolls when the playhead leaves the safe band", () => {
  assert.equal(followScrollTarget(500, 0, 1000, 5000), null);
  assert.equal(followScrollTarget(500, 0, 1000, 900), null, "no overflow, no scroll");
  const t = followScrollTarget(1500, 0, 1000, 5000)!;
  assert.ok(t > 0 && t <= 4000);
  assert.equal(followScrollTarget(4990, 0, 1000, 5000), 4000, "clamped to the end");
});

test("nextTrackHeight cycles S → M → L → S", () => {
  assert.equal(nextTrackHeight(36), 56);
  assert.equal(nextTrackHeight(56), 84);
  assert.equal(nextTrackHeight(84), 36);
  assert.equal(nextTrackHeight(1), 56);
});

// ---- collision math ------------------------------------------------------------

test("nearestFreeStart slides a clip to the closest gap", () => {
  const lane1 = [{ start: 2, duration: 3 }, { start: 8, duration: 2 }];
  assert.equal(nearestFreeStart(lane1, 5, 2), 5);
  assert.equal(nearestFreeStart(lane1, 3, 2), 5, "drop inside → nearest edge (after)");
  assert.equal(nearestFreeStart(lane1, 1.5, 2), 0, "before-edge fit wins when closer");
  assert.equal(nearestFreeStart(lane1, 9, 3), 10, "no room between → after the last clip");
});

test("carveRange splits straddling clips and removes the covered footage", () => {
  const d = carveRange(baseDoc(), "video", 2, 10);
  const v = lane(d, "video");
  assert.deepEqual(v.map((c) => [c.start, c.start + c.duration]), [[0, 2], [10, 12]]);
  const right = v[1] as Extract<Clip, { kind: "video" }>;
  assert.equal(right.sourceIn, 42, "the surviving tail keeps its source in point (40 + 2s)");
});

// ---- moves ---------------------------------------------------------------------------

test("placeClip on the magnetic lane reorders (insert) and ripples back-to-back", () => {
  const d = placeClip(baseDoc(), "a", "video", 10.5, "insert"); // drop A past C's midpoint
  assert.deepEqual(lane(d, "video").map((c) => c.id), ["b", "c", "a"]);
  assert.deepEqual(span(d, "video"), [["b", 0, 4], ["c", 4, 4], ["a", 8, 4]]);
  assert.equal(mainEnd(d), 12, "length preserved");
});

test("placeClip overwrite on the magnetic lane replaces the covered footage", () => {
  // Move C over the second half of B: B keeps its first 2s, C takes [6,10).
  const d = placeClip(baseDoc(), "c", "video", 6, "overwrite");
  const v = lane(d, "video");
  assert.equal(v.map((c) => c.id).join(","), "a,b,c");
  assert.deepEqual(v.map((c) => [c.start, c.duration]), [[0, 4], [4, 2], [6, 4]]);
  assert.equal(mainEnd(d), 10, "the moved clip's old slot closed up");
  // Dropped exactly over B → B is replaced entirely.
  const full = placeClip(baseDoc(), "c", "video", 4, "overwrite");
  assert.equal(lane(full, "video").map((c) => c.id).join(","), "a,c");
});

test("placeClip between lanes keeps the start and does not collide (insert → nearest free slot)", () => {
  // Moving main clip B (4s) onto the b-roll lane at 3s collides with p1 [2,5): lands at 5.
  const d = placeClip(baseDoc(), "b", "broll", 3, "insert");
  const broll = lane(d, "broll");
  assert.equal(broll.length, 2);
  const moved = broll.find((c) => c.id === "b")!;
  assert.equal(moved.start, 5);
  // The main lane closed the gap behind it.
  assert.deepEqual(span(d, "video"), [["a", 0, 4], ["c", 4, 4]]);
});

test("placeClip overwrite on a free lane trims what it lands on", () => {
  const d = placeClip(baseDoc(), "b", "broll", 3, "overwrite");
  const broll = lane(d, "broll").sort((x, y) => x.start - y.start);
  assert.deepEqual(broll.map((c) => [c.id, c.start, c.duration]), [["p1", 2, 1], ["b", 3, 4]]);
});

test("placeClip refuses locked lanes and wrong media families (same doc back)", () => {
  const doc = baseDoc();
  assert.equal(placeClip(doc, "a", "music", 1), doc, "video onto an audio lane");
  assert.equal(placeClip(doc, "mus", "video", 1), doc, "audio onto a visual lane");
  assert.equal(placeClip(doc, "nope", "video", 1), doc);
  const locked = parseEditDoc({ ...doc, tracks: doc.tracks.map((t) => (t.id === "broll" ? { ...t, locked: true } : t)) });
  assert.equal(placeClip(locked, "a", "broll", 1), locked, "destination locked");
});

test("placeClip is undo-safe: the input doc is never mutated", () => {
  const doc = baseDoc();
  const snap = JSON.stringify(doc);
  placeClip(doc, "b", "broll", 3, "overwrite");
  placeClip(doc, "a", "video", 10.5, "insert");
  assert.equal(JSON.stringify(doc), snap);
});

test("moving a main clip keeps captions glued to the footage they sit over", () => {
  const doc = parseEditDoc({
    ...baseDoc(),
    tracks: baseDoc().tracks.map((t) =>
      t.id === "titles" ? { ...t, id: "captions", clips: [{ id: "cap", kind: "text", start: 9, duration: 2, text: "c" }] } : t,
    ),
  });
  const d = placeClip(doc, "c", "video", 0, "insert"); // C moves to the front
  const cap = lane(d, "captions")[0]!;
  assert.ok(Math.abs(cap.start - 1) < 1e-6, `caption followed clip C (was 9 → ${cap.start})`);
});

test("reorderBlock moves several main clips together, preserving their order", () => {
  const d = reorderBlock(baseDoc(), ["a", "b"], 1); // among the rest [c], put the block after it
  assert.deepEqual(lane(d, "video").map((c) => c.id), ["c", "a", "b"]);
  assert.deepEqual(span(d, "video").map((s) => s[1]), [0, 4, 8]);
  assert.equal(reorderBlock(baseDoc(), ["a", "b"], 0).tracks[0]!.clips.map((c) => c.id).join(), "a,b,c");
});

test("moveClipsGroup shifts free clips together, clamped at 0, and reorders the main block", () => {
  const doc = baseDoc();
  const shifted = moveClipsGroup(doc, ["p1", "t1"], { deltaSec: 2, mode: "insert" });
  assert.equal(lane(shifted, "broll")[0]!.start, 4);
  assert.equal(lane(shifted, "titles")[0]!.start, 3);
  const clamped = moveClipsGroup(doc, ["p1", "t1"], { deltaSec: -10, mode: "insert" });
  assert.equal(lane(clamped, "titles")[0]!.start, 0, "earliest clip stops at 0");
  assert.equal(lane(clamped, "broll")[0]!.start, 1, "the group keeps its spacing");
  const mixed = moveClipsGroup(doc, ["a", "p1"], { deltaSec: 1, mode: "insert", blockIndex: 2 });
  assert.deepEqual(lane(mixed, "video").map((c) => c.id), ["b", "c", "a"]);
  assert.equal(lane(mixed, "broll")[0]!.start, 3);
});

test("moveClipsGroup lane steps move every clip up a lane (all-or-nothing)", () => {
  const doc = baseDoc();
  // broll is index 1 among visual lanes; +1 → layer-1 (empty, free).
  const up = moveClipsGroup(doc, ["p1"], { deltaSec: 0, laneSteps: 1, mode: "insert" });
  assert.equal(lane(up, "layer-1").length, 1);
  assert.equal(lane(up, "broll").length, 0);
  // titles is the top lane: +1 has nowhere to go → the group stays where it is.
  const stay = moveClipsGroup(doc, ["p1", "t1"], { deltaSec: 0, laneSteps: 1, mode: "insert" });
  assert.equal(lane(stay, "broll").length, 1, "all-or-nothing keeps both on their lanes");
  assert.equal(laneAtOffset(doc, "broll", 1)!.id, "layer-1");
  assert.equal(laneAtOffset(doc, "titles", 1), null);
});

// ---- drops ---------------------------------------------------------------------------

test("insertMediaAt (insert) lands at the nearest cut and ripples; overwrite replaces", () => {
  const doc = baseDoc();
  const clip = media("new", "video", 3);
  const ins = insertMediaAt(doc, clip, "video", 3.9, "insert");
  assert.ok(ins.clipId);
  assert.deepEqual(lane(ins.doc, "video").map((c) => c.id).slice(0, 2), ["a", ins.clipId]);
  assert.equal(docDurationSec(ins.doc), 15, "3s inserted → everything after rippled");
  assert.ok(ins.doc.media.some((m) => m.id === "new"), "asset registered in doc.media");
  const ow = insertMediaAt(doc, clip, "video", 4, "overwrite");
  assert.equal(lane(ow.doc, "video").map((c) => c.id).length, 4, "B trimmed, not removed");
  assert.ok(docDurationSec(ow.doc) <= 12 + 1e-6, "overwrite keeps the length");
  const bro = lane(ow.doc, "video").find((c) => c.id === "b-b") as Extract<Clip, { kind: "video" }>;
  assert.equal(bro.start, 7);
  assert.equal(bro.sourceIn, 23, "B head trimmed by the 3s overwrite");
});

test("insertMediaAt onto an audio lane and mismatches", () => {
  const doc = baseDoc();
  const ok = insertMediaAt(doc, media("sfx", "audio", 2), "music", 5, "insert");
  assert.ok(ok.clipId);
  assert.equal(lane(ok.doc, "music").find((c) => c.id === ok.clipId)!.start, 12, "music [0,12) occupies 5 → slides to the end");
  assert.equal(insertMediaAt(doc, media("sfx", "audio", 2), "video", 0).clipId, null, "audio on a visual lane");
  assert.equal(insertMediaAt(doc, media("img", "image"), "music", 0).clipId, null, "image on an audio lane");
});

test("addMediaAsOverlay makes a PiP at the drop point on a free lane", () => {
  const r = addMediaAsOverlay(baseDoc(), media("pic", "image", 3), 6, { xFrac: 0.25, yFrac: 0.75 });
  assert.ok(r.clipId);
  const placed = r.doc.tracks.flatMap((t) => t.clips.map((c) => ({ t, c }))).find((x) => x.c.id === r.clipId)!;
  assert.notEqual(placed.t.id, magneticTrackId(r.doc), "not on the main lane");
  assert.equal(placed.c.start, 6);
  const tr = (placed.c as Extract<Clip, { kind: "image" }>).transform;
  assert.deepEqual([tr.x, tr.y, tr.scale], [480, 810, 0.4]);
  // No free lane at all → a fresh layer is created.
  const bare = parseEditDoc({
    version: 1, meta: { width: 1280, height: 720 }, media: [{ id: "m", kind: "video", src: "/m", durationSec: 5 }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "a", kind: "video", start: 0, duration: 5, mediaId: "m" }] }],
  });
  const r2 = addMediaAsOverlay(bare, media("pic", "image", 2), 1);
  assert.equal(r2.doc.tracks.length, 2);
  assert.ok(r2.clipId);
});

test("dropItemIntoDoc: stickers, text styles, pro styles and graphics become edit-doc ops", () => {
  const doc = baseDoc();
  const st = dropItemIntoDoc(doc, { type: "sticker", emoji: "🔥" }, { startSec: 5, at: { xFrac: 0.2, yFrac: 0.3 } })!;
  assert.ok(st && st.clipId);
  const sc = st.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === st.clipId) as Extract<Clip, { kind: "text" }>;
  assert.equal(sc.start, 5);
  assert.equal(sc.transform.x, Math.round(0.2 * 1920));
  const onLane = dropItemIntoDoc(doc, { type: "sticker", emoji: "🔥" }, { startSec: 7, trackId: "layer-1" })!;
  assert.equal(lane(onLane.doc, "layer-1").length, 1, "dropped on a specific free lane");
  assert.equal(lane(onLane.doc, "layer-1")[0]!.start, 7);
  const tp = dropItemIntoDoc(doc, { type: "text-preset", key: "bold-title", text: "WOW" }, { startSec: 2 })!;
  assert.ok(tp.clipId);
  const pro = dropItemIntoDoc(doc, { type: "pro-text", key: "glitch" }, { startSec: 1, at: { xFrac: 0.5, yFrac: 0.5 } })!;
  assert.ok(pro.clipId);
  const gfx = dropItemIntoDoc(doc, { type: "graphic", preset: "subscribe-button" }, { startSec: 3 });
  // A graphic adds its own lane; unknown presets are rejected.
  assert.equal(dropItemIntoDoc(doc, { type: "graphic", preset: "definitely-not-real" }, { startSec: 3 }), null);
  assert.equal(dropItemIntoDoc(doc, { type: "text-preset", key: "nope" }, { startSec: 0 }), null);
  void gfx;
});

test("dropItemIntoDoc media drops respect lane + mode and return null without the asset", () => {
  const doc = baseDoc();
  assert.equal(dropItemIntoDoc(doc, { type: "media", mediaId: "x", mediaKind: "video" }, { startSec: 0, trackId: "video" }), null);
  const r = dropItemIntoDoc(doc, { type: "media", mediaId: "x", mediaKind: "video" }, { startSec: 4, trackId: "video", mode: "insert", media: media("x", "video", 2) })!;
  assert.equal(docDurationSec(r.doc), 14);
  const stage = dropItemIntoDoc(doc, { type: "media", mediaId: "x", mediaKind: "video" }, { startSec: 1, media: media("x", "video", 2), at: { xFrac: 0.5, yFrac: 0.5 } })!;
  assert.equal(docDurationSec(stage.doc), 12, "an overlay drop never lengthens the main lane");
});

test("previewDrop describes exactly what a drop will do", () => {
  const doc = baseDoc();
  const ins = previewDrop(doc, { trackId: "video", startSec: 5.5, durationSec: 3, kind: "video", mode: "insert" });
  assert.deepEqual([ins.valid, ins.startSec, ins.ripples, ins.carve], [true, 4, true, null], "snaps to the cut before B? mid of B is 6 → index 1");
  const ins2 = previewDrop(doc, { trackId: "video", startSec: 7, durationSec: 3, kind: "video", mode: "insert" });
  assert.equal(ins2.startSec, 8, "past B's midpoint → after B");
  const ow = previewDrop(doc, { trackId: "video", startSec: 5, durationSec: 3, kind: "video", mode: "overwrite" });
  assert.deepEqual(ow.carve, [5, 8]);
  const free = previewDrop(doc, { trackId: "broll", startSec: 3, durationSec: 2, kind: "image", mode: "insert" });
  assert.equal(free.startSec, 5);
  assert.equal(previewDrop(doc, { trackId: "music", startSec: 0, durationSec: 2, kind: "video", mode: "insert" }).valid, false);
  assert.equal(previewDrop(doc, { trackId: "titles", startSec: 1.2, durationSec: 2, kind: "text", mode: "insert" }).startSec, 1.2, "overlays may stack");
  assert.equal(previewDrop(doc, { trackId: "nope", startSec: 0, durationSec: 1, kind: "video", mode: "insert" }).valid, false);
});

test("payload helpers report duration + clip kind", () => {
  assert.equal(payloadDurationSec({ type: "media", mediaId: "x", mediaKind: "image" }), 4);
  assert.equal(payloadDurationSec({ type: "media", mediaId: "x", mediaKind: "video", durationSec: 7 }), 7);
  assert.equal(payloadDurationSec({ type: "sticker", emoji: "x" }), 3);
  assert.equal(payloadClipKind({ type: "media", mediaId: "x", mediaKind: "audio" }), "audio");
  assert.equal(payloadClipKind({ type: "graphic", preset: "x" }), "shape");
  assert.equal(payloadClipKind({ type: "pro-text", key: "x" }), "text");
});
