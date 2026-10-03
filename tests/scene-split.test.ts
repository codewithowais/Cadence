/**
 * Already-built video → divided into clips. Pure scoring (packages/understanding
 * scenes.ts), the `splitIntoScenes` op, the `split_into_scenes` Director tool and
 * the StubDirector routing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frameSignature,
  signatureDistance,
  scoreSeries,
  detectCutsFromScores,
  sensitivityParams,
  refineCut,
  normalizeCuts,
  cutsToShots,
  sentenceCuts,
  silenceCuts,
  beatCuts,
  intervalCuts,
  planSourceSplit,
  samplePlan,
  SplitPlanError,
  parseShowinfoCuts,
  sceneScanArgs,
  ffmpegSceneThreshold,
  type Transcript,
  type FrameSignature,
} from "@cadence/understanding";
import {
  splitIntoScenes,
  timelineTimeAtSource,
  parseSceneSplit,
  wantsSceneDetection,
  DIRECTOR_TOOLS,
  ProjectState,
  StubDirector,
} from "@cadence/director";
import { docDurationSec, parseEditDoc, sourceTimeAt, type EditDoc, type VideoClip } from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";

// ---- synthetic frames -------------------------------------------------------

function solid(r: number, g: number, b: number, w = 32, h = 18, noise = 0, seed = 1): FrameSignature {
  const px = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = r + rnd() * noise;
    px[i * 4 + 1] = g + rnd() * noise;
    px[i * 4 + 2] = b + rnd() * noise;
    px[i * 4 + 3] = 255;
  }
  return frameSignature(px, w, h);
}

/** A multi-shot "video": per-shot colour with sensor noise, sampled at 4 fps. */
function series(shots: { dur: number; rgb: [number, number, number] }[], fps = 4) {
  const sigs: FrameSignature[] = [];
  const times: number[] = [];
  let t = 0;
  let k = 0;
  for (const s of shots) {
    for (let i = 0; i < s.dur * fps; i++) {
      sigs.push(solid(s.rgb[0], s.rgb[1], s.rgb[2], 32, 18, 14, ++k));
      times.push(Math.round((t + i / fps) * 1000) / 1000);
    }
    t += s.dur;
  }
  return { sigs, times, duration: t };
}

const SHOTS: { dur: number; rgb: [number, number, number] }[] = [
  { dur: 3, rgb: [200, 40, 40] },
  { dur: 4, rgb: [40, 200, 60] },
  { dur: 2.5, rgb: [50, 60, 210] },
  { dur: 5, rgb: [230, 220, 40] },
];

test("signatureDistance: identical ≈ 0, different scene ≫ noise", () => {
  const a = solid(200, 40, 40, 32, 18, 14, 1);
  const a2 = solid(200, 40, 40, 32, 18, 14, 2);
  const b = solid(40, 200, 60, 32, 18, 14, 3);
  assert.equal(signatureDistance(a, a), 0);
  assert.ok(signatureDistance(a, a2) < 0.08, "sensor noise alone stays tiny");
  assert.ok(signatureDistance(a, b) > 0.5, "a different scene is far");
  const d = signatureDistance(a, b);
  assert.ok(d >= 0 && d <= 1);
  assert.equal(signatureDistance(a, b), signatureDistance(b, a), "symmetric");
});

test("detectCutsFromScores finds each colour change, once, at the right time", () => {
  const { sigs, times, duration } = series(SHOTS);
  const cuts = detectCutsFromScores(times, scoreSeries(sigs), duration, { sensitivity: 0.5, minShotSec: 1 });
  assert.deepEqual(cuts.map((c) => c.t), [3, 7, 9.5]);
  for (const c of cuts) assert.ok(c.score > 0.4 && c.score <= 1);
});

