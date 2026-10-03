/**
 * STORYBOARD — the contract between "one sentence" and a finished, editable video.
 *
 * A Storyboard is a plain, schema-validated JSON document: the genre / platform /
 * length / mood / palette chosen for a prompt, plus an ordered list of SCENES (copy,
 * duration, visual treatment, media assignment, transition). It is exactly what a
 * real LLM would emit — and what the deterministic stub planner emits today — so
 * swapping the planner never touches the realiser (`prompt-video.ts`), the tools, or
 * the UI. Everything here is pure data + types; no I/O and no network.
 *
 *   prompt ──StoryboardPlanner──▶ Storyboard ──realiseStoryboard──▶ EditDoc
 *            (stub | claude*)        (zod)          (existing tools' pure ops)
 *   * the Claude planner stays DORMANT behind DIRECTOR_MODE=claude (money gate).
 */
import { z } from "zod";
import { TransitionType, type MediaAsset } from "@cadence/core";
import { TEXT_VIDEO_THEMES } from "./textvideo";
import { GRAPHIC_POSITIONS, GRAPHIC_PRESET_KEYS } from "./graphics";
import { MUSIC_MOODS } from "./sound-synth";

export const STORYBOARD_VERSION = 1 as const;

export const GENRES = [
  "promo",
  "explainer",
  "greeting",
  "travel",
  "tutorial",
  "announcement",
  "quote",
  "invite",
  "launch",
  "testimonial",
  "intro",
  "slideshow",
] as const;
export type Genre = (typeof GENRES)[number];

export const GENRE_LABELS: Record<Genre, string> = {
  promo: "Promo / ad",
  explainer: "Explainer",
  greeting: "Birthday & greeting",
  travel: "Travel recap",
  tutorial: "Tutorial / tips",
  announcement: "Announcement",
  quote: "Quote / motivation",
  invite: "Event invite",
  launch: "Product launch",
  testimonial: "Testimonial",
  intro: "Intro / outro",
  slideshow: "Photo slideshow",
};

export const PLATFORMS = ["instagram", "tiktok", "youtube", "shorts", "facebook", "linkedin", "whatsapp", "x", "generic"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram Reel",
  tiktok: "TikTok",
  youtube: "YouTube",
  shorts: "YouTube Shorts",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp status",
  x: "X / Twitter",
  generic: "Any platform",
};

export const STORYBOARD_ASPECTS = ["9:16", "16:9", "1:1", "4:5"] as const;
export type StoryAspect = (typeof STORYBOARD_ASPECTS)[number];

export const MOODS = [
  "warm",
  "upbeat",
  "energetic",
  "calm",
  "elegant",
  "bold",
  "playful",
  "cinematic",
  "emotional",
  "professional",
  "minimal",
  "luxury",
] as const;
export type Mood = (typeof MOODS)[number];

/** Languages with a stock-phrase pack. Urdu is written in Roman script (the bundled fonts have no Arabic glyphs). */
export const LANGUAGES = ["en", "es", "fr", "de", "ur"] as const;
export type Language = (typeof LANGUAGES)[number];
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ur: "Urdu (Roman)",
};

const Hex = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

export const SCENE_ROLES = ["hook", "setup", "point", "detail", "proof", "offer", "cta", "outro", "title", "wish"] as const;
export const SCENE_KINDS = ["title", "body", "item", "quote", "cta"] as const;

export const SceneBackground = z.object({
  colors: z.array(Hex).min(2).max(5),
  angle: z.number().default(135),
  motion: z.enum(["none", "drift", "spin", "pulse", "aurora"]).default("none"),
  pattern: z.enum(["dots", "grid", "lines", "diagonal"]).optional(),
});
export type SceneBackground = z.infer<typeof SceneBackground>;

export const SceneGraphic = z.object({
  preset: z.string().refine((p) => GRAPHIC_PRESET_KEYS.includes(p), { message: "unknown graphic preset" }),
  text: z.string().max(80).optional(),
  subtext: z.string().max(120).optional(),
  position: z.enum(GRAPHIC_POSITIONS).optional(),
  scale: z.number().min(0.2).max(4).optional(),
});
export type SceneGraphic = z.infer<typeof SceneGraphic>;

