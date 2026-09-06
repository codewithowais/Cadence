/**
 * @cadence/core — pure look/motion helpers (grade.ts). Transition opacity ramps,
 * Ken Burns motion endpoints, and the CSS filter string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transitionOpacity,
  imageMotion,
  cssFilter,
  parseEditDoc,
  type ImageClip,
  type SolidClip,
} from "@cadence/core";

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

function solidWithRamps(): SolidClip {
  return parseEditDoc({
    version: 1,
    tracks: [
      {
        id: "t",
        kind: "visual",
        clips: [{ id: "s", kind: "solid", start: 0, duration: 10, transitionInSec: 1, transitionOutSec: 1 }],
      },
    ],
  }).tracks[0]!.clips[0]! as SolidClip;
}

test("transitionOpacity ramps in from 0→1 over transitionInSec", () => {
  const clip = solidWithRamps();
  assert.equal(transitionOpacity(clip, 0), 0, "opacity 0 at the very start");
  assert.ok(near(transitionOpacity(clip, 0.5), 0.5), "half-way through the in-ramp");
  assert.equal(transitionOpacity(clip, 1), 1, "fully in after transitionInSec");
  assert.equal(transitionOpacity(clip, 5), 1, "steady in the middle");
});

test("transitionOpacity ramps out to 0 over transitionOutSec", () => {
  const clip = solidWithRamps(); // ends at t=10
  assert.ok(near(transitionOpacity(clip, 9.5), 0.5), "half-way through the out-ramp");
  assert.equal(transitionOpacity(clip, 10), 0, "opacity 0 at the very end");
});

test("transitionOpacity is the base opacity when there are no ramps", () => {
  const clip = parseEditDoc({
    version: 1,
    tracks: [{ id: "t", kind: "visual", clips: [{ id: "s", kind: "solid", start: 0, duration: 5, transform: { opacity: 0.5 } }] }],
  }).tracks[0]!.clips[0]! as SolidClip;
  assert.equal(transitionOpacity(clip, 2.5), 0.5);
});

function imageWithMotion(): ImageClip {
  return parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "image", src: "a.jpg" }],
    tracks: [
      {
        id: "t",
        kind: "visual",
        clips: [{ id: "i", kind: "image", start: 0, duration: 4, mediaId: "m", motion: { zoom: 2, panX: 0.2, panY: -0.1 } }],
      },
    ],
  }).tracks[0]!.clips[0]! as ImageClip;
}

test("imageMotion is identity at the clip start (progress 0)", () => {
  const m = imageMotion(imageWithMotion(), 0);
  assert.equal(m.scale, 1);
  assert.ok(near(m.panXFrac, 0));
  assert.ok(near(m.panYFrac, 0));
});

test("imageMotion reaches the full Ken Burns move at the clip end (progress 1)", () => {
  const clip = imageWithMotion();
  const m = imageMotion(clip, 4);
  assert.equal(m.scale, 2, "end scale equals motion.zoom");
  assert.ok(near(m.panXFrac, 0.2));
  assert.ok(near(m.panYFrac, -0.1));
  // Half-way the zoom is exactly interpolated.
  assert.ok(near(imageMotion(clip, 2).scale, 1.5));
});

test("cssFilter is 'none' for a neutral grade", () => {
  const neutral = { brightness: 1, contrast: 1, saturation: 1, warmth: 0 };
  assert.equal(cssFilter(neutral), "none");
});

test("cssFilter emits only the non-neutral parts of a grade", () => {
  const f = cssFilter({ brightness: 1.1, contrast: 1, saturation: 1.3, warmth: 0.5 });
  assert.ok(f.includes("brightness(1.1)"), f);
  assert.ok(f.includes("saturate(1.3)"), f);
  assert.ok(f.includes("sepia("), "warmth maps to a sepia term");
  assert.ok(!f.includes("contrast("), "neutral contrast is omitted");
});
