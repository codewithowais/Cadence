/**
 * Editing speed & timeline craft — the pure ops behind split-all, close gaps,
 * in/out range cuts, freeze-frame hold, content-preserving speed presets, group
 * nudge / delete / duplicate, copy/paste attributes and edit-point navigation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitClipAtTime,
  splitAllAtTime,
  splitKeyframes,
  trackGaps,
  closeGap,
  closeGaps,
  rippleDeleteRange,
  keepRange,
  insertFreezeFrame,
  retimeClip,
  nudgeClips,
  copyClipAttributes,
  pasteClipAttributes,
  attributeGroupsOf,
  editPoints,
  nextEditPoint,
  nextMarkerTime,
  DIRECTOR_TOOLS,
  ProjectState,
  StubDirector,
} from "@cadence/director";
import { docDurationSec, parseEditDoc, sourceTimeAt, valueAt, type Clip, type EditDoc } from "@cadence/core";
import {
  rippleDeleteClips,
  duplicateClips,
  deleteClips,
  splitClip,
} from "../apps/web/src/lib/edit-ops.ts";

/** 3 × 4s cuts on the base track, captions over them, music under, 3 markers. */
function cutsDoc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "craft", width: 1920, height: 1080, fps: 30 },
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
        id: "captions",
        kind: "visual",
        clips: [
          { id: "cap1", kind: "text", start: 1, duration: 2, text: "one", words: [{ text: "one", start: 1, end: 2 }] },
          { id: "cap2", kind: "text", start: 5, duration: 2, text: "two", words: [{ text: "two", start: 5, end: 6 }] },
          { id: "cap3", kind: "text", start: 9, duration: 2, text: "three", words: [{ text: "three", start: 9, end: 10 }] },
        ],
      },
      { id: "music", kind: "audio", clips: [{ id: "mus", kind: "audio", start: 0, duration: 12, mediaId: "song" }] },
    ],
    markers: [{ t: 2 }, { t: 6 }, { t: 10 }],
  });
}

const track = (doc: EditDoc, id: string) => doc.tracks.find((t) => t.id === id)!;
const clipsOf = (doc: EditDoc, id: string): Clip[] => track(doc, id).clips;
const spans = (doc: EditDoc, id: string) => clipsOf(doc, id).map((c) => [c.start, c.duration]);

test("splitClipAtTime maps the second half's source through sourceTimeAt (speed + reverse)", () => {
  const doc = cutsDoc();
  const fast = parseEditDoc({ ...doc, tracks: [{ ...doc.tracks[0]!, clips: [{ ...doc.tracks[0]!.clips[0]!, speed: 2 }] }] });
  const out = splitClipAtTime(fast, "a", 1.5);
  const [h1, h2] = clipsOf(out, "video") as Extract<Clip, { kind: "video" }>[];
  assert.deepEqual([h1!.start, h1!.duration, h2!.start, h2!.duration], [0, 1.5, 1.5, 2.5]);
  assert.equal(h2!.sourceIn, 3, "2× speed: 1.5s of timeline = 3s of source");
  // Reversed: the EARLIER half shows the END of the source window.
  const rev = parseEditDoc({ ...doc, tracks: [{ ...doc.tracks[0]!, clips: [{ ...doc.tracks[0]!.clips[0]!, reversed: true }] }] });
  const r = clipsOf(splitClipAtTime(rev, "a", 1), "video") as Extract<Clip, { kind: "video" }>[];
  assert.equal(sourceTimeAt(r[0]!, 0.5), sourceTimeAt(rev.tracks[0]!.clips[0] as never, 0.5), "reversed half 1 shows the same frames");
  assert.equal(sourceTimeAt(r[1]!, 2), sourceTimeAt(rev.tracks[0]!.clips[0] as never, 2), "reversed half 2 shows the same frames");
  // Too close to an edge → unchanged.
  assert.equal(clipsOf(splitClipAtTime(doc, "a", 0.01), "video").length, 3);
});

test("splitKeyframes keeps the animation continuous across the cut", () => {
  const kfs = [
    { prop: "x" as const, t: 0, value: 0, easing: "linear" as const },
    { prop: "x" as const, t: 1, value: 100, easing: "linear" as const },
  ];
  const [a, b] = splitKeyframes(kfs, 0.25);
  assert.equal(valueAt(a, "x", 1, 0), 25, "first half ends at the value at the cut");
  assert.equal(valueAt(b, "x", 0, 0), 25, "second half starts at the value at the cut");
  assert.equal(valueAt(b, "x", 1, 0), 100);
  assert.equal(valueAt(a, "x", 0.5, 0), 12.5, "first half re-normalized");
});

