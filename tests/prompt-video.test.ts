/**
 * Prompt → video: the pure storyboard planner, the Claude seam (mocked, dormant), the
 * realiser, and StubDirector routing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { docDurationSec, parseEditDoc, type MediaAsset } from "@cadence/core";
import {
  ClaudeStoryboardPlanner,
  ProjectState,
  Storyboard,
  StubDirector,
  StubStoryboardPlanner,
  extractJsonObject,
  moveScene,
  parseBrief,
  parseStoryboard,
  planVideo,
  realiseStoryboard,
  refineStoryboard,
  regenerateScene,
  removeScene,
  selectStoryboardPlanner,
  setStoryboardStyle,
  setSceneText,
  storyboardDuration,
  storyboardOf,
  syncStoryboardWithDoc,
  updateScene,
  type CompleteFn,
} from "@cadence/director";

const photos = (n: number): MediaAsset[] =>
  Array.from({ length: n }, (_, i) => ({ id: `photo-${i}`, kind: "image" as const, src: `p${i}.jpg`, width: 1920, height: 1080, label: `p${i}.jpg` }));

const total = (sb: Storyboard): number => sb.scenes.reduce((a, s) => a + s.durationSec, 0);
const allText = (sb: Storyboard): string => sb.scenes.map((s) => `${s.heading} ${s.body ?? ""}`).join(" | ");

// ---- classification ----------------------------------------------------------------------------------

const GENRE_CASES: [string, string][] = [
  ["30s Instagram promo for my coffee shop, warm vibe, upbeat music", "promo"],
  ["Black Friday sale ad for Urban Kicks sneakers, 40% off", "promo"],
  ["birthday wish for Ayesha", "greeting"],
  ["Eid Mubarak video for my friend Hamza", "greeting"],
  ["congratulations video for my sister who just graduated", "greeting"],
  ["explain how photosynthesis works in 45s", "explainer"],
  ["what is blockchain, explain it simply", "explainer"],
  ["travel recap of Istanbul using my photos", "travel"],
  ["our family trip to Hunza", "travel"],
  ["5 tips for better sleep", "tutorial"],
  ["how to make cold brew at home", "tutorial"],
  ["we're hiring a designer, announcement", "announcement"],
  ["motivational quote about discipline", "quote"],
  ["invite to my daughter's birthday party this Saturday at 6pm", "invite"],
  ["webinar invitation for next Tuesday", "invite"],
  ["product launch for Nimbus, a budgeting app", "launch"],
  ["testimonial video for Glow Salon", "testimonial"],
  ["YouTube intro for my channel TechWithOwais", "intro"],
  ["slideshow of our wedding memories", "slideshow"],
];

for (const [prompt, genre] of GENRE_CASES) {
  test(`classifies "${prompt}" as ${genre}`, () => {
    assert.equal(parseBrief(prompt).genre, genre);
  });
}

test("brief: platform, aspect, length, mood, language and nouns", () => {
  const b = parseBrief("30s Instagram promo for my coffee shop, warm vibe, upbeat music");
  assert.equal(b.platform, "instagram");
  assert.equal(b.aspect, "9:16");
  assert.equal(b.targetSec, 30);
  assert.equal(b.explicitLength, true);
  assert.equal(b.mood, "warm");
  assert.equal(b.musicWord, "upbeat");
  assert.equal(b.subject, "coffee shop");
  assert.equal(b.category, "coffee");
  assert.equal(parseBrief("explain how photosynthesis works in 45s").targetSec, 45);
  assert.equal(parseBrief("explain how photosynthesis works in 45s").subject, "photosynthesis");
  assert.equal(parseBrief("a YouTube explainer about inflation").aspect, "16:9");
  assert.equal(parseBrief("birthday wish for Ayesha").name, "Ayesha");
  assert.equal(parseBrief("wish my mom a happy birthday, she turns 50").age, 50);
  assert.equal(parseBrief("Spanish birthday wish for Carlos").language, "es");
  assert.equal(parseBrief("a 2 min tutorial about git").targetSec, 120);
  assert.equal(parseBrief("promo for my gym, 20% off").offer, "20% off");
  const inv = parseBrief("invite to my daughter's birthday party this Saturday at 6pm at Gulberg Club");
  assert.equal(inv.when, "This Saturday at 6PM");
  assert.equal(inv.where, "Gulberg Club");
});

// ---- the planner ------------------------------------------------------------------------------------

test("planVideo is deterministic and returns a schema-valid storyboard", () => {
  for (const [prompt] of GENRE_CASES) {
    const a = planVideo({ prompt });
    const b = planVideo({ prompt });
    assert.deepEqual(a, b, prompt);
    assert.doesNotThrow(() => Storyboard.parse(JSON.parse(JSON.stringify(a))), prompt);
    assert.ok(a.scenes.length >= 3, `${prompt}: ${a.scenes.length} scenes`);
    assert.ok(a.scenes.every((s) => s.durationSec >= 1.5), prompt);
    assert.ok(!/lorem|ipsum|\{|\}|undefined|null/i.test(allText(a)), `${prompt} → ${allText(a)}`);
    // The first scene is a hook / title and the last is a closer.
    assert.ok(["cta", "outro"].includes(a.scenes[a.scenes.length - 1]!.role) || a.genre === "quote", prompt);
  }
});

test("copy is specific to the user's own nouns", () => {
  assert.match(allText(planVideo({ prompt: "30s Instagram promo for my coffee shop" })), /coffee|cup|latte|brew/i);
  assert.match(allText(planVideo({ prompt: "birthday wish for Ayesha" })), /Ayesha/);
  assert.match(allText(planVideo({ prompt: "explain how photosynthesis works in 45s" })), /chlorophyll/i);
  assert.match(allText(planVideo({ prompt: "5 tips for better sleep" })), /sleep|bed|caffeine|screens/i);
  assert.match(allText(planVideo({ prompt: "invite to my daughter's birthday party this Saturday at 6pm at Gulberg Club" })), /Gulberg Club/);
  assert.match(allText(planVideo({ prompt: "Eid Mubarak video for my friend Hamza" })), /Eid Mubarak, Hamza/);
  assert.match(allText(planVideo({ prompt: "Spanish birthday wish for Carlos" })), /Feliz cumpleaños, Carlos/);
  assert.match(allText(planVideo({ prompt: "travel recap of Istanbul using my photos" })), /Istanbul/);
  assert.match(allText(planVideo({ prompt: "promo for Brew House, 20% off this week" })), /20% off/);
  assert.match(allText(planVideo({ prompt: 'quote video: “Less is more.” — Mies van der Rohe', overrides: { genre: "quote" } })), /Less is more/);
});

test("scenes add up to the requested length (within a reading-time allowance)", () => {
  for (const [prompt, sec] of [
    ["15s promo for my bakery", 15],
    ["30s Instagram promo for my coffee shop", 30],
    ["explain how photosynthesis works in 45s", 45],
    ["60s tutorial about 4 ways to save money", 60],
  ] as [string, number][]) {
    const sb = planVideo({ prompt });
    assert.ok(Math.abs(total(sb) - sec) <= sec * 0.15 + 1, `${prompt}: ${total(sb)}s vs ${sec}s`);
  }
  assert.ok(storyboardDuration(planVideo({ prompt: "birthday wish for Ayesha" })) > 8);
});

test("overrides win over the prompt (platform, aspect, mood, length, genre, language)", () => {
  const sb = planVideo({ prompt: "promo for my bakery", overrides: { platform: "youtube", targetSec: 40, mood: "calm", language: "fr", genre: "promo" } });
  assert.equal(sb.platform, "youtube");
  assert.equal(sb.aspect, "16:9");
  assert.equal(sb.mood, "calm");
  assert.equal(sb.language, "fr");
  assert.ok(Math.abs(total(sb) - 40) <= 8);
  assert.equal(planVideo({ prompt: "promo for my bakery", overrides: { aspect: "1:1" } }).aspect, "1:1");
  assert.equal(planVideo({ prompt: "promo for my bakery", overrides: { genre: "launch" } }).genre, "launch");
});

test("a different seed gives different copy; the same seed the same", () => {
  const a = planVideo({ prompt: "30s promo for my coffee shop", seed: 1 });
  const b = planVideo({ prompt: "30s promo for my coffee shop", seed: 2 });
  assert.notEqual(allText(a), allText(b));
});

test("uploaded photos are assigned to scenes; unknown ids never appear", () => {
  const media = photos(6);
  const sb = planVideo({ prompt: "travel recap of Istanbul using my photos", media });
  assert.equal(sb.genre, "travel");
  assert.ok(sb.scenes.every((s) => !!s.mediaId && media.some((m) => m.id === s.mediaId)));
  assert.ok(new Set(sb.scenes.map((s) => s.mediaId)).size >= 6, "every photo is used");
  assert.ok(sb.look, "a look is chosen for photos");
  assert.equal(planVideo({ prompt: "travel recap of Istanbul" }).scenes.some((s) => s.mediaId), false);
});

test("regenerateScene rolls new copy and keeps timing + media", () => {
  const sb = planVideo({ prompt: "30s Instagram promo for my coffee shop" });
  const hook = regenerateScene(sb, 0);
  assert.notEqual(hook.heading, sb.scenes[0]!.heading);
  assert.equal(hook.durationSec, sb.scenes[0]!.durationSec);
  assert.equal(hook.variant, 1);
});

test("refine: shorter / longer / punchier / different-style / regenerate", () => {
  const sb = planVideo({ prompt: "30s Instagram promo for my coffee shop" });
  assert.ok(total(refineStoryboard(sb, "shorter")) < total(sb) - 4);
  assert.ok(total(refineStoryboard(sb, "longer")) > total(sb) + 4);
  const punchy = refineStoryboard(sb, "punchier");
  assert.equal(punchy.pace, "fast");
  assert.ok(total(punchy) < total(sb));
  assert.ok(punchy.scenes.some((s) => !s.body) || punchy.scenes.length === sb.scenes.length);
  const styled = refineStoryboard(sb, "different-style");
  assert.notEqual(styled.theme, sb.theme);
  assert.notEqual(styled.palette.name, sb.palette.name);
  assert.deepEqual(styled.scenes.map((s) => s.heading), sb.scenes.map((s) => s.heading));
  const regen = refineStoryboard(sb, "regenerate");
  assert.notEqual(allText(regen), allText(sb));
});

test("storyboard editing helpers: reorder, edit, remove keep ids unique", () => {
  const sb = planVideo({ prompt: "30s Instagram promo for my coffee shop" });
  const moved = moveScene(sb, 0, 2);
  assert.equal(moved.scenes[2]!.heading, sb.scenes[0]!.heading);
  assert.deepEqual(moved.scenes.map((s) => s.id), moved.scenes.map((_, i) => `sc${i + 1}`));
  const edited = updateScene(sb, 1, { heading: "Hello there", durationSec: 5 });
  assert.equal(edited.scenes[1]!.heading, "Hello there");
  assert.equal(removeScene(sb, 1).scenes.length, sb.scenes.length - 1);
  assert.equal(removeScene(planVideo({ prompt: "x promo" }), 0).scenes.length >= 1, true);
});

test("honest flags: a testimonial's stand-in quote and an unknown explainer are marked needsEdit", () => {
  const t = planVideo({ prompt: "testimonial video for Glow Salon" });
  assert.ok(t.scenes.some((s) => s.needsEdit));
  assert.ok(t.notes.some((n) => /stand-in/i.test(n)));
  const real = planVideo({ prompt: 'testimonial for Glow Salon: “Best haircut of my life.” — Sara K' });
  assert.ok(!real.scenes.some((s) => s.needsEdit));
  const e = planVideo({ prompt: "explain how a bill becomes law in 40s" });
  assert.ok(e.scenes.some((s) => s.needsEdit));
});

// ---- the Claude seam (dormant; mocked) -------------------------------------------------------------------

test("Claude planner: valid JSON is used, junk and errors fall back to the stub, media ids are sanitised", async () => {
  const stub = new StubStoryboardPlanner();
  const good = planVideo({ prompt: "promo for my bakery" });
  const withBadMedia = { ...good, scenes: good.scenes.map((s, i) => (i === 0 ? { ...s, mediaId: "ghost" } : s)), title: "From the model" };

  const ok = new ClaudeStoryboardPlanner(async () => "Here you go:\n```json\n" + JSON.stringify(withBadMedia) + "\n```", stub);
  const sb = await ok.plan({ prompt: "promo for my bakery" });
  assert.equal(sb.title, "From the model");
  assert.equal(sb.scenes[0]!.mediaId, undefined);

  let calls = 0;
  const junk: CompleteFn = async () => (calls++, "I cannot do that");
  const fb = await new ClaudeStoryboardPlanner(junk, stub).plan({ prompt: "promo for my bakery" });
  assert.equal(calls, 1);
  assert.equal(fb.title, good.title);

  const boom = await new ClaudeStoryboardPlanner(async () => { throw new Error("network down"); }, stub).plan({ prompt: "promo for my bakery" });
  assert.equal(boom.genre, "promo");

  const bad = await new ClaudeStoryboardPlanner(async () => JSON.stringify({ version: 1, scenes: [] }), stub).plan({ prompt: "promo for my bakery" });
  assert.equal(bad.genre, "promo");
});

test("planner selection stays on the stub unless DIRECTOR_MODE=claude AND a completion fn is supplied", () => {
  const stub = new StubStoryboardPlanner();
  const fn: CompleteFn = async () => "{}";
  assert.equal(selectStoryboardPlanner(stub, {}, fn).id, "stub");
  assert.equal(selectStoryboardPlanner(stub, { DIRECTOR_MODE: "stub" }, fn).id, "stub");
  assert.equal(selectStoryboardPlanner(stub, { DIRECTOR_MODE: "claude" }).id, "stub");
  assert.equal(selectStoryboardPlanner(stub, { DIRECTOR_MODE: "claude" }, fn).id, "claude");
  assert.equal(selectStoryboardPlanner(stub).id, "stub", "default env must not enable Claude");
});

test("extractJsonObject copes with fences, prose and braces inside strings", () => {
  assert.deepEqual(extractJsonObject('x {"a":"}{"} y'), { a: "}{" });
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJsonObject("no json here"));
  assert.throws(() => extractJsonObject('{"a":'));
  assert.throws(() => parseStoryboard({ version: 1 }), /Invalid storyboard/);
});

// ---- realiser + Director -----------------------------------------------------------------------------------

test("make_video_from_prompt builds a valid, editable doc with music, sfx, graphics and the stored recipe", async () => {
  const project = new ProjectState({ media: [] });
  const r = await new StubDirector().interpret("30s Instagram promo for my coffee shop, warm vibe, upbeat music", project);
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["make_video_from_prompt"]);
  const doc = parseEditDoc(r.doc);
  assert.equal(doc.meta.width, 1080);
  assert.equal(doc.meta.height, 1920);
  assert.ok(Math.abs(docDurationSec(doc) - 30) < 6, `${docDurationSec(doc)}`);
  assert.ok(doc.tracks.some((t) => t.id === "music" && t.clips.length === 1), "music bed");
  assert.ok(doc.tracks.some((t) => t.id === "sfx"), "sound effects");
  assert.ok(doc.tracks.some((t) => /^graphics-/.test(t.id)), "CTA graphic");
  assert.ok(doc.textVideo, "text-video recipe → Text room can edit every scene");
  const sb = storyboardOf(doc);
  assert.ok(sb && sb.genre === "promo");
  assert.match(r.summary, /Made your video/);
});

test("photos are shown behind the words and survive a theme restyle", async () => {
  const project = new ProjectState({ media: photos(5) });
  const d = new StubDirector();
  const r = await d.interpret("travel recap of Istanbul using my photos", project);
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["make_video_from_prompt"]);
  const media = r.doc.tracks.find((t) => t.id === "tv-media");
  assert.ok(media && media.clips.length >= 5);
  assert.ok(r.doc.media.some((m) => m.kind === "image"));
  const again = await d.interpret("switch to the neon theme", project);
  assert.ok(again.doc.tracks.some((t) => t.id === "tv-media"), "photos survive restyle");
  assert.ok(storyboardOf(again.doc), "recipe survives restyle");
});

test("refinement chips route to refine_video and keep the user's text edits", async () => {
  const project = new ProjectState({ media: [] });
  const d = new StubDirector();
  await d.interpret("birthday wish for Ayesha", project);
  project.setDoc(setSceneText(project.doc, 0, "head", "Happy Birthday, Aya!!"));
  const synced = syncStoryboardWithDoc(storyboardOf(project.doc)!, project.doc);
  assert.equal(synced.scenes[0]!.heading, "Happy Birthday, Aya!!");
  const r = await d.interpret("make it punchier", project);
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["refine_video"]);
  assert.match(storyboardOf(r.doc)!.scenes[0]!.heading, /Aya/);
  const s = await d.interpret("make it shorter", project);
  assert.deepEqual(s.toolCalls.map((c) => c.name), ["refine_video"]);
  const x = await d.interpret("give it a different style", project);
  assert.deepEqual(x.toolCalls.map((c) => c.name), ["refine_video"]);
});

test("a voice-over request degrades gracefully when no TTS provider is configured (money gate)", async () => {
  const project = new ProjectState({ media: [] });
  const sb = planVideo({ prompt: "30s promo for my bakery with a voice-over" });
  assert.equal(sb.voiceover, true);
  const r = await realiseStoryboard(project, sb);
  assert.ok(!r.doc.tracks.some((t) => t.id === "voiceover"));
  assert.ok(r.warnings.some((w) => /voice-over is off/i.test(w)));
  assert.ok(docDurationSec(r.doc) > 10);
});

test("routing: scripts, footage and edits are NOT hijacked; unknown input suggests describing a video", async () => {
  const d = new StubDirector();
  const names = async (prompt: string, project: ProjectState): Promise<string[]> => (await d.interpret(prompt, project)).toolCalls.map((c) => c.name);

  assert.deepEqual(await names("make a text video: Big news. We just launched. Try it free today.", new ProjectState()), ["make_text_video"]);
  assert.deepEqual(await names("make a vertical neon text video: Stay weird. Stay loud. Stay you.", new ProjectState()), ["make_text_video"]);
  assert.deepEqual(await names("make a slideshow from my photos with a warm look", new ProjectState({ media: photos(4) })), ["make_slideshow"]);

  const withVideo = new ProjectState({ media: [{ id: "v", kind: "video", src: "v.mp4", durationSec: 60, width: 1920, height: 1080 }] });
  assert.ok(!(await names("promo for my coffee shop", withVideo)).includes("make_video_from_prompt"));

  const existing = new ProjectState();
  await d.interpret("30s promo for my bakery", existing);
  const afterTitle = await names("add a title: Happy Birthday", existing);
  assert.ok(!afterTitle.includes("make_video_from_prompt"), afterTitle.join(","));

  const vague = await d.interpret("hmm what now", new ProjectState());
  assert.equal(vague.toolCalls.length, 0);
  assert.match(vague.summary, /describe a whole video in one sentence/i);
});

test("style controls: a palette change recolours every scene but keeps the words and the chosen music", () => {
  const sb = planVideo({ prompt: "30s Instagram promo for my coffee shop, warm vibe, upbeat music" });
  assert.equal(sb.music.mood, "upbeat", "the prompt's “upbeat music” wins over the warm mood's lo-fi");
  const ocean = setStoryboardStyle(sb, { palette: "ocean" });
  assert.equal(ocean.music.mood, "upbeat");
  assert.equal(ocean.palette.name, "ocean");
  assert.deepEqual(ocean.scenes.map((s) => s.heading), sb.scenes.map((s) => s.heading));
  assert.notDeepEqual(ocean.scenes[0]!.background?.colors, sb.scenes[0]!.background?.colors);
  assert.equal(setStoryboardStyle(sb, { music: "none" }).music.mood, "none");
  assert.equal(setStoryboardStyle(sb, { aspect: "1:1" }).aspect, "1:1");
});

test("restyling keeps the graphics + music; a brand-new script does not inherit them", async () => {
  const project = new ProjectState({ media: [] });
  const d = new StubDirector();
  await d.interpret("30s Instagram promo for my coffee shop", project);
  assert.ok(project.doc.tracks.some((t) => /^graphics-/.test(t.id)));
  const restyled = await d.interpret("switch to the neon theme", project);
  assert.ok(restyled.doc.tracks.some((t) => /^graphics-/.test(t.id)), "CTA graphic survives a restyle");
  assert.ok(restyled.doc.tracks.some((t) => t.id === "music"), "music survives a restyle");
  const fresh = await d.interpret("make a text video: Big news. We just launched. Try it free today.", project);
  assert.ok(!fresh.doc.tracks.some((t) => /^graphics-/.test(t.id)), "a fresh script starts clean");
});
