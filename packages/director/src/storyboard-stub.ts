/**
 * STUB PLANNER — `planVideo(prompt)` → Storyboard. Pure + deterministic: the same
 * prompt (and seed) always yields the same storyboard, offline, for free. It reads
 * the prompt (`parseBrief`), picks genre-aware beats of hand-written copy
 * (`storyboard-copy`), sizes the scenes to the requested length, then dresses each in
 * a palette-driven background, a graphic, a transition and (when the user attached
 * photos/clips) a media assignment.
 */
import type { MediaAsset, TransitionType } from "@cadence/core";
import { MOOD_DEFS } from "./sound-synth";
import {
  Storyboard,
  type Genre,
  type Mood,
  type PlanInput,
  type PlanOverrides,
  type Platform,
  type StoryAspect,
  type StoryboardPlanner,
  type StoryboardScene,
  STORYBOARD_VERSION,
} from "./storyboard";
import { aspectFor, defaultLength, LENGTH_BOUNDS, parseBrief, type Brief } from "./storyboard-brief";
import { beatsFor, CATEGORIES, copyFor, PACKS, type BeatDef, type CopyCtx } from "./storyboard-copy";

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** FNV-1a — a stable seed from the prompt. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- palettes -----------------------------------------------------------------------------------------

export interface PaletteDef {
  colors: string[];
  text: string;
  accent: string;
  /** Background luminance class: light palettes need dark text. */
  light?: boolean;
}

export const PALETTES: Record<string, PaletteDef> = {
  coffee: { colors: ["#4b2e1e", "#7a4a2b", "#2b1810", "#a0673a"], text: "#fff3e0", accent: "#f2b46d" },
  sunset: { colors: ["#e2552d", "#f08a3c", "#c2306a", "#6a2c91"], text: "#ffffff", accent: "#ffe08a" },
  ocean: { colors: ["#0b3d6b", "#127ca8", "#0a2a4a", "#1aa6b7"], text: "#ffffff", accent: "#ffd166" },
  forest: { colors: ["#0f4d3a", "#1f7a4f", "#0a3326", "#3c9d6a"], text: "#f4fff8", accent: "#f5d76e" },
  berry: { colors: ["#b0215c", "#e0457b", "#7a1d6b", "#f06292"], text: "#ffffff", accent: "#ffe3ec" },
  royal: { colors: ["#3b1c6e", "#6a3fb5", "#24104a", "#8e5bd6"], text: "#ffffff", accent: "#f1c75b" },
  midnight: { colors: ["#0c1633", "#1b2a5c", "#070b1f", "#2a3f8f"], text: "#f2f5ff", accent: "#6fd3ff" },
  ember: { colors: ["#b3121b", "#e23a24", "#7a0c14", "#f26a2e"], text: "#ffffff", accent: "#ffd37a" },
  mono: { colors: ["#1c1c1e", "#2c2c2e", "#111112", "#3a3a3c"], text: "#ffffff", accent: "#ffffff" },
  pastel: { colors: ["#ffd6e0", "#e0c3fc", "#c1f0f6", "#fff1c1"], text: "#2d2540", accent: "#7a4cc2", light: true },
  mint: { colors: ["#0e6e63", "#17a38f", "#0a4f48", "#2bc4aa"], text: "#ffffff", accent: "#fff3a8" },
  gold: { colors: ["#111111", "#2a2110", "#0a0a0a", "#3b2d12"], text: "#f6e3a1", accent: "#e8c77a" },
};

export const PALETTE_NAMES = Object.keys(PALETTES);

const MOOD_PALETTE: Record<Mood, string> = {
  warm: "sunset",
  upbeat: "sunset",
  energetic: "ember",
  calm: "ocean",
  elegant: "royal",
  bold: "ember",
  playful: "berry",
  cinematic: "midnight",
  emotional: "berry",
  professional: "ocean",
  minimal: "mono",
  luxury: "gold",
};

const MOOD_THEME: Record<Mood, Storyboard["theme"]> = {
  warm: "elegant",
  upbeat: "bold",
  energetic: "bold",
  calm: "minimal",
  elegant: "elegant",
  bold: "bold",
  playful: "playful",
  cinematic: "cinematic",
  emotional: "handwritten",
  professional: "corporate",
  minimal: "minimal",
  luxury: "elegant",
};