test("web splitClip now splits keyframes + fades instead of replaying them", () => {
  const doc = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080 },
    media: [{ id: "m", kind: "video", src: "/m.mp4", durationSec: 60 }],
    tracks: [{ id: "video", kind: "visual", clips: [{
      id: "a", kind: "video", start: 0, duration: 4, mediaId: "m", fadeInSec: 1, fadeOutSec: 1,
      keyframes: [{ prop: "opacity", t: 0, value: 0 }, { prop: "opacity", t: 1, value: 1 }],
    }] }],
  });
  const [a, b] = clipsOf(splitClip(doc, "a", 2), "video") as Extract<Clip, { kind: "video" }>[];
  assert.equal(a!.fadeOutSec, 0);
  assert.equal(b!.fadeInSec, 0);
  assert.equal(a!.fadeInSec, 1);
  assert.equal(b!.fadeOutSec, 1);
  assert.equal(valueAt(b!.keyframes, "opacity", 0, 1), 0.5);
});

test("splitAllAtTime splits every unlocked track under the playhead", () => {
  const doc = cutsDoc();
  const out = splitAllAtTime(doc, 5.5);
  assert.equal(clipsOf(out, "video").length, 4, "footage split");
  assert.equal(clipsOf(out, "captions").length, 4, "caption under the playhead split");
  assert.equal(clipsOf(out, "music").length, 2, "music split");
  const halves = clipsOf(out, "captions").filter((c) => c.kind === "text" && c.text === "two");
  assert.equal(halves.length, 2);
  assert.equal(docDurationSec(out), 12, "a split never changes the length");
  // Locked tracks are left alone; nothing to split returns the same reference.
  const locked = parseEditDoc({ ...doc, tracks: doc.tracks.map((t) => (t.id === "music" ? { ...t, locked: true } : t)) });
  assert.equal(clipsOf(splitAllAtTime(locked, 5.5), "music").length, 1);
  assert.equal(clipsOf(splitAllAtTime(doc, 4), "video").length, 3, "on an existing cut the footage isn't split again");
  assert.equal(splitAllAtTime(doc, 12), doc, "past every clip: nothing to split → same reference");
});

test("trackGaps / closeGap / closeGaps pack the lane and keep captions in sync", () => {
  const doc = cutsDoc();
  // Delete "b" WITHOUT closing the gap.
  const holed = parseEditDoc({ ...doc, tracks: doc.tracks.map((t) => (t.id === "video" ? { ...t, clips: t.clips.filter((c) => c.id !== "b") } : t)) });
  const gaps = trackGaps(holed);
  assert.deepEqual(gaps, [{ trackId: "video", start: 4, end: 8 }]);
  const closed = closeGap(holed, "video", 6);
  assert.deepEqual(spans(closed, "video"), [[0, 4], [4, 4]]);
  // cap3 (over "c", which moved 8→4) follows; cap1 stays; cap2 (inside the gap) lands at the gap start.
  const caps = clipsOf(closed, "captions");
  assert.deepEqual(caps.map((c) => c.start), [1, 4, 5]);
  const cap3 = caps.find((c) => c.id === "cap3")!;
  assert.ok(cap3.kind === "text" && cap3.words![0]!.start === 5, "karaoke words move with their caption");
  assert.equal(trackGaps(closed).length, 0);
  // Leading gap on the primary track + a gap between: closeGaps packs everything.
  const lead = parseEditDoc({ ...holed, tracks: holed.tracks.map((t) => (t.id === "video" ? { ...t, clips: t.clips.map((c) => ({ ...c, start: c.start + 1 })) } : t)) });
  assert.equal(trackGaps(lead).length, 2);
  const packed = closeGaps(lead);
  assert.deepEqual(spans(packed, "video"), [[0, 4], [4, 4]]);
  assert.equal(closeGaps(packed), packed, "nothing left to close → same reference");
  // Free lanes never report gaps (captions are placed at moments by design).
  assert.equal(trackGaps(doc, "captions").length, 0);
});