test("a single-shot noisy video yields no cuts (adaptive threshold does not fire on noise)", () => {
  const { sigs, times, duration } = series([{ dur: 20, rgb: [120, 130, 140] }]);
  assert.deepEqual(detectCutsFromScores(times, scoreSeries(sigs), duration, { sensitivity: 1 }), []);
});

test("minShotSec suppresses the weaker of two hits (a flash) and cuts near the ends", () => {
  const times = Array.from({ length: 40 }, (_, i) => i * 0.25);
  const scores = times.map(() => 0.02);
  scores[20] = 0.9; // cut at 5.0
  scores[21] = 0.6; // flash echo at 5.25 → suppressed
  scores[1] = 0.8; // 0.25s after the start → too close to the edge
  const cuts = detectCutsFromScores(times, scores, 10, { minShotSec: 1 });
  assert.deepEqual(cuts.map((c) => c.t), [5]);
});

test("sensitivity is monotonic: a soft change appears only at higher sensitivity", () => {
  const times = Array.from({ length: 60 }, (_, i) => i * 0.25);
  const scores = times.map(() => 0.02);
  scores[15] = 0.9; // hard cut
  scores[40] = 0.2; // soft change
  const at = (s: number) => detectCutsFromScores(times, scores, 15, { sensitivity: s, minShotSec: 1 }).length;
  assert.equal(at(0.1), 1);
  assert.equal(at(0.95), 2);
  assert.ok(sensitivityParams(0.9).absMin < sensitivityParams(0.1).absMin);
  assert.ok(sensitivityParams(0.9).k < sensitivityParams(0.1).k);
});

test("refineCut picks the largest adjacent jump inside a sample gap", () => {
  const a = solid(10, 10, 10);
  const b = solid(240, 240, 240);
  const times = [2, 2.05, 2.1, 2.15, 2.2];
  assert.equal(refineCut(times, [a, a, a, b, b], 2.2), 2.15);
  assert.equal(refineCut([1], [a], 1), 1, "degenerate input falls back");
});

test("samplePlan is bounded for very long media", () => {
  assert.equal(samplePlan(10, { fps: 4 }).length, 40);
  assert.equal(samplePlan(7200, { fps: 4, maxSamples: 900 }).length, 900);
  assert.deepEqual(samplePlan(0), []);
  const p = samplePlan(10);
  assert.ok(p.every((t, i) => t < 10 && (i === 0 || t > p[i - 1]!)));
});

test("normalizeCuts / cutsToShots tile [0, duration] with labels", () => {
  const cuts = normalizeCuts([5, 5, 0.2, 9.9, 3, NaN], 10, 1);
  assert.deepEqual(cuts, [3, 5]);
  const shots = cutsToShots(cuts, 10, { labels: ["Intro"] });
  assert.deepEqual(shots.map((s) => [s.start, s.end, s.label]), [
    [0, 3, "Intro"],
    [3, 5, "Scene 2"],
    [5, 10, "Scene 3"],
  ]);
});

// ---- other strategies --------------------------------------------------------

const TRANSCRIPT: Transcript = (() => {
  const seg = (id: string, text: string, start: number, end: number) => {
    const ws = text.split(" ");
    const step = (end - start) / ws.length;
    return { id, text, start, end, words: ws.map((w, i) => ({ text: w, start: start + i * step, end: start + (i + 1) * step - 0.02 })) };
  };
  const segments = [
    seg("s1", "Welcome to the show everybody", 0.5, 3),
    seg("s2", "Today we talk about editing", 3.2, 6),
    seg("s3", "Fast one", 6.1, 6.6), // too short alone
    seg("s4", "Now the big announcement arrives", 6.9, 9.4), // merges into s3's piece
    seg("s5", "And finally the end", 12.5, 14),
  ];
  return { mediaId: "m", durationSec: 14, language: "en", segments, words: segments.flatMap((s) => s.words) };
})();

