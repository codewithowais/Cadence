/**
 * POSITION (Cycle J): pure transform math, edit-doc ops (keyframe-aware), the
 * Director tools and the StubDirector phrases ("move the title to the top left"…).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignDelta,
  boxAabb,
  boxToPatch,
  distributeDeltas,
  handlePoint,
  hitTestLayers,
  layerBoxesAt,
  parseEditDoc,
  pointInBox,
  resizeBox,
  rotatePoint,
  rotationFromPointer,
  snapMove,
  snapPoint,
  fitScaleFor,
  type Box,
  type EditDoc,
} from "@cadence/core";
import {
  ProjectState,
  StubDirector,
  alignClips,
  arrangeClip,
  distributeClips,
  fitClip,
  moveClipsBy,
  resetTransform,
  setTransform,
  parseTransformRequest,
  applyTransformInput,
} from "@cadence/director";

const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

function doc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080 },
    media: [],
    tracks: [
      {
        id: "titles",
        kind: "visual",
        clips: [{ id: "t1", kind: "text", start: 0, duration: 5, text: "Hello", fontSize: 100, transform: { x: 960, y: 540 } }],
      },
      {
        id: "gfx",
        kind: "visual",
        clips: [
          { id: "s1", kind: "shape", shape: "rect", start: 0, duration: 5, w: 400, h: 200, transform: { x: 300, y: 300 } },
          { id: "s2", kind: "shape", shape: "rect", start: 0, duration: 5, w: 200, h: 200, transform: { x: 1000, y: 800 } },
          { id: "s3", kind: "shape", shape: "rect", start: 0, duration: 5, w: 100, h: 100, transform: { x: 1700, y: 200 } },
        ],
      },
    ],
  });
}

// ---- pure math ----
test("rotatePoint / box corners / AABB / hit-test honour rotation", () => {
  const p = rotatePoint(10, 0, 0, 0, 90);
  near(p.x, 0);
  near(p.y, 10);
  const b: Box = { cx: 100, cy: 100, w: 200, h: 100, rot: 90 };
  const r = boxAabb(b);
  near(r.left, 50);
  near(r.right, 150);
  near(r.top, 0);
  near(r.bottom, 200);
  assert.ok(pointInBox(b, 100, 20)); // inside the rotated (tall) box
  assert.ok(!pointInBox(b, 190, 100)); // outside it
});

test("resizeBox: SE corner pins the opposite corner; shift keeps aspect; alt grows from centre", () => {
  const b: Box = { cx: 200, cy: 200, w: 100, h: 50, rot: 0 };
  const a = resizeBox(b, "se", 300, 275);
  near(a.w, 150);
  near(a.h, 100);
  near(a.cx - a.w / 2, 150);
  near(a.cy - a.h / 2, 175); // NW corner pinned
  const k = resizeBox(b, "se", 300, 210, { keepAspect: true });
  near(k.w / k.h, 2);
  const c = resizeBox(b, "e", 300, 200, { fromCenter: true });
  near(c.cx, 200);
  near(c.w, 200);
});

test("resizeBox on a rotated box keeps the pinned corner fixed in world space", () => {
  const b: Box = { cx: 300, cy: 300, w: 200, h: 100, rot: 30 };
  const pinned = handlePoint(b, "nw");
  const dragTo = rotatePoint(pinned.x + 320, pinned.y + 160, pinned.x, pinned.y, 30); // 320×160 away along the box axes
  const r = resizeBox(b, "se", dragTo.x, dragTo.y);
  const after = handlePoint(r, "nw");
  near(after.x, pinned.x, 1e-6);
  near(after.y, pinned.y, 1e-6);
  near(r.w, 320, 1e-6);
  near(r.h, 160, 1e-6);
});

test("rotationFromPointer: straight up = 0, right = 90, shift snaps to 15°", () => {
  const b: Box = { cx: 0, cy: 0, w: 10, h: 10, rot: 0 };
  near(rotationFromPointer(b, 0, -50), 0);
  near(rotationFromPointer(b, 50, 0), 90);
  near(rotationFromPointer(b, 50, -40, 15) % 15, 0);
});

test("snapMove snaps to canvas centre, safe margins and other layers, with guides", () => {
  const W = 1920;
  const H = 1080;
  const moving: Box = { cx: 965, cy: 300, w: 200, h: 100, rot: 0 };
  const s = snapMove(moving, [], W, H, 8);
  near(s.dx, -5);
  assert.ok(s.guides.some((g) => g.axis === "x" && g.pos === 960 && g.kind === "canvas"));
  const other: Box = { cx: 500, cy: 700, w: 100, h: 100, rot: 0 };
  const s2 = snapMove({ cx: 503, cy: 400, w: 60, h: 60, rot: 0 }, [other], W, H, 8);
  near(s2.dx, -3);
  assert.ok(s2.guides.some((g) => g.kind === "layer"));
  const none = snapMove({ cx: 700, cy: 450, w: 60, h: 60, rot: 0 }, [], W, H, 8);
  assert.equal(none.dx, 0);
  assert.equal(none.dy, 0);
  const sp = snapPoint(97, 500, [], W, H, 8); // 5% safe margin = 96
  near(sp.x, 96);
});

test("align / distribute / fit math", () => {
  const r = { left: 100, top: 100, right: 200, bottom: 160 };
  const ref = { left: 0, top: 0, right: 1000, bottom: 500 };
  assert.deepEqual(alignDelta(r, ref, "left"), { dx: -100, dy: 0 });
  assert.deepEqual(alignDelta(r, ref, "hcenter"), { dx: 350, dy: 0 });
  assert.deepEqual(alignDelta(r, ref, "bottom"), { dx: 0, dy: 340 });
  const d = distributeDeltas(
    [
      { left: 0, top: 0, right: 100, bottom: 10 },
      { left: 120, top: 0, right: 220, bottom: 10 },
      { left: 700, top: 0, right: 800, bottom: 10 },
    ],
    "h",
  );
  near(d[1]!.dx, 230); // gaps: (800-300)/2 = 250 → mid starts at 350 (was 120)
  near(fitScaleFor(100, 50, 400, 400, "fit"), 4);
  near(fitScaleFor(100, 50, 400, 400, "fill"), 8);
});

// ---- boxes from clips ----
test("layerBoxesAt resolves text (align-aware) + shapes and hit-tests top-most", () => {
  const d = doc();
  const layers = layerBoxesAt(d, 1);
  assert.equal(layers.length, 4);
  const text = layers.find((l) => l.clipId === "t1")!;
  near(text.box.cx, 960); // centre-aligned text is centred on its anchor
  assert.equal(text.resize, "uniform");
  const hit = hitTestLayers(layers, 300, 300)!;
  assert.equal(hit.clipId, "s1");
  assert.equal(hitTestLayers(layers, 5, 5), null);
});

test("left-aligned text: the box centre is offset from the anchor and round-trips through boxToPatch", () => {
  const d = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080 },
    media: [],
    tracks: [
      {
        id: "titles",
        kind: "visual",
        clips: [{ id: "t", kind: "text", start: 0, duration: 4, text: "abcd", align: "left", fontSize: 100, transform: { x: 200, y: 200, rotation: 90 } }],
      },
    ],
  });
  const lb = layerBoxesAt(d, 1)[0]!;
  assert.ok(Math.abs(lb.box.cx - 200) > 1 || Math.abs(lb.box.cy - 200) > 1);
  const p = boxToPatch(lb, lb.box);
  near(p.x!, 200, 0.02);
  near(p.y!, 200, 0.02);
});

// ---- ops ----
test("setTransform writes static values, and keyframes when the prop is keyframed", () => {
  const d = doc();
  const a = setTransform(d, "s1", { x: 500, rotation: 20, opacity: 0.5 }, { atSec: 1 });
  const s1 = a.tracks[1]!.clips[0]!;
  assert.ok(s1.kind === "shape" && s1.transform.x === 500 && s1.transform.rotation === 20 && s1.transform.opacity === 0.5);
  const kfd = structuredClone(a);
  const c = kfd.tracks[1]!.clips[0]!;
  c.keyframes = [
    { prop: "x", t: 0, value: 100, easing: "linear" },
    { prop: "x", t: 1, value: 900, easing: "linear" },
  ];
  const b = setTransform(parseEditDoc(kfd), "s1", { x: 640, y: 111 }, { atSec: 2 });
  const s1b = b.tracks[1]!.clips[0]!;
  assert.ok(s1b.kind === "shape");
  assert.equal(s1b.keyframes!.filter((k) => k.prop === "x").length, 3);
  assert.ok(s1b.keyframes!.some((k) => k.prop === "x" && Math.abs(k.t - 0.4) < 1e-6 && k.value === 640));
  assert.equal(s1b.transform.y, 111); // y has no keyframes → static
  assert.equal(s1b.transform.x, 500); // static x kept
});

test("flip, shape size + purity (input never mutated)", () => {
  const d = doc();
  const before = JSON.stringify(d);
  const a = setTransform(d, "s2", { flipX: true, w: 640 });
  assert.equal(JSON.stringify(d), before);
  const s2 = a.tracks[1]!.clips[1]!;
  assert.ok(s2.kind === "shape" && s2.transform.flipX === true && s2.w === 640);
  const off = setTransform(a, "s2", { flipX: false });
  const s2b = off.tracks[1]!.clips[1]!;
  assert.ok(s2b.kind === "shape" && s2b.transform.flipX === undefined);
});

test("alignClips: canvas centre, 9-point with margin, selection-relative; distribute; fit; reset; move", () => {
  const d = doc();
  const c = alignClips(d, ["s1"], "center");
  const s1 = c.tracks[1]!.clips[0]!;
  assert.ok(s1.kind === "shape" && s1.transform.x === 960 && s1.transform.y === 540);
  const tl = alignClips(d, ["s1"], "top-left", { margin: 50 });
  const t1 = tl.tracks[1]!.clips[0]!;
  assert.ok(t1.kind === "shape" && t1.transform.x === 250 && t1.transform.y === 150); // 50 + 400/2, 50 + 200/2
  const sel = alignClips(d, ["s1", "s2", "s3"], "bottom", { relativeTo: "selection" });
  assert.ok(sel.tracks[1]!.clips.every((x) => x.kind === "shape" && Math.abs(x.transform.y + x.h / 2 - 900) < 1e-6)); // s2 bottom = 900
  const dist = distributeClips(d, ["s1", "s2", "s3"], "h");
  const xs = dist.tracks[1]!.clips.map((x) => (x.kind === "shape" ? x.transform.x : 0));
  near(xs[0]!, 300);
  near(xs[2]!, 1700);
  const gap1 = xs[1]! - 100 - (xs[0]! + 200);
  const gap2 = xs[2]! - 50 - (xs[1]! + 100);
  near(gap1, gap2, 0.05);
  const fill = fitClip(d, "s1", "fill");
  const f = fill.tracks[1]!.clips[0]!;
  assert.ok(f.kind === "shape" && f.w === 1920 && f.h === 1080 && f.transform.x === 960);
  const rst = resetTransform(setTransform(d, "s1", { rotation: 30, scale: 2, opacity: 0.2, flipY: true }), "s1");
  const r = rst.tracks[1]!.clips[0]!;
  assert.ok(r.kind === "shape" && r.transform.rotation === 0 && r.transform.scale === 1 && r.transform.opacity === 1 && !r.transform.flipY);
  const mv = moveClipsBy(d, ["s1"], 25, -10, { atSec: 1 });
  const m = mv.tracks[1]!.clips[0]!;
  assert.ok(m.kind === "shape" && m.transform.x === 325 && m.transform.y === 290);
});

test("arrangeClip restacks: whole track when alone, a new Layer lane when it overlaps siblings", () => {
  const d = doc();
  const front = arrangeClip(d, "t1", "front");
  assert.equal(front.tracks[front.tracks.length - 1]!.id, "titles");
  assert.equal(arrangeClip(d, "t1", "back"), d); // already at the back → a no-op
  const lifted = arrangeClip(d, "s1", "front");
  const last = lifted.tracks[lifted.tracks.length - 1]!;
  assert.ok(last.id.startsWith("layer-") && last.clips[0]!.id === "s1");
  assert.equal(lifted.tracks.find((t) => t.id === "gfx")!.clips.length, 2);
});

// ---- Director ----
test("applyTransformInput: scaleBy / rotateBy / nouns", () => {
  const d = doc();
  const { doc: a } = applyTransformInput(d, { clip: "shape", scaleBy: 0.5, all: true });
  const s = a.tracks[1]!.clips[0]!;
  assert.ok(s.kind === "shape" && s.w === 200 && s.h === 100);
  const { doc: b } = applyTransformInput(d, { clip: "title", rotateBy: 15 });
  const t = b.tracks[0]!.clips[0]!;
  assert.ok(t.kind === "text" && t.transform.rotation === 15);
  near(t.transform.x, 960, 0.05); // centred text rotates about its centre
  assert.throws(() => applyTransformInput(parseEditDoc({ version: 1, meta: {}, media: [], tracks: [] }), { clip: "it", scaleBy: 2 }));
});

test("parseTransformRequest understands the headline phrases", () => {
  const p = (s: string) => parseTransformRequest(s).steps.map((x) => ({ n: x.tool.name, i: x.input }));
  assert.deepEqual(p("move the title to the top left"), [{ n: "align_clip", i: { clip: "title", to: "top-left" } }]);
  assert.deepEqual(p("make the logo smaller"), [{ n: "set_transform", i: { clip: "logo", scaleBy: 0.8 } }]);
  assert.deepEqual(p("center it"), [{ n: "align_clip", i: { clip: "it", to: "center" } }]);
  assert.deepEqual(p("rotate 15 degrees"), [{ n: "set_transform", i: { clip: "it", rotateBy: 15 } }]);
  assert.deepEqual(p("flip the logo horizontally"), [{ n: "set_transform", i: { clip: "logo", flipX: "toggle" } }]);
  assert.deepEqual(p("send the logo to the back"), [{ n: "arrange_clip", i: { clip: "logo", mode: "back" } }]);
  assert.deepEqual(p("make the badge 50% transparent"), [{ n: "set_transform", i: { clip: "overlay", opacity: 0.5 } }]);
  assert.deepEqual(p("move it to the left"), [{ n: "align_clip", i: { clip: "it", to: "left" } }]);
  assert.deepEqual(p("make the title bigger"), []); // text size stays with style_text
  assert.deepEqual(p("cut a 60 second highlight"), []);
});

test("StubDirector: phrases run the transform tools end to end", async () => {
  const project = new ProjectState({ doc: doc() });
  const director = new StubDirector();
  const r1 = await director.interpret("move the title to the top left", project);
  assert.deepEqual(r1.toolCalls.map((c) => c.name), ["align_clip"]);
  const t = r1.doc.tracks[0]!.clips[0]!;
  assert.ok(t.kind === "text" && t.transform.x < 960 && t.transform.y < 540);
  const r2 = await director.interpret("center it", project);
  const t2 = r2.doc.tracks[1]!.clips.at(-1)!; // "it" = top-most layer (last shape)
  assert.ok(t2.kind === "shape" && t2.transform.x === 960 && t2.transform.y === 540);
  const r3 = await director.interpret("rotate 15 degrees", project);
  assert.deepEqual(r3.toolCalls.map((c) => c.name), ["set_transform"]);
  const r4 = await director.interpret("make the shape smaller", project);
  assert.deepEqual(r4.toolCalls.map((c) => c.name), ["set_transform"]);
});
