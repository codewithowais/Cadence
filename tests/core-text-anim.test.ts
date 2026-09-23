/**
 * @cadence/core — the text-animation resolver (text-anim.ts): staggered timing,
 * legacy-style equivalence with textKinetic, exits, loops, determinism, and the
 * animated/static window split the exporter relies on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipAnimatedWindows,
  clipStaticSpans,
  exitProgress,
  hash01,
  introProgress,
  parseEditDoc,
  scrambleText,
  staggerTiming,
  textKinetic,
  textUnitState,
  TEXT_ANIM_STYLES,
  type SolidClip,
  type TextClip,
} from "@cadence/core";

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

function text(over: Record<string, unknown> = {}): TextClip {
  return parseEditDoc({
    version: 1,
    tracks: [{ id: "t", kind: "visual", clips: [{ id: "x", kind: "text", start: 2, duration: 4, text: "Hello there", ...over }] }],
  }).tracks[0]!.clips[0]! as TextClip;
}

test("old docs parse with inert animation defaults", () => {
  const c = text();
  assert.equal(c.anim.style, "none");
  assert.equal(c.anim.unit, "whole");
  assert.equal(c.anim.delaySec, 0);
  assert.equal(c.anim.exit.style, "none");
  assert.equal(c.anim.loop.style, "none");
  assert.equal(c.effect, undefined);
  assert.deepEqual(textUnitState(c, 3), textUnitState(c, 5));
});

test("staggerTiming: the last unit always finishes exactly at the total", () => {
  for (const n of [1, 2, 3, 5, 40]) {
    const { unitDur, stagger } = staggerTiming(1.2, n);
    assert.ok(near(stagger * (n - 1) + unitDur, 1.2), `n=${n}`);
  }
});

test("introProgress honors delay and stagger", () => {
  const c = text({ anim: { style: "fade", durationSec: 1, delaySec: 0.5, unit: "word" } });
  assert.equal(introProgress(c, 2.4, 0, 2), 0); // before delay
  assert.equal(introProgress(c, 3.5, 1, 2), 1); // settled exactly at start+delay+duration
  assert.ok(introProgress(c, 2.7, 0, 2) > introProgress(c, 2.7, 1, 2)); // first word leads
});

test("legacy kinetic/pop/bounce: whole-block state equals textKinetic", () => {
  for (const style of ["kinetic", "pop", "bounce"] as const) {
    const c = text({ anim: { style, fromX: -80, fromY: 60, fromScale: 0.7, durationSec: 0.6 } });
    for (const t of [2, 2.1, 2.3, 2.59, 3]) {
      const k = textKinetic(c, t);
      const s = textUnitState(c, t);
      assert.ok(near(s.dx, k.dx) && near(s.dy, k.dy) && near(s.scaleX, k.scaleMul), `${style}@${t}`);
      assert.equal(s.opacity, 1);
    }
  }
});

test("every intro style settles to rest after its duration", () => {
  for (const style of TEXT_ANIM_STYLES) {
    const c = text({ anim: { style, durationSec: 0.8, unit: "letter" } });
    const s = textUnitState(c, 2.9, 3, 10);
    assert.equal(s.visible, true, style);
    assert.ok(near(s.dx, 0) && near(s.dy, 0) && near(s.rotation, 0), `${style} at rest position`);
    assert.ok(near(s.scaleX, 1) && near(s.scaleY, 1), `${style} at rest scale`);
    assert.ok(near(s.opacity, 1) && s.blur === 0 && s.revealTo === 1 && s.scramble === 0, `${style} fully shown`);
  }
});

test("fade-family styles start hidden", () => {
  for (const style of ["fade", "rise", "drop", "slide-left", "blur-in", "tumble", "spin", "scramble"] as const) {
    const c = text({ anim: { style, durationSec: 1 } });
    assert.equal(textUnitState(c, 2).opacity, 0, style);
  }
});

test("exit: nothing before the window, gone at the clip end", () => {
  const c = text({ anim: { exit: { style: "fade", durationSec: 1 } } });
  assert.equal(exitProgress(c, 4.9, 0, 1), 0);
  assert.equal(textUnitState(c, 4.9).opacity, 1);
  assert.ok(textUnitState(c, 5.9).opacity < 0.15);
  const sink = text({ anim: { exit: { style: "sink", durationSec: 1 } } });
  assert.ok(textUnitState(sink, 5.8).dy > 0);
});

test("loops move continuously and ripple across units", () => {
  const c = text({ anim: { loop: { style: "wave", speed: 1, amount: 1 }, unit: "letter" } });
  assert.notEqual(textUnitState(c, 2.25, 0, 5).dy, textUnitState(c, 2.25, 1, 5).dy);
  const b = text({ anim: { loop: { style: "breathe", speed: 1, amount: 1 } } });
  assert.notEqual(textUnitState(b, 2.25).scaleX, textUnitState(b, 2.75).scaleX);
});

test("deterministic pseudo-randomness", () => {
  assert.equal(hash01(42), hash01(42));
  assert.ok(hash01(1) >= 0 && hash01(1) < 1);
  const g = text({ anim: { style: "glitch", durationSec: 1 } });
  assert.deepEqual(textUnitState(g, 2.3), textUnitState(g, 2.3));
  assert.equal(scrambleText("Hello there", 0, 1), "Hello there");
  assert.equal(scrambleText("Hello there", 0.7, 1.23), scrambleText("Hello there", 0.7, 1.23));
  assert.notEqual(scrambleText("Hello there", 1, 1.23), "Hello there");
  assert.equal(scrambleText("a b", 1, 0)[1], " "); // spaces never scramble
});

test("animated windows: static text has none; intro/exit/transition windows are split out", () => {
  assert.deepEqual(clipAnimatedWindows(text()), []);
  assert.deepEqual(clipStaticSpans(text()), [[2, 6]]);
  const c = text({ transitionInSec: 0.3, anim: { style: "rise", durationSec: 0.8, delaySec: 0.2, exit: { style: "fade", durationSec: 0.5 } } });
  const w = clipAnimatedWindows(c);
  assert.equal(w.length, 2);
  assert.ok(near(w[0]![0], 2) && near(w[0]![1], 3)); // transition 2–2.3 merged with intro 2.2–3
  assert.ok(near(w[1]![0], 5.5) && near(w[1]![1], 6));
  const st = clipStaticSpans(c);
  assert.equal(st.length, 1);
  assert.ok(near(st[0]![0], 3) && near(st[0]![1], 5.5));
  // loops/karaoke/keyframes animate the whole span
  assert.deepEqual(clipAnimatedWindows(text({ anim: { loop: { style: "float" } } })), [[2, 6]]);
});

test("animated gradient backgrounds animate their whole span", () => {
  const s = parseEditDoc({
    version: 1,
    tracks: [{ id: "b", kind: "visual", clips: [{ id: "s", kind: "solid", start: 0, duration: 3, gradient: { stops: ["#000000", "#ffffff"], motion: "aurora" } }] }],
  }).tracks[0]!.clips[0]! as SolidClip;
  assert.deepEqual(clipAnimatedWindows(s), [[0, 3]]);
});
