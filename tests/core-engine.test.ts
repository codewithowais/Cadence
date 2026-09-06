/**
 * @cadence/core — timeline math (engine.ts). Boundary behavior of active-clip
 * selection, doc duration, and the source-time mapping. Pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeClipsAt,
  isClipActiveAt,
  docDurationSec,
  sourceTimeAt,
  sourceSpanSec,
  parseEditDoc,
  type VideoClip,
} from "@cadence/core";

function docWithClips() {
  return parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [
      {
        id: "v",
        kind: "visual",
        clips: [
          // clip A occupies [2, 5)
          { id: "a", kind: "video", start: 2, duration: 3, mediaId: "m" },
          // clip B occupies [5, 9)
          { id: "b", kind: "video", start: 5, duration: 4, mediaId: "m" },
        ],
      },
    ],
  });
}

test("isClipActiveAt is start-inclusive and end-exclusive", () => {
  const clip = docWithClips().tracks[0]!.clips[0]!; // [2,5)
  assert.equal(isClipActiveAt(clip, 1.999), false);
  assert.equal(isClipActiveAt(clip, 2), true, "start is inclusive");
  assert.equal(isClipActiveAt(clip, 4.999), true);
  assert.equal(isClipActiveAt(clip, 5), false, "end is exclusive");
});

test("activeClipsAt selects only clips whose range contains t", () => {
  const doc = docWithClips();
  assert.deepEqual(activeClipsAt(doc, 3).map((c) => c.clip.id), ["a"]);
  // At the A→B boundary t=5, A has ended (exclusive) and B has begun (inclusive).
  assert.deepEqual(activeClipsAt(doc, 5).map((c) => c.clip.id), ["b"]);
  assert.deepEqual(activeClipsAt(doc, 100).map((c) => c.clip.id), []);
});

test("activeClipsAt returns clips in paint order (track then clip order)", () => {
  const doc = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [
      { id: "bottom", kind: "visual", clips: [{ id: "lo", kind: "video", start: 0, duration: 10, mediaId: "m" }] },
      { id: "top", kind: "visual", clips: [{ id: "hi", kind: "text", start: 0, duration: 10, text: "x" }] },
    ],
  });
  assert.deepEqual(activeClipsAt(doc, 1).map((c) => c.clip.id), ["lo", "hi"]);
});

test("docDurationSec is the max clip end across all tracks", () => {
  assert.equal(docDurationSec(docWithClips()), 9); // clip B ends at 9
  assert.equal(docDurationSec(parseEditDoc({ version: 1, tracks: [] })), 0);
});

test("sourceTimeAt maps timeline progress onto source, scaled by speed", () => {
  const clip = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", kind: "video", start: 10, duration: 4, mediaId: "m", sourceIn: 100, speed: 0.5 }] }],
  }).tracks[0]!.clips[0]! as VideoClip;

  // At the clip start, source is exactly sourceIn.
  assert.equal(sourceTimeAt(clip, 10), 100);
  // Midway (local=2s) at 0.5x consumes 1s of source.
  assert.equal(sourceTimeAt(clip, 12), 101);
  // Clamped to the clip range below start...
  assert.equal(sourceTimeAt(clip, 0), 100);
  // ...and above end (local clamped to duration=4 → 100 + 4*0.5).
  assert.equal(sourceTimeAt(clip, 999), 102);
});

test("sourceSpanSec is duration times speed", () => {
  const clip = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 4, mediaId: "m", speed: 2 }] }],
  }).tracks[0]!.clips[0]! as VideoClip;
  assert.equal(sourceSpanSec(clip), 8);
});
