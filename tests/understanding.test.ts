/**
 * @cadence/understanding — Whisper JSON parsing (OpenAI + whisper.cpp shapes)
 * and StubTranscriber determinism. Pure / offline; no model download.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhisperJson, StubTranscriber } from "@cadence/understanding";
import type { MediaAsset } from "@cadence/core";

test("parseWhisperJson maps the OpenAI/faster-whisper shape (seconds + word probs)", () => {
  const openai = {
    text: "Hello world. This is a test.",
    language: "en",
    duration: 3.2,
    segments: [
      { id: 0, start: 0.0, end: 1.4, text: " Hello world.", avg_logprob: -0.22, words: [
        { word: " Hello", start: 0.0, end: 0.6, probability: 0.98 },
        { word: " world.", start: 0.6, end: 1.4, probability: 0.95 },
      ] },
      { id: 1, start: 1.6, end: 3.2, text: " This is a test.", avg_logprob: -0.31, words: [
        { word: " This", start: 1.6, end: 1.9, probability: 0.9 },
        { word: " test.", start: 2.3, end: 3.2, probability: 0.96 },
      ] },
    ],
  };
  const t = parseWhisperJson(openai, "media-xyz");
  assert.equal(t.mediaId, "media-xyz");
  assert.equal(t.language, "en");
  assert.equal(t.segments.length, 2);
  assert.equal(t.words.length, 4);
  assert.ok(Math.abs(t.durationSec - 3.2) < 1e-6);
  // Words are trimmed (no leading space) and each end >= start.
  for (const w of t.words) {
    assert.equal(w.text, w.text.trim());
    assert.ok(w.text.length > 0);
    assert.ok(w.end >= w.start);
  }
  // Segment id derives from the numeric id; score is a 0..1 confidence.
  assert.equal(t.segments[0]!.id, "seg0");
  assert.ok((t.segments[0]!.score ?? -1) >= 0 && (t.segments[0]!.score ?? 2) <= 1);
});

test("parseWhisperJson maps the whisper.cpp shape (ms offsets → seconds) and filters special tokens", () => {
  const cpp = {
    result: { language: "en" },
    transcription: [
      { offsets: { from: 0, to: 900 }, text: " Cadence", tokens: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
        { text: " Cadence", offsets: { from: 0, to: 900 } },
      ] },
      { offsets: { from: 900, to: 2000 }, text: " ships", tokens: [
        { text: " ships", offsets: { from: 900, to: 2000 } },
      ] },
    ],
  };
  const t = parseWhisperJson(cpp, "m2");
  assert.equal(t.language, "en");
  assert.equal(t.segments.length, 2);
  assert.ok(Math.abs(t.segments[0]!.end - 0.9) < 1e-6, "ms→s conversion (900ms → 0.9s)");
  assert.ok(Math.abs(t.durationSec - 2.0) < 1e-6);
  // [_BEG_] is dropped; only real words survive.
  assert.equal(t.words.length, 2);
  assert.ok(t.words.every((w) => !w.text.startsWith("[")));
});

test("parseWhisperJson defaults language to 'en' and duration to 0 when absent", () => {
  const t = parseWhisperJson({ segments: [] }, "empty");
  assert.equal(t.language, "en");
  assert.equal(t.durationSec, 0);
  assert.deepEqual(t.segments, []);
  assert.deepEqual(t.words, []);
});

const media = (id: string): MediaAsset => ({ id, kind: "video", src: `${id}.mp4`, durationSec: 60 });

test("StubTranscriber is deterministic — same media yields an identical transcript", async () => {
  const a = await new StubTranscriber().transcribe(media("clip-1"));
  const b = await new StubTranscriber().transcribe(media("clip-1"));
  assert.deepEqual(a, b);
  assert.ok(a.segments.length > 0 && a.words.length > 0);
});

test("StubTranscriber differs across distinct media ids", async () => {
  const a = await new StubTranscriber().transcribe(media("clip-1"));
  const b = await new StubTranscriber().transcribe(media("clip-2"));
  assert.notDeepEqual(a.segments, b.segments);
  assert.equal(a.mediaId, "clip-1");
  assert.equal(b.mediaId, "clip-2");
});

test("StubTranscriber produces monotonic, well-formed word timings", async () => {
  const t = await new StubTranscriber().transcribe(media("clip-1"));
  let prevEnd = 0;
  for (const w of t.words) {
    assert.ok(w.end >= w.start);
    assert.ok(w.start >= prevEnd - 1e-6, "words are ordered");
    prevEnd = w.end;
  }
});