const MOOD_MUSIC: Record<Mood, Storyboard["music"]["mood"]> = {
  warm: "lofi",
  upbeat: "upbeat",
  energetic: "upbeat",
  calm: "ambient",
  elegant: "ambient",
  bold: "upbeat",
  playful: "upbeat",
  cinematic: "cinematic",
  emotional: "cinematic",
  professional: "corporate",
  minimal: "lofi",
  luxury: "cinematic",
};

const MOOD_LOOK: Partial<Record<Mood, NonNullable<Storyboard["look"]>>> = {
  warm: "warm",
  emotional: "golden-hour",
  cinematic: "cinematic",
  upbeat: "vibrant",
  energetic: "punch",
  playful: "vivid",
  minimal: "matte",
  luxury: "moody",
  elegant: "matte",
};

const MOOD_TRANSITIONS: Record<Mood, TransitionType[]> = {
  energetic: ["wipe", "slide", "zoomin", "circleopen"],
  bold: ["wipe", "slide", "coverleft", "zoomin"],
  upbeat: ["slide", "smooth", "dissolve", "wipeup"],
  playful: ["circleopen", "slideup", "smooth", "squeezeh"],
  calm: ["dissolve", "fadeslow", "crossfade"],
  elegant: ["fadeslow", "dip-to-black", "dissolve"],
  luxury: ["fadeslow", "dip-to-black", "dissolve"],
  cinematic: ["dip-to-black", "fadeslow", "hblur"],
  emotional: ["crossfade", "dissolve", "fadeslow"],
  warm: ["dissolve", "crossfade", "smooth"],
  professional: ["crossfade", "smooth", "wipe"],
  minimal: ["crossfade", "dissolve"],
};

const GENRE_PALETTE: Partial<Record<Genre, string>> = {
  explainer: "ocean",
  travel: "ocean",
  quote: "midnight",
  invite: "royal",
  testimonial: "coffee",
  slideshow: "sunset",
  tutorial: "midnight",
  announcement: "ember",
  launch: "midnight",
  intro: "midnight",
  greeting: "berry",
};

const OCCASION_PALETTE: Record<string, string> = {
  eid: "forest",
  ramadan: "midnight",
  wedding: "gold",
  anniversary: "berry",
  graduation: "royal",
  newyear: "gold",
  diwali: "sunset",
  christmas: "ember",
  valentine: "berry",
  thanks: "sunset",
  getwell: "mint",
};

// ---- planning ---------------------------------------------------------------------------------------------

/** Average seconds a scene needs (reading time + motion) per genre. */
const AVG_SCENE: Record<Genre, number> = {
  promo: 3.2,
  explainer: 6,
  greeting: 3.4,
  travel: 3.2,
  tutorial: 5,
  announcement: 3.5,
  quote: 3.5,
  invite: 3.5,
  launch: 3.5,
  testimonial: 4.5,
  intro: 2.5,
  slideshow: 3.2,
};

const wordsIn = (s: string | undefined): number => (s ? s.split(/\s+/).filter(Boolean).length : 0);

/** The fastest a scene can be comfortably read. */
function readingMin(copy: { heading: string; body?: string }): number {
  return round1(Math.max(1.6, 0.9 + (wordsIn(copy.heading) + wordsIn(copy.body)) / 3.8));
}

function buildCtx(brief: Brief, nMedia: number): CopyCtx {
  const generic = !brief.subject && !brief.name && !brief.place && !brief.topic;
  const raw =
    brief.genre === "greeting"
      ? brief.name ?? brief.subject
      : brief.genre === "travel"
        ? brief.place ?? brief.subject
        : brief.genre === "intro"
          ? brief.name ?? brief.subject
          : brief.subject ?? brief.topic ?? brief.name ?? brief.place;
  const S = raw ?? (brief.genre === "promo" || brief.genre === "launch" ? "our business" : brief.genre === "explainer" ? "how it works" : brief.genre === "tutorial" ? "getting started" : brief.genre === "travel" ? "our trip" : brief.genre === "invite" ? "our celebration" : brief.genre === "announcement" ? "our big news" : "us");
  const proper = !raw || /^[A-Z]/.test(S);
  const cat = CATEGORIES[brief.category ?? "generic"] ?? CATEGORIES.generic!;
  const count =
    brief.genre === "travel" || brief.genre === "slideshow"
      ? clamp(nMedia || brief.count || 6, 3, 12)
      : brief.count ?? (brief.genre === "tutorial" ? clamp(Math.round((brief.targetSec - 8) / 5.5), 3, 8) : 3);
  return {
    brief,
    S,
    proper,
    we: proper ? S : `our ${S}`,
    name: brief.name ?? (brief.genre === "greeting" && brief.relation ? brief.relation.replace(/^\w/, (ch) => ch.toUpperCase()) : undefined),
    place: brief.place,
    topic: brief.topic ?? (brief.genre === "explainer" || brief.genre === "tutorial" ? S : undefined),
    count,
    lang: brief.language,
    pack: PACKS[brief.language] ?? PACKS.en,
    cat,
    generic,
  };
}

