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
  parseEditDoc,
  type EditDoc,
  type MediaAsset,
} from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";
import { StubTranscriber } from "@cadence/understanding";
import { ProjectState, StubDirector, runDirectorLoop } from "@cadence/director";

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

/**
 * An ALREADY-BUILT video: one long clip on the timeline (the "finished render
 * uploaded as a single file" case), optionally with browser-detected scene cuts.
 */
async function builtVideoProject(sceneCuts?: number[]): Promise<ProjectState> {
  const project = await videoProject(120);
  const media = project.media[0]!;
  project.setDoc(
    parseEditDoc({
      version: 1,
      meta: { title: "built", width: 1920, height: 1080, fps: 30 },
      media: [media],
      tracks: [
        {
          id: "video",
          kind: "visual",
          clips: [{ id: "src", kind: "video", start: 0, duration: 120, mediaId: media.id, sourceIn: 0, transform: { x: 960, y: 540 } }],
        },
      ],
    }),
  );
  if (sceneCuts) project.setSceneCuts(media.id, sceneCuts);
  return project;
}

const videoClipsOf = (doc: EditDoc) => doc.tracks.flatMap((t) => t.clips).filter((c) => c.kind === "video");

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

  // (g) EMOJI — a color-emoji sticker placed by words (no media).
  {
    id: "g",
    capability: "emoji · sticker by name + position",
    prompt: "add a fire emoji at the top right",
    setup: async () => new ProjectState({ media: [] }),
    expectTools: ["add_emoji"],
    extra: (doc) => {
      const c = doc.tracks.flatMap((t) => t.clips).find((x) => x.kind === "text" && x.text === "🔥");
      assert(c && c.kind === "text", "expected a 🔥 emoji clip");
      assert(c.transform.x > doc.meta.width / 2 && c.transform.y < doc.meta.height / 2, "expected the top-right quadrant");
      assert(c.anim.style === "pop", "expected a pop-in intro");
    },
    proof: "eval-g-emoji-sticker.png",
  },

  // (h) EMOJI — an animated reaction pack.
  {
    id: "h",
    capability: "emoji · confetti / party reaction pack",
    prompt: "add confetti",
    setup: async () => new ProjectState({ media: [] }),
    expectTools: ["add_reaction"],
    extra: (doc) => {
      const pieces = doc.tracks.flatMap((t) => t.clips).filter((x) => x.kind === "text" && /^emo-\d+-party-\d+$/.test(x.id));
      assert(pieces.length >= 10, `expected a party pack of 10+ emoji, got ${pieces.length}`);
      assert(new Set(pieces.map((x) => (x.kind === "text" ? x.text : ""))).size >= 3, "expected a mix of party emoji");
    },
    proof: "eval-h-emoji-confetti.png",
  },

  // (i) EMOJI, TRANSCRIPT-TIMED — hearts pop every time a word is said.
  {
    id: "i",
    capability: "emoji · reaction timed to a spoken word",
    prompt: "pop hearts when I say love",
    setup: async () => {
      const project = await videoProject(60);
      project.setDoc({
        version: 1,
        meta: { width: 1280, height: 720 },
        media: [{ id: "clip-001", kind: "video", src: "uploads/clip-001.mp4", durationSec: 60 }],
        tracks: [{ id: "video", kind: "visual", clips: [{ id: "v1", kind: "video", start: 0, duration: 30, mediaId: "clip-001", sourceIn: 0 }] }],
      });
      project.setTranscript({
        mediaId: "clip-001",
        durationSec: 60,
        language: "en",
        segments: [],
        words: [
          { text: "We", start: 1, end: 1.2 },
          { text: "love", start: 4, end: 4.4 },
          { text: "this", start: 4.5, end: 4.8 },
          { text: "Love!", start: 12, end: 12.5 },
        ],
      });
      return project;
    },
    expectTools: ["add_reaction"],
    extra: (doc) => {
      const starts = doc.tracks.flatMap((t) => t.clips).filter((x) => x.kind === "text" && x.id.startsWith("emo-")).map((x) => x.start);
      assert(starts.some((t) => Math.abs(t - 4) < 0.2) && starts.some((t) => Math.abs(t - 12) < 0.2), "expected the pack at 4s and 12s (when “love” is said)");
      assert(!doc.tracks.some((t) => t.id.startsWith("graphics-")), "must not also add the heart sticker graphic");
    },
    proof: "eval-i-emoji-when-said.png",
  },

  // (g) ALREADY-BUILT VIDEO — divide a finished render into its scenes.
  {
    id: "j",
    capability: "built video · divide into scenes (browser-detected cuts)",
    prompt: "split this video into scenes",
    setup: () => builtVideoProject([14.2, 33.5, 61, 88.4]),
    expectTools: ["split_into_scenes"],
    extra: (doc) => {
      const clips = videoClipsOf(doc).sort((a, b) => a.start - b.start);
      assert(clips.length === 5, `expected 5 scene clips, got ${clips.length}`);
      assert(clips.every((c, i) => c.label === `Scene ${i + 1}`), "scene clips should be labelled Scene 1…5");
      assert(Math.abs(docDurationSec(doc) - 120) < 0.01, "dividing must not change the total length");
      assert(clips[2]!.kind === "video" && Math.abs(clips[2]!.sourceIn - 33.5) < 0.01, "third clip should start at source 33.5s");
    },
    proof: "eval-g-scenes.png",
  },

  // (h) ALREADY-BUILT VIDEO — a fixed cadence, no analysis needed.
  {
    id: "k",
    capability: "built video · chop every N seconds",
    prompt: "chop every 30 seconds",
    setup: () => builtVideoProject(),
    expectTools: ["split_into_scenes"],
    extra: (doc) => {
      const clips = videoClipsOf(doc);
      assert(clips.length === 4, `expected 4 clips of 30s, got ${clips.length}`);
      assert(clips.every((c) => Math.abs(c.duration - 30) < 0.01), "every clip should be 30s");
      assert(!doc.tracks.some((t) => t.id === "titles"), "the interval phrase must not also build a highlight");
    },
    proof: "eval-h-interval.png",
  },

  // (i) ALREADY-BUILT VIDEO — one clip per spoken sentence (transcript-driven).
  {
    id: "l",
    capability: "built video · split by sentence (transcript)",
    prompt: "split by sentence",
    setup: () => builtVideoProject(),
    expectTools: ["split_into_scenes"],
    extra: (doc) => {
      const clips = videoClipsOf(doc);
      assert(clips.length > 3, `expected several sentence clips, got ${clips.length}`);
      assert(clips.every((c) => !!c.label), "sentence clips should be labelled with their opening words");
      assert(Math.abs(docDurationSec(doc) - 120) < 0.01, "dividing must not change the total length");
    },
    proof: "eval-i-sentences.png",
  },
];

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