export const StoryboardScene = z.object({
  id: z.string().min(1),
  /** Template key this scene's copy came from (e.g. "promo.hook") — lets "regenerate this scene" roll a new variant. */
  beat: z.string().optional(),
  /** Which copy variant of the beat is showing (regenerate bumps it). */
  variant: z.number().int().nonnegative().default(0),
  role: z.enum(SCENE_ROLES).default("point"),
  /** Drives size + styling of the main line in the text-video engine. */
  kind: z.enum(SCENE_KINDS).default("body"),
  heading: z.string().min(1).max(200),
  body: z.string().max(300).optional(),
  num: z.string().max(8).optional(),
  durationSec: z.number().min(1).max(30),
  background: SceneBackground.optional(),
  graphic: SceneGraphic.optional(),
  /** Shown on the storyboard card (not rendered into the video: export has no colour-emoji font). */
  emoji: z.string().max(8).optional(),
  /** An uploaded media asset shown behind this scene's copy. */
  mediaId: z.string().optional(),
  transition: TransitionType.optional(),
  /** The scene contains stand-in copy the user should replace with real facts (a quote, a date…). */
  needsEdit: z.boolean().optional(),
});
export type StoryboardScene = z.infer<typeof StoryboardScene>;

export const StoryboardBrief = z.object({
  subject: z.string().optional(),
  name: z.string().optional(),
  place: z.string().optional(),
  topic: z.string().optional(),
  count: z.number().int().optional(),
  occasion: z.string().optional(),
  relation: z.string().optional(),
  age: z.number().int().optional(),
  offer: z.string().optional(),
  when: z.string().optional(),
  where: z.string().optional(),
  quote: z.string().optional(),
  quoteBy: z.string().optional(),
  category: z.string().optional(),
  howto: z.boolean().optional(),
  /** The topic is a verb phrase ("save money on groceries"), so headings read "ways to …". */
  verbal: z.boolean().optional(),
  outro: z.boolean().optional(),
  confidence: z.number().optional(),
});
export type StoryboardBrief = z.infer<typeof StoryboardBrief>;

export const Storyboard = z.object({
  version: z.literal(STORYBOARD_VERSION),
  prompt: z.string(),
  genre: z.enum(GENRES),
  title: z.string().min(1).max(120),
  platform: z.enum(PLATFORMS).default("generic"),
  aspect: z.enum(STORYBOARD_ASPECTS),
  language: z.enum(LANGUAGES).default("en"),
  mood: z.enum(MOODS),
  theme: z.enum(TEXT_VIDEO_THEMES),
  look: z.enum(["warm", "cool", "vivid", "bw", "cinematic", "vintage", "noir", "vibrant", "bleach-bypass", "moody", "golden-hour", "matte", "punch", "none"]).optional(),
  pace: z.enum(["slow", "normal", "fast"]).default("normal"),
  palette: z.object({
    name: z.string(),
    colors: z.array(Hex).min(2).max(5),
    text: Hex,
    accent: Hex,
  }),
  music: z.object({ mood: z.enum([...MUSIC_MOODS, "none"]), bpm: z.number().positive().optional(), volume: z.number().min(0).max(1).optional() }),
  sfx: z.boolean().default(true),
  /** Ask for a TTS voice-over of the scene copy. Only runs when a TTS provider is configured (money-gated; graceful off). */
  voiceover: z.boolean().default(false),
  brief: StoryboardBrief.default({}),
  seed: z.number().int().nonnegative().default(1),
  scenes: z.array(StoryboardScene).min(1).max(40),
  /** Honest hints for the review screen ("the facts here are an outline — add yours"). */
  notes: z.array(z.string()).default([]),
});
export type Storyboard = z.infer<typeof Storyboard>;

// ---- planner seam --------------------------------------------------------------------