/** Choose `n` beats by priority, then restore narrative order. */
function selectBeats(beats: BeatDef[], n: number): BeatDef[] {
  if (n >= beats.length) return beats;
  const ranked = beats.map((b, i) => ({ b, i })).sort((x, y) => x.b.priority - y.b.priority || x.i - y.i);
  return ranked.slice(0, n).sort((x, y) => x.i - y.i).map((r) => r.b);
}

/** Split `total` seconds across scenes by weight, honouring each scene's reading minimum. */
function distribute(weights: number[], mins: number[], total: number): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  const fixed = new Array<boolean>(n).fill(false);
  let remaining = total;
  for (let pass = 0; pass < 4; pass++) {
    const wSum = weights.reduce((a, w, i) => a + (fixed[i] ? 0 : w), 0);
    if (wSum <= 0) break;
    let again = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const share = (remaining * weights[i]!) / wSum;
      if (share < mins[i]!) {
        out[i] = mins[i]!;
        fixed[i] = true;
        remaining -= mins[i]!;
        again = true;
      } else out[i] = share;
    }
    if (!again) break;
  }
  return out.map((d) => round1(clamp(d, 1.5, 10)));
}

function paletteFor(brief: Brief, cat: string, overrides?: PlanOverrides): { name: string; def: PaletteDef } {
  let name: string | undefined = brief.paletteWord;
  if (!name && brief.explicitMood) name = brief.mood === "warm" && cat === "coffee" ? "coffee" : MOOD_PALETTE[brief.mood];
  if (!name && (brief.genre === "promo" || brief.genre === "launch" || brief.genre === "intro" || brief.genre === "testimonial") && cat !== "generic") name = CATEGORIES[cat]?.palette;
  if (!name && brief.genre === "greeting" && brief.occasion && OCCASION_PALETTE[brief.occasion]) name = OCCASION_PALETTE[brief.occasion];
  if (!name) name = GENRE_PALETTE[brief.genre];
  if (!name) name = MOOD_PALETTE[overrides?.mood ?? brief.mood];
  const def = PALETTES[name] ?? PALETTES.sunset!;
  return { name: PALETTES[name] ? name : "sunset", def };
}

function motionFor(mood: Mood): "none" | "drift" | "pulse" | "aurora" {
  if (mood === "energetic" || mood === "bold" || mood === "upbeat" || mood === "playful") return "drift";
  if (mood === "cinematic") return "aurora";
  if (mood === "elegant" || mood === "luxury") return "pulse";
  return "none";
}

function patternFor(mood: Mood, genre: Genre): "dots" | "grid" | "lines" | "diagonal" | undefined {
  if (mood === "playful") return "dots";
  if (genre === "tutorial" || genre === "explainer") return "grid";
  if (mood === "professional") return "lines";
  return undefined;
}

function applyOverrides(brief: Brief, ov: PlanOverrides | undefined, hasMedia: boolean): Brief {
  if (!ov) return brief;
  const b: Brief = { ...brief };
  if (ov.genre) b.genre = ov.genre;
  if (ov.platform) b.platform = ov.platform;
  if (ov.aspect) b.aspect = ov.aspect;
  else if (ov.platform || ov.genre) b.aspect = aspectFor(b.platform, "", b.genre);
  if (ov.targetSec) {
    b.targetSec = ov.targetSec;
    b.explicitLength = true;
  } else if (ov.genre) b.targetSec = brief.explicitLength ? brief.targetSec : defaultLength(b.genre);
  if (ov.mood) {
    b.mood = ov.mood;
    b.explicitMood = true;
  }
  if (ov.language) b.language = ov.language;
  if (ov.voiceover !== undefined) b.wantsVoiceover = ov.voiceover;
  if (ov.music) b.musicWord = ov.music;
  void hasMedia;
  return b;
}

