/**
 * First-run ease & discoverability — the pure logic behind the command palette,
 * next-step chips, prompt library, "didn't understand" recovery, onboarding
 * checklist and composer history (apps/web/src/lib/suggestions.ts + commands.ts).
 *
 * The strongest guarantee: EVERY prompt in the library, in EVERY context it says it
 * supports, routes through the real StubDirector to at least one tool — so nothing
 * we suggest is a dead end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import { ProjectState, StubDirector, buildSlideshowDoc } from "@cadence/director";
import { StubTranscriber } from "@cadence/understanding";
import { combinedVideoDoc } from "../apps/web/src/lib/doc";
import {
  EXPORT_STEP,
  PROMPT_LIBRARY,
  closestIdeas,
  fuzzyScore,
  isAvailable,
  nextSteps,
  onboardingProgress,
  onboardingSteps,
  pushRecent,
  recallRecent,
  type EditorMode,
} from "../apps/web/src/lib/suggestions";
import { buildCommands, rankCommands, type CommandContext } from "../apps/web/src/lib/commands";

// ---- fixtures -----------------------------------------------------------------------

const VIDEO: MediaAsset = { id: "clip-1", kind: "video", src: "a.mp4", durationSec: 90, width: 1920, height: 1080, label: "a.mp4" };
const SONG: MediaAsset = { id: "song-1", kind: "audio", src: "song.mp3", durationSec: 60, label: "song.mp3" };
const PHOTOS: MediaAsset[] = Array.from({ length: 4 }, (_, i) => ({ id: `img-${i}`, kind: "image" as const, src: `p${i}.png`, width: 1600, height: 1200, label: `p${i}.png` }));

async function project(mode: EditorMode, withSong = false): Promise<ProjectState> {
  const song = withSong ? [SONG] : [];
  if (mode === "video") {
    const p = new ProjectState({ media: [VIDEO, ...song], doc: combinedVideoDoc([VIDEO]) });
    p.setTranscript(await new StubTranscriber().transcribe(VIDEO));
    return p;
  }
  if (mode === "images") return new ProjectState({ media: [...PHOTOS, ...song], doc: buildSlideshowDoc(PHOTOS) });
  if (mode === "text") {
    const p = new ProjectState({ media: [...song] });
    const r = await new StubDirector().interpret("make a text video: Big news. We launched. Try it today.", p);
    p.setDoc(r.doc);
    return p;
  }
  return new ProjectState({ media: [...song] });
}

const MODES: EditorMode[] = ["video", "images", "text", "none"];

// ---- the library is never a dead end -------------------------------------------------

test("library: ids are unique, labels are short, every idea either prompts or opens a room", () => {
  const ids = new Set<string>();
  for (const idea of PROMPT_LIBRARY) {
    assert.ok(!ids.has(idea.id), `duplicate id ${idea.id}`);
    ids.add(idea.id);
    assert.ok(idea.label.length <= 34, `label too long: ${idea.label}`);
    assert.ok(!!idea.prompt !== !!idea.room, `${idea.id} must have exactly one of prompt / room`);
  }
  assert.ok(PROMPT_LIBRARY.length >= 50, "a rich library");
});

test("library: every prompt routes to ≥1 Director tool in every context it claims", async () => {
  const failures: string[] = [];
  for (const mode of MODES) {
    for (const withSong of [false, true]) {
      for (const idea of PROMPT_LIBRARY) {
        if (!idea.prompt || !isAvailable(idea.needs, mode, withSong)) continue;
        const r = await new StubDirector().interpret(idea.prompt, await project(mode, withSong));
        if (r.toolCalls.length === 0) failures.push(`${mode}${withSong ? "+song" : ""}: ${idea.id} → "${r.summary.slice(0, 80)}"`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

// ---- next steps ---------------------------------------------------------------------

async function afterPrompt(mode: EditorMode, prompt: string): Promise<{ doc: EditDoc; tools: string[] }> {
  const p = await project(mode);
  const r = await new StubDirector().interpret(prompt, p);
  return { doc: r.doc, tools: r.toolCalls.map((c) => c.name) };
}

test("nextSteps: after a highlight → captions + vertical, never what's applied", async () => {
  const { doc, tools } = await afterPrompt("video", "cut a 60-second highlight");
  const steps = nextSteps({ doc, mode: "video", lastTools: tools, hasAudio: false });
  const ids = steps.map((s) => s.id);
  assert.ok(ids.length > 0 && ids.length <= 3);
  assert.equal(ids[0], "captions");
  assert.ok(ids.includes("vertical"));
  assert.ok(!ids.includes("highlight-60"), "doesn't suggest the edit just made");
  for (const s of steps) assert.equal(s.action.type === "prompt" || s.id === "export", true);
});

test("nextSteps: once captions + vertical are on, they're not suggested again", async () => {
  const { doc, tools } = await afterPrompt("video", "make it vertical with captions");
  const ids = nextSteps({ doc, mode: "video", lastTools: tools, hasAudio: false }).map((s) => s.id);
  assert.ok(!ids.includes("captions") && !ids.includes("karaoke"));
  assert.ok(!ids.includes("vertical") && !ids.includes("tiktok"));
});

test("nextSteps: after a text video → another theme, vertical, animation; music only with a song", async () => {
  const { doc, tools } = await afterPrompt("none", "make a neon text video: Tonight only. Doors at 9.");
  const ids = nextSteps({ doc, mode: "text", lastTools: tools, hasAudio: false, limit: 5 }).map((s) => s.id);
  assert.ok(!ids.includes("theme-neon"), "already neon");
  assert.ok(ids.includes("theme-elegant"));
  assert.ok(ids.includes("vertical"));
  assert.ok(ids.includes("letters-pop"));
  assert.ok(!ids.includes("music"));
});

test("nextSteps: without a song, music is never suggested; with one it is", async () => {
  const { doc, tools } = await afterPrompt("video", "give it a warm look");
  const without = nextSteps({ doc, mode: "video", lastTools: tools, hasAudio: false }).map((s) => s.id);
  const withSong = nextSteps({ doc, mode: "video", lastTools: tools, hasAudio: true }).map((s) => s.id);
  assert.ok(!without.includes("music"));
  assert.equal(withSong[0], "music");
  assert.ok(!without.some((id) => id.startsWith("look-")), "a look is already applied");
});

test("nextSteps: after 4K (or a well-polished doc) the last chip is Download", async () => {
  const { doc, tools } = await afterPrompt("video", "make it 4K");
  const steps = nextSteps({ doc, mode: "video", lastTools: tools, hasAudio: false });
  assert.deepEqual(steps.at(-1), EXPORT_STEP);
  // No edit yet → starters only, no Download.
  const fresh = nextSteps({ doc: combinedVideoDoc([VIDEO]), mode: "video", lastTools: [], hasAudio: false });
  assert.deepEqual(fresh.map((s) => s.id), ["highlight-60", "filler", "captions"]);
});

test("nextSteps: every suggested prompt actually runs in that context", async () => {
  for (const [mode, prompt] of [
    ["video", "cut a 60-second highlight"],
    ["video", "make it vertical"],
    ["video", "add captions"],
    ["images", "give it a warm look"],
    ["text", "letters pop in one by one"],
  ] as const) {
    const p = await project(mode);
    const r = await new StubDirector().interpret(prompt, p);
    p.setDoc(r.doc);
    for (const s of nextSteps({ doc: r.doc, mode, lastTools: r.toolCalls.map((c) => c.name), hasAudio: false, limit: 6 })) {
      if (s.action.type !== "prompt") continue;
      const next = await new StubDirector().interpret(s.action.prompt, new ProjectState({ media: p.media, doc: r.doc, transcripts: mode === "video" ? [await new StubTranscriber().transcribe(VIDEO)] : [] }));
      assert.ok(next.toolCalls.length > 0, `${mode} after "${prompt}": "${s.label}" did nothing`);
    }
  }
});

test("nextSteps: suggestion labels are safe for always-visible UI", () => {
  // See docs/agents/product-manager.md §4 — loose e2e lookups must stay unambiguous.
  const banned = /\b(send|start with text|cinematic look|kinetic title|words|speed|media|design|audio|deliver|tighten pauses|video clip|image clip)\b/i;
  for (const mode of MODES) {
    const doc = mode === "none" ? parseEditDoc({ version: 1 }) : parseEditDoc({ version: 1 });
    for (const s of nextSteps({ doc, mode, lastTools: [], hasAudio: true, limit: 10 })) {
      assert.ok(!/^(export|style|animate|background)/i.test(s.label), s.label);
      if (s.id !== "look-cinematic") assert.ok(!banned.test(s.label), s.label);
    }
  }
});

// ---- closest ideas ------------------------------------------------------------------

test("closestIdeas: everyday words map to real capabilities", () => {
  const ids = (q: string, mode: EditorMode = "video", hasAudio = false) => closestIdeas(q, { mode, hasAudio }).map((i) => i.id);
  assert.ok(ids("make it shorter").includes("highlight-60"));
  assert.ok(ids("cut out the boring parts").includes("highlight-60"));
  assert.ok(ids("put subtitles on it").includes("captions"));
  assert.ok(ids("make it moody like a movie").includes("look-cinematic"));
  assert.ok(ids("remove the background noise").includes("clean-audio"));
  assert.ok(ids("the footage is shaky").includes("stabilize"));
  assert.equal(ids("add a song", "video", true)[0], "music");
  // Unavailable ideas are never offered (no video → no captions).
  assert.ok(!ids("put subtitles on it", "none").includes("captions"));
  // No overlap at all → the mode's starters, so there's always something to tap.
  assert.deepEqual(ids("xyzzy plugh"), ["highlight-60", "filler", "captions"]);
  assert.deepEqual(ids("xyzzy", "none"), ["tv-announce", "tv-quote", "tv-list"]);
});

// ---- fuzzy + palette ranking --------------------------------------------------------

test("fuzzyScore: prefix > substring > subsequence; every token must match", () => {
  assert.ok(fuzzyScore("cap", "Add captions") > fuzzyScore("apt", "Add captions"));
  assert.ok(fuzzyScore("apt", "Add captions") > 0);
  assert.ok(fuzzyScore("cptns", "Add captions") > 0, "subsequence");
  assert.equal(fuzzyScore("captions zebra", "Add captions"), 0);
  assert.equal(fuzzyScore("", "anything"), 0);
  assert.ok(fuzzyScore("subtitles", "Add captions", ["subtitles"]) > 0, "keywords count");
  assert.ok(fuzzyScore("add", "Add captions") > fuzzyScore("add", "Please add captions"), "starts-with bonus");
});

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  doc: combinedVideoDoc([VIDEO]),
  mode: "video",
  hasContent: true,
  hasAudio: false,
  canUndo: true,
  canRedo: false,
  recents: ["make it warmer"],
  lastTools: [],
  ...over,
});

test("commands: catalogue covers rooms, project actions, recents and the library", () => {
  const all = buildCommands(ctx());
  const ids = new Set(all.map((c) => c.id));
  for (const id of ["ui:export", "ui:undo", "ui:redo", "ui:play", "ui:shortcuts", "ui:library", "room:design", "room:deliver", "idea:captions", "recent:0"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.equal(all.find((c) => c.id === "ui:redo")!.disabled, true, "nothing to redo");
  assert.equal(all.find((c) => c.id === "idea:theme-neon")!.disabled, true, "text-only idea is disabled for video");
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, "unique ids");
  const empty = buildCommands(ctx({ mode: "none", hasContent: false, canUndo: false, recents: [] }));
  assert.equal(empty.find((c) => c.id === "ui:export")!.disabled, true);
  assert.equal(empty.find((c) => c.id === "idea:tv-quote")!.disabled, false, "text videos work on an empty project");
});

test("rankCommands: empty query lists suggested first, hides disabled rows, no duplicates", () => {
  const ranked = rankCommands(buildCommands(ctx()), "");
  assert.equal(ranked[0]!.group, "Suggested");
  assert.ok(!ranked.some((c) => c.disabled), "only what you can do now");
  assert.equal(new Set(ranked.map((c) => JSON.stringify(c.action))).size, ranked.length, "each action once");
});

test("rankCommands: finds by title, synonym and typo-ish subsequence; Ask is always there", () => {
  const all = buildCommands(ctx());
  const top = (q: string) => rankCommands(all, q)[0]!;
  assert.equal(top("undo").id, "ui:undo");
  assert.equal(top("export").id, "ui:export");
  assert.equal(top("captions").id, "idea:captions");
  assert.ok(["idea:vertical", "idea:vertical-captions"].includes(top("vertical").id));
  assert.equal(top("make it vertical").id, "idea:vertical");
  assert.equal(top("design").id, "room:design");
  assert.equal(top("download").id, "ui:export", "keyword synonym");
  assert.equal(top("subtitles").id, "idea:captions", "keyword synonym");
  assert.ok(rankCommands(all, "cinmatic").some((c) => c.id === "idea:look-cinematic"), "subsequence");
  // Free text that matches nothing → Ask the Director first.
  const odd = rankCommands(all, "make the sky purple and dramatic");
  assert.equal(odd[0]!.id, "ask");
  assert.deepEqual(odd[0]!.action, { type: "prompt", prompt: "make the sky purple and dramatic" });
  // A strong match keeps Ask at the end.
  assert.equal(rankCommands(all, "undo").at(-1)!.id, "ask");
  // Enabled beats disabled.
  const neon = rankCommands(all, "neon");
  const firstEnabled = neon.findIndex((c) => !c.disabled);
  const firstDisabled = neon.findIndex((c) => c.disabled);
  assert.ok(firstEnabled < firstDisabled);
});

// ---- onboarding ---------------------------------------------------------------------

test("onboarding: steps tick from real signals; edit/preview need content", () => {
  const none = onboardingSteps({ hasContent: false, edited: true, previewed: true, exported: false });
  assert.deepEqual(none.map((s) => s.done), [false, false, false, false]);
  assert.equal(onboardingProgress(none).next!.id, "content");
  const mid = onboardingSteps({ hasContent: true, edited: true, previewed: false, exported: false });
  const p = onboardingProgress(mid);
  assert.equal(p.done, 2);
  assert.equal(p.total, 4);
  assert.equal(p.next!.id, "preview");
  const all = onboardingProgress(onboardingSteps({ hasContent: true, edited: true, previewed: true, exported: true }));
  assert.equal(all.done, 4);
  assert.equal(all.next, null);
});

// ---- recent prompts -----------------------------------------------------------------

test("pushRecent: newest first, trimmed, case-insensitive de-dupe, capped", () => {
  let l: string[] = [];
  l = pushRecent(l, "  add captions ");
  l = pushRecent(l, "make it warm");
  l = pushRecent(l, "ADD CAPTIONS");
  assert.deepEqual(l, ["ADD CAPTIONS", "make it warm"]);
  assert.deepEqual(pushRecent(l, "   "), l, "blank is ignored");
  const many = Array.from({ length: 30 }, (_, i) => `p${i}`).reduce<string[]>((acc, p) => pushRecent(acc, p), []);
  assert.equal(many.length, 20);
  assert.equal(many[0], "p29");
});

test("recallRecent: ↑ walks back, ↓ returns to the draft, stops at the oldest", () => {
  const l = ["newest", "middle", "oldest"];
  let s = recallRecent(l, null, "older");
  assert.deepEqual(s, { index: 0, text: "newest" });
  s = recallRecent(l, s.index, "older");
  s = recallRecent(l, s.index, "older");
  assert.deepEqual(s, { index: 2, text: "oldest" });
  assert.deepEqual(recallRecent(l, s.index, "older"), { index: 2, text: "oldest" });
  s = recallRecent(l, 2, "newer");
  assert.deepEqual(s, { index: 1, text: "middle" });
  assert.deepEqual(recallRecent(l, 0, "newer"), { index: null, text: null });
  assert.deepEqual(recallRecent([], null, "older"), { index: null, text: null });
});
