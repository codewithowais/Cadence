/**
 * EVALS — the agentic loop under real prompts (AGENTS.md, Ask 4).
 *
 * Five plain-language prompts exercise different capabilities. Each one:
 *   1. builds a suitable ProjectState (stub transcript for video, image assets
 *      for the slideshow),
 *   2. runs `runDirectorLoop` with the concrete CanvasRenderEngine injected
 *      (the loop itself stays engine-agnostic — it only knows the RenderEngine
 *      interface from @cadence/core),
 *   3. asserts: `verified === true`, the expected Director tool(s) were called,
 *      and a real (non-empty PNG) frame rendered — proof frames written to
 *      `.cadence/`.
 *
 * `npm run evals` runs all five and exits non-zero if any fails. The verify gate
 * (`npm run verify`) covers the loop on at least one prompt too.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  docDurationSec,
  type EditDoc,
  type MediaAsset,
} from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";
import { StubTranscriber } from "@cadence/understanding";
import { ProjectState, StubDirector, runDirectorLoop, storyboardOf, type Storyboard } from "@cadence/director";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", ".cadence");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const engine = new CanvasRenderEngine();

class EvalError extends Error {}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new EvalError(msg);
}

/** A source video project with a deterministic stub transcript loaded. */
async function videoProject(durationSec = 180): Promise<ProjectState> {
  const media: MediaAsset = {
    id: "clip-001",
    kind: "video",
    src: "uploads/clip-001.mp4",
    durationSec,
    width: 1920,
    height: 1080,
    label: "raw-podcast.mp4",
  };
  const project = new ProjectState({ media: [media] });
  project.setTranscript(await new StubTranscriber().transcribe(media));
  return project;
}

/** A project of `n` photos (for the slideshow eval). */
function photoProject(n = 6): ProjectState {
  const media: MediaAsset[] = Array.from({ length: n }, (_, i) => ({
    id: `photo-${i}`,
    kind: "image" as const,
    src: `photos/p${i}.jpg`,
    width: 1920,
    height: 1080,
    label: `p${i}.jpg`,
  }));
  return new ProjectState({ media });
}

/** Render a proof frame at mid-duration and write it to .cadence/. */
async function writeProof(doc: EditDoc, name: string): Promise<number> {
  const t = docDurationSec(doc) / 2;
  const frame = await engine.renderFrame(doc, t);
  const bytes = Buffer.from(frame.data);
  assert(bytes.subarray(0, 4).equals(PNG_MAGIC), `${name}: proof frame is not a PNG`);
  assert(bytes.length > 100, `${name}: proof frame too small (${bytes.length}b)`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, name), bytes);
  return bytes.length;
}

interface Eval {
  id: string;
  capability: string;
  prompt: string;
  /** Build the ProjectState the prompt runs against (may pre-seed a timeline). */
  setup(): Promise<ProjectState>;
  /** Tool names the loop's result MUST include. */
  expectTools: string[];
  /** Extra, capability-specific assertions on the verified doc. */
  extra?(doc: EditDoc): void;
  proof: string;
}