const isVisual = (m: MediaAsset): boolean => m.kind === "image" || m.kind === "video";

/** The pure planner. Same prompt + seed ⇒ same Storyboard. */
export function planVideo(input: PlanInput): Storyboard {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Describe the video you want — one sentence is enough.");
  const media = (input.media ?? []).filter(isVisual);
  const hasMedia = media.length > 0;
  const seed = input.seed ?? hashSeed(prompt) % 997;

  let brief = parseBrief(prompt, { hasMedia });
  brief = applyOverrides(brief, input.overrides, hasMedia);
  const genre = brief.genre;
  const ctx = buildCtx(brief, media.length);

  // ---- length -------------------------------------------------------------------
  const [lo, hi] = LENGTH_BOUNDS[genre];
  let targetSec = brief.targetSec;
  if (!brief.explicitLength && hasMedia && (genre === "travel" || genre === "slideshow")) targetSec = round1(media.length * 3.2 + 4);
  const notes: string[] = [];
  const clampedTarget = clamp(targetSec, lo, hi);
  if (brief.explicitLength && clampedTarget !== targetSec) notes.push(`A ${genre} works best between ${lo}s and ${hi}s, so I used ${clampedTarget}s.`);
  targetSec = clampedTarget;

  // ---- beats → scenes --------------------------------------------------------------
  const allBeats = beatsFor(genre, ctx);
  const wantN = clamp(Math.round(targetSec / AVG_SCENE[genre]), Math.min(3, allBeats.length), allBeats.length);
  let nScenes = wantN;
  if (hasMedia && (genre === "travel" || genre === "slideshow")) nScenes = clamp(Math.min(media.length, ctx.count) + 2, 3, allBeats.length);
  // Never write more than fits: drop the least essential scene until the copy is readable in the time.
  let beats = selectBeats(allBeats, nScenes);
  let copies = beats.map((b) => copyFor(b, ctx, seed, 0));
  while (beats.length > 3 && copies.reduce((a, c) => a + readingMin(c), 0) > targetSec * 1.05) {
    nScenes = beats.length - 1;
    beats = selectBeats(allBeats, nScenes);
    copies = beats.map((b) => copyFor(b, ctx, seed, 0));
  }

  const weights = beats.map((b) => b.weight);
  const mins = copies.map((c) => readingMin(c));
  const durations = distribute(weights, mins, targetSec);
  if (durations.reduce((a, d) => a + d, 0) > targetSec + 2.5) notes.push(`The copy needs a little more time to read than ${targetSec}s, so the video runs a touch longer.`);

  // ---- look & feel ---------------------------------------------------------------------
  const mood = brief.mood;
  const { name: paletteName, def: palette } = paletteFor(brief, brief.category ?? "generic", input.overrides);
  const theme = input.overrides?.theme ?? brief.themeWord ?? MOOD_THEME[mood];
  const musicMood = brief.musicWord ?? MOOD_MUSIC[mood];
  const pace: Storyboard["pace"] = mood === "calm" || mood === "elegant" || mood === "luxury" || mood === "emotional" ? "slow" : mood === "energetic" || mood === "bold" ? "fast" : "normal";
  const motion = motionFor(mood);
  const pattern = patternFor(mood, genre);
  const transitions = MOOD_TRANSITIONS[mood];
  const L = palette.colors.length;

  const scenes: StoryboardScene[] = beats.map((beat, i) => {
    const copy = copies[i]!;
    const stops = [palette.colors[i % L]!, palette.colors[(i + 1) % L]!];
    const media0 = hasMedia ? media[i % media.length]! : undefined;
    const scene: StoryboardScene = {
      id: `sc${i + 1}`,
      beat: beat.id,
      variant: 0,
      role: beat.role,
      kind: copy.kind ?? beat.kind,
      heading: copy.heading,
      ...(copy.body ? { body: copy.body } : {}),
      ...(copy.num ? { num: copy.num } : {}),
      durationSec: durations[i]!,
      background: { colors: stops, angle: [135, 160, 110, 200][i % 4]!, motion, ...(pattern ? { pattern } : {}) },
      ...(copy.graphic ? { graphic: copy.graphic } : {}),
      ...(copy.emoji ? { emoji: copy.emoji } : {}),
      ...(media0 ? { mediaId: media0.id } : {}),
      ...(i > 0 ? { transition: transitions[(i + seed) % transitions.length]! } : {}),
      ...(copy.needsEdit ? { needsEdit: true } : {}),
    };
    return scene;
  });

  // Notes the review screen shows.
  if (ctx.generic && (genre === "promo" || genre === "launch")) notes.push("Tell me what it's for (“for my coffee shop”) and I'll write copy that's specific to it.");
  if (scenes.some((s) => s.needsEdit)) {
    notes.push(
      genre === "testimonial"
        ? "The customer quote is a stand-in. Replace it with a real one (use “…” quotes in your prompt, or edit the card)."
        : genre === "explainer"
          ? "I don't have verified facts for this topic yet, so the steps are an outline. Edit each card with your own facts."
          : "Cards marked “needs your detail” contain stand-in wording. Edit them before you create the video.",
    );
  }
  if (genre === "explainer" && !scenes.some((s) => s.needsEdit)) notes.push("Check the facts, then tweak the wording to your audience.");
  if (brief.language !== "en" && !(genre === "greeting" && brief.occasion === "birthday")) notes.push(`Stock phrases are in ${brief.language === "ur" ? "Roman Urdu" : brief.language}; descriptive lines stay in English so you can edit them.`);
  if (hasMedia) notes.push(`Using your ${media.length} ${media.length === 1 ? "file" : "files"}, shown behind the text, so keep photos bright and uncluttered.`);

  const title = titleFor(genre, ctx);
  const sb: Storyboard = {
    version: STORYBOARD_VERSION,
    prompt,
    genre,
    title,
    platform: brief.platform,
    aspect: brief.aspect,
    language: brief.language,
    mood,
    theme,
    ...(hasMedia ? { look: MOOD_LOOK[mood] ?? "none" } : {}),
    pace,
    palette: { name: paletteName, colors: palette.colors, text: palette.text, accent: palette.accent },
    music: { mood: musicMood, ...(mood === "energetic" ? { bpm: Math.min(MOOD_DEFS.upbeat.bpm * 1.08, 140) } : {}) },
    sfx: genre !== "quote" && genre !== "explainer",
    voiceover: brief.wantsVoiceover,
    brief: {
      subject: brief.subject,
      name: brief.name,
      place: brief.place,
      topic: brief.topic,
      count: brief.count,
      occasion: brief.occasion,
      relation: brief.relation,
      age: brief.age,
      offer: brief.offer,
      when: brief.when,
      where: brief.where,
      quote: brief.quote,
      category: brief.category,
      howto: /\bhow to\b/i.test(prompt),
      verbal: brief.verbal,
      outro: /\boutro\b|\bend ?screen\b|\bend card\b/i.test(prompt),
      confidence: brief.confidence,
    },
    seed,
    scenes,
    notes,
  };
  return Storyboard.parse(sb);
}

