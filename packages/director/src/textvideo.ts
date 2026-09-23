/**
 * TEXT VIDEO — make a whole video from words alone (Canva-style), no upload.
 *
 * `buildTextVideo` turns a script into timed SCENES (story / quote / list /
 * announcement / lyrics), each a full-frame background (solid, gradient, animated
 * aurora, pattern) with animated typography, joined by scene transitions — styled by
 * one of the THEMES below. Everything is plain EditDoc data, so it previews and
 * exports through the shared canvas exactly, and every clip stays editable.
 *
 * Clip ids encode the scene structure (`tv-s{n}-{role}`: title/body/item/quote/cta
 * for the main line, `sub`, `num`, `acc`, `bg`), and `doc.textVideo` stores the
 * recipe (theme/format/pace). `textVideoScenes` reads the scenes back from the
 * clips (so text edits made anywhere are respected), which lets restyle, reframe,
 * and scene add/remove/reorder/retime rebuild the video consistently. Pure.
 */
import {
  FONT_LIBRARY,
  fontStack,
  parseEditDoc,
  type BackgroundGradient,
  type BackgroundPattern,
  type EditDoc,
  type TextAnimStyle,
  type TextAnimUnit,
  type TextEffect,
  type TextExitStyle,
  type TextLoopStyle,
  type TransitionType,
} from "@cadence/core";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export const TEXT_VIDEO_THEMES = [
  "bold",
  "minimal",
  "neon",
  "elegant",
  "playful",
  "corporate",
  "retro",
  "aurora",
  "cinematic",
  "handwritten",
] as const;
export type TextVideoTheme = (typeof TEXT_VIDEO_THEMES)[number];

export const TEXT_VIDEO_FORMATS = ["story", "quote", "list", "announcement", "lyrics"] as const;
export type TextVideoFormat = (typeof TEXT_VIDEO_FORMATS)[number];

export type TextVideoPace = "slow" | "normal" | "fast";

export const TEXT_VIDEO_ASPECTS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
} as const;
export type TextVideoAspect = keyof typeof TEXT_VIDEO_ASPECTS;

/** The role of a scene's main line (drives its size and styling). */
export type SceneKind = "title" | "body" | "item" | "quote" | "cta";

/** One scene of a text video. `durationSec` absent ⇒ computed from reading speed. */
export interface TextScene {
  kind: SceneKind;
  /** The main line (may contain newlines). */
  head: string;
  /** Optional secondary line (author, detail, call to action). */
  sub?: string;
  /** Optional big number / label (list items: "01"). */
  num?: string;
  durationSec?: number;
}

// ---- themes ------------------------------------------------------------------

interface Motion {
  style: TextAnimStyle;
  unit: TextAnimUnit;
  durationSec: number;
}

interface ThemeDef {
  label: string;
  description: string;
  head: { family: string; weight: "normal" | "medium" | "semibold" | "bold"; uppercase: boolean; letterSpacing: number; italic?: boolean };
  body: { family: string; weight: "normal" | "medium" | "semibold" | "bold"; italic?: boolean };
  /** Scene backgrounds, cycled. */
  backgrounds: { color: string; gradient?: BackgroundGradient; pattern?: BackgroundPattern }[];
  text: string;
  sub: string;
  accent: string;
  intro: Motion;
  bodyIntro: Motion;
  subIntro: Motion;
  exit: { style: TextExitStyle; durationSec: number };
  loop?: { style: TextLoopStyle; speed: number; amount: number };
  effect?: TextEffect;
  titleEffect?: TextEffect;
  accentBar: boolean;
  transition: TransitionType;
  transitionSec: number;
  /** Charcter-width factor of the head face (for fit-to-frame sizing). */
  charW: number;
}

const fam = (family: string): string => {
  const f = FONT_LIBRARY.find((x) => x.family === family);
  return f ? fontStack(f) : `${family}, sans-serif`;
};
const g = (stops: string[], angle = 135, motion: BackgroundGradient["motion"] = "none", kind: "linear" | "radial" = "linear"): BackgroundGradient => ({
  kind,
  angle,
  stops,
  motion,
  speed: 1,
});