test("sentenceCuts cuts before each sentence, merges tiny ones, labels with the opening words", () => {
  const r = sentenceCuts(TRANSCRIPT, 14, { minShotSec: 1 });
  assert.equal(r.cuts.length, 3);
  assert.ok(r.cuts[0]! > 3 && r.cuts[0]! < 3.2, "cut sits in the gap, before the next word");
  assert.ok(r.cuts[1]! > 6 && r.cuts[1]! < 6.1);
  assert.ok(r.cuts[2]! > 9.4 && r.cuts[2]! < 12.5);
  assert.equal(r.labels.length, 4);
  assert.equal(r.labels[0], "Welcome to the show everybody");
  assert.match(r.labels[1]!, /^Today we talk about editing/);
  assert.match(r.labels[2]!, /^Fast one Now the big/, "the too-short sentence absorbed its neighbour");
  assert.equal(r.labels[3], "And finally the end");
});

test("silenceCuts cuts mid-gap only for gaps ≥ minGap", () => {
  const cuts = silenceCuts(TRANSCRIPT, 14, { minGapSec: 1, minShotSec: 1 });
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0]! > 9.4 && cuts[0]! < 12.5);
  assert.ok(silenceCuts(TRANSCRIPT, 14, { minGapSec: 0.15, minShotSec: 0.5 }).length >= 2);
});

test("beatCuts honours every-Nth and min length; intervalCuts steps cleanly", () => {
  const beats = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
  assert.deepEqual(beatCuts(beats, 5, { every: 4, minShotSec: 0.5 }), [2, 4]);
  assert.deepEqual(beatCuts(beats, 5, { every: 1, minShotSec: 1 }), [1, 2, 3, 4]);
  assert.deepEqual(intervalCuts(12, 5), [5, 10]);
  assert.deepEqual(intervalCuts(10, 5), [5], "no cut at the very end");
  assert.deepEqual(intervalCuts(10, 20), []);
});

test("planSourceSplit: shared planner + helpful errors when analysis is missing", () => {
  assert.throws(() => planSourceSplit({ method: "scenes", durationSec: 10 }), SplitPlanError);
  assert.throws(() => planSourceSplit({ method: "sentences", durationSec: 10 }), /transcript/);
  assert.throws(() => planSourceSplit({ method: "interval", durationSec: 10 }), /how often/);
  const p = planSourceSplit({ method: "scenes", durationSec: 20, sceneCuts: [4, 4.2, 9, 19.8], minShotSec: 1 });
  assert.deepEqual(p.cuts, [4, 9]);
  assert.deepEqual(p.shots.map((s) => s.label), ["Scene 1", "Scene 2", "Scene 3"]);
  const i = planSourceSplit({ method: "interval", durationSec: 12, every: 5 });
  assert.equal(i.shots.length, 3);
  assert.equal(i.shots[0]!.label, "Part 1");
});

test("ffmpeg scene scan: showinfo parsing and the exact filter", () => {
  const stderr = [
    "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  90000 pts_time:1.5     duration: 1",
    "[Parsed_showinfo_1 @ 0x1] n:   1 pts: 270000 pts_time:4.512   duration: 1",
    "noise line",
    "[Parsed_showinfo_1 @ 0x1] n:   2 pts: 270000 pts_time:4.512   duration: 1",
  ].join("\n");
  assert.deepEqual(parseShowinfoCuts(stderr), [1.5, 4.512]);
  assert.deepEqual(parseShowinfoCuts(""), []);
  const args = sceneScanArgs("/tmp/x.mp4", 0.3);
  assert.ok(args.includes("select='gt(scene,0.3)',showinfo"));
  assert.equal(args[args.indexOf("-i") + 1], "/tmp/x.mp4");
  assert.ok(ffmpegSceneThreshold(1) < ffmpegSceneThreshold(0));
});

// ---- the op -------------------------------------------------------------------

