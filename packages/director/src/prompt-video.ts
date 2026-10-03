/**
 * PROMPT → VIDEO. Realises a Storyboard into a complete, editable EditDoc.
 *
 * The scenes become a text video (`buildTextVideo`: the same engine as `make_text_video`,
 * so every scene stays editable in the Text room), re-dressed with the storyboard's palette
 * and transitions, with any uploaded photos/clips shown behind the copy; then the existing
 * Director tools finish the job — `add_graphic` (CTAs, badges, stickers), `generate_music`
 * (mood picked from the storyboard), `auto_sfx`, and — only when a TTS provider is
 * configured (money-gated, graceful off) — `generate_voiceover` + `auto_duck`.
 *
 * Tools are imported lazily inside the functions so this module can be re-exported from the
 * barrel and registered in DIRECTOR_TOOLS without an import cycle.
 */
import { docDurationSec, parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import { z } from "zod";
import type { ProjectState } from "./project";
import { emptyDoc } from "./project";
import type { DirectorTool, ToolCall } from "./tools";
import { LOOK_PRESETS } from "./edits";
import { isSynthSrc } from "./sound-synth";
import { buildTextVideo, TEXT_VIDEO_ASPECTS, textVideoScenes, type TextScene, type TextVideoFormat } from "./textvideo";
import {
  GENRES,
  GENRE_LABELS,
  LANGUAGES,
  MOODS,
  PLATFORMS,
  STORYBOARD_ASPECTS,
  Storyboard,
  parseStoryboard,
  selectStoryboardPlanner,
  storyboardDuration,
  type PlanOverrides,
} from "./storyboard";
import { StubStoryboardPlanner } from "./storyboard-stub";
import { addMusic } from "./edits";
import { addGraphicTool } from "./graphics-tools";

const round = (n: number): number => Math.round(n * 1000) / 1000;

const FORMAT_FOR: Record<Storyboard["genre"], TextVideoFormat> = {
  promo: "story",
  explainer: "story",
  greeting: "story",
  travel: "story",
  tutorial: "list",
  announcement: "announcement",
  quote: "quote",
  invite: "announcement",
  launch: "announcement",
  testimonial: "quote",
  intro: "announcement",
  slideshow: "story",
};

const KEN_BURNS = [
  { zoom: 1.14, panX: 0.05, panY: 0 },
  { zoom: 1.12, panX: -0.05, panY: 0.03 },
  { zoom: 1.16, panX: 0, panY: -0.05 },
  { zoom: 1.1, panX: 0.04, panY: 0.04 },
];

/** A storyboard scene as the text-video engine's scene. */
export function toTextScenes(sb: Storyboard): TextScene[] {
  return sb.scenes.map((s) => ({
    // Big title/CTA type + a sub-line wraps taller than the engine's line estimate for long
    // headings, so those drop to the body size (hooks and short CTAs keep the big type).
    kind: (s.kind === "title" || s.kind === "cta") && s.body && s.heading.length > 16 ? "body" : s.kind,
    head: s.heading,
    ...(s.body ? { sub: s.body } : {}),
    ...(s.num ? { num: s.num } : {}),
    durationSec: s.durationSec,
  }));
}

/** Text → palette text colour with an alpha suffix (keeps #RRGGBB valid). */
const withAlpha = (hex: string, aa: string): string => (/^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${aa}` : hex);

export interface RealiseResult {
  doc: EditDoc;
  /** Human-readable steps that ran. */
  steps: string[];
  /** Things that were skipped / gated (never fatal). */
  warnings: string[];
  /** The Director tools the finishing pass called. */
  calls: ToolCall[];
}

/** Build the visual document for a storyboard (pure, synchronous; no audio, no graphics). */
export function buildStoryboardVisuals(sb: Storyboard, media: MediaAsset[], base: EditDoc = emptyDoc()): EditDoc {
  const size = TEXT_VIDEO_ASPECTS[sb.aspect];
  let doc = buildTextVideo(base, {
    scenes: toTextScenes(sb),
    theme: sb.theme,
    format: FORMAT_FOR[sb.genre],
    size,
    pace: sb.pace,
  });

  const clone: EditDoc = structuredClone(doc);
  const W = clone.meta.width;
  const H = clone.meta.height;
  clone.meta.title = sb.title;
  clone.meta.background = sb.palette.colors[0]!;
  const byId = new Map<string, EditDoc["tracks"][number]["clips"][number]>();
  for (const t of clone.tracks) for (const c of t.clips) byId.set(c.id, c);

  const ROLE = /^tv-s(\d+)-(title|body|item|quote|cta|sub|num|acc)$/;
  for (const t of clone.tracks) {
    for (const c of t.clips) {
      const m = c.id.match(ROLE);
      if (!m) continue;
      if (c.kind === "text") {
        const role = m[2];
        c.color = role === "sub" ? withAlpha(sb.palette.text, "d9") : role === "num" ? withAlpha(sb.palette.accent, "66") : sb.palette.text;
      } else if (c.kind === "shape") {
        c.fill = sb.palette.accent;
      }
    }
  }

  // Backgrounds: the storyboard's per-scene gradient, pattern and transition.
  const used: MediaAsset[] = [];
  const mediaClips: unknown[] = [];
  const scrimClips: unknown[] = [];
  sb.scenes.forEach((scene, i) => {
    const bg = byId.get(`tv-s${i}-bg`);
    if (!bg || bg.kind !== "solid") return;
    const b = scene.background;
    if (b) {
      bg.color = b.colors[0]!;
      bg.gradient = { kind: "linear", angle: b.angle, stops: b.colors, motion: b.motion, speed: 1 };
      bg.pattern = b.pattern ? { kind: b.pattern, color: sb.palette.text, opacity: 0.07, scale: 1 } : undefined;
    }
    if (i > 0 && scene.transition) bg.transitionType = scene.transition;

    const asset = scene.mediaId ? media.find((m) => m.id === scene.mediaId && (m.kind === "image" || m.kind === "video")) : undefined;
    if (!asset) return;
    if (!used.some((u) => u.id === asset.id)) used.push(asset);
    const look = sb.look ? LOOK_PRESETS[sb.look] : undefined;
    const lookObj = look ? { brightness: look.brightness, contrast: look.contrast, saturation: look.saturation, warmth: look.warmth } : undefined;
    const common = {
      start: bg.start,
      duration: bg.kind === "solid" ? bg.duration : scene.durationSec,
      transform: { x: W / 2, y: H / 2 },
      transitionInSec: bg.transitionInSec,
      transitionType: bg.transitionType,
      ...(lookObj ? { look: lookObj } : {}),
    };
    if (asset.kind === "image") {
      mediaClips.push({ ...common, id: `pv-m${i}`, kind: "image", mediaId: asset.id, motion: KEN_BURNS[i % KEN_BURNS.length] });
    } else {
      mediaClips.push({ ...common, id: `pv-m${i}`, kind: "video", mediaId: asset.id, sourceIn: 0, speed: 1, volume: 0, duration: round(Math.min(common.duration, asset.durationSec ?? common.duration)) });
    }
    scrimClips.push({
      id: `pv-scrim${i}`,
      kind: "shape",
      shape: "rect",
      start: bg.start,
      duration: common.duration,
      w: W,
      h: H,
      fill: "#000000",
      fillOpacity: 0.42,
      transform: { x: W / 2, y: H / 2 },
      transitionInSec: bg.transitionInSec,
    });
  });

  if (mediaClips.length) {
    const bgIdx = clone.tracks.findIndex((t) => t.id === "tv-bg");
    (clone.tracks as unknown[]).splice(
      bgIdx + 1,
      0,
      { id: "tv-media", kind: "visual", name: "Your media", clips: mediaClips },
      { id: "tv-scrim", kind: "visual", name: "Legibility scrim", clips: scrimClips },
    );
    for (const u of used) if (!clone.media.some((m) => m.id === u.id)) clone.media.push(u);
  }
  doc = parseEditDoc(clone);
  return doc;
}

/**
 * Realise a Storyboard on a project: replaces the timeline with the video, then runs the
 * existing audio / graphics tools. Returns the new doc and what happened; the caller
 * (the Director tool, or the studio UI) commits it.
 */
export async function realiseStoryboard(project: ProjectState, sb: Storyboard): Promise<RealiseResult> {
  const steps: string[] = [];
  const warnings: string[] = [];
  const calls: ToolCall[] = [];

  const T = await import("./tools");
  const visuals = buildStoryboardVisuals(sb, project.media, emptyDoc());
  project.setDoc(visuals);
  steps.push(`${sb.scenes.length} scenes, ${sb.aspect}, ${sb.theme} theme`);

  const run = async <I>(tool: DirectorTool<I>, input: I): Promise<boolean> => {
    try {
      await tool.execute(input, { project });
      calls.push({ name: tool.name, input });
      return true;
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : `${tool.name} couldn't run.`);
      return false;
    }
  };

  // Graphics: CTAs, badges, stickers — timed to their scene.
  let starts: number[] = [];
  {
    let t = 0;
    starts = sb.scenes.map((s) => {
      const at = t;
      t += s.durationSec;
      return at;
    });
  }
  for (let i = 0; i < sb.scenes.length; i++) {
    const g = sb.scenes[i]!.graphic;
    if (!g) continue;
    const ok = await run(addGraphicTool, {
      preset: g.preset,
      ...(g.text ? { text: g.text } : {}),
      ...(g.subtext ? { subtext: g.subtext } : {}),
      ...(g.position ? { position: g.position } : {}),
      ...(g.scale ? { scale: g.scale } : {}),
      accent: sb.palette.accent,
      atSec: round(starts[i]! + 0.45),
      durationSec: Math.max(1, round(sb.scenes[i]!.durationSec - 0.7)),
    });
    if (ok) steps.push(`${g.preset} graphic`);
  }

  // Voice-over: only with a configured TTS provider; otherwise say so, never fail.
  let hasVoice = false;
  if (sb.voiceover) {
    const narration = sb.scenes.map((s) => [s.heading, s.body].filter(Boolean).join(". ").replace(/\.{2,}/g, ".")).join(" ");
    hasVoice = await run(T.generateVoiceoverTool, { text: narration.slice(0, 2000) });
    if (hasVoice) steps.push("voice-over");
    else warnings.unshift("Voice-over is off: it needs a text-to-speech provider (a paid/metered service, so it stays disabled until you set one up). Everything else is ready.");
  }

  // Music: the user's own track if they attached one, otherwise a generated bed in the planned mood.
  const ownAudio = project.media.find((m) => m.kind === "audio" && !isSynthSrc(m.src));
  if (sb.music.mood !== "none") {
    if (ownAudio) {
      project.setDoc(addMusic(project.doc, ownAudio, { volume: hasVoice ? 0.28 : 0.5 }));
      steps.push(`your music (${ownAudio.label ?? "audio"})`);
    } else {
      const ok = await run(T.generateMusicTool, {
        mood: sb.music.mood,
        seed: sb.seed,
        volume: hasVoice ? 0.28 : 0.55,
        ...(sb.music.bpm ? { bpm: Math.round(sb.music.bpm) } : {}),
      });
      if (ok) steps.push(`${sb.music.mood} music`);
    }
    if (hasVoice) await run(T.autoDuckTool, {});
  }

  if (sb.sfx) {
    const ok = await run(T.autoSfxTool, { style: sb.pace === "fast" ? "punchy" : "subtle" });
    if (ok) steps.push("sound effects");
  }

  // Keep the recipe with the doc: refinement chips and the storyboard review read it back.
  const finished = structuredClone(project.doc);
  finished.textVideo = { ...(finished.textVideo ?? { theme: sb.theme, format: FORMAT_FOR[sb.genre], pace: sb.pace }), storyboard: sb };
  project.setDoc(finished);

  return { doc: project.doc, steps, warnings, calls };
}

