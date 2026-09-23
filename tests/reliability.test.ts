/**
 * Reliability, speed & trust — the PURE pieces: ffmpeg progress parsing, the
 * export progress stream protocol, export pre-flight, autosave draft
 * (de)serialization and the project-file envelope. No I/O, no DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEditDoc, type EditDoc } from "@cadence/core";
import {
  FfmpegProgressParser,
  MonotonicProgress,
  blockFraction,
  blockOutTimeSec,
  etaSeconds,
  parseClockTime,
} from "@cadence/render-ffmpeg";
import {
  ExportStreamDecoder,
  asExportEvent,
  encodeExportEvent,
  formatEta,
} from "../apps/web/src/lib/export-stream.ts";
import { preflightExport, stripUnusedMedia, usedMediaIds } from "../apps/web/src/lib/export-preflight.ts";
import {
  SCRATCH_DRAFT_KEY,
  buildDraft,
  describeDraftAge,
  draftHasContent,
  draftMedia,
  draftSummary,
  mediaToPersist,
  mediaToPrune,
  parseDraft,
} from "../apps/web/src/lib/autosave.ts";
import {
  buildProjectFile,
  matchFilesToMissing,
  parseProjectFile,
  projectFileName,
} from "../apps/web/src/lib/project-file.ts";

// A real `-progress pipe:1` transcript captured from the bundled ffmpeg 6.0.
const REAL_PROGRESS = [
  "frame=0", "fps=0.00", "stream_0_0_q=0.0", "bitrate=  -0.0kbits/s", "total_size=0",
  "out_time_us=-9223372036854775807", "out_time_ms=-9223372036854775807", "out_time=-577014:32:22.775807",
  "dup_frames=0", "drop_frames=0", "speed=N/A", "progress=continue",
  "frame=45", "fps=0.00", "out_time_us=1500000", "out_time_ms=1500000", "out_time=00:00:01.500000",
  "speed=30x", "progress=continue",
  "frame=90", "fps=0.00", "stream_0_0_q=-1.0", "bitrate=  48.4kbits/s", "total_size=17540",
  "out_time_us=2900000", "out_time_ms=2900000", "out_time=00:00:02.900000",
  "dup_frames=0", "drop_frames=0", "speed=68.9x", "progress=end",
].join("\n") + "\n";

test("progress parser: splits blocks across arbitrary chunk boundaries", () => {
  const whole = new FfmpegProgressParser().push(REAL_PROGRESS);
  assert.equal(whole.length, 3);
  // Feed one byte at a time — identical blocks.
  const p = new FfmpegProgressParser();
  const bytewise = [...REAL_PROGRESS].flatMap((ch) => p.push(ch));
  assert.deepEqual(bytewise, whole);
  assert.equal(whole[2]!.progress, "end");
  assert.equal(whole[1]!.out_time_us, "1500000");
});

test("progress parser: negative sentinel / N/A read as 'no data yet'", () => {
  const [first, mid, last] = new FfmpegProgressParser().push(REAL_PROGRESS);
  assert.equal(blockOutTimeSec(first!), null);
  assert.equal(blockFraction(first!, 3, 30), null, "no time and frame=0 → nothing known yet");
  assert.equal(blockOutTimeSec(mid!), 1.5);
  assert.equal(blockFraction(mid!, 3), 0.5);
  assert.equal(blockFraction(last!, 3), 1, "progress=end is always 1");
});

test("progress fraction: clock-string and frame fallbacks, clamped", () => {
  assert.equal(parseClockTime("00:01:02.500000"), 62.5);
  assert.equal(parseClockTime("-577014:32:22.775807"), null);
  assert.equal(parseClockTime("garbage"), null);
  assert.equal(blockFraction({ out_time: "00:00:05.000000" }, 10), 0.5);
  assert.equal(blockFraction({ frame: "150" }, 10, 30), 0.5);
  assert.equal(blockFraction({ out_time_us: "20000000" }, 10), 1, "overshoot clamps to 1");
  assert.equal(blockFraction({ out_time_us: "5000000" }, 0), null, "unknown total → null");
});

test("progress: ETA extrapolation needs signal, never negative", () => {
  assert.equal(etaSeconds(0.01, 10), null, "too early (<2%)");
  assert.equal(etaSeconds(0.5, 0.1), null, "too soon (<0.5s)");
  assert.equal(etaSeconds(0.25, 5), 15);
  assert.equal(etaSeconds(1, 7), 0);
});

test("progress: MonotonicProgress never moves backwards and throttles tiny steps", () => {
  const m = new MonotonicProgress(0.01);
  assert.equal(m.update(0.1), 0.1);
  assert.equal(m.update(0.05), null, "backwards step is dropped");
  assert.equal(m.update(0.105), null, "sub-step is throttled");
  assert.equal(m.update(0.2), 0.2);
  assert.equal(m.update(null), null);
  assert.equal(m.finish(), 1);
  assert.equal(m.finish(), null);
  assert.equal(m.value, 1);
});

// ---- export progress stream protocol ------------------------------------------

function streamBytes(fileBytes: Uint8Array): Uint8Array {
  const parts = [
    encodeExportEvent({ type: "phase", phase: "preparing" }),
    encodeExportEvent({ type: "progress", fraction: 0.25, etaSec: 9 }),
    encodeExportEvent({ type: "progress", fraction: 0.8, etaSec: null }),
    encodeExportEvent({ type: "file", size: fileBytes.byteLength, filename: "x.mp4", contentType: "video/mp4" }),
    fileBytes,
  ];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

test("stream decoder: events then byte-exact binary file, any chunking", () => {
  // Binary payload deliberately full of 0x0a (newline) and invalid UTF-8.
  const file = new Uint8Array(4096).map((_, i) => (i % 7 === 0 ? 0x0a : (i * 31) & 0xff));
  const bytes = streamBytes(file);
  for (const chunk of [1, 3, 17, 1000, bytes.byteLength]) {
    const d = new ExportStreamDecoder();
    const events = [];
    for (let i = 0; i < bytes.byteLength; i += chunk) events.push(...d.push(bytes.subarray(i, i + chunk)));
    assert.deepEqual(events.map((e) => e.type), ["phase", "progress", "progress", "file"], `chunk=${chunk}`);
    assert.ok(d.complete, `chunk=${chunk} complete`);
    const joined = new Uint8Array(d.fileBytes);
    let o = 0;
    for (const p of d.fileParts) { joined.set(p, o); o += p.byteLength; }
    assert.deepEqual(joined, file, `chunk=${chunk}: file bytes must be identical`);
  }
});

test("stream decoder: error events, corrupt lines, unknown types, trailing bytes", () => {
  const d = new ExportStreamDecoder();
  const ev = d.push(new TextEncoder().encode('{"type":"hello"}\n{"type":"error","error":"boom","code":"X"}\n'));
  assert.deepEqual(ev, [{ type: "error", error: "boom", code: "X" }], "unknown types are skipped");
  const bad = new ExportStreamDecoder();
  bad.push(new TextEncoder().encode("not json\n"));
  assert.ok(bad.corrupt);
  // Bytes beyond the declared size are ignored.
  const extra = new ExportStreamDecoder();
  extra.push(encodeExportEvent({ type: "file", size: 2, filename: "a", contentType: "video/mp4" }));
  extra.push(new Uint8Array([1, 2, 3, 4]));
  assert.equal(extra.fileBytes, 2);
  assert.ok(extra.complete);
});

test("stream events are validated defensively", () => {
  assert.equal(asExportEvent({ type: "progress", fraction: "x" }), null);
  assert.deepEqual(asExportEvent({ type: "progress", fraction: 2, etaSec: -1 }), { type: "progress", fraction: 1, etaSec: null });
  assert.equal(asExportEvent({ type: "phase", phase: "hacking" }), null);
  assert.equal(asExportEvent({ type: "file", size: -1 }), null);
  assert.equal(formatEta(null), "");
  assert.equal(formatEta(0.4), "almost done");
  assert.equal(formatEta(12.2), "~12s left");
  assert.equal(formatEta(125), "~2 min left");
});

// ---- export pre-flight ---------------------------------------------------------

function footageDoc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "p", width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "a", kind: "video", src: "a.mp4", label: "Beach.mp4" },
      { id: "b", kind: "audio", src: "b.mp3", label: "Song.mp3" },
      { id: "unused", kind: "video", src: "u.mp4", label: "Leftover.mp4" },
    ],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "v", kind: "video", mediaId: "a", start: 0, duration: 5 }] },
      { id: "music", kind: "audio", clips: [{ id: "m", kind: "audio", mediaId: "b", start: 0, duration: 5 }] },
    ],
  });
}

test("preflight: unused media is stripped, never uploaded, never blocks", () => {
  const doc = footageDoc();
  assert.deepEqual(usedMediaIds(doc).sort(), ["a", "b"]);
  const stripped = stripUnusedMedia(doc);
  assert.deepEqual(stripped.media.map((m) => m.id), ["a", "b"]);
  assert.equal(stripUnusedMedia(stripped), stripped, "no-op returns the same doc");
  const r = preflightExport(doc, { hasFile: (id) => id !== "unused", fileBytes: () => 1000 });
  assert.ok(r.ok);
  assert.equal(r.uploadBytes, 2000);
});

test("preflight: missing media blocks with the file names; empty doc blocks", () => {
  const r = preflightExport(footageDoc(), { hasFile: (id) => id === "b" });
  assert.equal(r.ok, false);
  assert.equal(r.missing.map((m) => m.id).join(), "a");
  assert.match(r.issues[0]!.message, /Beach\.mp4/);
  const empty = preflightExport(parseEditDoc({ version: 1, media: [], tracks: [] }), { hasFile: () => true });
  assert.equal(empty.ok, false);
  assert.equal(empty.issues[0]!.code, "empty");
});

test("preflight: >4K, very long and huge uploads warn but don't block", () => {
  const doc = footageDoc();
  const r = preflightExport(doc, { hasFile: () => true, fileBytes: () => 400 * 1024 * 1024, output: { width: 7680, height: 4320 } });
  assert.ok(r.ok);
  assert.deepEqual(r.issues.map((i) => i.code).sort(), ["huge-resolution", "large-upload"]);
  const long = parseEditDoc({ ...doc, tracks: [{ id: "video", kind: "visual", clips: [{ id: "v", kind: "video", mediaId: "a", start: 0, duration: 3600 }] }] });
  assert.ok(preflightExport(long, { hasFile: () => true }).issues.some((i) => i.code === "very-long"));
  assert.equal(preflightExport(doc, { hasFile: () => true, output: { width: 3840, height: 2160 } }).issues.length, 0, "exactly 4K is fine");
});

// ---- autosave drafts -------------------------------------------------------------

test("autosave: draft round-trips through structured clone and validates", () => {
  const doc = footageDoc();
  const rec = buildDraft({
    key: SCRATCH_DRAFT_KEY,
    doc,
    mediaList: doc.media,
    transcripts: { a: { mediaId: "a", language: "en", durationSec: 5, segments: [], words: [] } as never },
    now: 1_000,
  });
  const back = parseDraft(structuredClone(rec));
  assert.ok(back);
  assert.deepEqual(back.doc, doc);
  assert.equal(back.savedAt, 1_000);
  assert.deepEqual(Object.keys(back.transcripts), ["a"]);
  assert.ok(draftHasContent(back));
  assert.equal(draftMedia(back).length, 3);
});

test("autosave: corrupt / foreign / old drafts are rejected, bad parts dropped", () => {
  assert.equal(parseDraft(null), null);
  assert.equal(parseDraft({ v: 99, key: "scratch", doc: footageDoc() }), null, "unknown version");
  assert.equal(parseDraft({ v: 1, key: "scratch", doc: { tracks: "nope" } }), null, "schema-invalid doc");
  const partial = parseDraft({
    v: 1,
    key: "scratch",
    savedAt: "yesterday",
    doc: footageDoc(),
    mediaList: [{ id: "ok", kind: "video", src: "x.mp4" }, { id: "", kind: "bogus" }],
    transcripts: { a: { segments: [] }, b: "junk" },
  });
  assert.ok(partial);
  assert.deepEqual(partial.mediaList.map((m) => m.id), ["ok"]);
  assert.deepEqual(Object.keys(partial.transcripts), ["a"]);
  assert.equal(partial.savedAt, 0);
  const empty = parseDraft({ v: 1, key: "scratch", doc: { version: 1, media: [], tracks: [] }, mediaList: [] });
  assert.ok(empty);
  assert.equal(draftHasContent(empty), false, "an empty project is not worth a restore banner");
});

test("autosave: media persist/prune sets and banner copy", () => {
  assert.deepEqual(mediaToPersist(["a", "b", "c"], new Set(["a"]), new Set(["c"])), ["b"]);
  assert.deepEqual(mediaToPrune(["a", "b"], new Set(["b"])), ["a"]);
  const now = 10_000_000;
  assert.equal(describeDraftAge(now - 10_000, now), "just now");
  assert.equal(describeDraftAge(now - 5 * 60_000, now), "5 min ago");
  assert.equal(describeDraftAge(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(describeDraftAge(now - 30 * 3_600_000, now), "yesterday");
  assert.equal(draftSummary({ doc: footageDoc(), mediaList: [] }), "3 media files · 0:05");
});

// ---- project files -----------------------------------------------------------

test("project file: envelope round-trips; plain edit-doc JSON opens too", () => {
  const doc = footageDoc();
  const extra = { id: "later", kind: "audio" as const, src: "vo.webm", label: "vo.webm" };
  const file = buildProjectFile(doc, [extra], new Date("2026-09-01T00:00:00Z"));
  assert.equal(file.format, "cadence.project");
  assert.deepEqual(file.mediaList.map((m) => m.id), ["later", "a", "b", "unused"], "registry ∪ doc.media, de-duplicated");
  const back = parseProjectFile(JSON.stringify(file));
  assert.ok(back.ok);
  assert.deepEqual(back.doc, doc);
  assert.equal(back.mediaList.length, 4);
  const legacy = parseProjectFile(JSON.stringify(doc));
  assert.ok(legacy.ok, "an .editdoc.json from 'Duplicate as new' opens");
  assert.equal(legacy.mediaList.length, 3);
});

test("project file: bad inputs give friendly errors, never throw", () => {
  for (const [input, re] of [
    ["{nope", /valid JSON/],
    ["42", /isn't a Cadence project/],
    [JSON.stringify({ hello: 1 }), /isn't a Cadence project/],
    [JSON.stringify({ format: "cadence.project", version: 9, doc: {} }), /newer Cadence/],
    [JSON.stringify({ format: "cadence.project", version: 1, doc: { tracks: 5 } }), /damaged/],
  ] as const) {
    const r = parseProjectFile(input);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, re);
  }
  assert.equal(projectFileName("My trip / día 2"), "My-trip-día-2.cadence.json");
  assert.equal(projectFileName(""), "cadence.cadence.json");
});

test("project file: re-link matches by name + kind, each asset once", () => {
  const missing = footageDoc().media; // Beach.mp4 (video), Song.mp3 (audio), Leftover.mp4
  const m = matchFilesToMissing(
    [
      { name: "song.MP3", type: "audio/mpeg" },
      { name: "Beach.mp4", type: "video/mp4" },
      { name: "Beach.mp4", type: "video/mp4" }, // duplicate → only one link
      { name: "Leftover.mp4", type: "audio/mpeg" }, // wrong kind → no link
      { name: "new-clip.mp4", type: "video/mp4" },
    ],
    missing,
  );
  assert.deepEqual([...m.entries()], [[0, "b"], [1, "a"]]);
});