/** What the user chose in the studio chips; each wins over what the prompt implies. */
export interface PlanOverrides {
  platform?: Platform;
  aspect?: StoryAspect;
  targetSec?: number;
  mood?: Mood;
  language?: Language;
  theme?: Storyboard["theme"];
  music?: Storyboard["music"]["mood"];
  genre?: Genre;
  voiceover?: boolean;
}

export interface PlanInput {
  prompt: string;
  /** Uploaded photos / clips to weave in (audio is ignored). */
  media?: MediaAsset[];
  overrides?: PlanOverrides;
  /** Roll a different variant of everything (the "Regenerate" button). */
  seed?: number;
}

/**
 * Anything that turns a prompt into a Storyboard. The stub is deterministic and
 * offline; the Claude planner (dormant) emits the same JSON from an LLM.
 */
export interface StoryboardPlanner {
  readonly id: "stub" | "claude";
  plan(input: PlanInput): Promise<Storyboard>;
  /** Rewrite one scene (new copy variant). */
  regenerateScene?(sb: Storyboard, index: number): Promise<StoryboardScene>;
}

// ---- pure helpers ----------------------------------------------------------------------

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function storyboardDuration(sb: Pick<Storyboard, "scenes">): number {
  return round1(sb.scenes.reduce((a, s) => a + s.durationSec, 0));
}

/** Validate unknown JSON (e.g. an LLM reply) as a Storyboard, with a readable error. */
export function parseStoryboard(input: unknown): Storyboard {
  const r = Storyboard.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`Invalid storyboard: ${issue ? `${issue.path.join(".") || "(root)"} — ${issue.message}` : "unknown problem"}`);
  }
  return r.data;
}

/** Re-number scene ids so they stay unique + ordered after reorder / add / remove. */
export function renumberScenes(sb: Storyboard): Storyboard {
  return { ...sb, scenes: sb.scenes.map((s, i) => ({ ...s, id: `sc${i + 1}` })) };
}

/** Move scene `from` to position `to` (the review screen's reorder buttons). */
export function moveScene(sb: Storyboard, from: number, to: number): Storyboard {
  if (from === to || from < 0 || to < 0 || from >= sb.scenes.length || to >= sb.scenes.length) return sb;
  const scenes = [...sb.scenes];
  const [m] = scenes.splice(from, 1);
  scenes.splice(to, 0, m!);
  return renumberScenes({ ...sb, scenes });
}

/** Edit a scene's copy / timing in place (the review screen's inline fields). */
export function updateScene(sb: Storyboard, index: number, patch: Partial<Pick<StoryboardScene, "heading" | "body" | "durationSec" | "graphic" | "mediaId">>): Storyboard {
  const scenes = sb.scenes.map((s, i) => {
    if (i !== index) return s;
    const next: StoryboardScene = { ...s, ...patch, needsEdit: patch.heading !== undefined || patch.body !== undefined ? false : s.needsEdit };
    if (patch.body === "") delete next.body;
    return next;
  });
  return { ...sb, scenes };
}

export function removeScene(sb: Storyboard, index: number): Storyboard {
  if (sb.scenes.length <= 1) return sb;
  return renumberScenes({ ...sb, scenes: sb.scenes.filter((_, i) => i !== index) });
}

export function setPalette(sb: Storyboard, palette: Storyboard["palette"]): Storyboard {
  return { ...sb, palette };
}

// ---- Claude seam (DORMANT) ------------------------------------------------------------

/** A text-completion function. The caller supplies it; this module never opens a network connection. */
export type CompleteFn = (args: { system: string; user: string }) => Promise<string>;

export class StoryboardParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "StoryboardParseError";
  }
}

/** Pull the first balanced JSON object out of an LLM reply (it may be wrapped in prose / a code fence). */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1]! : text;
  const start = src.indexOf("{");
  if (start < 0) throw new StoryboardParseError("The model reply contained no JSON object.", text);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(start, i + 1));
        } catch (e) {
          throw new StoryboardParseError(`The model reply was not valid JSON (${e instanceof Error ? e.message : "parse error"}).`, text);
        }
      }
    }
  }
  throw new StoryboardParseError("The model reply's JSON was cut off.", text);
}