function longDoc(over: Record<string, unknown> = {}): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "built", width: 1280, height: 720, fps: 30 },
    media: [{ id: "m", kind: "video", src: "built.mp4", durationSec: 60, width: 1280, height: 720, label: "built.mp4" }],
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [{ id: "src", kind: "video", start: 0, duration: 60, mediaId: "m", sourceIn: 0, transform: { x: 640, y: 360 }, ...over }],
      },
      { id: "captions", kind: "visual", clips: [{ id: "cap", kind: "text", start: 40, duration: 5, text: "hello" }] },
      { id: "music", kind: "audio", clips: [] },
    ],
    markers: [{ t: 30 }],
  });
}

const videoClips = (doc: EditDoc): VideoClip[] =>
  doc.tracks.flatMap((t) => (t.id === "video" ? t.clips : [])).filter((c): c is VideoClip => c.kind === "video").sort((a, b) => a.start - b.start);

test("splitIntoScenes: pieces tile the source, offsets are exact, labelled, overlays untouched", () => {
  const doc = longDoc();
  const r = splitIntoScenes(doc, { sourceCuts: [10, 25.5, 40], labelPrefix: "Scene" });
  assert.equal(r.pieces, 4);
  const clips = videoClips(r.doc);
  assert.deepEqual(clips.map((c) => [c.start, c.duration, c.sourceIn]), [[0, 10, 0], [10, 15.5, 10], [25.5, 14.5, 25.5], [40, 20, 40]]);
  assert.deepEqual(clips.map((c) => c.label), ["Scene 1", "Scene 2", "Scene 3", "Scene 4"]);
  assert.equal(docDurationSec(r.doc), 60, "ripple-safe: total length unchanged");
  const cap = r.doc.tracks.find((t) => t.id === "captions")!.clips[0]!;
  assert.equal(cap.start, 40, "captions did not move");
  assert.deepEqual(r.doc.markers?.map((m) => m.t), [30]);
  assert.equal(r.clipIds.length, 4);
  assert.equal(doc.tracks[0]!.clips.length, 1, "input doc is not mutated (undo-safe)");
});

test("splitIntoScenes honours speed: source cuts map back through the clip's playback rate", () => {
  const doc = longDoc({ speed: 2, duration: 30 }); // plays source 0..60 in 30s
  const r = splitIntoScenes(doc, { sourceCuts: [20, 40] });
  const clips = videoClips(r.doc);
  assert.deepEqual(clips.map((c) => [c.start, c.duration]), [[0, 10], [10, 10], [20, 10]]);
  assert.deepEqual(clips.map((c) => c.sourceIn), [0, 20, 40]);
  assert.ok(clips.every((c) => c.speed === 2));
  assert.equal(timelineTimeAtSource(videoClips(doc)[0]!, 20), 10);
});

test("splitIntoScenes handles a reversed clip (cuts still show the right source frames)", () => {
  const doc = longDoc({ reversed: true });
  const orig = videoClips(doc)[0]!;
  const r = splitIntoScenes(doc, { sourceCuts: [15] });
  const [first, second] = videoClips(r.doc);
  assert.equal(r.pieces, 2);
  // At the boundary both pieces show source second 15.
  assert.ok(Math.abs(sourceTimeAt(first!, first!.start + first!.duration) - 15) < 0.01);
  assert.ok(Math.abs(sourceTimeAt(second!, second!.start) - 15) < 0.01);
  assert.ok(Math.abs(sourceTimeAt(orig, 45) - 15) < 1e-6, "sanity: original maps timeline 45 → source 15");
});