function titleFor(genre: Genre, c: CopyCtx): string {
  const t = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  switch (genre) {
    case "promo":
      return t(`${c.proper ? c.S : c.S[0]!.toUpperCase() + c.S.slice(1)} promo`);
    case "greeting":
      return t(c.name ? `${(c.brief.occasion ?? "birthday") === "birthday" ? "Birthday wish" : "Greeting"} for ${c.name}` : "Greeting");
    case "travel":
      return t(`${c.place ?? c.S} recap`);
    case "explainer":
      return t(`${c.topic ?? c.S} explained`);
    case "tutorial":
      return t(`${c.brief.howto ? "How to " : "Tips: "}${c.topic ?? c.S}`);
    case "intro":
      return t(`${c.name ?? c.S} intro`);
    default:
      return t(c.S[0]!.toUpperCase() + c.S.slice(1));
  }
}

// ---- scene regeneration + refinement (pure) ------------------------------------------------------------------

function ctxFromStoryboard(sb: Storyboard): CopyCtx {
  const brief = parseBrief(sb.prompt, {});
  const merged: Brief = {
    ...brief,
    ...sb.brief,
    genre: sb.genre,
    platform: sb.platform,
    aspect: sb.aspect,
    language: sb.language,
    mood: sb.mood,
    targetSec: sb.scenes.reduce((a, s) => a + s.durationSec, 0),
    confidence: sb.brief.confidence ?? 1,
  };
  return buildCtx(merged, sb.scenes.filter((s) => s.mediaId).length);
}

