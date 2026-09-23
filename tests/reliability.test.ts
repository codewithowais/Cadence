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