test("splitIntoScenes: min shot, edges, duplicates, locked tracks, freeze frames are respected", () => {
  const doc = longDoc();
  const r = splitIntoScenes(doc, { sourceCuts: [0.3, 10, 10.2, 59.9], minShotSec: 1 });
  assert.deepEqual(videoClips(r.doc).map((c) => c.start), [0, 10]);
  assert.equal(splitIntoScenes(doc, { sourceCuts: [] }).doc, doc, "nothing to cut → same reference");
  assert.equal(splitIntoScenes(doc, { sourceCuts: [200] }).pieces, 0, "out-of-range cut ignored");
  const locked = parseEditDoc({ ...doc, tracks: doc.tracks.map((t) => (t.id === "video" ? { ...t, locked: true } : t)) });
  assert.equal(splitIntoScenes(locked, { sourceCuts: [10] }).pieces, 0);
  const frozen = longDoc({ freezeAtSec: 5 });
  assert.equal(splitIntoScenes(frozen, { sourceCuts: [10] }).pieces, 0);
});

test("splitIntoScenes: everySec chops evenly; timelineCuts for beats", () => {
  const r = splitIntoScenes(longDoc(), { everySec: 25, labelPrefix: "Part" });
  assert.deepEqual(videoClips(r.doc).map((c) => c.duration), [25, 25, 10]);
  assert.equal(videoClips(r.doc)[2]!.label, "Part 3");
  const b = splitIntoScenes(longDoc(), { timelineCuts: [12, 24.5] });
  assert.equal(b.pieces, 3);
});

test("splitIntoScenes: a sync-aligned audio clip of the same media is split in lockstep (audio link)", () => {
  const doc = parseEditDoc({
    ...longDoc(),
    tracks: [
      ...longDoc().tracks.filter((t) => t.id !== "music"),
      { id: "audio", kind: "audio", clips: [{ id: "a1", kind: "audio", start: 0, duration: 60, mediaId: "m", sourceIn: 0 }] },
    ],
  });
  const r = splitIntoScenes(doc, { sourceCuts: [20] });
  const audio = r.doc.tracks.find((t) => t.id === "audio")!.clips;
  assert.equal(audio.length, 2);
  assert.equal(audio[1]!.start, 20);
  assert.equal(audio[1]!.kind === "audio" ? audio[1]!.sourceIn : -1, 20);
  // An out-of-sync audio clip (offset by 5s) is left alone.
  const off = parseEditDoc({
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === "audio" ? { ...t, clips: [{ id: "a1", kind: "audio", start: 5, duration: 50, mediaId: "m", sourceIn: 0 }] } : t)),
  });
  assert.equal(splitIntoScenes(off, { sourceCuts: [20] }).doc.tracks.find((t) => t.id === "audio")!.clips.length, 1);
});

test("splitIntoScenes re-splitting is stable (idempotent on the same cuts)", () => {
  const once = splitIntoScenes(longDoc(), { sourceCuts: [10, 30] }).doc;
  const twice = splitIntoScenes(once, { sourceCuts: [10, 30] });
  assert.equal(twice.pieces, 0);
  assert.equal(twice.doc, once);
});