/** The system prompt a real LLM planner would be given: the contract, in words. */
export function storyboardSystemPrompt(): string {
  return [
    "You are the storyboard planner for Cadence, a prompt-native video editor.",
    "Turn the user's one-sentence request into a Storyboard: ONE JSON object, no prose.",
    `Fields: version (${STORYBOARD_VERSION}), prompt, genre (${GENRES.join("|")}), title, platform (${PLATFORMS.join("|")}), aspect (${STORYBOARD_ASPECTS.join("|")}),`,
    `language (${LANGUAGES.join("|")}), mood (${MOODS.join("|")}), theme (${TEXT_VIDEO_THEMES.join("|")}), pace (slow|normal|fast),`,
    "palette {name, colors[2-5 hex], text hex, accent hex}, music {mood: lofi|upbeat|cinematic|corporate|ambient|none}, sfx bool, voiceover bool,",
    "brief {subject?, name?, place?, topic?}, seed (int), notes[], and scenes[1-40].",
    "Each scene: id, role (hook|setup|point|detail|proof|offer|cta|outro|title|wish), kind (title|body|item|quote|cta), heading (short, punchy, <= 8 words),",
    "body? (<= 16 words), durationSec (1-30; the scenes must sum to the requested length), background? {colors, angle, motion}, graphic? {preset}, mediaId? (only an id from the supplied media list), transition?.",
    "Write real, specific copy from the user's words — never lorem ipsum. Never invent testimonials, prices, dates or statistics: use a clearly-editable stand-in and set needsEdit:true.",
  ].join("\n");
}

/**
 * The real-LLM planner. DORMANT: it only runs when constructed with a completion
 * function, and the app only constructs one when DIRECTOR_MODE=claude AND a key was
 * approved at the money gate. No network client lives in this package. Failure of any
 * kind (bad JSON, schema mismatch, thrown error) falls back to `fallback` — the stub —
 * so a flaky model can never block the user.
 */
export class ClaudeStoryboardPlanner implements StoryboardPlanner {
  readonly id = "claude" as const;
  constructor(
    private readonly complete: CompleteFn,
    private readonly fallback: StoryboardPlanner,
  ) {}

  async plan(input: PlanInput): Promise<Storyboard> {
    const media = (input.media ?? []).filter((m) => m.kind === "image" || m.kind === "video").map((m) => ({ id: m.id, kind: m.kind, label: m.label ?? m.src }));
    const user = JSON.stringify({ request: input.prompt, overrides: input.overrides ?? {}, media });
    try {
      const raw = await this.complete({ system: storyboardSystemPrompt(), user });
      const sb = parseStoryboard(extractJsonObject(raw));
      // Only keep media ids that actually exist.
      const ids = new Set((input.media ?? []).map((m) => m.id));
      return { ...sb, prompt: input.prompt, scenes: sb.scenes.map((s) => (s.mediaId && !ids.has(s.mediaId) ? { ...s, mediaId: undefined } : s)) };
    } catch {
      return this.fallback.plan(input);
    }
  }

  async regenerateScene(sb: Storyboard, index: number): Promise<StoryboardScene> {
    return this.fallback.regenerateScene ? this.fallback.regenerateScene(sb, index) : sb.scenes[index]!;
  }
}

/**
 * Choose the planner for this process. Stub unless DIRECTOR_MODE=claude AND the host
 * supplied a completion function (which it does only after the money gate is approved).
 */
export function selectStoryboardPlanner(
  stub: StoryboardPlanner,
  env: { DIRECTOR_MODE?: string } = typeof process !== "undefined" ? (process.env as { DIRECTOR_MODE?: string }) : {},
  complete?: CompleteFn,
): StoryboardPlanner {
  if (env.DIRECTOR_MODE === "claude" && complete) return new ClaudeStoryboardPlanner(complete, stub);
  return stub;
}
