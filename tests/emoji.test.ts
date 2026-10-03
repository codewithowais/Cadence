/**
 * Emoji — catalog, search, skin tones, grapheme segmentation, drag payload, sprite
 * naming, sticker / reaction ops, Director routing, and the color-emoji render.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  EMOJI_CATALOG,
  EMOJI_DRAG_MIME,
  EMOJI_GROUPS,
  SKIN_TONES,
  bestEmoji,
  countEmoji,
  decodeEmojiDrag,
  emojiSegments,
  emojiSpriteName,
  emojiTotal,
  emojiWithTone,
  encodeEmojiDrag,
  findEmojiEntry,
  hasEmoji,
  pushRecent,
  searchEmoji,
  splitGraphemes,
  toggleFavorite,
  parseEditDoc,
  drawText,
  type EditDoc,
  type TextClip,
} from "@cadence/core";
import { bundledEmojiDir, renderTextClipPng } from "@cadence/render-node";
import {
  DIRECTOR_TOOLS,
  ProjectState,
  REACTION_PACKS,
  StubDirector,
  addEmoji,
  addReaction,
  editEmoji,
  emojiGroups,
  parseEmojiRequest,
  timesWhenSaid,
} from "@cadence/director";

const base = (): EditDoc => new ProjectState({ media: [] }).doc;
const SPRITES = resolve(import.meta.dirname, "../apps/web/public/emoji");

test("catalog: every standard emoji (1,800+ base, 3,000+ with skin tones), grouped and sprite-backed", () => {
  assert.ok(EMOJI_CATALOG.length >= 1800, `base ${EMOJI_CATALOG.length}`);
  assert.ok(emojiTotal() >= 3000, `total ${emojiTotal()}`);
  assert.equal(EMOJI_GROUPS.length, 9);
  const groups = new Set(EMOJI_CATALOG.map((e) => e.group));
  assert.equal(groups.size, 9);
  // Every catalog emoji (and skin variant) has a vendored sprite.
  const have = new Set(readdirSync(SPRITES).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)));
  let missing = 0;
  for (const e of EMOJI_CATALOG) {
    for (const v of [e.emoji, ...(e.skins ?? [])]) if (!emojiSpriteName(v).some((n) => have.has(n))) missing++;
  }
  assert.equal(missing, 0);
  assert.ok(existsSync(resolve(SPRITES, "ATTRIBUTION.md")), "CC-BY attribution ships with the sprites");
});

test("search: names, keywords, multi-word, the emoji itself; skin tones", () => {
  assert.equal(bestEmoji("fire")?.emoji, "🔥");
  assert.equal(bestEmoji("party popper")?.emoji, "🎉");
  assert.ok(searchEmoji("heart eyes").some((e) => e.emoji === "😍"));
  assert.ok(searchEmoji("thumbs").some((e) => e.emoji === "👍"));
  assert.equal(searchEmoji("zzzzqqq").length, 0);
  assert.equal(searchEmoji("🔥")[0]?.emoji, "🔥");
  const wave = findEmojiEntry("👋")!;
  assert.equal(wave.skins?.length, 5);
  assert.notEqual(emojiWithTone(wave, 3), "👋");
  assert.equal(emojiWithTone(wave, 0), "👋");
  assert.equal(findEmojiEntry(wave.skins![2]!)?.emoji, "👋", "a toned form resolves to its base entry");
  assert.equal(SKIN_TONES.length, 6);
  assert.equal(emojiWithTone(findEmojiEntry("🔥")!, 4), "🔥", "no variants → base");
});

test("grapheme segmentation keeps ZWJ / flags / keycaps / skin tones whole; plain text is untouched", () => {
  assert.deepEqual(emojiSegments("hi").map((s) => s.emoji), [false]);
  const s = emojiSegments("a 👨‍👩‍👧 🇺🇸 👍🏽 1️⃣ 5");
  assert.deepEqual(s.filter((x) => x.emoji).map((x) => x.text), ["👨‍👩‍👧", "🇺🇸", "👍🏽", "1️⃣"]);
  assert.equal(countEmoji("🔥🔥 ok"), 2);
  assert.equal(hasEmoji("© 2026 ™"), false);
  assert.equal(hasEmoji("plain 5 text"), false);
  assert.equal(splitGraphemes("a👍🏽b").length, 3);
  assert.deepEqual(emojiSpriteName("🔥"), ["1f525"]);
  assert.deepEqual(emojiSpriteName("❤️"), ["2764", "2764-fe0f"]);
  assert.deepEqual(emojiSpriteName("👁️‍🗨️")[0], "1f441-fe0f-200d-1f5e8-fe0f");
});

test("recents / favorites / drag payload helpers", () => {
  assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.equal(pushRecent(Array.from({ length: 40 }, (_, i) => String(i)), "x", 32).length, 32);
  assert.deepEqual(toggleFavorite(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleFavorite(["a", "b"], "a"), ["b"]);
  assert.equal(EMOJI_DRAG_MIME, "application/x-cadence-emoji");
  const raw = encodeEmojiDrag({ emoji: "🔥", pack: "burst" });
  assert.deepEqual(decodeEmojiDrag(raw), { v: 1, emoji: "🔥", pack: "burst" });
  assert.equal(decodeEmojiDrag("{nope"), null);
  assert.equal(decodeEmojiDrag(JSON.stringify({ v: 2, emoji: "x" })), null);
  assert.equal(decodeEmojiDrag(null), null);
});

test("addEmoji builds an animated sticker clip on its own lane; edit + remove round-trip", () => {
  const { doc, groupId, clipIds } = addEmoji(base(), { emoji: "🔥", position: "top-right", atSec: 2, loop: "wiggle", intro: "bounce" });
  assert.equal(groupId, "emo-1");
  const g = emojiGroups(doc)[0]!;
  assert.equal(g.pack, "sticker");
  const c = g.clips[0]!;
  assert.equal(c.id, clipIds[0]);
  assert.equal(c.text, "🔥");
  assert.equal(c.start, 2);
  assert.ok(c.transform.x > doc.meta.width / 2 && c.transform.y < doc.meta.height / 2, "top-right");
  assert.equal(c.anim.style, "bounce");
  assert.equal(c.anim.loop.style, "wiggle");
  const e2 = editEmoji(doc, "emo-1", { emoji: "😍", scale: 2, position: "bottom-left", loop: "float", atSec: 4 });
  const c2 = emojiGroups(e2)[0]!.clips[0]!;
  assert.equal(c2.text, "😍");
  assert.equal(c2.fontSize, c.fontSize * 2);
  assert.ok(c2.transform.x < doc.meta.width / 2 && c2.transform.y > doc.meta.height / 2);
  assert.equal(c2.anim.loop.style, "float");
  assert.equal(c2.start, 4);
  assert.equal(emojiGroups(editEmoji(e2, "emo-1", { remove: true })).length, 0);
  // Second group gets the next uid.
  assert.equal(addEmoji(doc, { emoji: "💯" }).groupId, "emo-2");
  assert.throws(() => addEmoji(base(), { emoji: " " }));
});

test("every reaction pack builds valid, staggered, in-frame clips and re-parses through the schema", () => {
  assert.ok(REACTION_PACKS.length >= 6);
  for (const p of REACTION_PACKS) {
    const { doc, clipIds } = addReaction(base(), { pack: p.key, atSec: 1 });
    parseEditDoc(doc); // valid
    assert.ok(clipIds.length >= 5, `${p.key} has several pieces`);
    const g = emojiGroups(doc)[0]!;
    assert.equal(g.pack, p.key);
    assert.ok(g.start >= 1, `${p.key} starts at/after atSec`);
    for (const c of g.clips) assert.ok(c.transform.x >= -50 && c.transform.x <= doc.meta.width + 50, `${p.key} x in frame`);
    // Deterministic.
    const again = addReaction(base(), { pack: p.key, atSec: 1 });
    assert.deepEqual(again.doc.tracks[0]!.clips, doc.tracks[0]!.clips, `${p.key} deterministic`);
  }
  const two = addReaction(base(), { pack: "pop", atSec: [1, 5], emoji: ["💕"] });
  assert.equal(emojiGroups(two.doc)[0]!.clips.length, 12, "plays at each time");
  assert.throws(() => addReaction(base(), { pack: "nope" }));
});

test("timesWhenSaid maps spoken words through the cuts", () => {
  const doc = parseEditDoc({
    version: 1,
    meta: {},
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", kind: "video", start: 10, duration: 5, mediaId: "m", sourceIn: 20 }] }],
  });
  const words = [
    { text: "I", start: 19, end: 19.2 },
    { text: "Love,", start: 21, end: 21.4 },
    { text: "love", start: 40, end: 40.4 },
    { text: "this", start: 22, end: 22.3 },
  ];
  assert.deepEqual(timesWhenSaid(doc, [{ words }], "love"), [11]);
});

test("Director routes emoji phrases to add_emoji / add_reaction (and never also the heart graphic)", async () => {
  const run = async (prompt: string) => {
    const p = new ProjectState({ media: [] });
    const r = await new StubDirector().interpret(prompt, p);
    return { r, p };
  };
  let { r, p } = await run("add a fire emoji at the top right");
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["add_emoji"]);
  assert.equal(emojiGroups(p.doc)[0]!.clips[0]!.text, "🔥");
  assert.ok(emojiGroups(p.doc)[0]!.clips[0]!.transform.x > p.doc.meta.width / 2);

  ({ r, p } = await run("add confetti"));
  assert.deepEqual(r.toolCalls.map((c) => `${c.name}:${(c.input as { pack: string }).pack}`), ["add_reaction:party"]);
  ({ r, p } = await run("add a laughing reaction"));
  assert.equal((r.toolCalls[0]!.input as { pack: string }).pack, "laugh");
  ({ r, p } = await run("make a fire burst at 2 seconds"));
  assert.equal((r.toolCalls[0]!.input as { pack: string; atSec: number }).pack, "burst");
  ({ r, p } = await run("hearts floating up"));
  assert.equal((r.toolCalls[0]!.input as { pack: string }).pack, "float-up");
  ({ r, p } = await run("add 🔥 and 😂"));
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["add_emoji", "add_emoji"]);

  const parsed = parseEmojiRequest("pop hearts when i say love");
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0]!.tool.name, "add_reaction");
  assert.equal((parsed.requests[0]!.input as { whenSaid: string }).whenSaid, "love");
  assert.ok(!/heart/.test(parsed.rest), "the matched phrase is withheld from the graphics router");

  // Graphics phrases are unaffected.
  ({ r } = await run("add a heart sticker"));
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["add_graphic"]);
});

test("add_reaction whenSaid resolves from the transcript and errors helpfully without one", async () => {
  const project = new ProjectState({ media: [{ id: "m", kind: "video", src: "a.mp4", durationSec: 30 } as never] });
  project.setDoc({
    version: 1,
    meta: {},
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 30, mediaId: "m" }] }],
  });
  await assert.rejects(() => DIRECTOR_TOOLS.add_reaction.execute({ pack: "pop", whenSaid: "love" } as never, { project }), /transcript/);
  project.setTranscript({ mediaId: "m", durationSec: 30, language: "en", segments: [], words: [{ text: "love", start: 3, end: 3.4 }, { text: "Love!", start: 9, end: 9.5 }] });
  const res = await DIRECTOR_TOOLS.add_reaction.execute({ pack: "pop", whenSaid: "love" } as never, { project });
  assert.match(res.summary, /2× when/);
  assert.equal(emojiGroups(project.doc)[0]!.clips.length, 12);
  await assert.rejects(() => DIRECTOR_TOOLS.add_reaction.execute({ pack: "pop", whenSaid: "zebra" } as never, { project }), /couldn't find/);
});

test("color emoji render as bundled sprites in the node canvas / export PNG (non-trivial color pixels)", () => {
  assert.ok(bundledEmojiDir(), "sprite dir resolves");
  const doc = base();
  const clip = { id: "e", kind: "text", start: 0, duration: 3, text: "🔥", fontSize: 300, transform: { x: 960, y: 540 }, anim: { style: "none" } } as unknown as TextClip;
  const png = renderTextClipPng(doc, parseEditDoc({ ...doc, tracks: [{ id: "t", kind: "visual", clips: [clip] }] }).tracks[0]!.clips[0] as TextClip);
  assert.ok(png.length > 4000, `png ${png.length}B`);
  // Decode through a canvas and count orange / yellow flame pixels around the center.
  const cv = createCanvas(doc.meta.width, doc.meta.height);
  const ctx = cv.getContext("2d");
  return import("@napi-rs/canvas").then(async ({ loadImage }) => {
    ctx.drawImage(await loadImage(png), 0, 0);
    const d = ctx.getImageData(960 - 170, 540 - 170, 340, 340).data;
    let orange = 0;
    let yellow = 0;
    let opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! > 200) opaque++;
      if (d[i]! > 230 && d[i + 1]! > 130 && d[i + 1]! < 170 && d[i + 2]! < 40 && d[i + 3]! > 200) orange++; // #F4900C
      if (d[i]! > 240 && d[i + 1]! > 190 && d[i + 2]! > 60 && d[i + 2]! < 90 && d[i + 3]! > 200) yellow++; // #FFCC4D
    }
    assert.ok(opaque > 20000, `opaque ${opaque}`);
    assert.ok(orange > 5000, `orange ${orange}`);
    assert.ok(yellow > 1500, `yellow ${yellow}`);
    // Two renders are pixel-identical (deterministic sprite raster).
    const png2 = renderTextClipPng(doc, parseEditDoc({ ...doc, tracks: [{ id: "t", kind: "visual", clips: [clip] }] }).tracks[0]!.clips[0] as TextClip);
    assert.ok(png.equals(png2));
  });
});

test("emoji inside a text clip lay out inline with the words (measure + draw)", () => {
  const cv = createCanvas(800, 200);
  const ctx = cv.getContext("2d");
  const mk = (text: string): TextClip => parseEditDoc({ ...base(), tracks: [{ id: "t", kind: "visual", clips: [{ id: "x", kind: "text", start: 0, duration: 2, text, fontSize: 80, align: "left", color: "#ff0000", transform: { x: 20, y: 100 } }] }] }).tracks[0]!.clips[0] as TextClip;
  ctx.clearRect(0, 0, 800, 200);
  drawText(ctx as never, mk("Go 🔥"), 0);
  const d = ctx.getImageData(0, 0, 800, 200).data;
  // Flame sprite is to the RIGHT of the red word and contains orange.
  let orangeX = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 800; x++) {
    const i = (y * 800 + x) * 4;
    if (d[i]! > 230 && d[i + 1]! > 130 && d[i + 1]! < 170 && d[i + 2]! < 40 && d[i + 3]! > 200) orangeX = Math.max(orangeX, x);
  }
  assert.ok(orangeX > 120, `flame right of the word (x=${orangeX})`);
});