const EVALS: Eval[] = [
  // (a) VIDEO — a single-tool highlight cut.
  {
    id: "a",
    capability: "video · highlight cut",
    prompt: "cut a 45-second highlight",
    setup: () => videoProject(),
    expectTools: ["create_highlight"],
    extra: (doc) => {
      const dur = docDurationSec(doc);
      assert(dur >= 38 && dur <= 60, `highlight should be ~45s, got ${Math.round(dur)}s`);
    },
    proof: "eval-a-highlight.png",
  },

  // (b) VIDEO, CHAINED — reframe vertical + captions + a cinematic look on an
  // existing highlight.
  {
    id: "b",
    capability: "video · reframe + captions + look (chained)",
    prompt: "make it vertical with captions and a cinematic look",
    setup: async () => {
      const project = await videoProject();
      // Pre-seed a timeline to transform (the chained workflow).
      await new StubDirector().interpret("cut a 40 second highlight", project);
      return project;
    },
    expectTools: ["reframe", "add_captions", "apply_look"],
    extra: (doc) => {
      assert(doc.meta.width === 1080 && doc.meta.height === 1920, `expected 1080x1920, got ${doc.meta.width}x${doc.meta.height}`);
      const caps = doc.tracks.find((t) => t.id === "captions");
      assert((caps?.clips.length ?? 0) > 0, "expected caption clips");
      const vid = doc.tracks.flatMap((t) => t.clips).find((c) => c.kind === "video");
      assert(vid && vid.kind === "video" && vid.look.warmth > 0, "cinematic look not applied");
    },
    proof: "eval-b-vertical-captions.png",
  },

  // (c) VIDEO, CHAINED — a kinetic title + punch-in emphasis + fades.
  {
    id: "c",
    capability: "video · kinetic title + punch-in + fades (chained)",
    prompt: 'add a kinetic title that says "Hello", punch in at 2s, fade in and out',
    setup: async () => {
      const project = await videoProject();
      await new StubDirector().interpret("cut a 30 second highlight", project);
      return project;
    },
    expectTools: ["add_kinetic_title", "add_emphasis", "add_fades"],
    extra: (doc) => {
      const kt = doc.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.kind === "text" && c.anim.style === "kinetic");
      assert(kt && kt.kind === "text" && kt.text === "Hello", "expected a kinetic title reading “Hello”");
      const emph = doc.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.kind === "video" && !!c.emphasis && c.emphasis.zoom > 1);
      assert(emph, "expected a punch-in emphasis on the video");
      assert(doc.tracks.some((t) => t.id === "fades" && t.clips.length > 0), "expected fade solids");
    },
    proof: "eval-c-kinetic-punch-fade.png",
  },

  // (d) IMAGES — a slideshow from photos with a warm look.
  {
    id: "d",
    capability: "images · slideshow",
    prompt: "make a slideshow from my photos with a warm look",
    setup: async () => photoProject(6),
    expectTools: ["make_slideshow"],
    extra: (doc) => {
      const photos = doc.tracks.find((t) => t.id === "photos");
      assert((photos?.clips.length ?? 0) === 6, "expected 6 photo clips");
      assert(photos!.clips.some((c) => c.kind === "image" && c.look.warmth > 0), "expected warm look on photos");
      assert(photos!.clips.some((c) => c.kind === "image" && c.transitionInSec > 0), "expected crossfades");
    },
    proof: "eval-d-slideshow.png",
  },

  // (e) VIDEO, CHAINED — filler cut then a 4K quality bump.
  {
    id: "e",
    capability: "video · filler cut + 4K (chained)",
    prompt: "remove filler words then make it 4K",
    setup: () => videoProject(),
    expectTools: ["filler_cut", "set_quality"],
    extra: (doc) => {
      assert(doc.quality.preset === "ultra", `expected ultra quality, got ${doc.quality.preset}`);
      assert((doc.quality.targetWidth ?? 0) >= 2160, "expected an upscaled 4K target width");
      assert(docDurationSec(doc) > 0, "filler cut produced an empty timeline");
    },
    proof: "eval-e-filler-4k.png",
  },

  // (f) TEXT ONLY — a whole video from words, no media at all (Canva-style).
  {
    id: "f",
    capability: "text only · script → text video (no media)",
    prompt: "make a vertical neon text video: Stay weird. Stay loud. Stay you.",
    setup: async () => new ProjectState({ media: [] }),
    expectTools: ["make_text_video"],
    extra: (doc) => {
      assert(doc.textVideo?.theme === "neon", `expected the neon theme, got ${doc.textVideo?.theme}`);
      assert(doc.meta.width === 1080 && doc.meta.height === 1920, "expected a vertical 1080×1920 frame");
      const texts = doc.tracks.flatMap((t) => t.clips).filter((c) => c.kind === "text");
      assert(texts.length === 3, `expected 3 text scenes, got ${texts.length}`);
      assert(doc.media.length === 0, "a text video needs no media");
    },
    proof: "eval-f-text-video.png",
  },

  // ---- PROMPT → VIDEO (one sentence → storyboard → complete editable video) ----------------
  promptEval({
    id: "g",
    capability: "prompt→video · promo (genre, palette, graphics, music)",
    prompt: "30s Instagram promo for my coffee shop, warm vibe, upbeat music",
    proof: "eval-g-prompt-promo.png",
    check: (doc, sb) => {
      assert(sb.genre === "promo" && sb.platform === "instagram", `genre/platform: ${sb.genre}/${sb.platform}`);
      assert(doc.meta.width === 1080 && doc.meta.height === 1920, "Instagram promo should be 9:16");
      const d = docDurationSec(doc);
      assert(d >= 24 && d <= 38, `~30s expected, got ${d.toFixed(1)}s`);
      assert(doc.tracks.some((t) => t.id === "music" && t.clips.length > 0), "expected a generated music bed");
      assert(doc.tracks.some((t) => /^graphics-/.test(t.id)), "expected a CTA graphic (link-in-bio)");
      assert(sb.palette.name === "coffee", `warm coffee palette expected, got ${sb.palette.name}`);
      assert(/coffee|cup|brew|latte/i.test(sb.scenes.map((s) => `${s.heading} ${s.body ?? ""}`).join(" ")), "copy should mention the coffee shop's world");
    },
  }),
  promptEval({
    id: "h",
    capability: "prompt→video · birthday greeting with the person's name",
    prompt: "birthday wish for Ayesha",
    proof: "eval-h-prompt-birthday.png",
    check: (doc, sb) => {
      assert(sb.genre === "greeting", `genre ${sb.genre}`);
      const texts = doc.tracks.flatMap((t) => t.clips).filter((c) => c.kind === "text").map((c) => (c.kind === "text" ? c.text : ""));
      assert(texts.some((t) => /Happy Birthday, Ayesha/.test(t)), "expected “Happy Birthday, Ayesha!”");
    },
  }),
  promptEval({
    id: "i",
    capability: "prompt→video · explainer with real steps",
    prompt: "explain how photosynthesis works in 45s",
    proof: "eval-i-prompt-explainer.png",
    check: (doc, sb) => {
      assert(sb.genre === "explainer" && doc.meta.width === 1920, "explainer should be 16:9");
      const d = docDurationSec(doc);
      assert(d >= 38 && d <= 52, `~45s expected, got ${d.toFixed(1)}s`);
      assert(sb.scenes.some((s) => /chlorophyll/i.test(s.body ?? "")), "expected the real photosynthesis steps");
    },
  }),
  promptEval({
    id: "j",
    capability: "prompt→video · travel recap using uploaded photos",
    prompt: "travel recap of Istanbul using my photos",
    photos: 6,
    proof: "eval-j-prompt-travel-photos.png",
    check: (doc, sb) => {
      assert(sb.genre === "travel", `genre ${sb.genre}`);
      const media = doc.tracks.find((t) => t.id === "tv-media");
      assert((media?.clips.length ?? 0) >= 6, `expected a photo behind each scene, got ${media?.clips.length}`);
      assert(doc.media.filter((m) => m.kind === "image").length === 6, "all 6 photos must be in the doc");
      assert(media!.clips.every((c) => c.kind === "image" && c.look.brightness < 0.8), "photos are dimmed through their grade so the words stay legible");
    },
  }),
  promptEval({
    id: "k",
    capability: "prompt→video · tips list (numbered items)",
    prompt: "5 tips for better sleep",
    proof: "eval-k-prompt-tips.png",
    check: (doc, sb) => {
      assert(sb.genre === "tutorial", `genre ${sb.genre}`);
      assert(sb.scenes.filter((s) => s.kind === "item").length === 5, "expected five numbered tip scenes");
      assert(doc.textVideo?.format === "list", "tips should use the list format");
    },
  }),
  promptEval({
    id: "l",
    capability: "prompt→video · event invite with date + venue parsed from the sentence",
    prompt: "invite to my daughter's birthday party this Saturday at 6pm at Gulberg Club",
    proof: "eval-l-prompt-invite.png",
    check: (_doc, sb) => {
      assert(sb.genre === "invite", `genre ${sb.genre}`);
      const t = sb.scenes.map((s) => `${s.heading} ${s.body ?? ""}`).join(" | ");
      assert(/Gulberg Club/.test(t) && /Saturday/.test(t), `details missing: ${t}`);
    },
  }),
  promptEval({
    id: "m",
    capability: "prompt→video · product launch, cinematic mood",
    prompt: "product launch video for Nimbus, a budgeting app, cinematic, 20s",
    proof: "eval-m-prompt-launch.png",
    check: (doc, sb) => {
      assert(sb.genre === "launch" && sb.mood === "cinematic", `${sb.genre}/${sb.mood}`);
      assert(sb.music.mood === "cinematic", `music ${sb.music.mood}`);
      assert(docDurationSec(doc) >= 16 && docDurationSec(doc) <= 26, `~20s, got ${docDurationSec(doc)}`);
      assert(sb.scenes.some((s) => /Nimbus/.test(s.heading)), "expected “Meet/Introducing Nimbus”");
    },
  }),
  promptEval({
    id: "n",
    capability: "prompt→video · Spanish greeting (language pack)",
    prompt: "Spanish birthday wish for Carlos",
    proof: "eval-n-prompt-spanish.png",
    check: (_doc, sb) => {
      assert(sb.language === "es", `language ${sb.language}`);
      assert(sb.scenes.some((s) => /Feliz cumpleaños, Carlos/.test(s.heading)), "expected “¡Feliz cumpleaños, Carlos!”");
    },
  }),
  promptEval({
    id: "o",
    capability: "prompt→video · quote with attribution kept verbatim",
    prompt: 'motivational quote video about discipline: “Discipline is the bridge between goals and results.” — Jim Rohn',
    proof: "eval-o-prompt-quote.png",
    check: (doc) => {
      const texts = doc.tracks.flatMap((t) => t.clips).filter((c) => c.kind === "text").map((c) => (c.kind === "text" ? c.text : ""));
      assert(texts.some((t) => /bridge between goals and results/.test(t)), "the user's own words must stay verbatim");
    },
    // The user supplied the words, so this stays a text video — assert the routing, not the planner.
    expectTools: ["make_text_video"],
    requireStoryboard: false,
  }),
  promptEval({
    id: "p",
    capability: "prompt→video · refine: make it punchier (chained, edits kept)",
    prompt: "make it punchier",
    setupPrompt: "30s promo for my bakery",
    proof: "eval-p-prompt-punchier.png",
    expectTools: ["refine_video"],
    check: (doc, sb) => {
      assert(sb.pace === "fast", `pace ${sb.pace}`);
      assert(docDurationSec(doc) < 30, `punchier should be tighter than 30s, got ${docDurationSec(doc)}`);
    },
  }),
  promptEval({
    id: "q",
    capability: "prompt→video · voice-over request degrades gracefully (money gate)",
    prompt: "20s promo for my gym with a voice-over",
    proof: "eval-q-prompt-voiceover-gated.png",
    check: (doc, sb) => {
      assert(sb.voiceover === true, "voice-over was requested");
      assert(!doc.tracks.some((t) => t.id === "voiceover"), "no TTS provider ⇒ no voice-over track (gate holds)");
      assert(docDurationSec(doc) > 10, "the rest of the video must still be built");
    },
  }),
];