/** Roll a fresh copy variant for ONE scene (keeps its timing, visuals, media). */
export function regenerateScene(sb: Storyboard, index: number): StoryboardScene {
  const scene = sb.scenes[index];
  if (!scene) throw new Error("No such scene.");
  const ctx = ctxFromStoryboard(sb);
  const beat = beatsFor(sb.genre, ctx).find((b) => b.id === scene.beat);
  if (!beat) {
    // A scene from outside the template set (e.g. an LLM's): tighten its wording instead.
    return { ...scene, heading: punchy(scene.heading), body: scene.body ? punchy(scene.body) : undefined };
  }
  const nextVariant = scene.variant + 1;
  let copy = copyFor(beat, ctx, sb.seed, nextVariant);
  // If the new variant is identical (single-variant beat), keep the old copy.
  if (copy.heading === scene.heading && copy.body === scene.body && beat.variants.length > 1) copy = copyFor(beat, ctx, sb.seed, nextVariant + 1);
  const { needsEdit, ...rest } = scene;
  void rest;
  return {
    ...scene,
    variant: nextVariant,
    kind: copy.kind ?? scene.kind,
    heading: copy.heading,
    ...(copy.body ? { body: copy.body } : { body: undefined }),
    ...(copy.num ? { num: copy.num } : {}),
    ...(copy.emoji ? { emoji: copy.emoji } : {}),
    graphic: copy.graphic ?? scene.graphic,
    needsEdit: copy.needsEdit ? true : needsEdit && beat.variants.length === 1 ? true : undefined,
  };
}

const FILLER = /\b(?:really|very|just|a little|quite|actually|simply|truly|so)\s+/gi;

/** Cut copy down to its punchiest form: drop filler, take the first clause. */
export function punchy(text: string): string {
  const t = text.replace(FILLER, "").replace(/\s+/g, " ").trim();
  const first = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  const words = first.split(" ");
  const out = words.length > 8 ? words.slice(0, 8).join(" ") : first;
  return /[.!?…]$/.test(out) ? out : out.replace(/[,;:]$/, "") + (/[A-Za-z0-9]$/.test(out) ? "." : "");
}

export type RefineKind = "regenerate" | "punchier" | "shorter" | "longer" | "different-style";

/** The storyboard review screen's style controls (palette / theme / mood / music / frame). Copy is untouched. */
export function setStoryboardStyle(
  sb: Storyboard,
  patch: { palette?: string; theme?: Storyboard["theme"]; mood?: Mood; music?: Storyboard["music"]["mood"]; aspect?: StoryAspect; sfx?: boolean; voiceover?: boolean },
): Storyboard {
  let out = sb;
  if (patch.palette && PALETTES[patch.palette]) out = restyle(out, patch.palette, out.mood, out.theme, "keep");
  if (patch.mood) out = restyle(out, out.palette.name, patch.mood, out.theme);
  if (patch.theme) out = { ...out, theme: patch.theme };
  if (patch.music) out = { ...out, music: { ...out.music, mood: patch.music } };
  if (patch.aspect) out = { ...out, aspect: patch.aspect };
  if (patch.sfx !== undefined) out = { ...out, sfx: patch.sfx };
  if (patch.voiceover !== undefined) out = { ...out, voiceover: patch.voiceover };
  return out;
}

const STYLE_CYCLE: { theme: Storyboard["theme"]; mood: Mood }[] = [
  { theme: "bold", mood: "bold" },
  { theme: "elegant", mood: "elegant" },
  { theme: "neon", mood: "energetic" },
  { theme: "playful", mood: "playful" },
  { theme: "minimal", mood: "minimal" },
  { theme: "cinematic", mood: "cinematic" },
  { theme: "retro", mood: "upbeat" },
  { theme: "aurora", mood: "calm" },
  { theme: "corporate", mood: "professional" },
];