test("rippleDeleteRange removes in→out across every track and closes it", () => {
  const doc = cutsDoc();
  const out = rippleDeleteRange(doc, 3, 9);
  assert.equal(docDurationSec(out), 6, "12s − 6s range");
  assert.deepEqual(spans(out, "video"), [[0, 3], [3, 3]]);
  const [v0, v1] = clipsOf(out, "video") as Extract<Clip, { kind: "video" }>[];
  assert.equal(v0!.sourceIn, 0);
  assert.equal(v1!.sourceIn, 41, "the kept tail of 'c' starts on the frame that was at 9s");
  // Captions: cap1 trimmed at 3? (1..3 kept), cap2 (5..7) removed, cap3 (9..11) shifted to 3.
  const caps = clipsOf(out, "captions");
  assert.deepEqual(caps.map((c) => [c.id, c.start, c.duration]), [["cap1", 1, 2], ["cap3", 3, 2]]);
  assert.deepEqual(spans(out, "music"), [[0, 3], [3, 3]], "music cut and closed too");
  assert.deepEqual(out.markers.map((m) => m.t), [2, 4], "marker inside removed, marker after shifted");
  assert.equal(rippleDeleteRange(doc, 5, 5.01), doc, "a tiny range is a no-op");
});

test("keepRange trims the timeline to in→out", () => {
  const out = keepRange(cutsDoc(), 2, 6);
  assert.equal(docDurationSec(out), 4);
  assert.deepEqual(spans(out, "video"), [[0, 2], [2, 2]]);
  const first = clipsOf(out, "video")[0] as Extract<Clip, { kind: "video" }>;
  assert.equal(first.sourceIn, 2);
});

test("insertFreezeFrame holds the frame at the playhead and ripples the rest", () => {
  const doc = cutsDoc();
  const out = insertFreezeFrame(doc, "b", 5, 2);
  const v = clipsOf(out, "video") as Extract<Clip, { kind: "video" }>[];
  assert.equal(v.length, 5, "b split + freeze inserted");
  const freeze = v.find((c) => c.freezeAtSec !== undefined)!;
  assert.equal(freeze.start, 5);
  assert.equal(freeze.duration, 2);
  assert.equal(freeze.freezeAtSec, 21, "the source frame on screen at 5s (b.sourceIn 20 + 1)");
  assert.equal(freeze.volume, 0, "a still is silent");
  assert.equal(docDurationSec(out), 14);
  const bTail = v[v.indexOf(freeze) + 1]!;
  assert.equal(bTail.start, 7);
  assert.equal(bTail.sourceIn, 21, "b continues from the frozen frame");
  assert.equal(clipsOf(out, "captions").find((c) => c.id === "cap3")!.start, 11, "caption after the hold follows");
  assert.equal(clipsOf(out, "captions").find((c) => c.id === "cap1")!.start, 1, "caption before stays");
  // At a clip's head → the hold goes before it.
  const head = clipsOf(insertFreezeFrame(doc, "b", 4, 1), "video") as Extract<Clip, { kind: "video" }>[];
  assert.equal(head[1]!.freezeAtSec, 20);
  assert.equal(head[2]!.id, "b");
  assert.equal(head[2]!.start, 5);
});

test("retimeClip keeps the footage: 2× halves the clip and the lane ripples", () => {
  const doc = cutsDoc();
  const out = retimeClip(doc, "b", 2);
  const v = clipsOf(out, "video") as Extract<Clip, { kind: "video" }>[];
  assert.deepEqual(v.map((c) => [c.start, c.duration]), [[0, 4], [4, 2], [6, 4]]);
  assert.equal(v[1]!.speed, 2);
  assert.equal(v[1]!.sourceIn + v[1]!.duration * v[1]!.speed, 24, "same source window (20→24)");
  const caps = clipsOf(out, "captions");
  assert.equal(caps.find((c) => c.id === "cap2")!.start, 4.5, "caption over the clip re-timed onto the same moment");
  assert.equal(caps.find((c) => c.id === "cap3")!.start, 7, "caption after shifts by −2s");
  // 0.5× doubles it.
  assert.equal(clipsOf(retimeClip(doc, "b", 0.5), "video")[1]!.duration, 8);
  // A ramp's source span is preserved too.
  const ramped = parseEditDoc({ ...doc, tracks: doc.tracks.map((t) => (t.id === "video" ? { ...t, clips: t.clips.map((c) => (c.id === "b" ? { ...c, speedRamp: [[0, 1], [1, 3]] } : c)) } : t)) });
  const r = clipsOf(retimeClip(ramped, "b", 1), "video")[1] as Extract<Clip, { kind: "video" }>;
  assert.equal(r.duration, 8, "ramp 1→3 consumes 8s of source over 4s → 8s at 1×");
  assert.equal(r.speedRamp, undefined);
});