/** An eval for a one-sentence video prompt (see packages/director/src/prompt-video.ts). */
function promptEval(o: {
  id: string;
  capability: string;
  prompt: string;
  proof: string;
  photos?: number;
  setupPrompt?: string;
  expectTools?: string[];
  requireStoryboard?: boolean;
  check: (doc: EditDoc, sb: Storyboard) => void;
}): Eval {
  return {
    id: o.id,
    capability: o.capability,
    prompt: o.prompt,
    setup: async () => {
      const project = o.photos ? photoProject(o.photos) : new ProjectState({ media: [] });
      if (o.setupPrompt) await new StubDirector().interpret(o.setupPrompt, project);
      return project;
    },
    expectTools: o.expectTools ?? ["make_video_from_prompt"],
    extra: (doc) => {
      const sb = storyboardOf(doc);
      if (o.requireStoryboard === false) {
        o.check(doc, sb as Storyboard);
        return;
      }
      assert(sb, "the storyboard must ride along on the doc (doc.textVideo.storyboard)");
      o.check(doc, sb);
    },
    proof: o.proof,
  };
}

interface EvalOutcome {
  id: string;
  capability: string;
  prompt: string;
  ok: boolean;
  detail: string;
}

async function runEval(ev: Eval): Promise<EvalOutcome> {
  try {
    const project = await ev.setup();
    // Probe t=0 AND mid-duration; correct up to 3 attempts before falling back.
    const loop = await runDirectorLoop(ev.prompt, project, { engine, maxAttempts: 3 });

    assert(loop.verified, `loop did not verify (corrections: ${loop.corrections.join("; ") || "none"})`);

    const names = loop.result.toolCalls.map((c) => c.name);
    for (const want of ev.expectTools) {
      assert(names.includes(want), `expected tool "${want}" to be called (got: ${names.join(", ") || "none"})`);
    }

    ev.extra?.(loop.result.doc);
    const bytes = await writeProof(loop.result.doc, ev.proof);

    return {
      id: ev.id,
      capability: ev.capability,
      prompt: ev.prompt,
      ok: true,
      detail: `tools[${names.join(", ")}] · ${Math.round(docDurationSec(loop.result.doc))}s · ${ev.proof} ${bytes}b · attempts=${loop.attempts}`,
    };
  } catch (err) {
    return {
      id: ev.id,
      capability: ev.capability,
      prompt: ev.prompt,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  console.log("running director-loop evals (plan→act→verify→correct)…\n");
  const outcomes: EvalOutcome[] = [];
  for (const ev of EVALS) {
    const o = await runEval(ev);
    outcomes.push(o);
    const mark = o.ok ? "\x1b[32m✔ PASS\x1b[0m" : "\x1b[31m✖ FAIL\x1b[0m";
    console.log(`  ${mark}  (${o.id}) ${o.capability}`);
    console.log(`         "${o.prompt}"`);
    console.log(`         ${o.detail}\n`);
  }

  const passed = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - passed;
  if (failed > 0) {
    console.error(`\x1b[31m✖ EVALS FAILED\x1b[0m — ${passed}/${outcomes.length} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`\x1b[32m✔ EVALS PASSED\x1b[0m — ${passed}/${outcomes.length} prompts verified; proof frames in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(`\x1b[31m✖ EVALS CRASHED:\x1b[0m ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