/** The storyboard a doc was made from (null for any other doc). */
export function storyboardOf(doc: EditDoc): Storyboard | null {
  const raw = doc.textVideo?.storyboard;
  if (!raw) return null;
  const r = Storyboard.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * The stored storyboard with the doc's CURRENT words and timings folded back in — text edited
 * in the Text room or the inspector is respected, and added/removed scenes carry over.
 */
export function syncStoryboardWithDoc(sb: Storyboard, doc: EditDoc): Storyboard {
  const live = textVideoScenes(doc);
  if (live.length === 0) return sb;
  const scenes = live.map((l, i) => {
    const base = sb.scenes[i] ?? sb.scenes[sb.scenes.length - 1]!;
    const changedCopy = sb.scenes[i] ? sb.scenes[i]!.heading !== l.head || (sb.scenes[i]!.body ?? "") !== (l.sub ?? "") : true;
    return {
      ...base,
      id: `sc${i + 1}`,
      kind: l.kind,
      heading: l.head,
      body: l.sub,
      ...(l.num ? { num: l.num } : { num: undefined }),
      durationSec: l.durationSec ? Math.min(30, Math.max(1, l.durationSec)) : base.durationSec,
      needsEdit: changedCopy ? undefined : base.needsEdit,
      ...(sb.scenes[i] ? {} : { graphic: undefined, mediaId: undefined, beat: undefined }),
    };
  });
  return { ...sb, scenes };
}

// ---- Director tools ----------------------------------------------------------------------------------

const OverridesSchema = z.object({
  platform: z.enum(PLATFORMS).optional(),
  aspect: z.enum(STORYBOARD_ASPECTS).optional(),
  targetSec: z.number().min(3).max(300).optional(),
  mood: z.enum(MOODS).optional(),
  language: z.enum(LANGUAGES).optional(),
  genre: z.enum(GENRES).optional(),
  voiceover: z.boolean().optional(),
});

export interface MakeVideoFromPromptInput {
  /** One sentence describing the video. */
  prompt?: string;
  /** A ready storyboard (what an LLM planner emits, or the studio's edited one) — skips planning. */
  storyboard?: unknown;
  overrides?: PlanOverrides;
  seed?: number;
}

function describe(sb: Storyboard): string {
  const dur = Math.round(storyboardDuration(sb));
  return `${dur}s ${GENRE_LABELS[sb.genre].toLowerCase()} · ${sb.scenes.length} scenes · ${sb.aspect} · ${sb.mood}`;
}

export const makeVideoFromPromptTool: DirectorTool<MakeVideoFromPromptInput> = {
  name: "make_video_from_prompt",
  description:
    "Make a COMPLETE, editable video from one sentence (with or without uploaded media): classify the genre (promo/ad, explainer, birthday & greeting, travel recap, tutorial/tips, announcement, quote, event invite, product launch, testimonial, intro/outro, photo slideshow) + platform/length/mood/palette/language, write a scene-by-scene storyboard of real copy, then build it as animated text scenes on themed gradients (your photos/clips shown behind the words), with graphics, mood-matched generated music and sound effects. Optionally pass a ready `storyboard` (the JSON schema is the contract) or `overrides` {platform, aspect, targetSec, mood, language, genre, voiceover}. A voice-over is added only if a TTS provider is configured (money-gated). Every scene stays editable in the Text room.",
  inputSchema: z.object({
    prompt: z.string().min(1).optional(),
    storyboard: z.unknown().optional(),
    overrides: OverridesSchema.optional(),
    seed: z.number().int().nonnegative().optional(),
  }) as unknown as z.ZodType<MakeVideoFromPromptInput>,
  async execute(input, ctx) {
    let sb: Storyboard;
    if (input.storyboard) sb = parseStoryboard(input.storyboard);
    else {
      if (!input.prompt?.trim()) throw new Error("Describe the video you want, for example “30s Instagram promo for my coffee shop”.");
      // DIRECTOR_MODE=claude would swap in the LLM planner here (dormant, money-gated); the stub is the default.
      const planner = selectStoryboardPlanner(new StubStoryboardPlanner());
      sb = await planner.plan({ prompt: input.prompt, media: ctx.project.media, overrides: input.overrides, seed: input.seed });
    }
    const r = await realiseStoryboard(ctx.project, sb);
    const warn = r.warnings.length ? ` Note: ${r.warnings.join(" ")}` : "";
    const edit = sb.scenes.some((s) => s.needsEdit) ? " A few cards hold stand-in wording — edit them in the Text room." : "";
    return {
      summary: `Made your video: ${describe(sb)} (${r.steps.join(", ")}). Edit any scene in the Text room, or say “make it punchier”, “switch to the neon theme”, “make it shorter”.${edit}${warn}`,
      durationSec: docDurationSec(ctx.project.doc),
    };
  },
};

export const planVideoTool: DirectorTool<{ prompt: string; overrides?: PlanOverrides; seed?: number }> = {
  name: "plan_video",
  description:
    "Plan a video from one sentence WITHOUT changing the project: returns the storyboard (genre, platform, length, mood, scenes with their copy). Use it to preview or discuss; call make_video_from_prompt to build it.",
  inputSchema: z.object({ prompt: z.string().min(1), overrides: OverridesSchema.optional(), seed: z.number().int().nonnegative().optional() }) as unknown as z.ZodType<{ prompt: string; overrides?: PlanOverrides; seed?: number }>,
  async execute(input, ctx) {
    const planner = selectStoryboardPlanner(new StubStoryboardPlanner());
    const sb = await planner.plan({ prompt: input.prompt, media: ctx.project.media, overrides: input.overrides, seed: input.seed });
    return {
      summary: `Storyboard — ${describe(sb)}:\n${sb.scenes.map((s, i) => `${i + 1}. ${s.heading}${s.body ? ` — ${s.body}` : ""} (${s.durationSec}s)`).join("\n")}`,
      durationSec: docDurationSec(ctx.project.doc),
    };
  },
};
