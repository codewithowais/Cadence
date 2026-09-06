/**
 * @cadence/core — edit-doc schema. parseEditDoc defaulting, validation
 * rejection, and discriminated-union clip parsing. Pure; no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEditDoc, safeParseEditDoc, type EditDoc } from "@cadence/core";

test("parseEditDoc fills meta/media/tracks/quality defaults from a minimal doc", () => {
  const doc = parseEditDoc({ version: 1 });
  assert.equal(doc.meta.width, 1920);
  assert.equal(doc.meta.height, 1080);
  assert.equal(doc.meta.fps, 30);
  assert.equal(doc.meta.title, "Untitled");
  assert.equal(doc.meta.background, "#000000");
  assert.deepEqual(doc.media, []);
  assert.deepEqual(doc.tracks, []);
  assert.equal(doc.quality.preset, "standard");
  assert.equal(doc.quality.faithful, true);
  assert.equal(doc.quality.aiUpscale, false);
});

test("parseEditDoc fills per-clip defaults (transform/look/volume/transitions)", () => {
  const doc = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 5, mediaId: "m" }] }],
  });
  const clip = doc.tracks[0]!.clips[0]!;
  assert.equal(clip.kind, "video");
  if (clip.kind !== "video") throw new Error("unreachable");
  assert.equal(clip.transform.scale, 1);
  assert.equal(clip.transform.opacity, 1);
  assert.equal(clip.speed, 1);
  assert.equal(clip.volume, 1);
  assert.equal(clip.sourceIn, 0);
  assert.equal(clip.look.brightness, 1);
  assert.equal(clip.transitionType, "crossfade");
});

test("parseEditDoc rejects a bad version literal", () => {
  assert.throws(() => parseEditDoc({ version: 2, tracks: [] }));
});

test("parseEditDoc rejects a non-positive clip duration", () => {
  const bad = {
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: -1, mediaId: "m" }] }],
  };
  assert.throws(() => parseEditDoc(bad));
  // Zero is also non-positive.
  const zero = structuredClone(bad);
  zero.tracks[0]!.clips[0]!.duration = 0;
  assert.throws(() => parseEditDoc(zero));
});

test("parseEditDoc rejects an invalid hex color", () => {
  assert.throws(() =>
    parseEditDoc({ version: 1, meta: { background: "red" }, tracks: [] }),
  );
  assert.throws(() =>
    parseEditDoc({
      version: 1,
      tracks: [{ id: "t", kind: "visual", clips: [{ id: "x", kind: "text", start: 0, duration: 1, text: "hi", color: "#zzzzzz" }] }],
    }),
  );
});

test("parseEditDoc parses every clip kind in the discriminated union", () => {
  const doc: EditDoc = parseEditDoc({
    version: 1,
    media: [
      { id: "vid", kind: "video", src: "a.mp4" },
      { id: "img", kind: "image", src: "b.jpg" },
      { id: "aud", kind: "audio", src: "c.mp3" },
    ],
    tracks: [
      {
        id: "t",
        kind: "visual",
        clips: [
          { id: "c-video", kind: "video", start: 0, duration: 2, mediaId: "vid" },
          { id: "c-image", kind: "image", start: 2, duration: 2, mediaId: "img" },
          { id: "c-text", kind: "text", start: 0, duration: 1, text: "hello" },
          { id: "c-solid", kind: "solid", start: 0, duration: 1 },
        ],
      },
      { id: "a", kind: "audio", clips: [{ id: "c-audio", kind: "audio", start: 0, duration: 3, mediaId: "aud" }] },
    ],
  });
  const kinds = doc.tracks.flatMap((t) => t.clips.map((c) => c.kind));
  assert.deepEqual(kinds, ["video", "image", "text", "solid", "audio"]);
  // Kind-specific defaults resolved by the matching union member.
  const solid = doc.tracks[0]!.clips.find((c) => c.kind === "solid")!;
  assert.equal(solid.kind === "solid" && solid.color, "#000000");
  const text = doc.tracks[0]!.clips.find((c) => c.kind === "text")!;
  assert.equal(text.kind === "text" && text.fontSize, 64);
});

test("parseEditDoc rejects a union member missing its required field", () => {
  // kind:video without mediaId is invalid.
  assert.throws(() =>
    parseEditDoc({
      version: 1,
      tracks: [{ id: "t", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 1 }] }],
    }),
  );
});

test("safeParseEditDoc returns a success flag instead of throwing", () => {
  assert.equal(safeParseEditDoc({ version: 1 }).success, true);
  assert.equal(safeParseEditDoc({ version: 9 }).success, false);
});
