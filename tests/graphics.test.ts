/**
 * Graphics pack — pure resolvers (shape motion, progress, counters, geometry,
 * export windows) and the pure group ops (add / edit / remove / animate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHAPE_KINDS,
  clipAnimatedWindows,
  counterText,
  counterTickTimes,
  counterValue,
  formatClock,
  formatNumber,
  parseEditDoc,
  polylineLength,
  shapeAnimState,
  shapeOutline,
  shapeProgressLevel,
  type EditDoc,
  type ShapeClip,
  type TextClip,
} from "@cadence/core";
import {
  DIRECTOR_TOOLS,
  GRAPHIC_PRESETS,
  ProjectState,
  StubDirector,
  addGraphic,
  animateShape,
  editGraphic,
  estimateTextWidth,
  findGraphicGroup,
  graphicGroups,
  graphicParams,
  parseGraphicId,
  removeGraphic,
} from "@cadence/director";

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

function shape(over: Record<string, unknown> = {}): ShapeClip {
  return parseEditDoc({
    version: 1,
    tracks: [{ id: "s", kind: "visual", clips: [{ id: "x", kind: "shape", start: 1, duration: 4, w: 200, h: 100, ...over }] }],
  }).tracks[0]!.clips[0] as ShapeClip;
}

function text(over: Record<string, unknown> = {}): TextClip {
  return parseEditDoc({
    version: 1,
    tracks: [{ id: "t", kind: "visual", clips: [{ id: "c", kind: "text", start: 0, duration: 4, text: "3", ...over }] }],
  }).tracks[0]!.clips[0] as TextClip;
}

const emptyDoc = (w = 1920, h = 1080): EditDoc => parseEditDoc({ version: 1, meta: { width: w, height: h }, tracks: [] });

test("a shape with no anim resolves to the identity state (legacy docs unchanged)", () => {
  const s = shapeAnimState(shape(), 2);
  assert.equal(s.scale, 1);
  assert.equal(s.opacity, 1);
  assert.equal(s.drawTo, 1);
  assert.equal(s.visible, true);
  const legacy = shape();
  assert.equal("anim" in legacy, false, "anim stays absent after parsing a legacy shape");
  assert.deepEqual(clipAnimatedWindows(legacy), []);
});

test("pop intro overshoots then settles; hidden before its delay", () => {
  const c = shape({ anim: { style: "pop", durationSec: 0.5, delaySec: 0.2 } });
  assert.equal(shapeAnimState(c, 1.1).visible, false, "before the delay the shape is not drawn");
  const peak = Math.max(...[0.3, 0.4, 0.5, 0.6].map((d) => shapeAnimState(c, 1.2 + d * 0.5).scale));
  assert.ok(peak > 1.02, `pop should overshoot (peak ${peak})`);
  assert.ok(near(shapeAnimState(c, 2).scale, 1), "settled after the intro");
});

test("grow-x stretches from the left edge; draw reveals the stroke path", () => {
  const g = shapeAnimState(shape({ anim: { style: "grow-x", durationSec: 1 } }), 1.25);
  assert.ok(g.stretchX > 0 && g.stretchX < 1);
  assert.equal(g.originX, -100);
  const d = shape({ shape: "scribble", anim: { style: "draw", durationSec: 1 } });
  const mid = shapeAnimState(d, 1.4);
  assert.ok(mid.drawTo > 0 && mid.drawTo < 1, `mid draw ${mid.drawTo}`);
  assert.equal(shapeAnimState(d, 2.5).drawTo, 1);
});

test("exits run over the clip's last seconds; loops move continuously", () => {
  const c = shape({ anim: { style: "none", exit: { style: "shrink", durationSec: 0.5 }, loop: { style: "wiggle", amount: 1 } } });
  assert.ok(near(shapeAnimState(c, 4).scale, 1), "no exit before the window");
  assert.ok(shapeAnimState(c, 4.9).scale < 0.5, "shrinking near the end");
  assert.notEqual(shapeAnimState(c, 2.1).rotation, shapeAnimState(c, 2.3).rotation, "wiggle rotates over time");
  assert.equal(clipAnimatedWindows(c).length, 1);
  assert.deepEqual(clipAnimatedWindows(c)[0], [1, 5], "a loop animates the whole span");
});

test("motion is deterministic", () => {
  const c = shape({ anim: { style: "drop", durationSec: 0.8, loop: { style: "heartbeat", amount: 0.8 } } });
  assert.deepEqual(shapeAnimState(c, 1.37), shapeAnimState(c, 1.37));
});

test("progress fills from→to over its window, with repeat and ranges", () => {
  const c = shape({ progress: { from: 0, to: 1 } });
  assert.equal(shapeProgressLevel(c, 1), 0);
  assert.ok(near(shapeProgressLevel(c, 3), 0.5));
  assert.equal(shapeProgressLevel(c, 5), 1);
  const r = shape({ progress: { from: 0, to: 1, startSec: 1, durationSec: 2 } });
  assert.equal(shapeProgressLevel(r, 1.5), 0);
  assert.ok(near(shapeProgressLevel(r, 3), 0.5));
  assert.equal(shapeProgressLevel(r, 4.5), 1);
  const rep = shape({ progress: { repeat: 4 } });
  assert.ok(near(shapeProgressLevel(rep, 1.5), 0.5), "each of 4 cycles lasts 1s");
  assert.deepEqual(clipAnimatedWindows(r), [[2, 4]]);
  assert.equal(shapeProgressLevel(shape(), 2), 1, "no progress ⇒ fully drawn");
});

test("tick counters hold each value for an equal share; smooth counters count continuously", () => {
  const c = text({ counter: { from: 3, to: 0, endText: "GO!" } });
  assert.deepEqual([0.1, 1.1, 2.1, 3.1].map((t) => counterText(c, t)), ["3", "2", "1", "GO!"]);
  assert.deepEqual(counterTickTimes(c), [1, 2, 3]);
  const w = clipAnimatedWindows(c);
  assert.equal(w.length, 3, "one tiny window per tick (stills between) — not the whole span");
  assert.ok(w.every(([a, b]) => b - a < 0.01));
  const up = text({ counter: { from: 0, to: 10000, mode: "smooth" } });
  assert.equal(counterValue(up, 2), 5000);
  assert.equal(counterText(up, 4), "10,000");
  assert.deepEqual(clipAnimatedWindows(up), [[0, 4]]);
  const clock = text({ duration: 61, counter: { from: 60, to: 0, format: "mm:ss" } });
  assert.equal(counterText(clock, 0.5), "01:00");
  assert.equal(counterText(clock, 1.5), "00:59");
  assert.equal(counterText(clock, 60.5), "00:00");
});

test("number / clock formatting is locale-independent", () => {
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatNumber(-1234.5, 1), "-1,234.5");
  assert.equal(formatClock(75), "01:15");
  assert.equal(formatClock(3725, true), "01:02:05");
  assert.equal(formatClock(-3), "00:00");
});

test("every shape kind has a finite outline inside its box", () => {
  for (const k of SHAPE_KINDS) {
    const lines = shapeOutline(k, 200, 120, 20, 10);
    assert.ok(lines.length > 0 && polylineLength(lines) > 0, k);
    for (const ln of lines) {
      for (let i = 0; i < ln.pts.length; i += 2) {
        assert.ok(Number.isFinite(ln.pts[i]!) && Math.abs(ln.pts[i]!) <= 101, `${k} x in box`);
        assert.ok(Number.isFinite(ln.pts[i + 1]!) && Math.abs(ln.pts[i + 1]!) <= 61, `${k} y in box`);
      }
    }
  }
});

test("addGraphic inserts a group on the graphics track with readable ids", () => {
  const { doc, groupId, clipIds } = addGraphic(emptyDoc(), { preset: "subscribe", atSec: 2 });
  assert.equal(groupId, "gfx-1");
  assert.deepEqual(clipIds, ["gfx-1-subscribe-btn", "gfx-1-subscribe-bell"]);
  const track = doc.tracks.find((t) => t.id === "graphics-1")!;
  assert.equal(track.name, "Subscribe + bell", "each graphic gets its own named lane");
  assert.equal(track.clips.length, 2);
  assert.deepEqual(parseGraphicId("gfx-1-lt-bar-edge"), { group: "gfx-1", uid: 1, preset: "lt-bar", role: "edge" });
  assert.equal(parseGraphicId("shape-123"), null);
  const second = addGraphic(doc, { preset: "lt-bar" });
  assert.equal(second.groupId, "gfx-2");
  assert.equal(second.doc.tracks[second.doc.tracks.length - 1]!.id, "graphics-2", "newer graphics stack on top");
  assert.equal(graphicGroups(second.doc).length, 2);
  // Every layer starts at the playhead, sits inside the frame, and carries motion.
  for (const c of track.clips as ShapeClip[]) {
    assert.ok(c.start >= 2);
    assert.ok(c.transform.x > 0 && c.transform.x < 1920 && c.transform.y > 0 && c.transform.y < 1080);
    assert.ok(c.anim);
  }
});

test("every preset builds a valid, in-frame group in landscape and portrait", () => {
  for (const [w, h] of [[1920, 1080], [1080, 1920]] as const) {
    for (const p of GRAPHIC_PRESETS) {
      const { doc, groupId } = addGraphic(emptyDoc(w, h), { preset: p.key, atSec: 0, durationSec: 4 });
      const g = findGraphicGroup(doc, groupId)!;
      assert.ok(g && g.layers.length > 0, p.key);
      for (const { clip } of g.layers) {
        const hw = (clip.w * clip.transform.scale) / 2;
        const hh = (clip.h * clip.transform.scale) / 2;
        assert.ok(clip.transform.x - hw >= -1 && clip.transform.x + hw <= w + 1, `${p.key} ${clip.id} fits horizontally at ${w}x${h}`);
        assert.ok(clip.transform.y - hh >= -1 && clip.transform.y + hh <= h + 1, `${p.key} ${clip.id} fits vertically at ${w}x${h}`);
      }
    }
  }
});

test("editGraphic rebuilds in place: words widen the pill, colors/timing/position/scale apply", () => {
  const { doc, groupId } = addGraphic(emptyDoc(), { preset: "follow", position: "bottom-left" });
  const before = findGraphicGroup(doc, groupId)!;
  const w0 = before.layers[0]!.clip.w;
  const c0 = graphicParams(before).center;
  const longer = editGraphic(doc, groupId, { text: "Follow for daily tips" });
  const g1 = findGraphicGroup(longer, groupId)!;
  assert.ok(g1.layers[0]!.clip.w > w0 * 1.5, "a longer label widens its pill");
  assert.ok(near(graphicParams(g1).center.x, c0.x, 1) && near(graphicParams(g1).center.y, c0.y, 1), "stays where it was");
  assert.equal(graphicParams(g1).text, "Follow for daily tips");
  const recolored = editGraphic(longer, groupId, { color: "#00aa55", atSec: 3, durationSec: 6 });
  const g2 = findGraphicGroup(recolored, groupId)!;
  assert.equal(g2.layers[0]!.clip.fill, "#00aa55");
  assert.equal(g2.start, 3);
  assert.equal(g2.end, 9);
  const moved = editGraphic(recolored, groupId, { position: "top-right", scale: 1.5 });
  const g3 = findGraphicGroup(moved, groupId)!;
  assert.ok(graphicParams(g3).center.x > 1000 && graphicParams(g3).center.y < 300);
  assert.equal(g3.layers[0]!.clip.transform.scale, 1.5);
  const loopy = editGraphic(moved, groupId, { loop: "wiggle", intro: "drop" });
  const g4 = findGraphicGroup(loopy, groupId)!;
  assert.equal(g4.layers[0]!.clip.anim!.loop.style, "wiggle");
  assert.equal(g4.layers[0]!.clip.anim!.style, "drop");
  // Motion overrides survive a later words edit.
  const g5 = findGraphicGroup(editGraphic(loopy, groupId, { text: "Follow" }), groupId)!;
  assert.equal(g5.layers[0]!.clip.anim!.loop.style, "wiggle");
});

test("countdown / timer amounts re-time the group", () => {
  const { doc, groupId } = addGraphic(emptyDoc(), { preset: "countdown-321" });
  const g = findGraphicGroup(doc, groupId)!;
  assert.deepEqual(g.layers.map((l) => l.role), ["n3", "n2", "n1", "go"]);
  assert.equal(g.end - g.start, 4);
  const five = findGraphicGroup(editGraphic(doc, groupId, { amount: 5 }), groupId)!;
  assert.equal(five.layers.length, 6);
  assert.equal(five.end - five.start, 6);
  const timer = addGraphic(emptyDoc(), { preset: "timer", amount: 30 });
  const tg = findGraphicGroup(timer.doc, timer.groupId)!;
  assert.equal(tg.end - tg.start, 31, "a 30 s timer holds 00:00 for its last second");
  assert.equal(graphicParams(tg).amount, 30);
});

test("removeGraphic drops the group (and the empty graphics track); other clips survive", () => {
  const base = parseEditDoc({ version: 1, tracks: [{ id: "shapes", kind: "visual", clips: [{ id: "s1", kind: "shape", start: 0, duration: 2 }] }] });
  const { doc, groupId } = addGraphic(base, { preset: "heart" });
  const out = removeGraphic(doc, groupId);
  assert.equal(graphicGroups(out).length, 0);
  assert.equal(out.tracks.some((t) => t.id.startsWith("graphics-")), false);
  assert.equal(out.tracks[0]!.clips.length, 1);
});

test("animateShape adds / clears motion on plain shapes only", () => {
  const base = parseEditDoc({ version: 1, tracks: [{ id: "shapes", kind: "visual", clips: [{ id: "s1", kind: "shape", start: 0, duration: 2 }] }] });
  const withGfx = addGraphic(base, { preset: "star" }).doc;
  const { doc, count } = animateShape(withGfx, { style: "pop", loop: "pulse" });
  assert.equal(count, 1, "graphics keep their own motion");
  const s1 = doc.tracks[0]!.clips[0] as ShapeClip;
  assert.equal(s1.anim!.style, "pop");
  const cleared = animateShape(doc, { clipId: "s1", style: "none", loop: "none" }).doc;
  assert.equal("anim" in (cleared.tracks[0]!.clips[0] as object), false, "no motion ⇒ anim removed (static path)");
});

test("text width estimate tracks real font metrics", () => {
  // Measured with Skia: Montserrat bold "Subscribe" @100px ≈ 519px.
  const w = estimateTextWidth("Subscribe", 100);
  assert.ok(w > 500 && w < 580, `estimate ${w}`);
});

test("the Director routes plain-language graphics requests to the graphics tools", async () => {
  const cases: [string, string, string][] = [
    ["add a subscribe button at the bottom right", "add_graphic", "subscribe"],
    ["put a link in bio sticker", "add_graphic", "link-in-bio"],
    ["add a progress bar at the bottom", "add_progress_bar", "bottom"],
    ["add a 3 2 1 countdown", "add_countdown", "321"],
    ["add a 30 second timer in the top right", "add_countdown", "timer"],
    ["add a count up to 5000 followers", "add_countdown", "countup"],
    ["add a heart sticker", "add_graphic", "heart"],
    ["circle it with a hand-drawn circle", "add_graphic", "circle-mark"],
  ];
  for (const [prompt, tool, key] of cases) {
    const project = new ProjectState({ media: [] });
    const r = await new StubDirector().interpret(prompt, project);
    const call = r.toolCalls.find((c) => c.name === tool);
    assert.ok(call, `${prompt} → ${tool} (got ${r.toolCalls.map((c) => c.name).join(", ")})`);
    const input = call!.input as { preset?: string; style?: string };
    assert.equal(input.preset ?? input.style, key, prompt);
    assert.equal(graphicGroups(r.doc).length, 1, `${prompt} adds one graphic`);
  }
  // Timer seconds + position are read from the words.
  const p = new ProjectState({ media: [] });
  await new StubDirector().interpret("add a 30 second timer in the top right", p);
  const g = graphicGroups(p.doc)[0]!;
  assert.equal(graphicParams(g).amount, 30);
  assert.ok(graphicParams(g).center.x > 1200 && graphicParams(g).center.y < 300);
});

test("graphics tools are registered at the end of DIRECTOR_TOOLS and edit via edit_graphic", async () => {
  const names = Object.keys(DIRECTOR_TOOLS);
  assert.deepEqual(names.slice(-6), ["add_graphic", "add_lower_third", "add_progress_bar", "add_countdown", "edit_graphic", "animate_shape"]);
  const project = new ProjectState({ media: [] });
  await DIRECTOR_TOOLS.add_lower_third.execute({ name: "Ayesha Khan", title: "Host", style: "split" }, { project });
  const g = graphicGroups(project.doc)[0]!;
  assert.equal(g.preset, "lt-split");
  assert.equal(graphicParams(g).text, "Ayesha Khan");
  await DIRECTOR_TOOLS.edit_graphic.execute({ subtext: "Host & producer", position: "bottom-right" }, { project });
  assert.equal(graphicParams(graphicGroups(project.doc)[0]!).subtext, "Host & producer");
  await DIRECTOR_TOOLS.edit_graphic.execute({ remove: true }, { project });
  assert.equal(graphicGroups(project.doc).length, 0);
});
