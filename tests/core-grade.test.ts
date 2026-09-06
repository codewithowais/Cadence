/**
 * @cadence/core — pure look/motion helpers (grade.ts). Transition opacity ramps,
 * Ken Burns motion endpoints, and the CSS filter string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transitionOpacity,
  transitionStyle,
  imageMotion,
  cssFilter,
  parseEditDoc,
  type ImageClip,
  type SolidClip,
  type TransitionType,
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

// ---- transitionStyle (browser-preview CSS resolver) ------------------------

const FW = 1920;
const FH = 1080;

/** An image clip on a 4s slot with a 1s INCOMING ramp of the given type. */
function imageWithTransition(type: TransitionType): ImageClip {
  return parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "image", src: "a.jpg" }],
    tracks: [
      {
        id: "t",
        kind: "visual",
        clips: [
          { id: "i", kind: "image", start: 0, duration: 4, mediaId: "m", transitionInSec: 1, transitionType: type },
        ],
      },
    ],
  }).tracks[0]!.clips[0]! as ImageClip;
}

test("transitionStyle: fade types ramp OPACITY (crossfade / dip-to-black / dissolve)", () => {
  for (const type of ["crossfade", "dip-to-black", "dissolve"] as const) {
    const clip = imageWithTransition(type);
    const s0 = transitionStyle(clip, 0, FW, FH);
    const sMid = transitionStyle(clip, 0.5, FW, FH);
    const s1 = transitionStyle(clip, 1, FW, FH);
    assert.equal(s0.type, type);
    assert.equal(s0.opacity, 0, `${type}: opacity 0 at ramp start`);
    assert.ok(near(sMid.opacity, 0.5), `${type}: opacity ~0.5 mid-ramp`);
    assert.equal(s1.opacity, 1, `${type}: opacity 1 at ramp end`);
    // Fade types never slide, scale, or wipe.
    assert.equal(sMid.translateXPct, 0);
    assert.equal(sMid.scaleMul, 1);
    assert.equal(sMid.clipPath, "none");
  }
});

test("transitionStyle: slide/smooth TRANSLATE in from the right (no opacity fade)", () => {
  for (const type of ["slide", "smooth"] as const) {
    const clip = imageWithTransition(type);
    const s0 = transitionStyle(clip, 0, FW, FH);
    const sMid = transitionStyle(clip, 0.5, FW, FH);
    const s1 = transitionStyle(clip, 1, FW, FH);
    assert.equal(s0.opacity, 1, `${type}: stays opaque (slides, not fades)`);
    assert.equal(s0.translateXPct, 100, `${type}: fully off to the right at ramp start`);
    assert.ok(sMid.translateXPct > 0 && sMid.translateXPct < 100, `${type}: partway in mid-ramp (${sMid.translateXPct})`);
    assert.equal(s1.translateXPct, 0, `${type}: settled in place at ramp end`);
    assert.equal(sMid.clipPath, "none");
    assert.equal(sMid.scaleMul, 1);
  }
});

test("transitionStyle: wipe reveals left→right via clip-path inset (no opacity fade)", () => {
  const clip = imageWithTransition("wipe");
  const s0 = transitionStyle(clip, 0, FW, FH);
  const sMid = transitionStyle(clip, 0.5, FW, FH);
  const s1 = transitionStyle(clip, 1, FW, FH);
  assert.equal(s0.opacity, 1, "wipe stays opaque");
  assert.equal(s0.clipPath, "inset(0 100% 0 0)", "fully hidden at ramp start");
  assert.equal(sMid.clipPath, "inset(0 50% 0 0)", "half revealed mid-ramp");
  assert.equal(s1.clipPath, "none", "fully revealed at ramp end");
  assert.equal(sMid.translateXPct, 0);
});

test("transitionStyle: zoom scales in while it fades", () => {
  const clip = imageWithTransition("zoom");
  const s0 = transitionStyle(clip, 0, FW, FH);
  const s1 = transitionStyle(clip, 1, FW, FH);
  assert.ok(s0.scaleMul > 1, `zoom starts scaled up (${s0.scaleMul})`);
  assert.equal(s0.opacity, 0, "zoom fades opacity in too");
  assert.equal(s1.scaleMul, 1, "zoom settles to 1× at ramp end");
  assert.equal(s1.opacity, 1);
});

test("transitionStyle: `active` is true only inside the transition window", () => {
  const clip = imageWithTransition("wipe");
  assert.equal(transitionStyle(clip, 0.5, FW, FH).active, true, "inside the 1s in-ramp");
  assert.equal(transitionStyle(clip, 2, FW, FH).active, false, "steady in the middle of the clip");
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