test("nudgeClips moves free clips as a group but never magnetic ones", () => {
  const doc = cutsDoc();
  const out = nudgeClips(doc, ["cap1", "cap2", "b"], 0.5);
  assert.deepEqual(clipsOf(out, "captions").map((c) => c.start), [1.5, 5.5, 9]);
  assert.equal(clipsOf(out, "video")[1]!.start, 4, "a magnetic main clip stays put");
  const left = nudgeClips(doc, ["cap1", "cap2"], -5);
  assert.deepEqual(clipsOf(left, "captions").map((c) => c.start), [0, 4, 9], "clamped at 0, spacing kept");
  assert.equal(nudgeClips(doc, ["a"], 1), doc, "only magnetic clips → same reference");
});

test("group ripple-delete / delete / duplicate fold the single-clip ops", () => {
  const doc = cutsDoc();
  const del = rippleDeleteClips(doc, ["a", "c"]);
  assert.deepEqual(spans(del, "video"), [[0, 4]]);
  assert.equal(clipsOf(del, "video")[0]!.id, "b");
  const gapped = deleteClips(doc, ["a", "cap1"]);
  assert.equal(clipsOf(gapped, "video")[0]!.start, 4, "plain delete leaves the gap");
  const dup = duplicateClips(doc, ["a", "cap2"]);
  assert.equal(clipsOf(dup, "video").length, 4);
  assert.equal(clipsOf(dup, "captions").length, 4);
  assert.equal(docDurationSec(dup), 16);
});

test("copy / paste attributes lands each group only where it fits", () => {
  const doc = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080 },
    media: [
      { id: "m", kind: "video", src: "/m.mp4", durationSec: 60 },
      { id: "p", kind: "image", src: "/p.png" },
      { id: "s", kind: "audio", src: "/s.mp3", durationSec: 60 },
    ],
    tracks: [
      { id: "video", kind: "visual", clips: [
        { id: "src", kind: "video", start: 0, duration: 4, mediaId: "m", volume: 0.4, fadeInSec: 0.5, pan: -0.5,
          look: { warmth: 0.6, saturation: 1.2 }, transform: { x: 100, y: 200, scale: 1.5 }, blendMode: "screen",
          keyframes: [{ prop: "scale", t: 0, value: 1 }, { prop: "scale", t: 1, value: 2 }, { prop: "volume", t: 1, value: 0 }] },
        { id: "dst", kind: "video", start: 4, duration: 4, mediaId: "m" },
        { id: "img", kind: "image", start: 8, duration: 4, mediaId: "p" },
      ] },
      { id: "titles", kind: "visual", clips: [{ id: "txt", kind: "text", start: 0, duration: 2, text: "hi" }] },
      { id: "music", kind: "audio", clips: [{ id: "aud", kind: "audio", start: 0, duration: 8, mediaId: "s" }] },
    ],
  });
  const attrs = copyClipAttributes(doc, "src")!;
  assert.deepEqual(attributeGroupsOf(attrs), ["look", "transform", "motion", "audio", "speed"]);
  const out = pasteClipAttributes(doc, ["dst", "img", "txt", "aud"], attrs);
  const dst = clipsOf(out, "video")[1] as Extract<Clip, { kind: "video" }>;
  assert.equal(dst.look.warmth, 0.6);
  assert.equal(dst.transform.scale, 1.5);
  assert.equal(dst.blendMode, "screen");
  assert.equal(dst.volume, 0.4);
  assert.equal(dst.pan, -0.5);
  assert.equal(dst.keyframes!.length, 3);
  const img = clipsOf(out, "video")[2] as Extract<Clip, { kind: "image" }>;
  assert.equal(img.look.warmth, 0.6);
  assert.ok(img.keyframes!.every((k) => k.prop !== "volume"), "photos can't animate volume");
  const txt = clipsOf(out, "titles")[0] as Extract<Clip, { kind: "text" }>;
  assert.equal(txt.transform.x, 100, "text takes the transform");
  const aud = clipsOf(out, "music")[0] as Extract<Clip, { kind: "audio" }>;
  assert.equal(aud.volume, 0.4);
  assert.ok(aud.keyframes!.every((k) => k.prop === "volume"), "audio only keeps volume keyframes");
  // Only the chosen groups.
  const lookOnly = clipsOf(pasteClipAttributes(doc, ["dst"], attrs, ["look"]), "video")[1] as Extract<Clip, { kind: "video" }>;
  assert.equal(lookOnly.look.warmth, 0.6);
  assert.equal(lookOnly.volume, 1, "audio untouched");
  // Speed pastes content-preserving.
  const fast = copyClipAttributes(retimeClip(doc, "src", 2), "src")!;
  const sped = clipsOf(pasteClipAttributes(doc, ["dst"], fast, ["speed"]), "video")[1] as Extract<Clip, { kind: "video" }>;
  assert.deepEqual([sped.speed, sped.duration], [2, 2]);
});