test("a divided doc still renders a frame (render-verify)", async () => {
  const r = splitIntoScenes(longDoc(), { sourceCuts: [10, 30] });
  const frame = await new CanvasRenderEngine().renderFrame(r.doc, 12);
  assert.deepEqual([...frame.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(frame.data.length > 100);
});

// ---- the tool + routing ----------------------------------------------------------

test("split_into_scenes tool: scenes (client cuts), sentences, interval, silence; friendly errors", async () => {
  const mk = (cuts?: Record<string, number[]>) => {
    const doc = longDoc();
    const p = new ProjectState({ media: doc.media, doc, transcripts: [{ ...TRANSCRIPT, durationSec: 60 }], sceneCuts: cuts });
    return p;
  };
  const t = DIRECTOR_TOOLS.split_into_scenes;
  await assert.rejects(() => t.execute({ method: "scenes" }, { project: mk() }), /look at the frames/);
  const p1 = mk({ m: [10, 30] });
  const r1 = await t.execute({ method: "scenes" }, { project: p1 });
  assert.match(r1.summary, /3 clips by scene changes/);
  assert.equal(videoClips(p1.doc).length, 3);
  const p2 = mk();
  await t.execute({ method: "interval", every: 20 }, { project: p2 });
  assert.equal(videoClips(p2.doc).length, 3);
  const p3 = mk();
  await t.execute({ method: "sentences" }, { project: p3 });
  const labels = videoClips(p3.doc).map((c) => c.label);
  assert.equal(labels.length, 4);
  assert.match(labels[0]!, /^Welcome to the show/);
  const p4 = mk();
  await t.execute({ method: "silence", sensitivity: 0.5 }, { project: p4 });
  assert.ok(videoClips(p4.doc).length >= 2);
  await assert.rejects(() => t.execute({ method: "scenes", cuts: [0.2] }, { project: mk() }), /didn't find any scene changes/);
  await assert.rejects(() => t.execute({ method: "interval" }, { project: mk() }), /how often/);
  const empty = new ProjectState();
  await assert.rejects(() => t.execute({ method: "interval", every: 5 }, { project: empty }), /no video/);
});

test("parseSceneSplit maps plain-language phrases", () => {
  const m = (s: string) => parseSceneSplit(s)?.input;
  assert.deepEqual(m("split this video into scenes"), { method: "scenes" });
  assert.deepEqual(m("divide into clips"), { method: "scenes" });
  assert.deepEqual(m("cut at every scene change"), { method: "scenes" });
  assert.deepEqual(m("Detect scenes"), { method: "scenes" });
  assert.deepEqual(m("chop every 5 seconds"), { method: "interval", every: 5 });
  assert.deepEqual(m("split into 10 second clips"), { method: "interval", every: 10 });
  assert.deepEqual(m("cut every 2.5s"), { method: "interval", every: 2.5 });
  assert.deepEqual(m("split by sentence"), { method: "sentences" });
  assert.deepEqual(m("split at the pauses"), { method: "silence" });
  assert.deepEqual(m("chop to the beat"), { method: "beats" });
  assert.equal(m("split into scenes, more sensitive")?.sensitivity, 0.8);
  assert.equal(m("divide into scenes but only the major ones")?.sensitivity, 0.25);
  assert.equal(m("split into scenes at least 2 seconds long")?.minShotSec, 2);
  for (const no of ["cut a 60-second highlight", "remove the silence", "cut the silences", "make it vertical", "cut to the beat", "trim to 30 seconds", "split all tracks at 6s"]) {
    assert.equal(parseSceneSplit(no), null, no);
  }
  assert.equal(wantsSceneDetection("split into scenes"), true);
  assert.equal(wantsSceneDetection("chop every 5 seconds"), false);
});

test("StubDirector routes split phrases to split_into_scenes without side-reads", async () => {
  const run = async (req: string, cuts?: Record<string, number[]>) => {
    const doc = longDoc();
    const project = new ProjectState({ media: doc.media, doc, transcripts: [{ ...TRANSCRIPT, durationSec: 60 }], sceneCuts: cuts });
    return new StubDirector().interpret(req, project);
  };
  const a = await run("split this video into scenes", { m: [15, 45] });
  assert.deepEqual(a.toolCalls.map((c) => c.name), ["split_into_scenes"]);
  assert.equal(videoClips(parseEditDoc(a.doc)).length, 3);
  const b = await run("chop every 20 seconds");
  assert.deepEqual(b.toolCalls.map((c) => c.name), ["split_into_scenes"], "not also a highlight");
  assert.equal(videoClips(parseEditDoc(b.doc)).length, 3);
  const c = await run("divide into clips and give it a warm look", { m: [30] });
  assert.deepEqual(c.toolCalls.map((x) => x.name), ["split_into_scenes", "apply_look"]);
  // Without client-detected cuts the scenes request fails softly (no tool call recorded).
  const d = await run("split into scenes");
  assert.deepEqual(d.toolCalls, []);
  assert.match(d.summary, /look at the frames/);
});