export const TEXT_VIDEO_THEME_DEFS: Record<TextVideoTheme, ThemeDef> = {
  bold: {
    label: "Bold",
    description: "Heavy caps on vivid gradients, stomp-in titles.",
    head: { family: fam("Montserrat"), weight: "bold", uppercase: true, letterSpacing: 0 },
    body: { family: fam("Montserrat"), weight: "bold" },
    backgrounds: [
      { color: "#ff512f", gradient: g(["#ff512f", "#dd2476"], 135, "drift") },
      { color: "#4776e6", gradient: g(["#4776e6", "#8e54e9"], 135, "drift") },
      { color: "#11998e", gradient: g(["#11998e", "#38ef7d"], 135, "drift") },
      { color: "#f7971e", gradient: g(["#f7971e", "#ffd200"], 135, "drift") },
    ],
    text: "#ffffff",
    sub: "#ffffffd9",
    accent: "#ffffff",
    intro: { style: "stomp", unit: "whole", durationSec: 0.55 },
    bodyIntro: { style: "rise", unit: "word", durationSec: 0.8 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.5 },
    exit: { style: "zoom-out", durationSec: 0.35 },
    titleEffect: { style: "lift", intensity: 0.5, offset: 0.5, direction: -45 },
    effect: { style: "lift", intensity: 0.35, offset: 0.5, direction: -45 },
    accentBar: true,
    transition: "slide",
    transitionSec: 0.45,
    charW: 0.62,
  },
  minimal: {
    label: "Minimal",
    description: "Quiet ink on paper, gentle word fades.",
    head: { family: fam("Inter"), weight: "bold", uppercase: false, letterSpacing: -1 },
    body: { family: fam("Inter"), weight: "normal" },
    backgrounds: [{ color: "#f6f4ef" }, { color: "#ffffff" }, { color: "#efeee9" }],
    text: "#141414",
    sub: "#6b6b6b",
    accent: "#141414",
    intro: { style: "fade", unit: "word", durationSec: 0.8 },
    bodyIntro: { style: "fade", unit: "word", durationSec: 0.9 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.6 },
    exit: { style: "fade", durationSec: 0.4 },
    accentBar: false,
    transition: "dissolve",
    transitionSec: 0.5,
    charW: 0.55,
  },
  neon: {
    label: "Neon",
    description: "Glowing signs on a dark grid that flicker on.",
    head: { family: fam("Righteous"), weight: "normal", uppercase: false, letterSpacing: 2 },
    body: { family: fam("Righteous"), weight: "normal" },
    backgrounds: [
      { color: "#07060f", pattern: { kind: "grid", color: "#7b2ff7", opacity: 0.14, scale: 1.4 } },
      { color: "#050b12", pattern: { kind: "grid", color: "#00e5ff", opacity: 0.12, scale: 1.4 } },
    ],
    text: "#ff3df2",
    sub: "#7df9ff",
    accent: "#00e5ff",
    intro: { style: "neon", unit: "whole", durationSec: 0.9 },
    bodyIntro: { style: "neon", unit: "word", durationSec: 1 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.5 },
    exit: { style: "fade", durationSec: 0.3 },
    loop: { style: "flicker", speed: 0.6, amount: 0.25 },
    effect: { style: "neon", intensity: 0.6, offset: 0.5, direction: -45 },
    titleEffect: { style: "neon", intensity: 0.8, offset: 0.5, direction: -45 },
    accentBar: false,
    transition: "dip-to-black",
    transitionSec: 0.5,
    charW: 0.56,
  },
  elegant: {
    label: "Elegant",
    description: "Gold serif italics that blur into focus.",
    head: { family: fam("Playfair Display"), weight: "bold", uppercase: false, letterSpacing: 0 },
    body: { family: fam("Playfair Display"), weight: "normal", italic: true },
    backgrounds: [
      { color: "#0f1a2b", gradient: g(["#1d2b4a", "#0b1220"], 0, "pulse", "radial") },
      { color: "#2a0f1a", gradient: g(["#4a1d2b", "#140810"], 0, "pulse", "radial") },
    ],
    text: "#f1d9a0",
    sub: "#e9e1cf",
    accent: "#e8c77a",
    intro: { style: "blur-in", unit: "line", durationSec: 1.1 },
    bodyIntro: { style: "blur-in", unit: "word", durationSec: 1.1 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.8 },
    exit: { style: "blur-out", durationSec: 0.5 },
    accentBar: true,
    transition: "dissolve",
    transitionSec: 0.7,
    charW: 0.52,
  },
  playful: {
    label: "Playful",
    description: "Pastels, bouncy letters, and a happy wave.",
    head: { family: fam("Poppins"), weight: "bold", uppercase: false, letterSpacing: 0 },
    body: { family: fam("Poppins"), weight: "semibold" },
    backgrounds: [
      { color: "#ffd1dc", gradient: g(["#ffd1dc", "#ffe8a3"], 120, "spin") },
      { color: "#c1f0e4", gradient: g(["#c1f0e4", "#c7d2fe"], 120, "spin") },
      { color: "#fde68a", gradient: g(["#fde68a", "#fbcfe8"], 120, "spin") },
    ],
    text: "#2b2250",
    sub: "#4b3f7a",
    accent: "#ff6fa5",
    intro: { style: "pop", unit: "letter", durationSec: 0.9 },
    bodyIntro: { style: "pop", unit: "word", durationSec: 0.8 },
    subIntro: { style: "rise", unit: "word", durationSec: 0.6 },
    exit: { style: "zoom-out", durationSec: 0.35 },
    loop: { style: "wave", speed: 0.7, amount: 0.25 },
    accentBar: false,
    transition: "circleopen",
    transitionSec: 0.5,
    charW: 0.6,
  },
  corporate: {
    label: "Corporate",
    description: "Clean navy slides with a sharp accent bar.",
    head: { family: fam("Poppins"), weight: "semibold", uppercase: false, letterSpacing: 0 },
    body: { family: fam("Inter"), weight: "normal" },
    backgrounds: [
      { color: "#0b2545", gradient: g(["#0b2545", "#13315c"], 160), pattern: { kind: "diagonal", color: "#ffffff", opacity: 0.04, scale: 1 } },
      { color: "#13315c", gradient: g(["#13315c", "#1d4e89"], 160), pattern: { kind: "diagonal", color: "#ffffff", opacity: 0.04, scale: 1 } },
    ],
    text: "#ffffff",
    sub: "#b8c7e0",
    accent: "#3ddc97",
    intro: { style: "slide-left", unit: "line", durationSec: 0.7 },
    bodyIntro: { style: "rise", unit: "line", durationSec: 0.7 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.5 },
    exit: { style: "slide-left", durationSec: 0.35 },
    accentBar: true,
    transition: "wipe",
    transitionSec: 0.45,
    charW: 0.58,
  },
  retro: {
    label: "Retro",
    description: "Chunky type with a retro drop-shadow on sunny dots.",
    head: { family: fam("Abril Fatface"), weight: "normal", uppercase: false, letterSpacing: 1 },
    body: { family: fam("Righteous"), weight: "normal" },
    backgrounds: [
      { color: "#ffcc4d", pattern: { kind: "dots", color: "#7a2e0e", opacity: 0.12, scale: 0.9 } },
      { color: "#ff8a5b", pattern: { kind: "dots", color: "#3b1405", opacity: 0.12, scale: 0.9 } },
      { color: "#2ec4b6", pattern: { kind: "dots", color: "#073b36", opacity: 0.14, scale: 0.9 } },
    ],
    text: "#fffaf0",
    sub: "#2b1208",
    accent: "#2b1208",
    intro: { style: "drop", unit: "word", durationSec: 0.8 },
    bodyIntro: { style: "bounce", unit: "word", durationSec: 0.9 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.5 },
    exit: { style: "sink", durationSec: 0.35 },
    effect: { style: "echo", color: "#2b1208", intensity: 0.9, offset: 0.35, direction: -45 },
    titleEffect: { style: "echo", color: "#2b1208", intensity: 1, offset: 0.45, direction: -45 },
    accentBar: false,
    transition: "slideup",
    transitionSec: 0.45,
    charW: 0.58,
  },
  aurora: {
    label: "Aurora",
    description: "Floating northern-light gradients, letters rising in.",
    head: { family: fam("Space Grotesk"), weight: "bold", uppercase: false, letterSpacing: -1 },
    body: { family: fam("Space Grotesk"), weight: "normal" },
    backgrounds: [
      { color: "#070b1d", gradient: g(["#1a1446", "#7b2ff7", "#00c2ff", "#ff5edb"], 135, "aurora") },
      { color: "#06121a", gradient: g(["#0b2a3a", "#00c9a7", "#845ec2", "#ffc75f"], 135, "aurora") },
    ],
    text: "#ffffff",
    sub: "#e6e9ff",
    accent: "#ffffff",
    intro: { style: "rise", unit: "letter", durationSec: 1 },
    bodyIntro: { style: "rise", unit: "word", durationSec: 0.9 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.6 },
    exit: { style: "rise", durationSec: 0.4 },
    effect: { style: "lift", intensity: 0.3, offset: 0.5, direction: -45 },
    titleEffect: { style: "lift", intensity: 0.4, offset: 0.5, direction: -45 },
    accentBar: false,
    transition: "crossfade",
    transitionSec: 0.6,
    charW: 0.56,
  },
  cinematic: {
    label: "Cinematic",
    description: "Wide-tracked caps revealed from the dark.",
    head: { family: fam("Bebas Neue"), weight: "normal", uppercase: true, letterSpacing: 14 },
    body: { family: fam("Oswald"), weight: "normal" },
    backgrounds: [
      { color: "#000000", gradient: g(["#1c1c22", "#000000"], 0, "none", "radial") },
      { color: "#050507", gradient: g(["#23201a", "#050507"], 0, "none", "radial") },
    ],
    text: "#f4efe6",
    sub: "#a8a298",
    accent: "#c9a45c",
    intro: { style: "baseline", unit: "line", durationSec: 1.1 },
    bodyIntro: { style: "wipe", unit: "line", durationSec: 1.1 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.8 },
    exit: { style: "fade", durationSec: 0.6 },
    accentBar: true,
    transition: "dip-to-black",
    transitionSec: 0.8,
    charW: 0.42,
  },
  handwritten: {
    label: "Handwritten",
    description: "Marker notes on lined paper, written in letter by letter.",
    head: { family: fam("Permanent Marker"), weight: "normal", uppercase: false, letterSpacing: 0 },
    body: { family: fam("Caveat"), weight: "bold" },
    backgrounds: [
      { color: "#fbf6ea", pattern: { kind: "lines", color: "#5b8bd9", opacity: 0.18, scale: 1.2 } },
      { color: "#fffdf5", pattern: { kind: "lines", color: "#5b8bd9", opacity: 0.18, scale: 1.2 } },
    ],
    text: "#1f2a44",
    sub: "#b23a48",
    accent: "#b23a48",
    intro: { style: "wipe", unit: "letter", durationSec: 1 },
    bodyIntro: { style: "wipe", unit: "word", durationSec: 1.1 },
    subIntro: { style: "fade", unit: "whole", durationSec: 0.5 },
    exit: { style: "fade", durationSec: 0.35 },
    accentBar: false,
    transition: "coverleft",
    transitionSec: 0.45,
    charW: 0.6,
  },
};