test("editPoints / nextEditPoint / nextMarkerTime navigate cuts and markers", () => {
  const doc = cutsDoc();
  assert.deepEqual(editPoints(doc), [0, 1, 3, 4, 5, 7, 8, 9, 11, 12]);
  assert.equal(nextEditPoint(doc, 4, 1), 5);
  assert.equal(nextEditPoint(doc, 4, -1), 3);
  assert.equal(nextEditPoint(doc, 12, 1), null);
  assert.equal(nextEditPoint(doc, 0, -1), null);
  assert.equal(nextMarkerTime(doc, 2, 1), 6);
  assert.equal(nextMarkerTime(doc, 2, -1), null);
});

test("Director tools: split_all_tracks · close_gaps · cut_range · hold_frame · retime_clip", async () => {
  const project = new ProjectState({ media: cutsDoc().media, doc: cutsDoc() });
  const ctx = { project };
  await DIRECTOR_TOOLS.split_all_tracks.execute({ atSec: 2 }, ctx);
  assert.equal(clipsOf(project.doc, "video").length, 4);
  await DIRECTOR_TOOLS.cut_range.execute({ startSec: 2, endSec: 4 }, ctx);
  assert.equal(docDurationSec(project.doc), 10);
  await DIRECTOR_TOOLS.hold_frame.execute({ atSec: 1, holdSec: 1 }, ctx);
  assert.equal(docDurationSec(project.doc), 11);
  await DIRECTOR_TOOLS.retime_clip.execute({ atSec: 5, speed: 2 }, ctx);
  assert.ok(docDurationSec(project.doc) < 11);
  await DIRECTOR_TOOLS.cut_range.execute({ startSec: 0, endSec: 3, keep: true }, ctx);
  assert.equal(docDurationSec(project.doc), 3);
  const holed = parseEditDoc({ ...cutsDoc(), tracks: cutsDoc().tracks.map((t) => (t.id === "video" ? { ...t, clips: t.clips.filter((c) => c.id !== "b") } : t)) });
  const p2 = new ProjectState({ media: holed.media, doc: holed });
  const r = await DIRECTOR_TOOLS.close_gaps.execute({}, { project: p2 });
  assert.match(r.summary, /Closed 1 gap/);
  assert.equal(trackGaps(p2.doc).length, 0);
});

test("StubDirector routes plain-language craft requests to the new tools", async () => {
  const holed = () =>
    parseEditDoc({ ...cutsDoc(), tracks: cutsDoc().tracks.map((t) => (t.id === "video" ? { ...t, clips: t.clips.filter((c) => c.id !== "b") } : t)) });
  const run = async (req: string, doc: EditDoc = cutsDoc()) => {
    const project = new ProjectState({ media: doc.media, doc });
    return new StubDirector().interpret(req, project);
  };
  const names = async (req: string, doc?: EditDoc) => (await run(req, doc)).toolCalls.map((c) => c.name);
  assert.deepEqual(await names("split all tracks at 6s"), ["split_all_tracks"]);
  assert.deepEqual(await names("close the gaps", holed()), ["close_gaps"]);
  assert.ok(!(await names("remove the gaps", holed())).includes("close_gaps"), "“remove the gaps” keeps meaning dead air (remove_silence)");
  const cut = await run("remove from 2s to 5s");
  assert.deepEqual(cut.toolCalls.map((c) => c.name), ["cut_range"]);
  assert.equal(cut.durationSec, 9);
  const keep = await run("keep only 2s to 5s");
  assert.deepEqual(keep.toolCalls.map((c) => c.name), ["cut_range"]);
  assert.equal(keep.durationSec, 3);
  const hold = await run("freeze the frame at 3s for 2 seconds");
  assert.deepEqual(hold.toolCalls.map((c) => c.name), ["hold_frame"]);
  assert.equal(hold.durationSec, 14);
  // The whole-clip freeze_frame phrasing is unchanged.
  assert.deepEqual(await names("freeze frame at 3s"), ["freeze_frame"]);
});