function restyle(sb: Storyboard, paletteName: string, mood: Mood, theme: Storyboard["theme"], music: "keep" | "mood" = "mood"): Storyboard {
  const palette = PALETTES[paletteName] ?? PALETTES.sunset!;
  const L = palette.colors.length;
  const motion = motionFor(mood);
  const transitions = MOOD_TRANSITIONS[mood];
  return {
    ...sb,
    mood,
    theme,
    palette: { name: paletteName, colors: palette.colors, text: palette.text, accent: palette.accent },
    music: { ...sb.music, mood: music === "keep" || sb.music.mood === "none" ? sb.music.mood : MOOD_MUSIC[mood] },
    pace: mood === "calm" || mood === "elegant" ? "slow" : mood === "energetic" || mood === "bold" ? "fast" : "normal",
    scenes: sb.scenes.map((s, i) => ({
      ...s,
      background: { colors: [palette.colors[i % L]!, palette.colors[(i + 1) % L]!], angle: s.background?.angle ?? 135, motion, ...(s.background?.pattern ? { pattern: s.background.pattern } : {}) },
      ...(i > 0 ? { transition: transitions[(i + sb.seed) % transitions.length]! } : {}),
    })),
  };
}

/**
 * Refinement chips after a video exists. All deterministic:
 *  regenerate — new copy everywhere (same brief, next seed);
 *  punchier — tighter wording, faster pace, bolder look;
 *  shorter / longer — drop or add scenes (re-plans at ~70% / ~140% of the length);
 *  different-style — next theme + palette + music, same words.
 */
export function refineStoryboard(sb: Storyboard, kind: RefineKind, media: MediaAsset[] = []): Storyboard {
  const total = sb.scenes.reduce((a, s) => a + s.durationSec, 0);
  const overrides: PlanOverrides = { platform: sb.platform, aspect: sb.aspect, mood: sb.mood, language: sb.language, theme: sb.theme, music: sb.music.mood, genre: sb.genre, voiceover: sb.voiceover };
  switch (kind) {
    case "regenerate":
      return planVideo({ prompt: sb.prompt, media, overrides: { ...overrides, targetSec: round1(total) }, seed: sb.seed + 1 });
    case "shorter":
      return planVideo({ prompt: sb.prompt, media, overrides: { ...overrides, targetSec: Math.max(LENGTH_BOUNDS[sb.genre][0], Math.round(total * 0.7)) }, seed: sb.seed });
    case "longer":
      return planVideo({ prompt: sb.prompt, media, overrides: { ...overrides, targetSec: Math.min(LENGTH_BOUNDS[sb.genre][1], Math.round(total * 1.4)) }, seed: sb.seed });
    case "punchier": {
      const scenes = sb.scenes.map((s, i) => {
        const keepBody = s.role === "cta" || s.role === "offer" || s.role === "hook" || s.kind === "quote" || !!s.num;
        const next: StoryboardScene = {
          ...s,
          heading: s.needsEdit ? s.heading : punchy(s.heading),
          durationSec: round1(Math.max(1.6, s.durationSec * 0.82)),
          ...(i > 0 ? { transition: (["wipe", "slide", "zoomin", "wipeup"] as TransitionType[])[(i + sb.seed) % 4]! } : {}),
        };
        if (!keepBody) delete next.body;
        return next;
      });
      const bold = restyle({ ...sb, scenes }, sb.palette.name, sb.mood === "calm" || sb.mood === "elegant" ? "bold" : sb.mood, sb.theme === "minimal" || sb.theme === "elegant" ? "bold" : sb.theme, "keep");
      return { ...bold, sfx: true, pace: "fast" };
    }
    case "different-style": {
      const idx = STYLE_CYCLE.findIndex((s) => s.theme === sb.theme);
      const next = STYLE_CYCLE[(idx + 1) % STYLE_CYCLE.length]!;
      const pi = PALETTE_NAMES.indexOf(sb.palette.name);
      const pal = PALETTE_NAMES[(pi + 3) % PALETTE_NAMES.length]!;
      return restyle(sb, pal, next.mood, next.theme);
    }
  }
}

// ---- planner objects --------------------------------------------------------------------------------------------

export class StubStoryboardPlanner implements StoryboardPlanner {
  readonly id = "stub" as const;
  async plan(input: PlanInput): Promise<Storyboard> {
    return planVideo(input);
  }
  async regenerateScene(sb: Storyboard, index: number): Promise<StoryboardScene> {
    return regenerateScene(sb, index);
  }
}

export type { Platform, StoryAspect };
