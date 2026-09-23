/**
 * @cadence/director — text video: script → scenes, themes, restyle/retarget
 * round-trips, in-place scene edits, text/background ops, and StubDirector routing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { docDurationSec, parseEditDoc, type EditDoc, type TextClip } from "@cadence/core";
import {
  ProjectState,
  StubDirector,
  animateText,
  buildTextVideo,
  detectTextVideoFormat,
  extractScript,
  isTextVideo,
  reframe,
  restyleTextVideo,
  setBackground,
  setSceneText,
  setTextVideoScenes,
  splitScript,
  styleText,
  textVideoScenes,
  TEXT_VIDEO_THEMES,
} from "@cadence/director";

const blank = (): EditDoc => parseEditDoc({ version: 1 });
const texts = (d: EditDoc): TextClip[] => d.tracks.flatMap((t) => t.clips).filter((c): c is TextClip => c.kind === "text");

test("format detection: list, quote, story", () => {
  assert.equal(detectTextVideoFormat("Tips\n1. One\n2. Two"), "list");
  assert.equal(detectTextVideoFormat("“Stay hungry.” — Steve Jobs"), "quote");
  assert.equal(detectTextVideoFormat("We launched. Try it."), "story");
});

test("splitScript: lists get numbered items with optional detail lines", () => {
  const { format, scenes } = splitScript("3 tips\n1. Sleep: 8 hours\n2. Water\n3. Walk\nFollow for more");
  assert.equal(format, "list");
  assert.deepEqual(scenes.map((s) => s.kind), ["title", "item", "item", "item", "cta"]);
  assert.equal(scenes[1]!.num, "01");
  assert.equal(scenes[1]!.head, "Sleep");
  assert.equal(scenes[1]!.sub, "8 hours");
});

test("splitScript: quotes keep the author as a sub line; long prose chunks", () => {
  const q = splitScript("“Stay hungry, stay foolish.” — Steve Jobs").scenes;
  assert.equal(q.length, 1);
  assert.equal(q[0]!.sub, "— Steve Jobs");
  const long = splitScript("This is one very long sentence that keeps going and going, with a comma here, and another clause that should be split.").scenes;
  assert.ok(long.length >= 2 && long.every((s) => s.head.split(" ").length <= 14));
});

test("buildTextVideo: every theme builds a valid, media-free, timed doc", () => {
  for (const theme of TEXT_VIDEO_THEMES) {
    const d = buildTextVideo(blank(), { script: "Big news. We launched. Try it free.", theme, aspect: "9:16" });
    assert.equal(d.meta.width, 1080);
    assert.equal(d.meta.height, 1920);
    assert.equal(d.textVideo?.theme, theme);
    assert.equal(d.media.length, 0);
    assert.equal(texts(d).length, 3, theme);
    assert.ok(docDurationSec(d) > 5, theme);
    for (const t of texts(d)) assert.ok(t.transform.x === 540 && t.fontSize >= 22 && t.maxWidth! < 1080, theme);
  }
  assert.throws(() => buildTextVideo(blank(), { script: "   " }), /Give me some text/);
});

test("scenes round-trip: read back, retime, reorder, restyle keeps words + timing", () => {
  const d = buildTextVideo(blank(), { script: "3 tips\n1. Sleep\n2. Water\n3. Walk", theme: "bold" });
  const scenes = textVideoScenes(d);
  assert.equal(scenes.length, 4);
  assert.equal(scenes[0]!.head, "3 tips"); // uppercase is render-time, text keeps its case
  // retime scene 2 and drop the last
  const edited = setTextVideoScenes(d, [scenes[0]!, { ...scenes[1]!, durationSec: 5 }, scenes[2]!]);
  const again = textVideoScenes(edited);
  assert.equal(again.length, 3);
  assert.equal(again[1]!.durationSec, 5);
  const r = restyleTextVideo(edited, "minimal");
  assert.equal(r.textVideo?.theme, "minimal");
  assert.deepEqual(textVideoScenes(r).map((s) => [s.head, s.durationSec]), again.map((s) => [s.head, s.durationSec]));
});

test("reframe re-lays a text video instead of stretching it", () => {
  const d = buildTextVideo(blank(), { script: "Hello there. General Kenobi.", aspect: "16:9" });
  const v = reframe(d, "9:16");
  assert.equal(v.meta.width, 1080);
  assert.equal(v.meta.height, 1920);
  assert.ok(isTextVideo(v));
  for (const t of texts(v)) assert.equal(t.transform.x, 540);
});

test("setSceneText edits in place (keeps manual styling)", () => {
  const d = buildTextVideo(blank(), { script: "One. Two." });
  const styled = styleText(d, { target: "all", color: "#123456" }).doc;
  const e = setSceneText(styled, 1, "head", "Deux");
  const t = texts(e).find((c) => c.id.startsWith("tv-s1-"))!;
  assert.equal(t.text, "Deux");
  assert.equal(t.color, "#123456");
});

test("animateText / styleText / setBackground ops", () => {
  const d = buildTextVideo(blank(), { script: "One. Two." });
  const a = animateText(d, { target: "all", style: "glitch", unit: "letter", exit: "blur-out", loop: "wave" });
  assert.equal(a.count, 2);
  for (const t of texts(a.doc)) assert.deepEqual([t.anim.style, t.anim.unit, t.anim.exit.style, t.anim.loop.style], ["glitch", "letter", "blur-out", "wave"]);
  const s = styleText(d, { effect: { style: "neon", intensity: 0.5, offset: 0.5, direction: -45 }, fillGradient: { stops: ["#ff0000", "#0000ff"], angle: 0 } });
  assert.ok(texts(s.doc).every((t) => t.effect?.style === "neon" && t.fillGradient));
  const b = setBackground(d, { gradient: { kind: "linear", angle: 90, stops: ["#000000", "#ffffff"], motion: "aurora", speed: 1 } });
  assert.equal(b.count, 2);
  // A doc with no background solid gains one.
  const empty = setBackground(blank(), { color: "#ff0000" });
  assert.equal(empty.count, 1);
  assert.equal(empty.doc.tracks[0]!.id, "background");
});

test("extractScript keeps the user's words (and case) out of the instruction", () => {
  const a = extractScript("Make a NEON text video: Stay Vertical. Be bold.");
  assert.equal(a.script, "Stay Vertical. Be bold.");
  assert.equal(a.instruction, "make a neon text video");
  const b = extractScript('quote video with “Less is more”');
  assert.equal(b.script, "Less is more");
});

test("StubDirector: text video from words, no media; script words never trigger edits", async () => {
  const project = new ProjectState({ media: [] });
  const r = await new StubDirector().interpret("make a text video: Think outside the box. Stay vertical in business.", project);
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["make_text_video"]);
  assert.equal(r.doc.meta.width, 1920); // "vertical" was in the SCRIPT, not the instruction
  const r2 = await new StubDirector().interpret("switch to the elegant theme", project);
  assert.deepEqual(r2.toolCalls.map((c) => c.name), ["restyle_text_video"]);
  const r3 = await new StubDirector().interpret("letters pop in one by one", project);
  assert.deepEqual(r3.toolCalls.map((c) => c.name), ["animate_text"]);
  const r4 = await new StubDirector().interpret("add an aurora background", project);
  assert.deepEqual(r4.toolCalls.map((c) => c.name), ["set_background"]);
  const r5 = await new StubDirector().interpret("add background music", project);
  assert.ok(!r5.toolCalls.some((c) => c.name === "set_background"), "background music is not a background");
});