/** Themes for UI enumeration: key + label + one-line description + swatch colors. */
export const TEXT_VIDEO_THEME_LIST = TEXT_VIDEO_THEMES.map((key) => {
  const d = TEXT_VIDEO_THEME_DEFS[key];
  const bg = d.backgrounds[0]!;
  return { key, label: d.label, description: d.description, swatch: bg.gradient?.stops ?? [bg.color], text: d.text, family: d.head.family };
});

export function isTextVideoTheme(v: unknown): v is TextVideoTheme {
  return typeof v === "string" && (TEXT_VIDEO_THEMES as readonly string[]).includes(v);
}

// ---- script → scenes ------------------------------------------------------------

const LIST_RE = /^\s*(?:\d{1,2}[.)]|[-•*–])\s+/;
const QUOTE_OPEN = /^["“”'‘]/;
const AUTHOR_RE = /\s*[—–-]{1,2}\s*([^—–\n]{2,60})$/;

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** Detect the most fitting format for a script. */
export function detectTextVideoFormat(script: string): TextVideoFormat {
  const lines = script.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.filter((l) => LIST_RE.test(l)).length >= 2) return "list";
  const joined = lines.join(" ");
  if ((QUOTE_OPEN.test(joined) && AUTHOR_RE.test(joined)) || (QUOTE_OPEN.test(joined) && /["”’]$/.test(joined))) return "quote";
  return "story";
}

/** Split long prose into readable chunks (sentences; long ones at commas / halves). */
function chunkProse(text: string, maxWords: number): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (words(s) <= maxWords) {
      out.push(s);
      continue;
    }
    const parts = s.split(/(?<=[,;:])\s+/);
    let cur = "";
    for (const p of parts) {
      const next = cur ? `${cur} ${p}` : p;
      if (cur && words(next) > maxWords) {
        out.push(cur);
        cur = p;
      } else cur = next;
    }
    if (cur) {
      // Still too long (no commas): split into word halves.
      const ws = cur.split(" ");
      while (ws.length > maxWords) out.push(ws.splice(0, Math.ceil(ws.length / Math.ceil(ws.length / maxWords))).join(" "));
      if (ws.length) out.push(ws.join(" "));
    }
  }
  return out;
}

const stripQuotes = (s: string): string => s.replace(/^["“”'‘]+|["“”’']+$/g, "").trim();

/** Turn a script into scenes for `format` (auto-detected when omitted). Pure. */
export function splitScript(script: string, format?: TextVideoFormat): { format: TextVideoFormat; scenes: TextScene[] } {
  const fmt = format ?? detectTextVideoFormat(script);
  const lines = script.split("\n").map((l) => l.trim()).filter(Boolean);
  const scenes: TextScene[] = [];
  if (lines.length === 0) return { format: fmt, scenes };

  if (fmt === "list") {
    let n = 0;
    let seenItem = false;
    for (const line of lines) {
      if (LIST_RE.test(line)) {
        seenItem = true;
        n++;
        const body = line.replace(LIST_RE, "").trim();
        // "Title: detail" → head + sub
        const m = body.match(/^([^:]{2,60}):\s+(.+)$/);
        scenes.push({ kind: "item", num: String(n).padStart(2, "0"), head: m ? m[1]! : body, ...(m ? { sub: m[2]! } : {}) });
      } else if (!seenItem) {
        scenes.push({ kind: "title", head: line });
      } else {
        scenes.push({ kind: "cta", head: line });
      }
    }
    return { format: fmt, scenes };
  }

  if (fmt === "quote") {
    const joined = lines.join("\n");
    const m = joined.match(AUTHOR_RE);
    const body = stripQuotes(m ? joined.slice(0, m.index).trim() : joined);
    const chunks = words(body) > 26 ? chunkProse(body, 18) : [body];
    chunks.forEach((c, i) => {
      const last = i === chunks.length - 1;
      scenes.push({ kind: "quote", head: `${i === 0 ? "“" : ""}${c}${last ? "”" : ""}`, ...(last && m ? { sub: `— ${m[1]!.trim()}` } : {}) });
    });
    return { format: fmt, scenes };
  }

  if (fmt === "lyrics") {
    for (const line of lines) scenes.push({ kind: "body", head: line });
    return { format: fmt, scenes };
  }

  if (fmt === "announcement") {
    // One paragraph ⇒ one scene per sentence; first is the headline, last the CTA.
    const parts = lines.length === 1 ? chunkProse(lines[0]!, 14) : lines;
    parts.forEach((line, i) => {
      const kind: SceneKind = i === 0 ? "title" : i === parts.length - 1 && parts.length >= 3 ? "cta" : "body";
      for (const c of kind === "body" ? chunkProse(line, 14) : [line]) scenes.push({ kind, head: c });
    });
    return { format: fmt, scenes };
  }

  // story
  const chunks = lines.length === 1 ? chunkProse(lines[0]!, 14) : lines.flatMap((l) => chunkProse(l, 14));
  chunks.forEach((c, i) => {
    const kind: SceneKind = i === 0 && chunks.length > 1 && words(c) <= 7 ? "title" : "body";
    scenes.push({ kind, head: c });
  });
  return { format: fmt, scenes };
}

/** Reading-time duration for a scene at `pace`. */
export function sceneDuration(scene: TextScene, pace: TextVideoPace, format: TextVideoFormat): number {
  if (scene.durationSec && scene.durationSec > 0) return scene.durationSec;
  const wps = pace === "slow" ? 2.2 : pace === "fast" ? 3.6 : 2.8;
  const n = words(scene.head) + (scene.sub ? words(scene.sub) * 0.6 : 0);
  if (format === "lyrics") return round(clamp(0.8 + n / 3.2, 1.5, 5));
  const min = scene.kind === "title" || scene.kind === "cta" ? 2.4 : 2;
  return round(clamp(1.4 + n / wps, min, 8));
}

// ---- build ------------------------------------------------------------------------

export interface BuildTextVideoOptions {
  /** A script (split into scenes) — or explicit `scenes`. */
  script?: string;
  scenes?: TextScene[];
  theme?: TextVideoTheme;
  format?: TextVideoFormat;
  aspect?: TextVideoAspect;
  /** Explicit frame size (overrides `aspect`; used by reframe). */
  size?: { width: number; height: number };
  pace?: TextVideoPace;
}

const SIZE_FRAC: Record<SceneKind, number> = { title: 0.13, body: 0.095, item: 0.1, quote: 0.09, cta: 0.11 };

/** Fit a font size so `text` wraps into ≤ `maxLines` within `maxW` and `maxH`. */
function fitFontSize(text: string, base: number, maxW: number, maxH: number, charW: number, lineHeight: number): number {
  const chars = Math.max(1, text.replace(/\s+/g, " ").length);
  const byArea = Math.sqrt((maxH * maxW) / (chars * charW * lineHeight));
  // A single long word must fit on one line too.
  const longest = Math.max(1, ...text.split(/\s+/).map((w) => w.length));
  const byWord = maxW / (longest * charW);
  return Math.round(clamp(Math.min(base, byArea, byWord), 22, base));
}

/** Estimated number of wrapped lines (for vertical layout). */
function estLines(text: string, fs: number, maxW: number, charW: number): number {
  return text.split("\n").reduce((n, para) => n + Math.max(1, Math.ceil((para.length * charW * fs) / maxW)), 0);
}

/**
 * Build a text video into `doc`: replaces the visual tracks with background /
 * accent / text tracks for the scenes, keeps existing AUDIO tracks (music,
 * voice-over) and their media, and records the recipe on `doc.textVideo`. Pure.
 */
export function buildTextVideo(doc: EditDoc, opts: BuildTextVideoOptions): EditDoc {
  const theme = opts.theme ?? (isTextVideoTheme(doc.textVideo?.theme) ? doc.textVideo!.theme : "bold");
  const T = TEXT_VIDEO_THEME_DEFS[theme];
  const pace = opts.pace ?? doc.textVideo?.pace ?? "normal";
  const split = opts.scenes
    ? { format: opts.format ?? ((doc.textVideo?.format as TextVideoFormat | undefined) ?? "story"), scenes: opts.scenes }
    : splitScript(opts.script ?? "", opts.format);
  const format = split.format;
  const scenes = split.scenes.filter((s) => s.head.trim().length > 0);
  if (scenes.length === 0) throw new Error("Give me some text for the video — a script, a quote, or a list.");

  const size =
    opts.size ??
    (opts.aspect
      ? TEXT_VIDEO_ASPECTS[opts.aspect]
      : doc.textVideo || !doc.tracks.some((t) => t.clips.some((c) => c.kind === "video" || c.kind === "image"))
        ? { width: doc.meta.width, height: doc.meta.height }
        : TEXT_VIDEO_ASPECTS["16:9"]);
  const W = Math.max(2, Math.round(size.width / 2) * 2);
  const H = Math.max(2, Math.round(size.height / 2) * 2);
  const portrait = H > W;
  // Type scale: the short edge, boosted on tall frames so vertical text fills the screen.
  const short = Math.min(W, H) * (portrait ? 1.3 : W / H > 1.5 ? 1 : 1.1);
  const maxW = W * (portrait ? 0.84 : 0.78);
  const X = T.transitionSec;
  const lineHeight = 1.12;

  const bgClips: unknown[] = [];
  const accClips: unknown[] = [];
  const textClips: unknown[] = [];
  let t = 0;
  scenes.forEach((scene, i) => {
    const last = i === scenes.length - 1;
    const D = Math.max(1, sceneDuration(scene, pace, format));
    const bg = T.backgrounds[i % T.backgrounds.length]!;
    bgClips.push({
      id: `tv-s${i}-bg`,
      kind: "solid",
      start: round(t),
      duration: round(D + (last ? 0 : X)),
      color: bg.color,
      ...(bg.gradient ? { gradient: bg.gradient } : {}),
      ...(bg.pattern ? { pattern: bg.pattern } : {}),
      ...(i > 0 ? { transitionInSec: X, transitionType: T.transition } : {}),
    });

    const isTitle = scene.kind === "title" || scene.kind === "cta";
    const face = isTitle || scene.kind === "item" ? T.head : { ...T.body, uppercase: false, letterSpacing: 0 };
    // Case is applied at render time (clip.uppercase) so the stored text keeps the
    // user's casing across restyles; sizing measures the displayed (cased) text.
    const headText = scene.head;
    const shown = face.uppercase ? headText.toUpperCase() : headText;
    const charW = isTitle || scene.kind === "item" ? T.charW : 0.55;
    const maxH = H * (scene.sub || scene.num ? 0.42 : 0.56);
    const fs = fitFontSize(shown, short * SIZE_FRAC[scene.kind], maxW, maxH, charW + (face.letterSpacing > 4 ? 0.12 : 0), lineHeight);
    const lines = estLines(shown, fs, maxW, charW);
    const headH = lines * fs * lineHeight;
    const subFs = Math.round(clamp(fs * 0.5, short * 0.042, short * 0.07));
    const numFs = Math.round(short * 0.16);
    // Vertical stack: [num] head [accent] [sub], centered on the frame.
    const gap = fs * 0.35;
    const barSpace = T.accentBar && (isTitle || scene.kind === "item" || scene.kind === "quote") && scene.sub ? Math.max(6, fs * 0.07) + gap * 0.6 : 0;
    const stackH = (scene.num ? numFs * 0.9 + gap : 0) + headH + (scene.sub ? gap * 1.4 + barSpace + subFs * 1.3 : 0);
    let y = H / 2 - stackH / 2;
    const tIn = round(t + (i === 0 ? 0.15 : X * 0.8));
    const tOut = round(t + D + (last ? 0 : X * 0.1));
    const span = Math.max(0.8, round(tOut - tIn));
    const motion = isTitle || scene.kind === "item" ? T.intro : T.bodyIntro;
    const exit = last ? { style: "fade" as const, durationSec: Math.max(0.3, T.exit.durationSec) } : T.exit;

    if (scene.num) {
      // On the Accents lane so it doesn't stack under the headline on the timeline.
      accClips.push({
        id: `tv-s${i}-num`,
        kind: "text",
        start: tIn,
        duration: span,
        text: scene.num,
        fontFamily: T.head.family,
        fontWeight: T.head.weight,
        fontSize: numFs,
        color: T.accent.length === 7 ? `${T.accent}66` : T.accent,
        transform: { x: W / 2, y: round(y + (numFs * 0.9) / 2) },
        anim: { style: "fade", unit: "whole", durationSec: 0.5, exit },
      });
      y += numFs * 0.9 + gap;
    }

    textClips.push({
      id: `tv-s${i}-${scene.kind}`,
      kind: "text",
      start: tIn,
      duration: span,
      text: headText,
      uppercase: face.uppercase,
      fontFamily: face.family,
      fontWeight: face.weight,
      italic: !!face.italic || scene.kind === "quote",
      fontSize: fs,
      color: T.text,
      align: "center",
      maxWidth: round(maxW),
      lineHeight,
      letterSpacing: face.letterSpacing,
      transform: { x: W / 2, y: round(y + headH / 2) },
      ...(isTitle ? (T.titleEffect ? { effect: T.titleEffect } : {}) : T.effect ? { effect: T.effect } : {}),
      anim: {
        style: motion.style,
        unit: motion.unit,
        durationSec: motion.durationSec,
        exit,
        ...(T.loop ? { loop: T.loop } : {}),
      },
    });
    y += headH;

    const hasBar = T.accentBar && (isTitle || scene.kind === "item" || scene.kind === "quote");
    if (hasBar) {
      const barW = Math.round(clamp(short * 0.12, 60, 220));
      const barH = Math.max(6, Math.round(fs * 0.07));
      accClips.push({
        id: `tv-s${i}-acc`,
        kind: "shape",
        shape: "rect",
        start: round(tIn + motion.durationSec * 0.6),
        duration: Math.max(0.5, round(span - motion.durationSec * 0.6)),
        w: barW,
        h: barH,
        radius: barH / 2,
        fill: T.accent,
        transform: { x: W / 2, y: round(y + gap * 0.7) },
        transitionInSec: 0.35,
        transitionOutSec: Math.min(0.3, exit.durationSec),
      });
    }

    if (scene.sub) {
      y += gap * 1.4 + (hasBar ? Math.max(6, fs * 0.07) + gap * 0.6 : 0);
      textClips.push({
        id: `tv-s${i}-sub`,
        kind: "text",
        start: tIn,
        duration: span,
        text: scene.sub,
        fontFamily: T.body.family,
        fontWeight: T.body.weight === "bold" ? "semibold" : T.body.weight,
        italic: !!T.body.italic,
        fontSize: subFs,
        color: T.sub,
        align: "center",
        maxWidth: round(maxW),
        lineHeight: 1.2,
        transform: { x: W / 2, y: round(y + (subFs * 1.3) / 2) },
        anim: { style: T.subIntro.style, unit: T.subIntro.unit, durationSec: T.subIntro.durationSec, delaySec: round(motion.durationSec * 0.7), exit },
      });
    }
    t += D;
  });

  const audioTracks = doc.tracks.filter((tr) => tr.kind === "audio");
  const audioMedia = new Set(audioTracks.flatMap((tr) => tr.clips.map((c) => ("mediaId" in c ? c.mediaId : ""))));
  const first = scenes[0]!.head.replace(/\s+/g, " ").trim();
  return parseEditDoc({
    ...doc,
    meta: {
      ...doc.meta,
      title: doc.textVideo ? doc.meta.title : first.length > 48 ? `${first.slice(0, 45)}…` : first,
      width: W,
      height: H,
      background: T.backgrounds[0]!.color,
    },
    media: doc.media.filter((m) => audioMedia.has(m.id)),
    tracks: [
      { id: "tv-bg", kind: "visual", name: "Backgrounds", clips: bgClips },
      { id: "tv-accents", kind: "visual", name: "Accents", clips: accClips },
      { id: "tv-text", kind: "visual", name: "Text", clips: textClips },
      ...audioTracks,
    ],
    textVideo: { theme, format, pace },
  });
}

// ---- read back + edit ------------------------------------------------------------

const ID_RE = /^tv-s(\d+)-(title|body|item|quote|cta|sub|num|bg|acc)$/;

/** True when the doc is a text video built by buildTextVideo. */
export function isTextVideo(doc: EditDoc): boolean {
  return !!doc.textVideo && doc.tracks.some((t) => t.clips.some((c) => ID_RE.test(c.id)));
}

/**
 * Read the scenes back from a text video's clips (text edits made anywhere — the
 * inspector, the Director — are respected). Durations come from the background
 * solids' starts, so scene retimes survive a rebuild.
 */
export function textVideoScenes(doc: EditDoc): TextScene[] {
  const byIndex = new Map<number, Partial<TextScene> & { bgStart?: number; bgDur?: number }>();
  for (const track of doc.tracks) {
    for (const c of track.clips) {
      const m = c.id.match(ID_RE);
      if (!m) continue;
      const i = Number(m[1]);
      const role = m[2]!;
      const s = byIndex.get(i) ?? {};
      if (role === "bg") {
        s.bgStart = c.start;
        s.bgDur = c.duration;
      } else if (c.kind === "text") {
        if (role === "sub") s.sub = c.text;
        else if (role === "num") s.num = c.text;
        else if (role !== "acc") {
          s.kind = role as SceneKind;
          s.head = c.text;
        }
      }
      byIndex.set(i, s);
    }
  }
  const idx = [...byIndex.keys()].sort((a, b) => a - b);
  return idx
    .map((i, k) => {
      const s = byIndex.get(i)!;
      const next = k + 1 < idx.length ? byIndex.get(idx[k + 1]!) : undefined;
      const dur =
        next?.bgStart !== undefined && s.bgStart !== undefined
          ? next.bgStart - s.bgStart
          : s.bgDur !== undefined
            ? s.bgDur
            : undefined;
      return {
        kind: s.kind ?? "body",
        head: s.head ?? "",
        ...(s.sub ? { sub: s.sub } : {}),
        ...(s.num ? { num: s.num } : {}),
        ...(dur ? { durationSec: round(dur) } : {}),
      } as TextScene;
    })
    .filter((s) => s.head.length > 0);
}

/** Rebuild a text video with edited scenes (keeps theme, format, pace, frame size, audio). */
export function setTextVideoScenes(doc: EditDoc, scenes: TextScene[]): EditDoc {
  return buildTextVideo(doc, { scenes, size: { width: doc.meta.width, height: doc.meta.height } });
}

/** Switch a text video to another theme, keeping its scenes and timing. */
export function restyleTextVideo(doc: EditDoc, theme: TextVideoTheme): EditDoc {
  if (!isTextVideo(doc)) throw new Error("This project isn't a text video yet — make one first.");
  const scenes = textVideoScenes(doc);
  return buildTextVideo(doc, { scenes, theme, size: { width: doc.meta.width, height: doc.meta.height } });
}

/** Re-lay a text video for a new frame size (reframe), keeping scenes + theme. */
export function retargetTextVideo(doc: EditDoc, width: number, height: number): EditDoc {
  return buildTextVideo(doc, { scenes: textVideoScenes(doc), size: { width, height } });
}

/** Change one scene's main line / sub line IN PLACE (keeps any manual styling). */
export function setSceneText(doc: EditDoc, sceneIndex: number, role: "head" | "sub", text: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let hit = false;
  for (const track of clone.tracks) {
    for (const c of track.clips) {
      const m = c.id.match(ID_RE);
      if (!m || Number(m[1]) !== sceneIndex || c.kind !== "text") continue;
      const isHead = m[2] !== "sub" && m[2] !== "num";
      if ((role === "head" && isHead) || (role === "sub" && m[2] === "sub")) {
        c.text = text;
        hit = true;
      }
    }
  }
  if (!hit && role === "sub" && text.trim()) {
    const scenes = textVideoScenes(doc);
    const s = scenes[sceneIndex];
    if (s) {
      scenes[sceneIndex] = { ...s, sub: text };
      return setTextVideoScenes(doc, scenes);
    }
  }
  return parseEditDoc(clone);
}
