/**
 * StubDirector — deterministic, offline, free stand-in for the real Claude
 * Director. It parses a plain-language request, detects one or more intents,
 * and runs the matching typed tools IN ORDER (builders first, then transforms),
 * so custom multi-step scenarios work, e.g.:
 *   "cut a 30s highlight, make it vertical with captions and a warm look"
 * The real Director swaps this rules brain for an LLM but calls the same tools.
 */
import { docDurationSec, FONT_LIBRARY, fontStack, type ColorGrade, type EditDoc, type TextAnimStyle } from "@cadence/core";
import {
  isTextVideo,
  type TextVideoAspect,
  type TextVideoFormat,
  type TextVideoPace,
  type TextVideoTheme,
} from "./textvideo";
import type { AnimateTextInput, SetBackgroundInput, StyleTextInput } from "./text-ops";
import type { ProjectState } from "./project";
import type { TransitionType } from "@cadence/core";
import {
  addCalloutTool,
  addMarkerTool,
  animateTextTool,
  makeTextVideoTool,
  restyleTextVideoTool,
  setBackgroundTool,
  styleTextTool,
  addMaskTool,
  adjustColorTool,
  adjustCurvesTool,
  adjustHslTool,
  animateTool,
  audioFadeTool,
  autoMixTool,
  autoReframeTool,
  blurRegionTool,
  brollTool,
  buildDemoTool,
  captionsTool,
  chromaKeyTool,
  createHighlightTool,
  editByTranscriptTool,
  emphasisTool,
  fadesTool,
  fillerCutTool,
  freezeFrameTool,
  generateVoiceoverTool,
  kineticTitleTool,
  lookTool,
  musicTool,
  normalizeLoudnessTool,
  pixelateRegionTool,
  platformTool,
  qualityTool,
  reframeTool,
  removeSilenceTool,
  reverseClipTool,
  setBlendTool,
  setPanTool,
  slideshowTool,
  speedTool,
  styleCaptionsTool,
  titleTool,
  transitionTool,
  vfxTool,
  zoomTool,
  type ToolCall,
} from "./tools";
import { currentGrade } from "./edits";
import {
  addSfxTool,
  autoDuckTool,
  autoSfxTool,
  beatSyncTool,
  enhanceVoiceTool,
  generateMusicTool,
} from "./tools";
import { speechRegions } from "./audio";
import { isSynthSrc } from "./sound-synth";
import type { MusicMood, SfxKind } from "./sound-synth";
import type { BrollCorner, CaptionStyleOpts, TitleAnimStyle, TitleStyle, TranscriptEditMode, TranscriptEditUnit } from "./edits";
import type { AspectKey, LookKey, PlatformKey, QualityKey } from "./edits";
import type { BlendMode, CurvePoint, KeyframeEasing, KeyframeProp } from "@cadence/core";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export interface DirectorResult {
  doc: EditDoc;
  summary: string;
  toolCalls: ToolCall[];
  durationSec: number;
}

interface PlannedStep {
  run: (project: ProjectState) => Promise<{ summary: string; durationSec: number }>;
  call: ToolCall;
}

function parseTargetSeconds(req: string): number {
  // Allow a hyphen or space between the number and its unit ("45-second", "2 min").
  const min = req.match(/(\d+(?:\.\d+)?)[-\s]*(?:m|min|minute)/i);
  if (min) return Math.round(parseFloat(min[1]!) * 60);
  const sec = req.match(/(\d+(?:\.\d+)?)[-\s]*(?:s|sec|second)/i);
  if (sec) return Math.round(parseFloat(sec[1]!));
  return 60;
}

function parseAspect(req: string): AspectKey | null {
  if (/9:16|vertical|reels?|shorts|tik ?tok|story|stories/.test(req)) return "9:16";
  if (/2\.39|2\.40|2\.35|anamorphic|cinemascope|\bscope\b|letterbox/.test(req)) return "2.39:1";
  if (/21:9|ultra ?wide/.test(req)) return "21:9";
  if (/1:1|square/.test(req)) return "1:1";
  if (/2:3|tall portrait/.test(req)) return "2:3";
  if (/4:5|portrait/.test(req)) return "4:5";
  if (/4:3|fullscreen|full ?screen|\bclassic\b/.test(req)) return "4:3";
  if (/16:9|widescreen|landscape|horizontal/.test(req)) return "16:9";
  if (/reframe|resize|aspect/.test(req)) return "9:16";
  return null;
}

/**
 * Parse a custom width×height ("reframe to 1600x900", "make it 1200 by 675").
 * Requires both dimensions to be 3–5 digits so it never collides with a speed /
 * zoom factor like "1.5x". Returns null when no explicit WxH is present.
 */
function parseCustomReframe(req: string): { width: number; height: number } | null {
  const m = req.match(/(\d{3,5})\s*(?:[x×]|by)\s*(\d{3,5})/);
  if (!m) return null;
  return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
}

function parseLook(req: string): LookKey | null {
  if (/\b(no|remove|reset)\s+(look|grade|colou?r|filter)\b/.test(req)) return "none";
  if (/bleach.?bypass|silver.?retention/.test(req)) return "bleach-bypass";
  if (/golden.?hour|sunset|magic hour/.test(req)) return "golden-hour";
  if (/\bmatte\b|faded look|lifted blacks?|washed film/.test(req)) return "matte";
  if (/\bmoody\b|dark and? moody|somber|broody/.test(req)) return "moody";
  if (/noir/.test(req)) return "noir";
  if (/black.?and.?white|b\s?&\s?w|grayscale|greyscale|monochrome/.test(req)) return "bw";
  if (/vintage|retro|old ?film|nostalg/.test(req)) return "vintage";
  if (/cinematic|film(ic)?|movie/.test(req)) return "cinematic";
  if (/vibrant/.test(req)) return "vibrant";
  // "punch/punchy" as a LOOK only when it isn't a punch-IN emphasis request.
  if (/\bpunch(y)?\b/.test(req) && !/punch.?in|push in/.test(req)) return "punch";
  if (/vivid|saturat/.test(req)) return "vivid";
  if (/warm|golden|cozy|cosy/.test(req)) return "warm";
  if (/cool|cold|blue/.test(req)) return "cool";
  if (/look|grade|colou?r|filter/.test(req)) return "warm";
  return null;
}

function parseTitle(req: string, original: string): { text: string; style: TitleStyle } | null {
  if (!/\btitle\b|title card|lower.?third|name card|intro text/.test(req)) return null;
  const style: TitleStyle = /lower.?third/.test(req) ? "lower-third" : "card";
  const quoted = original.match(/["“'“”]([^"“”']{1,60})["“”']/);
  let text = quoted?.[1] ?? null;
  if (!text) {
    const m = original.match(/(?:titled|that says|called|saying|title:?)\s+(.+)$/i);
    if (m) text = m[1]!.trim().replace(/[.]+$/, "");
  }
  return { text: text ?? "Title", style };
}

function parseKineticTitle(req: string, original: string): { text: string; style: TitleAnimStyle } | null {
  const wantsKinetic =
    /\bkinetic\b|animated title|title that (slides|animates|pops|bounces|moves|flies)|slide.?in title|pop.?in title|bounce.?in title|animate (the )?title|(pop|bounce|bouncing|bouncy)\s+title|title that pops/.test(
      req,
    );
  if (!wantsKinetic) return null;
  const style: TitleAnimStyle = /\bbounce|bouncing|bouncy\b/.test(req)
    ? "bounce"
    : /\bpops?\b|pop.?in/.test(req)
      ? "pop"
      : "kinetic";
  const quoted = original.match(/["“'“”]([^"“”']{1,60})["“”']/);
  let text = quoted?.[1] ?? null;
  if (!text) {
    const m = original.match(/(?:titled|that says|called|saying|title:?)\s+(.+)$/i);
    if (m) text = m[1]!.trim().replace(/[.]+$/, "");
  }
  return { text: text ?? "Title", style };
}

function parseBrollCorner(req: string): BrollCorner | undefined {
  if (/top.?left/.test(req)) return "top-left";
  if (/top.?right/.test(req)) return "top-right";
  if (/bottom.?left/.test(req)) return "bottom-left";
  if (/bottom.?right|corner/.test(req)) return "bottom-right";
  if (/cent(er|re)/.test(req)) return "center";
  return undefined;
}

/** Parse an "at Ns" / "at N seconds" timeline offset, if present. */
function parseAtSeconds(req: string): number | undefined {
  const m = req.match(/(?:\bat|from|around)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|second)/i);
  if (m) return parseFloat(m[1]!);
  return undefined;
}

/** Parse a zoom factor like "1.4x", "1.4 x", or "30%" (→ 1.3). */
function parseZoom(req: string): number | undefined {
  const x = req.match(/(\d+(?:\.\d+)?)\s*x\b/);
  if (x) return parseFloat(x[1]!);
  const pct = req.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return 1 + parseFloat(pct[1]!) / 100;
  return undefined;
}

/** Parse a bare speed factor like "2x", "0.5 x", "0.25x". */
function parseSpeedFactor(req: string): number | undefined {
  const x = req.match(/(\d+(?:\.\d+)?)\s*x\b/);
  if (x) return parseFloat(x[1]!);
  if (/half speed/.test(req)) return 0.5;
  if (/double speed|twice as fast/.test(req)) return 2;
  return undefined;
}

/**
 * Parse a speed-ramp request → a multiplier. Handles "slow motion / slow it
 * down / speed up / 2x / 0.5x". Returns null when the request isn't about speed.
 * A bare "Nx" only counts as speed when no punch-in/zoom context is present
 * (those own the zoom factor).
 */
function parseSpeed(req: string): number | undefined {
  if (/slow ?mo(tion)?|slo-?mo|slow it down|slow down|half speed/.test(req)) {
    return parseSpeedFactor(req) ?? 0.5;
  }
  if (/speed (it |the )?up|speed up|fast ?forward|faster|double speed|twice as fast/.test(req)) {
    return parseSpeedFactor(req) ?? 2;
  }
  if (/\bspeed\b/.test(req)) {
    return parseSpeedFactor(req); // "set speed to 1.5x"; undefined ⇒ skip (ambiguous)
  }
  // A bare factor ("make it 2x", "0.5x") means speed only if not a zoom/punch cmd.
  if (!/punch|zoom|emphasi|reframe|crop/.test(req)) return parseSpeedFactor(req);
  return undefined;
}

/**
 * Parse a manual (static) zoom/reframe → { scale, pan }. Handles "zoom in 1.5x",
 * "zoom to 2x", "crop to the center", "reframe". Distinct from the animated
 * punch-in emphasis ("punch in"). Returns null when not a reframe request.
 */
function parseZoomReframe(req: string): { scale?: number; panXFrac?: number; panYFrac?: number } | null {
  // "zoom in/to" or "crop" (a static reframe). NOT bare "reframe"/"resize" —
  // those mean an aspect-ratio change (parseAspect owns them).
  const isReframe = /zoom (in|to)|\bcrop\b/.test(req);
  if (!isReframe) return null;
  const scale = parseZoom(req);
  let panXFrac = 0;
  let panYFrac = 0;
  if (/\bleft\b/.test(req)) panXFrac = -0.18;
  if (/\bright\b/.test(req)) panXFrac = 0.18;
  if (/\btop\b|\bup\b/.test(req)) panYFrac = -0.18;
  if (/\bbottom\b|\bdown\b/.test(req)) panYFrac = 0.18;
  return { scale, panXFrac: panXFrac || undefined, panYFrac: panYFrac || undefined };
}

/** Parse a transition style ("dip to black / slide / wipe / dissolve / zoom / smooth"). */
function parseTransition(req: string): TransitionType | null {
  if (/dip.?to.?black|dip to black|fade through black/.test(req)) return "dip-to-black";
  if (/wipe/.test(req)) return "wipe";
  if (/dissolve/.test(req)) return "dissolve";
  if (/zoom (transition|between)|zoom.?in transition|zooming transition/.test(req)) return "zoom";
  if (/smooth (transition|slide|between)|smooth transitions?/.test(req)) return "smooth";
  if (/slide (transition|between)|sliding transition|slide transitions?/.test(req)) return "slide";
  if (/cross.?fade/.test(req)) return "crossfade";
  if (/transition/.test(req)) return "crossfade";
  return null;
}

/**
 * Parse whole-frame VFX overlays ("add a vignette", "film grain", "light leak").
 * Returns null when the request mentions none. Strengths are sensible defaults.
 */
function parseVfx(req: string): { vignette?: number; grain?: number; lightLeak?: boolean } | null {
  const out: { vignette?: number; grain?: number; lightLeak?: boolean } = {};
  if (/vignette|darken (the )?edges|dark edges|edge darkening/.test(req)) out.vignette = 0.5;
  if (/grain|film.?grain|grainy|noise texture|add noise/.test(req)) out.grain = 0.35;
  if (/light.?leak|lens flare|leak of light|warm leak/.test(req)) out.lightLeak = true;
  return Object.keys(out).length ? out : null;
}

const CAPTION_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  yellow: "#ffe14d",
  red: "#ff4d4d",
  green: "#4dff88",
  blue: "#4db4ff",
  orange: "#ff9f40",
  pink: "#ff6fb5",
};

/**
 * Parse a caption STYLE request ("white captions", "bold yellow captions with a
 * black outline", "captions at the top"). Returns null unless the request is
 * about captions AND names at least one style attribute (color / weight / outline
 * / position / font), so a plain "add captions" still routes to add_captions only.
 */
function parseCaptionStyle(req: string): CaptionStyleOpts | null {
  if (!/caption|subtitle/.test(req)) return null;
  const out: CaptionStyleOpts = {};
  for (const [name, hex] of Object.entries(CAPTION_COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(req)) {
      out.color = hex;
      break;
    }
  }
  if (/\bbold\b/.test(req)) out.fontWeight = "bold";
  else if (/semi.?bold/.test(req)) out.fontWeight = "semibold";
  else if (/\bmedium weight|medium captions?\b/.test(req)) out.fontWeight = "medium";
  if (/outline|stroke|border|outlined/.test(req)) {
    out.outlineWidth = 6;
    out.outlineColor = /white outline/.test(req) ? "#ffffff" : "#000000";
  }
  if (/at the top|on top|up top|top of (the )?(screen|frame)/.test(req)) out.position = "top";
  else if (/in the (middle|cent(er|re))|cent(er|re)ed captions?/.test(req)) out.position = "center";
  else if (/at the bottom|bottom of (the )?(screen|frame)/.test(req)) out.position = "bottom";
  if (/big(ger)? captions?|large captions?/.test(req)) out.fontSize = 84;
  else if (/small(er)? captions?|tiny captions?/.test(req)) out.fontSize = 40;
  return Object.keys(out).length ? out : null;
}


// ---- text video ------------------------------------------------------------

const TEXT_VIDEO_TRIGGER =
  /text[- ]?(?:only[- ])?video|typography video|kinetic typography|animated text video|motion text video|video (?:from|out of) (?:this |my |the |some )?(?:text|script|words|quote|list)|(?:script|text|words|quote|list|tips) (?:in)?to (?:a )?video|quote video|lyrics? video|list video|tips video|announcement video|make (?:me )?(?:a )?video (?:that says|saying|with (?:the )?(?:text|words))|(?:video|reel|short|story) (?:that says|saying)/;

const THEME_WORDS: [RegExp, TextVideoTheme][] = [
  [/\bneon\b|glow(?:ing)? sign/, "neon"],
  [/\bminimal|minimalist|\bclean\b|\bsimple\b/, "minimal"],
  [/elegant|luxury|luxurious|classy|\bgold(?:en)?\b|wedding/, "elegant"],
  [/playful|\bfun\b|cute|pastel|kids?\b|birthday/, "playful"],
  [/corporate|business|professional|\bpitch\b|company/, "corporate"],
  [/\bretro\b|vintage|70s|80s|groovy/, "retro"],
  [/aurora|dreamy|northern lights|ethereal/, "aurora"],
  [/cinematic|movie|trailer|\bepic\b|dramatic/, "cinematic"],
  [/hand-?written|handwriting|notebook|\bnotes?\b|marker/, "handwritten"],
  [/\bbold\b|\bloud\b|punchy|energetic|hype/, "bold"],
];

function parseTheme(instr: string): TextVideoTheme | undefined {
  for (const [re, key] of THEME_WORDS) if (re.test(instr)) return key;
  return undefined;
}

function parseTextVideoFormat(instr: string): TextVideoFormat | undefined {
  if (/\bquote\b|quotation/.test(instr)) return "quote";
  if (/\blist\b|\btips?\b|\bsteps?\b|top \d+|countdown|reasons/.test(instr)) return "list";
  if (/announce|announcement|launch|\bsale\b|promo|event|invite|invitation/.test(instr)) return "announcement";
  if (/lyrics?\b|song/.test(instr)) return "lyrics";
  if (/\bstory\b/.test(instr)) return "story";
  return undefined;
}

function parseTextVideoAspect(instr: string): TextVideoAspect | undefined {
  if (/9:16|vertical|portrait|reels?|shorts|tik ?tok|stor(?:y|ies)/.test(instr)) return "9:16";
  if (/1:1|square|feed post/.test(instr)) return "1:1";
  if (/4:5/.test(instr)) return "4:5";
  if (/16:9|widescreen|landscape|horizontal|youtube/.test(instr)) return "16:9";
  return undefined;
}

/**
 * Pull the SCRIPT (the words to show) out of a request, preserving case:
 * text after the first colon, else the longest quoted span, else after
 * "saying/that says/with the text", else every line after the first. Returns the
 * script and the remaining INSTRUCTION (lowercased) so theme/format/aspect words
 * are only read from the instruction — never from the user's own script.
 */
export function extractScript(original: string): { script: string; instruction: string } {
  const text = original.trim();
  const colon = text.indexOf(":");
  if (colon > 0 && colon < 160) {
    const rest = text.slice(colon + 1).trim();
    if (rest.split(/\s+/).filter(Boolean).length >= 2) {
      return { script: rest, instruction: text.slice(0, colon).toLowerCase() };
    }
  }
  const quoted = [...text.matchAll(/[“"]([^”"]{3,})[”"]/g)].map((m) => m[1]!).sort((a, b) => b.length - a.length)[0];
  if (quoted) return { script: quoted.trim(), instruction: text.replace(quoted, " ").toLowerCase() };
  const saying = text.match(/\b(?:saying|that says|with the (?:text|words))\s+(.{3,})$/is);
  if (saying) return { script: saying[1]!.trim(), instruction: text.slice(0, saying.index).toLowerCase() };
  const lines = text.split("\n");
  if (lines.length >= 2) return { script: lines.slice(1).join("\n").trim(), instruction: lines[0]!.toLowerCase() };
  return { script: "", instruction: text.toLowerCase() };
}

function parseTextVideo(
  req: string,
  original: string,
  hasVisualMedia: boolean,
): { input: { script: string; theme?: TextVideoTheme; format?: TextVideoFormat; aspect?: TextVideoAspect; pace?: TextVideoPace }; instruction: string } | null {
  const explicit = TEXT_VIDEO_TRIGGER.test(req);
  const { script, instruction } = extractScript(original);
  // Without media, "make a video: <words>" is a text video too.
  const implicit = !hasVisualMedia && !!script && /\b(?:make|create|build|turn|generate)\b[\s\S]*\bvideo\b|\bvideo\b/.test(instruction);
  if (!explicit && !implicit) return null;
  const pace: TextVideoPace | undefined = /\bslow(?:er|ly)?\b|calm|relaxed/.test(instruction)
    ? "slow"
    : /\bfast(?:er)?\b|quick|snappy|rapid/.test(instruction)
      ? "fast"
      : undefined;
  const theme = parseTheme(instruction);
  const format = parseTextVideoFormat(instruction);
  const aspect = parseTextVideoAspect(instruction);
  return {
    input: { script, ...(theme ? { theme } : {}), ...(format ? { format } : {}), ...(aspect ? { aspect } : {}), ...(pace ? { pace } : {}) },
    instruction,
  };
}

/** "switch to the neon theme", "make it elegant", "restyle as retro" — on a text video. */
function parseRestyle(req: string): TextVideoTheme | null {
  if (!/theme|style|restyle|make it|switch|change|look|turn it|go /.test(req)) return null;
  return parseTheme(req) ?? null;
}

const ANIM_WORDS: [RegExp, TextAnimStyle][] = [
  [/typewriter|type(?:s|d)? (?:out|in)|typing/, "typewriter"],
  [/scrambl|decod|hacker|matrix/, "scramble"],
  [/glitch/, "glitch"],
  [/neon|flicker(?:s)? on/, "neon"],
  [/stomp|slam/, "stomp"],
  [/blur(?:s|red)?[- ]?in|unblur|come into focus|focus in/, "blur-in"],
  [/baseline|rise from (?:behind|below) (?:a |the )?line/, "baseline"],
  [/tumble/, "tumble"],
  [/\bspin/, "spin"],
  [/\bflip/, "flip"],
  [/wipe|reveal/, "wipe"],
  [/zoom(?:s)?[- ]?in|grow(?:s)? in|scale(?:s)? in/, "zoom-in"],
  [/slide(?:s)?[- ]?(?:in )?from (?:the )?left|from the left/, "slide-right"],
  [/slide(?:s)?[- ]?in|slide(?:s)?[- ]?(?:in )?from (?:the )?right|from the right/, "slide-left"],
  [/\bdrop(?:s)?\b|fall(?:s)? in|from above/, "drop"],
  [/\brise|rising|float(?:s)? up|from below|slide(?:s)? up/, "rise"],
  [/\bpop/, "pop"],
  [/bounc/, "bounce"],
  [/fade(?:s)?[- ]?in|\bfade\b/, "fade"],
];

function parseAnimateText(rawReq: string): AnimateTextInput | null {
  // "fade in and out" / "fade to black" are whole-video fades (add_fades), and a
  // request that CREATES a title carries its own animation — neither re-animates text.
  const req = rawReq.replace(/fade(?:s)? (?:in and out|in\/out|in & out|(?:from|to) black|out at the end)/g, " ");
  const explicitAnim = /animat|letter[- ]by[- ]letter|word[- ]by[- ]word|line[- ]by[- ]line|each (?:letter|word|line)/.test(req);
  if (!explicitAnim && /kinetic title|add (?:a |an )?(?:\w+ )?title|title card|lower.?third|name card|intro text/.test(req)) return null;
  const textish = /\btext\b|title|letters?|words?|lines?|heading|typography|caption/.test(req);
  if (!textish && !/animat/.test(req)) return null;
  const out: AnimateTextInput = {};
  const introPart = req.replace(/(?:fade|slide|zoom|blur|wipe|sink|rise|tumble|blow)(?:s)?[- ]?(?:out|away)[^,.;]*/g, " ");
  for (const [re, style] of ANIM_WORDS) {
    if (re.test(introPart)) {
      out.style = style;
      break;
    }
  }
  if (/letter[- ]by[- ]letter|each letter|per letter|\bletters\b|character by character/.test(req)) out.unit = "letter";
  else if (/word[- ]by[- ]word|each word|per word|one word at a time|\bwords\b/.test(req)) out.unit = "word";
  else if (/line[- ]by[- ]line|each line|per line/.test(req)) out.unit = "line";
  const ex = req.match(/(fade|slide|zoom|blur|wipe|sink|rise|tumble|blow)(?:s)?[- ]?(?:out|away)/);
  if (ex) {
    const w = ex[1]!;
    out.exit = w === "fade" ? "fade" : w === "slide" ? "slide-left" : w === "zoom" ? "zoom-out" : w === "blur" ? "blur-out" : w === "wipe" ? "wipe" : w === "sink" ? "sink" : w === "rise" ? "rise" : w === "tumble" ? "tumble" : "blow-up";
  }
  const loop = req.match(/\b(breath(?:e|ing)|float(?:ing)?|bob(?:bing)?|wiggl(?:e|ing)|flicker(?:ing)?|puls(?:e|ing)|shak(?:e|ing)|wav(?:e|y|ing))\b/);
  if (loop && !/float(?:s)? up/.test(req)) {
    const w = loop[1]!;
    out.loop = w.startsWith("breath") ? "breathe" : w.startsWith("float") || w.startsWith("bob") ? "float" : w.startsWith("wiggl") ? "wiggle" : w.startsWith("flicker") ? "flicker" : w.startsWith("puls") ? "pulse" : w.startsWith("shak") ? "shake" : "wave";
  }
  if (!out.style && /\b(?:slow(?:er)?|more slowly)\b/.test(req) && /anim|text|letters|words|title/.test(req)) out.speedScale = 1.5;
  else if (!out.style && /\b(?:fast(?:er)?|quick(?:er)?|snappier|speed (?:it )?up)\b/.test(req) && /anim|text|letters|words|title/.test(req)) out.speedScale = 0.65;
  if (!out.style && !out.exit && !out.loop && !out.speedScale) return null;
  if (/\ball (?:the )?text|every(?:thing)?\b/.test(req)) out.target = "all";
  if (/slow(?:ly)?/.test(req) && out.style) out.durationSec = 1.4;
  else if (/fast|quick|snappy/.test(req) && out.style) out.durationSec = 0.45;
  return out;
}

const COLOR_WORDS: Record<string, string> = {
  ...CAPTION_COLORS,
  purple: "#a855f7",
  violet: "#8b5cf6",
  teal: "#14b8a6",
  cyan: "#22d3ee",
  gold: "#e8c77a",
  golden: "#e8c77a",
  navy: "#0b2545",
  gray: "#9ca3af",
  grey: "#9ca3af",
  cream: "#f6f1e3",
  mint: "#a7f3d0",
  coral: "#ff7f6e",
};

function colorIn(s: string): string | undefined {
  for (const [name, hex] of Object.entries(COLOR_WORDS)) if (new RegExp(`\\b${name}\\b`).test(s)) return hex;
  return undefined;
}

function parseStyleText(req: string): StyleTextInput | null {
  if (/caption|subtitle/.test(req)) return null; // captions have their own styler
  const aboutText = /\btext\b|title|font|letters|heading|typography|words/.test(req);
  const out: StyleTextInput = {};
  const font = FONT_LIBRARY.find((f) => req.includes(f.family.toLowerCase()));
  if (font) out.fontFamily = fontStack(font);
  if (!aboutText && !font) return null;
  const color = req.match(/(?:text|title|font|letters)(?: colou?r)?(?: to| in)? (\w+)|(\w+) (?:text|titles?|letters|font)\b/);
  const cword = color ? (color[1] ?? color[2])! : "";
  if (COLOR_WORDS[cword]) out.color = COLOR_WORDS[cword];
  if (/neon|glow(?:ing|y)?\b/.test(req)) out.effect = { style: "neon", intensity: 0.6, offset: 0.5, direction: -45 };
  else if (/hollow|outlined? (?:text|letters)|outline only/.test(req)) out.effect = { style: "hollow", intensity: 0.5, offset: 0.5, direction: -45 };
  else if (/\becho\b/.test(req)) out.effect = { style: "echo", intensity: 0.5, offset: 0.5, direction: -45 };
  else if (/glitch/.test(req) && !/glitch(?:es|ing)? in/.test(req)) out.effect = { style: "glitch", intensity: 0.5, offset: 0.5, direction: -45 };
  else if (/splice/.test(req)) out.effect = { style: "splice", intensity: 0.5, offset: 0.5, direction: -45 };
  else if (/\blift\b|drop shadow|shadow/.test(req)) out.effect = { style: "lift", intensity: 0.5, offset: 0.5, direction: -45 };
  else if (/highlight(?:ed|er)?|marker/.test(req)) out.effect = { style: "highlight", intensity: 0.6, offset: 0.5, direction: -45, ...(colorIn(req) ? { color: colorIn(req)! } : {}) };
  else if (/no effect|remove (?:the )?effect|plain text/.test(req)) out.effect = null;
  if (/rainbow/.test(req)) out.fillGradient = { stops: ["#ff5f6d", "#ffc371", "#47e891", "#4facfe"], angle: 0 };
  else if (/gradient (?:text|fill|title|letters)|(?:text|title|letters) gradient/.test(req)) out.fillGradient = { stops: ["#ff7a18", "#af002d", "#319197"], angle: 0 };
  if (/all caps|uppercase|capital letters|in caps/.test(req)) out.uppercase = true;
  else if (/lower ?case|no caps|sentence case/.test(req)) out.uppercase = false;
  if (/\bbold(?:er)?\b/.test(req) && aboutText) out.fontWeight = "bold";
  if (/\bitalic/.test(req)) out.italic = true;
  if (/(?:text|title|font|letters) (?:bigger|larger)|bigger (?:text|title|font)|larger (?:text|title|font)/.test(req)) out.sizeScale = 1.2;
  else if (/(?:text|title|font|letters) smaller|smaller (?:text|title|font)/.test(req)) out.sizeScale = 0.85;
  if (/wide(?:r)? (?:letter )?spacing|spaced out|tracking/.test(req)) out.letterSpacing = 8;
  if (/\ball (?:the )?text|every(?:thing)?\b/.test(req)) out.target = "all";
  const keys = Object.keys(out).filter((k) => k !== "target");
  return keys.length ? out : null;
}

function parseBackground(req: string): SetBackgroundInput | null {
  if (!/background|backdrop/.test(req) || /background music|\bbgm\b|background (?:song|track|audio|sound)/.test(req)) return null;
  const out: SetBackgroundInput = {};
  const colors = Object.entries(COLOR_WORDS)
    .filter(([name]) => new RegExp(`\\b${name}\\b`).test(req))
    .map(([, hex]) => hex);
  const motion = /aurora|northern lights/.test(req)
    ? "aurora"
    : /spin(?:ning)?|rotat/.test(req)
      ? "spin"
      : /puls|breath/.test(req)
        ? "pulse"
        : /animat|moving|drift|flow/.test(req)
          ? "drift"
          : "none";
  if (/gradient|aurora|animat|moving|drift|flow|pulse|spin/.test(req)) {
    const stops =
      colors.length >= 2
        ? colors.slice(0, 4)
        : motion === "aurora"
          ? ["#1a1446", "#7b2ff7", "#00c2ff", "#ff5edb"]
          : colors.length === 1
            ? [colors[0]!, "#0b0b12"]
            : ["#ff512f", "#dd2476"];
    out.gradient = { kind: /radial|spotlight|glow/.test(req) ? "radial" : "linear", angle: 135, stops, motion, speed: 1 };
    out.color = stops[0]!;
  } else if (colors.length > 0) {
    out.color = colors[0]!;
    out.gradient = null;
  }
  const pattern = /polka|dots?\b|dotted/.test(req) ? "dots" : /grid/.test(req) ? "grid" : /diagonal|stripes?/.test(req) ? "diagonal" : /\blines?\b|lined|ruled/.test(req) ? "lines" : null;
  if (pattern) out.pattern = { kind: pattern, color: "#ffffff", opacity: 0.1, scale: 1 };
  else if (/no pattern|remove (?:the )?pattern|plain background/.test(req)) out.pattern = null;
  return Object.keys(out).length ? out : null;
}

/**
 * Parse a RELATIVE color adjustment ("brighter", "more contrast", "warmer",
 * "less saturated") into absolute grade targets, computed from the doc's CURRENT
 * grade so repeated nudges accumulate. Returns null when the request isn't a
 * relative tweak (a named preset like "warm look" is handled by parseLook). The
 * comparative forms take precedence over the presets (see interpret()).
 */
function parseColorAdjust(req: string, doc: EditDoc): Partial<ColorGrade> | null {
  const g = currentGrade(doc);
  const out: Partial<ColorGrade> = {};
  const STEP = 0.12;
  if (/brighter|brighten|lighter|more (light|exposure)|raise exposure/.test(req))
    out.brightness = round(clamp(g.brightness + STEP, 0.2, 3));
  if (/darker|darken|dimmer|less (light|exposure|bright)/.test(req))
    out.brightness = round(clamp(g.brightness - STEP, 0.2, 3));
  if (/more contrast|punchier|higher contrast|add contrast|increase contrast/.test(req))
    out.contrast = round(clamp(g.contrast + STEP, 0.2, 3));
  if (/less contrast|flatter|lower contrast|reduce contrast|decrease contrast/.test(req))
    out.contrast = round(clamp(g.contrast - STEP, 0.2, 3));
  if (/more saturat|more colou?r|richer|boost colou?r|deeper colou?r/.test(req))
    out.saturation = round(clamp(g.saturation + 0.15, 0, 3));
  if (/less saturat|desaturat|muted|washed?.?out|reduce colou?r|drain (the )?colou?r/.test(req))
    out.saturation = round(clamp(g.saturation - 0.15, 0, 3));
  if (/warmer|warm it up|more warmth|add warmth/.test(req))
    out.warmth = round(clamp(g.warmth + 0.15, 0, 1));
  if (/cooler|cool it (down|off)|less warmth|more blue|colder/.test(req))
    out.warmth = round(clamp(g.warmth - 0.15, 0, 1));
  return Object.keys(out).length ? out : null;
}

/**
 * Parse a callout / highlight request → a default rect (with optional zoom + label)
 * over the frame. Handles "highlight the …", "call out the …", and "zoom into the
 * …" (a callout zoom, distinct from the numeric static "zoom in 1.5x"). Since raw
 * screenshots carry no field pixels, the rect is a sensible centered default the
 * user can nudge. Returns null when the request is neither.
 */
function parseCallout(
  req: string,
  doc: EditDoc,
): { x: number; y: number; w: number; h: number; label?: string; zoom?: number } | null {
  const hasFactor = /\d+(?:\.\d+)?\s*x\b/.test(req);
  const isZoomInto = /zoom\s+(?:into|in on|in to|on)\b/.test(req) && !hasFactor;
  const isHighlight = /highlight|call ?out|point (?:to|at)|draw attention to/.test(req);
  if (!isZoomInto && !isHighlight) return null;
  const W = doc.meta.width;
  const H = doc.meta.height;
  // Centered default rect (~half width, a band tall).
  const rect = { x: round(W * 0.25), y: round(H * 0.4), w: round(W * 0.5), h: round(H * 0.18) };
  const m = req.match(/(?:highlight|call ?out|zoom\s+(?:into|in on|in to|on)|point (?:to|at))\s+(?:the\s+)?([a-z0-9 ]{1,30})/);
  const label = m?.[1]?.trim() || undefined;
  return { ...rect, ...(label ? { label } : {}), ...(isZoomInto ? { zoom: 1.4 } : {}) };
}

/**
 * Parse a delivery-platform request ("export for tiktok", "make it for youtube",
 * "reels", "instagram story"). Shorts/story are checked before their parent so
 * "youtube shorts" and "instagram story" win. Returns null when none is named.
 */
function parsePlatform(req: string): PlatformKey | null {
  if (/tik ?tok/.test(req)) return "tiktok";
  if (/youtube shorts|yt shorts|\bshorts\b/.test(req)) return "youtube-shorts";
  if (/insta(gram)? (story|stories)|ig story/.test(req)) return "instagram-story";
  if (/insta(gram)? (feed|post)|ig feed|instagram\b/.test(req)) return "instagram-feed";
  if (/\breels?\b/.test(req)) return "reels";
  if (/youtube|yt\b/.test(req)) return "youtube";
  return null;
}

/**
 * Parse an animation (keyframe) request. Handles "fade the title", "animate the
 * title" (opacity on the titles track), and "over time / animate / gradually /
 * keyframe" for a zoom (scale), fade (opacity), or rotation. Returns null when
 * the request isn't animation-shaped.
 */
function parseAnimate(
  req: string,
): { prop: KeyframeProp; from?: number; to: number; easing?: KeyframeEasing; track?: string } | null {
  if (/fade (in )?(the |a )?title|animate (the )?title|title (that )?fades? in/.test(req)) {
    return { prop: "opacity", from: 0, to: 1, easing: "ease-in", track: "titles" };
  }
  const overTime = /over time|animate\b|gradually|keyframe|slowly (zoom|push|pan)/.test(req);
  if (!overTime) return null;
  if (/rotat|spin/.test(req)) return { prop: "rotation", from: 0, to: 360, easing: "linear" };
  if (/fade|opacity/.test(req)) return { prop: "opacity", from: 0, to: 1, easing: "ease-in-out" };
  // Default: a zoom / push-in over time (scale). Honor an explicit factor.
  const to = parseZoom(req) ?? 1.3;
  return { prop: "scale", from: 1, to, easing: "ease-in-out" };
}

function parseQuality(req: string): { preset: QualityKey; aiUpscale: boolean } | null {
  const aiUpscale = /\bai\b.*upscal|upscale.*\bai\b|super.?resolution|super.?res/.test(req);
  if (/4k|ultra|2160/.test(req)) return { preset: "ultra", aiUpscale };
  if (/high.?quality|\bhd\b|1440|sharpen|enhance|crisp|1080p?\+|better quality|improve quality/.test(req))
    return { preset: "high", aiUpscale };
  if (/\bupscale\b|higher quality|more quality|quality/.test(req)) return { preset: "high", aiUpscale };
  return null;
}

/**
 * Parse a chroma-key request ("green screen", "remove the green/blue background",
 * "key out the green"). Picks blue when the request names blue, else green.
 */
function parseChroma(req: string): { color: string } | null {
  const isChroma =
    /green.?screen|blue.?screen|chroma.?key|\bkey(ing)? out\b|key out the|remove (the )?(green|blue)\s*(background|screen|bg)|drop (the )?(green|blue)\s*(background|screen)/.test(
      req,
    );
  if (!isChroma) return null;
  const color = /\bblue\b/.test(req) ? "#0047ff" : "#00d000";
  return { color };
}

/** Parse a blend-mode request ("screen blend", "multiply the layer", "blend mode overlay"). */
function parseBlend(req: string): BlendMode | null {
  const wantsBlend =
    /\bblend\b/.test(req) || /(screen|multiply|overlay|soft.?light|additive)\s+(mode|layer)/.test(req);
  if (!wantsBlend) return null;
  if (/soft.?light/.test(req)) return "soft-light";
  if (/screen/.test(req)) return "screen";
  if (/multiply/.test(req)) return "multiply";
  if (/overlay/.test(req)) return "overlay";
  if (/\bnormal\b/.test(req)) return "normal";
  if (/\badd(itive)?\b/.test(req)) return "add";
  return "screen"; // a sensible default for a bare "blend it"
}

/**
 * Parse a region blur/pixelate request ("blur the face", "pixelate the plate",
 * "hide the license plate", "censor the logo") → a centered default region.
 */
function parseRegionFx(
  req: string,
  doc: EditDoc,
): { type: "blur" | "pixelate"; x: number; y: number; w: number; h: number } | null {
  const isPixel = /pixel(ate|ize|ated|ise)|mosaic|censor/.test(req);
  const isBlur = /\bblur\b/.test(req);
  const isHide = /hide (the )?(face|plate|licen[cs]e|number ?plate|logo|sign)/.test(req);
  if (!isPixel && !isBlur && !isHide) return null;
  const W = doc.meta.width;
  const H = doc.meta.height;
  return {
    type: isPixel ? "pixelate" : "blur",
    x: round(W * 0.35),
    y: round(H * 0.28),
    w: round(W * 0.3),
    h: round(H * 0.34),
  };
}

/** Parse a mask request ("mask to a circle", "reveal only the center", "invert mask"). */
function parseMask(
  req: string,
  doc: EditDoc,
): { shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number; invert: boolean } | null {
  if (!/\bmask\b|reveal only|spotlight (on|the)/.test(req)) return null;
  const shape: "rect" | "ellipse" = /circle|ellipse|oval|round|spotlight/.test(req) ? "ellipse" : "rect";
  const invert = /invert|outside|everything (else|except)|all but/.test(req);
  const W = doc.meta.width;
  const H = doc.meta.height;
  return { shape, x: round(W * 0.25), y: round(H * 0.2), w: round(W * 0.5), h: round(H * 0.6), invert };
}

/**
 * Parse a curves request ("add an s-curve", "lift the mids", "crush the blacks").
 * Returns default master control points for the requested shape.
 */
function parseCurves(req: string): { master?: CurvePoint[] } | null {
  if (!/\bcurves?\b|s-?curve|lift (the )?mids|crush (the )?blacks|contrast curve/.test(req)) return null;
  if (/lift (the )?mids|raise (the )?mids|brighten (the )?mids/.test(req)) {
    return { master: [[0, 0], [0.5, 0.62], [1, 1]] };
  }
  if (/crush (the )?blacks|deepen (the )?blacks|lower (the )?blacks/.test(req)) {
    return { master: [[0, 0], [0.25, 0.12], [1, 1]] };
  }
  // Default: a gentle S-curve (more contrast).
  return { master: [[0, 0], [0.25, 0.17], [0.75, 0.83], [1, 1]] };
}

/** Parse an HSL request ("shift the hue by 40", "hue shift", "rotate the hue"). */
function parseHsl(req: string): { hueShift: number } | null {
  if (!/hue.?shift|shift (the )?hue|rotate (the )?hue|hue rotation|shift (the )?colou?rs?/.test(req)) return null;
  const m = req.match(/(-?\d+(?:\.\d+)?)\s*(?:deg|degrees|°)?/);
  const deg = m ? parseFloat(m[1]!) : 30;
  return { hueShift: deg };
}

/** Parse an audio-fade request ("fade in the music", "fade the audio out"). */
function parseAudioFade(req: string): { fadeInSec?: number; fadeOutSec?: number } | null {
  if (!/(music|audio|sound|song|voice.?over)/.test(req)) return null;
  if (!/\bfade/.test(req)) return null;
  const fin = /fade\s*(in|up)/.test(req);
  const fout = /fade\s*(out|down)/.test(req);
  const out: { fadeInSec?: number; fadeOutSec?: number } = {};
  if (fin) out.fadeInSec = 1.5;
  if (fout) out.fadeOutSec = 1.5;
  if (!fin && !fout) {
    out.fadeInSec = 1.5;
    out.fadeOutSec = 1.5;
  }
  return out;
}

/** Parse a pan request ("pan left", "pan the audio right", "hard left"). */
function parsePan(req: string): number | null {
  if (!/\bpan\b/.test(req)) return null;
  if (/left/.test(req)) return -1;
  if (/right/.test(req)) return 1;
  if (/cent(er|re)/.test(req)) return 0;
  return null;
}

/** Parse a loudness-normalize request ("normalize loudness", "match loudness", "LUFS"). */
function parseLoudness(req: string): boolean {
  return /loudnorm|loudness|normali[sz]e (the )?(audio|loudness|sound|mix)|\blufs\b/.test(req);
}

// ---- Sound made easy parsers ----------------------------------------------------

const MOOD_WORDS: [RegExp, MusicMood][] = [
  [/\blo-?fi\b|\bchill|relax|laid.?back|study/, "lofi"],
  [/\bcinematic|\bepic\b|dramatic|trailer|orchestral|heroic/, "cinematic"],
  [/corporate|business|inspir|uplifting|motivational|\btech\b|presentation/, "corporate"],
  [/ambient|\bcalm|peaceful|meditat|dreamy|atmospheric|soothing/, "ambient"],
  [/upbeat|happy|energetic|\bpop\b|dance|\bfun\b|party|bright|hype/, "upbeat"],
];

/**
 * A request for GENERATED (royalty-free) music: explicit ("generate / compose
 * music", "royalty-free", "make a beat"), a mood + music word ("chill music",
 * "cinematic soundtrack"), or plain "add music" when no audio was uploaded.
 */
function parseGenerateMusic(req: string, hasUploadedAudio: boolean): { mood?: MusicMood; bpm?: number } | null {
  const musicWord = /\b(?:music|soundtrack|song|score|tune|bgm|background track)\b/.test(req);
  const explicit =
    /\b(?:generate|compose|synth(?:esi[sz]e)?|create|write|make)\b[^.;]*\b(?:music|soundtrack|song|score|tune|bgm)\b|royalty.?free|copyright.?free|no.?copyright|original (?:music|soundtrack|score)|\b(?:make|generate|compose|create) (?:me )?(?:a|some) (?:[\w-]+ )?beat\b/.test(req);
  const mood = MOOD_WORDS.find(([re]) => re.test(req))?.[1];
  const wants = explicit || (musicWord && !!mood) || (musicWord && !hasUploadedAudio);
  if (!wants) return null;
  if (/\b(?:remove|delete|mute|no|without) (?:the )?(?:background )?music\b/.test(req)) return null;
  const bpm = req.match(/(\d{2,3})\s*bpm/);
  return { ...(mood ? { mood } : {}), ...(bpm ? { bpm: Number(bpm[1]) } : {}) };
}

/** "add sound effects" / "sfx on every cut" → auto; "add a whoosh at 3s" → one. */
function parseSfx(req: string): { auto: { style: "subtle" | "punchy" } } | { one: { kind: SfxKind; atSec: number } } | null {
  const one = req.match(/\b(?:add|put|drop|insert|play)\b[^.]*?\b(whoosh|swoosh|pop|click|ding|chime|riser|boom)\b(?!.?(?:in|up|out)\b)/);
  if (one && /\b(?:whoosh|swoosh|pop|click|ding|chime|riser|boom)\b(?: sound| sfx| effect|\s+at\b|$|[.,!])/.test(req)) {
    const map: Record<string, SfxKind> = { swoosh: "whoosh", chime: "ding" };
    const kind = (map[one[1]!] ?? one[1]) as SfxKind;
    const at = req.match(/\bat (\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/);
    return { one: { kind, atSec: at ? Number(at[1]) : 0 } };
  }
  if (/sound ?effects?|\bsfx\b|sound.?design|whooshes|swooshes/.test(req) && !/(?:remove|delete|no) (?:the )?(?:sound effects?|sfx)/.test(req)) {
    return { auto: { style: /punchy|dramatic|\bbig\b|bold|hype|more|lots|intense/.test(req) ? "punchy" : "subtle" } };
  }
  return null;
}

/** "duck the music under my voice", "music lower when I talk", "-18 dB duck". */
function parseDuck(req: string): { depthDb?: number } | null {
  if (!/\bduck(?:ing|ed)?\b|(?:lower|dip|drop|quieter)[^.]*music[^.]*(?:when|while|under)|music[^.]*(?:down|lower|quieter|softer)[^.]*(?:when|while|under)|under (?:the |my )?(?:voice|speech|narration|talking)/.test(req)) return null;
  const db = req.match(/-?(\d{1,2})\s*db\b/);
  return db ? { depthDb: -Math.abs(Number(db[1])) } : {};
}

/** "enhance my voice", "make the voice sound professional", "podcast sound", "de-ess". */
function parseVoiceEnhance(req: string): boolean {
  return /enhance (?:the |my )?(?:voice|vocals?|narration|dialogue|speech)|voice enhance|(?:improve|polish|boost|sweeten|fix) (?:the |my )?(?:voice|vocals?|narration|dialogue|speech)|(?:voice|vocals?|narration|dialogue) (?:sound )?(?:better|clearer|crisp(?:er)?|professional|richer)|podcast (?:voice|sound|quality)|broadcast (?:voice|sound|quality)|radio voice|\bde-?ess/.test(req);
}

/** "cut to the beat", "sync the photos to the music", "change scenes on every bar". */
function parseBeatSync(req: string): { every: "beat" | "bar" } | null {
  if (/detect (?:the )?beats?/.test(req)) return null;
  if (!/beat.?sync|(?:on|to) the (?:beat|rhythm)|(?:cut|sync|time|match|snap|land|change|switch)[^.]*\b(?:to|on|with) (?:the |every |each )?(?:beats?|rhythm|music|bars?)\b/.test(req)) return null;
  return { every: /\bbars?\b/.test(req) ? "bar" : "beat" };
}

/** Extract a phrase after a "say/mention/about/…" keyword (case preserved from original). */
function extractSpokenPhrase(original: string): string | undefined {
  const m = original.match(
    /(?:where they say|they say|say|says|saying|mention(?:s|ing)?|talk(?:s|ing)? about|talked about|about)\s+["'“”]?(.+?)["'“”]?[.?!]*\s*$/i,
  );
  return m?.[1]?.trim() || undefined;
}

/**
 * Parse a transcript-based (text) edit → { phrase, mode, unit }, or null. Handles:
 *  - "delete every 'um'" / "cut all the likes"           → remove, word
 *  - "cut the sentence about pricing"                     → remove, segment
 *  - "remove the part where they say let's begin"         → remove, segment
 *  - "keep only where they mention the product"           → keep, segment
 */
function parseTranscriptEdit(
  req: string,
  original: string,
): { phrase: string; mode: TranscriptEditMode; unit: TranscriptEditUnit } | null {
  const quoted =
    original.match(/["'“”]([^"'“”]{1,80})["'“”]/)?.[1]?.trim() ||
    original.match(/'([^']{1,80})'/)?.[1]?.trim() ||
    undefined;

  // Keep only the sentences that mention/say/are about a phrase.
  if (/\bkeep only\b/.test(req) && /(mention|talk|about|say|where|part|section|moment|bit)/.test(req)) {
    const phrase = quoted ?? extractSpokenPhrase(original);
    if (phrase) return { phrase, mode: "keep", unit: "segment" };
  }

  // Delete every occurrence of a word ("delete every um", "cut all the likes").
  // Skip words that belong to the silence/filler tools so those intents win.
  const TE_STOPWORDS = new Set(["filler", "pause", "pauses", "silence", "silences", "gap", "gaps", "dead", "air"]);
  const everyWord = req.match(
    /\b(?:delete|remove|cut|strip|drop|get rid of)\s+(?:every|all|each|any)\s+(?:the\s+)?["']?([a-z']{1,20}?)["']?s?\b/,
  );
  if (everyWord) {
    const w = quoted ?? everyWord[1];
    if (w && !TE_STOPWORDS.has(w.toLowerCase())) return { phrase: w, mode: "remove", unit: "word" };
  }

  // Cut/remove a whole sentence/part matching a phrase.
  if (
    /\b(?:cut|remove|delete|drop)\b/.test(req) &&
    /(sentence|the part|that part|section|segment|paragraph|bit about|where (?:they|he|she|i) say|part where)/.test(req)
  ) {
    const phrase = quoted ?? extractSpokenPhrase(original);
    if (phrase) return { phrase, mode: "remove", unit: "segment" };
  }

  return null;
}

/**
 * Parse an auto-reframe request → { aspect, pan, subjectTracking }, or null.
 * Handles "auto-reframe to vertical", "reframe and keep me centered", "smart
 * reframe". subjectTracking (a gated upgrade) is set only when tracking is asked for.
 */
function parseAutoReframe(
  req: string,
): { aspect: AspectKey; pan?: boolean; subjectTracking?: boolean } | null {
  const isAuto =
    /auto.?reframe|smart reframe|reframe (?:and|&) keep|keep (?:me|him|her|them|us|the subject|the speaker|the face|yourself|myself)\s+(?:centered|centred|in frame|in the frame|framed)/.test(
      req,
    );
  if (!isAuto) return null;
  const aspect = parseAspect(req) ?? "9:16";
  const subjectTracking =
    /subject.?track|track(?:ing)? (?:the )?(?:subject|speaker|face|me)|follow (?:me|the subject|the speaker|the face)/.test(
      req,
    ) || undefined;
  const pan = /\bpan\b|settle|drift|glide/.test(req) || undefined;
  return { aspect, pan, subjectTracking };
}

/**
 * Parse a TTS voice-over request → { text }, or null. Handles "voice this over:
 * '…'", "read this in a voice", "narrate this", "generate a voice-over". The
 * actual synthesis is money-gated; when no provider is configured the tool fails
 * gracefully (surfaced by interpret()).
 */
function parseVoiceover(req: string, original: string): { text: string } | null {
  const isVo =
    /voice.?over|voice (?:this|it) over|read (?:this|it|the following)(?:\s+(?:out )?(?:loud|aloud|in a voice))?|narrat(?:e|ion)|say this in a voice|generate (?:a )?(?:voice|narration)|add (?:a )?voice/.test(
      req,
    );
  if (!isVo) return null;
  let text =
    original.match(/["'“”]([^"'“”]{1,300})["'“”]/)?.[1]?.trim() ||
    original.match(/'([^']{1,300})'/)?.[1]?.trim() ||
    "";
  if (!text) {
    const m = original.match(
      /(?:voice this over|voice it over|voice over|read this|read it|read the following|narrate|say)\s*[:,-]?\s+(.+?)[.?!]*\s*$/i,
    );
    if (m) text = m[1]!.trim();
  }
  return { text: text || "voice-over" };
}

export class StubDirector {
  readonly mode = "stub" as const;

  async interpret(request: string, project: ProjectState): Promise<DirectorResult> {
    let req = request.toLowerCase();
    const steps: PlannedStep[] = [];

    // ---- text video: a whole video from words (no footage needed) ----
    // Detected FIRST, and the rest of the request is then read from the
    // INSTRUCTION only, so words inside the user's own script ("stay vertical")
    // can never trigger an unrelated edit.
    const hasVisualMedia = project.media.some((m) => m.kind === "video" || m.kind === "image");
    const tv = parseTextVideo(req, request, hasVisualMedia);
    if (tv) {
      const input = tv.input;
      steps.push({
        run: (p) => makeTextVideoTool.execute(input, { project: p }),
        call: { name: makeTextVideoTool.name, input },
      });
      req = tv.instruction;
    } else if (isTextVideo(project.doc)) {
      const theme = parseRestyle(req);
      if (theme) {
        const input = { theme };
        steps.push({
          run: (p) => restyleTextVideoTool.execute(input, { project: p }),
          call: { name: restyleTextVideoTool.name, input },
        });
      }
    }
    const docHasText = project.doc.tracks.some((t) => t.clips.some((c) => c.kind === "text"));
    // In TEXT MODE (a text-video build or restyle is queued) the generic media
    // parsers are switched off; only text-relevant follow-ups are read below.
    const textMode = steps.length > 0;
    const textInstr = req;
    if (textMode) req = "";

    // ---- builders (replace the doc); pick at most one ----
    const hasImages = project.media.some((m) => m.kind === "image");
    // Interaction demo / walkthrough from screenshots (wins over slideshow when
    // the request is demo-shaped and there are screenshots to assemble).
    const wantsLoginDemo =
      /type (?:the )?(?:e-?mail|email)\b[\s\S]*\bpassword\b[\s\S]*(?:click|press|log ?in|sign ?in|login|button)|(?:e-?mail|email) and password then (?:click|press|log ?in|sign ?in)|login (?:demo|walk.?through)/.test(
        req,
      );
    const wantsDemo =
      wantsLoginDemo ||
      /interactive demo|walk.?through|product (?:demo|tour|walkthrough)|demo (?:from|of|video|walk.?through)|(?:make|build|create|turn)[\s\S]*(?:screenshots?|screens)[\s\S]*(?:demo|video|walk.?through|interactive)|from (?:these|the|my)\s+screenshots?/.test(
        req,
      );
    const wantsSlideshow = /slide ?show|photo montage|from (my |these |the )?(photos|pictures|images)|make.*(video|clip).*(photos|pictures|images)/.test(req);
    // "make it <n> seconds/minutes" means a highlight; "make it 4K/1080p" does
    // NOT (that's a quality change), so the duration unit is required here.
    const wantsHighlight =
      /highlight|best (parts|bits|moments)|shorten|make it [\d.]+[-\s]*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b|trim to|\bcut\b.*\d/.test(req);
    // Transcript-based (content-driven) edit — a builder like highlight/filler.
    const transcriptEdit = parseTranscriptEdit(req, request);
    // Silence / dead-air removal (drops long inter-segment gaps; keeps all segments).
    const wantsSilence =
      /remove (?:the )?(?:silence|silences|dead ?air|pauses|gaps)|dead ?air|tighten (?:the )?(?:pauses?|gaps?|silence|dead ?air)|remove the gaps|cut (?:the )?(?:silence|dead ?air|pauses)/.test(
        req,
      );
    // Filler-word removal (drops filler-heavy segments). Narrowed so silence/pause
    // phrasing routes to remove_silence instead.
    const wantsFiller = /filler|remove (?:the )?(?:um|uh|ums|uhs|ers?)\b|clean ?up/.test(req);

    if (textMode) {
      // The text video (or its restyle) is the builder for this request.
    } else if (wantsDemo && hasImages) {
      const login = wantsLoginDemo || /\blog ?in\b|\bsign ?in\b|\blogin\b/.test(req);
      const input = { login };
      steps.push({
        run: (p) => buildDemoTool.execute(input, { project: p }),
        call: { name: buildDemoTool.name, input },
      });
    } else if (wantsSlideshow && hasImages) {
      const look = parseLook(req) ?? undefined;
      steps.push({
        run: (p) => slideshowTool.execute({ look }, { project: p }),
        call: { name: slideshowTool.name, input: { look } },
      });
    } else if (transcriptEdit) {
      steps.push({
        run: (p) => editByTranscriptTool.execute(transcriptEdit, { project: p }),
        call: { name: editByTranscriptTool.name, input: transcriptEdit },
      });
    } else if (wantsSilence) {
      steps.push({
        run: (p) => removeSilenceTool.execute({}, { project: p }),
        call: { name: removeSilenceTool.name, input: {} },
      });
    } else if (wantsHighlight) {
      const targetSec = parseTargetSeconds(req);
      steps.push({
        run: (p) => createHighlightTool.execute({ targetSec }, { project: p }),
        call: { name: createHighlightTool.name, input: { targetSec } },
      });
    } else if (wantsFiller) {
      steps.push({
        run: (p) => fillerCutTool.execute({}, { project: p }),
        call: { name: fillerCutTool.name, input: {} },
      });
    }

    // ---- transforms (apply on the current doc, in a sensible order) ----
    // A delivery platform ("export for tiktok") reframes + sets quality + fps in
    // one step, so it takes precedence over a plain aspect reframe.
    const platform = parsePlatform(req);
    const animateReq = parseAnimate(req);
    if (platform) {
      const input = { platform };
      steps.push({
        run: (p) => platformTool.execute(input, { project: p }),
        call: { name: platformTool.name, input },
      });
    }

    // Auto-reframe ("auto-reframe to vertical", "keep me centered") — a subject-aware
    // reframe. Takes precedence over the plain aspect/custom reframe below.
    const autoReframeReq = !platform ? parseAutoReframe(req) : null;
    if (autoReframeReq) {
      const input = {
        aspect: autoReframeReq.aspect,
        ...(autoReframeReq.pan ? { pan: true } : {}),
        ...(autoReframeReq.subjectTracking ? { subjectTracking: true } : {}),
      };
      steps.push({
        run: (p) => autoReframeTool.execute(input, { project: p }),
        call: { name: autoReframeTool.name, input },
      });
    }

    // A custom width×height ("reframe to 1600x900") wins over a named aspect.
    const custom = parseCustomReframe(req);
    const aspect = parseAspect(req);
    if (custom && !autoReframeReq) {
      const input = { width: custom.width, height: custom.height };
      steps.push({
        run: (p) => reframeTool.execute(input, { project: p }),
        call: { name: reframeTool.name, input },
      });
    } else if (aspect && !platform && !autoReframeReq) {
      steps.push({
        run: (p) => reframeTool.execute({ aspect }, { project: p }),
        call: { name: reframeTool.name, input: { aspect } },
      });
    }

    // A relative color tweak ("brighter", "warmer") takes precedence over a
    // preset so "make it warmer" nudges warmth instead of applying the warm look.
    const colorAdjust = parseColorAdjust(req, project.doc);

    const look = parseLook(req);
    if (look && !wantsSlideshow && !colorAdjust) {
      steps.push({
        run: (p) => lookTool.execute({ look }, { project: p }),
        call: { name: lookTool.name, input: { look } },
      });
    }

    if (colorAdjust) {
      steps.push({
        run: (p) => adjustColorTool.execute(colorAdjust, { project: p }),
        call: { name: adjustColorTool.name, input: colorAdjust },
      });
    }

    if (/caption|subtitle|add text|burn.?in|words on screen/.test(req)) {
      steps.push({
        run: (p) => captionsTool.execute({}, { project: p }),
        call: { name: captionsTool.name, input: {} },
      });
    }

    // Caption styling ("white bold captions with an outline", "captions at the top")
    // — runs after add_captions so it styles the freshly-generated caption clips.
    const captionStyle = parseCaptionStyle(req);
    if (captionStyle) {
      steps.push({
        run: (p) => styleCaptionsTool.execute(captionStyle, { project: p }),
        call: { name: styleCaptionsTool.name, input: captionStyle },
      });
    }

    // B-roll / picture-in-picture overlay.
    if (/b.?roll|overlay|picture.?in.?picture|\bpip\b|cutaway|inset/.test(req)) {
      const corner = parseBrollCorner(req);
      const atSec = parseAtSeconds(req);
      const input = { corner, atSec };
      steps.push({
        run: (p) => brollTool.execute(input, { project: p }),
        call: { name: brollTool.name, input },
      });
    }

    // Kinetic (animated) title takes precedence over a plain title card. Skipped
    // when the request is "fade/animate the title", which animates an EXISTING
    // title via keyframes rather than adding a new one.
    const titleFade = !!animateReq && animateReq.track === "titles";
    const kinetic = !titleFade ? parseKineticTitle(req, request) : null;
    if (kinetic) {
      steps.push({
        run: (p) => kineticTitleTool.execute(kinetic, { project: p }),
        call: { name: kineticTitleTool.name, input: kinetic },
      });
    }

    const title = !kinetic && !titleFade ? parseTitle(req, request) : null;
    if (title) {
      steps.push({
        run: (p) => titleTool.execute(title, { project: p }),
        call: { name: titleTool.name, input: title },
      });
    }

    // Keyframe animation ("zoom over time", "fade the title in"). Runs after any
    // title so "fade the title" has a title to animate.
    if (animateReq) {
      steps.push({
        run: (p) => animateTool.execute(animateReq, { project: p }),
        call: { name: animateTool.name, input: animateReq },
      });
    }

    // Callout / highlight ("highlight the …", "zoom into the …"). Parsed before
    // the static zoom so "zoom into the sidebar" highlights+zooms a region rather
    // than doing a numeric reframe.
    const callout = parseCallout(req, project.doc);
    if (callout) {
      steps.push({
        run: (p) => addCalloutTool.execute(callout, { project: p }),
        call: { name: addCalloutTool.name, input: callout },
      });
    }

    // Manual static zoom / reframe (fixed punch-in) — checked before the
    // animated emphasis so "zoom in 1.5x" reframes instead of pulsing. Skipped
    // when the request is a callout "zoom into the …", or a keyframe animation
    // ("zoom in over time" → animate, not a static reframe).
    const zoomReframe = !callout && !animateReq ? parseZoomReframe(req) : null;
    if (zoomReframe) {
      const input = { ...zoomReframe, atSec: parseAtSeconds(req) };
      steps.push({
        run: (p) => zoomTool.execute(input, { project: p }),
        call: { name: zoomTool.name, input },
      });
    }

    // Punch-in emphasis (animated scale pulse on the video).
    if (/punch.?in|\bpunch\b|emphasi[sz]|push in/.test(req) && !zoomReframe) {
      const input = { atSec: parseAtSeconds(req), zoom: parseZoom(req) };
      steps.push({
        run: (p) => emphasisTool.execute(input, { project: p }),
        call: { name: emphasisTool.name, input },
      });
    }

    // Speed ramp (slow motion / speed up).
    const speed = parseSpeed(req);
    if (speed !== undefined) {
      const input = { speed, atSec: parseAtSeconds(req) };
      steps.push({
        run: (p) => speedTool.execute(input, { project: p }),
        call: { name: speedTool.name, input },
      });
    }

    // Reverse (play backwards).
    if (/\breverse\b|reversed|backwards?|play(ed)? back|in reverse/.test(req)) {
      const input = { atSec: parseAtSeconds(req) };
      steps.push({
        run: (p) => reverseClipTool.execute(input, { project: p }),
        call: { name: reverseClipTool.name, input },
      });
    }

    // Freeze-frame (hold a still frame).
    if (/freeze.?frame|freeze the frame|freeze it|hold (the |a )?frame|freeze at/.test(req)) {
      const input = { atSec: parseAtSeconds(req) };
      steps.push({
        run: (p) => freezeFrameTool.execute(input, { project: p }),
        call: { name: freezeFrameTool.name, input },
      });
    }

    // Timeline marker ("add a marker at 12s", "mark a chapter at 30s").
    if (/add (a )?marker|\bmarker at|mark(er)? (a )?(chapter|point)|chapter (point|marker) at/.test(req)) {
      const input = { t: parseAtSeconds(req) ?? 0 };
      steps.push({
        run: (p) => addMarkerTool.execute(input, { project: p }),
        call: { name: addMarkerTool.name, input },
      });
    }

    // Transition style between clips/photos (crossfade/dip-to-black/slide/wipe/
    // dissolve/zoom/smooth).
    const transition = parseTransition(req);
    if (transition) {
      const input = { type: transition };
      steps.push({
        run: (p) => transitionTool.execute(input, { project: p }),
        call: { name: transitionTool.name, input },
      });
    }

    // Whole-frame VFX overlays ("add a vignette", "film grain", "light leak").
    const vfx = parseVfx(req);
    if (vfx) {
      steps.push({
        run: (p) => vfxTool.execute(vfx, { project: p }),
        call: { name: vfxTool.name, input: vfx },
      });
    }

    // Chroma key (green/blue screen) — composites the overlay over the base.
    const chroma = parseChroma(req);
    if (chroma) {
      steps.push({
        run: (p) => chromaKeyTool.execute(chroma, { project: p }),
        call: { name: chromaKeyTool.name, input: chroma },
      });
    }

    // Blend mode ("screen blend", "multiply the layer").
    const blend = parseBlend(req);
    if (blend) {
      const input = { mode: blend };
      steps.push({
        run: (p) => setBlendTool.execute(input, { project: p }),
        call: { name: setBlendTool.name, input },
      });
    }

    // Blur / pixelate a region ("blur the face", "pixelate the plate").
    const region = parseRegionFx(req, project.doc);
    if (region) {
      const tool = region.type === "pixelate" ? pixelateRegionTool : blurRegionTool;
      const input = region.type === "pixelate" ? { x: region.x, y: region.y, w: region.w, h: region.h } : region;
      steps.push({
        run: (p) => tool.execute(input as never, { project: p }),
        call: { name: tool.name, input },
      });
    }

    // Shape mask ("mask to a circle", "reveal only the center").
    const mask = parseMask(req, project.doc);
    if (mask) {
      steps.push({
        run: (p) => addMaskTool.execute(mask, { project: p }),
        call: { name: addMaskTool.name, input: mask },
      });
    }

    // Color curves ("s-curve", "lift the mids").
    const curves = parseCurves(req);
    if (curves) {
      steps.push({
        run: (p) => adjustCurvesTool.execute(curves, { project: p }),
        call: { name: adjustCurvesTool.name, input: curves },
      });
    }

    // HSL ("shift the hue by 40").
    const hsl = parseHsl(req);
    if (hsl) {
      steps.push({
        run: (p) => adjustHslTool.execute(hsl, { project: p }),
        call: { name: adjustHslTool.name, input: hsl },
      });
    }

    // Generated (royalty-free) music — "chill music", "compose a soundtrack", or
    // plain "add music" when nothing was uploaded. Wins over add_music.
    const hasUploadedAudio = project.media.some((m) => m.kind === "audio" && !isSynthSrc(m.src));
    const genMusic = parseGenerateMusic(req, hasUploadedAudio);
    // Background music (added before auto-mix so ducking applies to it).
    if (!genMusic && /\bmusic\b|background (track|music|song)|soundtrack|\bsong\b|add (a )?track|score it/.test(req)) {
      steps.push({
        run: (p) => musicTool.execute({}, { project: p }),
        call: { name: musicTool.name, input: {} },
      });
    }

    if (genMusic) {
      const input = genMusic;
      steps.push({
        run: (p) => generateMusicTool.execute(input, { project: p }),
        call: { name: generateMusicTool.name, input },
      });
    }
    // Cut to the beat (after music exists), then sound effects on the new cuts.
    const beatReq = parseBeatSync(req);
    if (beatReq) {
      steps.push({
        run: (p) => beatSyncTool.execute(beatReq, { project: p }),
        call: { name: beatSyncTool.name, input: beatReq },
      });
    }
    const sfxReq = parseSfx(req);
    if (sfxReq && "auto" in sfxReq) {
      const input = sfxReq.auto;
      steps.push({ run: (p) => autoSfxTool.execute(input, { project: p }), call: { name: autoSfxTool.name, input } });
    } else if (sfxReq) {
      const input = sfxReq.one;
      steps.push({ run: (p) => addSfxTool.execute(input, { project: p }), call: { name: addSfxTool.name, input } });
    }

    // TTS voice-over ("voice this over: '…'", "read this in a voice"). Money-gated:
    // when no TTS provider is configured the tool fails gracefully with a clear
    // message (captured per-step below and surfaced in the summary).
    const voiceover = parseVoiceover(req, request);
    if (voiceover) {
      const input = { text: voiceover.text };
      steps.push({
        run: (p) => generateVoiceoverTool.execute(input, { project: p }),
        call: { name: generateVoiceoverTool.name, input },
      });
    }

    // Audio fade in/out on the music/VO ("fade the music out") — parsed before the
    // black-fade branch so it doesn't add black solids for an audio-fade request.
    const audioFadeReq = parseAudioFade(req);
    if (audioFadeReq) {
      steps.push({
        run: (p) => audioFadeTool.execute(audioFadeReq, { project: p }),
        call: { name: audioFadeTool.name, input: audioFadeReq },
      });
    }

    // Fade from/to black — but not "fade the title" (keyframe animation) or an
    // audio fade ("fade the music"), which is handled by audio_fade above.
    if (
      /\bfades?\b|fade in|fade out|from black|to black|intro and outro/.test(req) &&
      !(animateReq && animateReq.track === "titles") &&
      !audioFadeReq
    ) {
      steps.push({
        run: (p) => fadesTool.execute({}, { project: p }),
        call: { name: fadesTool.name, input: {} },
      });
    }

    // Stereo pan ("pan the audio left").
    const pan = parsePan(req);
    if (pan !== null) {
      const input = { pan };
      steps.push({
        run: (p) => setPanTool.execute(input, { project: p }),
        call: { name: setPanTool.name, input },
      });
    }

    // Smart ducking (keyframed, only under speech) when someone speaks; a plain
    // "duck" with no speech source falls through to auto_mix below.
    const duckReq = parseDuck(req);
    const canSmartDuck =
      !!duckReq && (speechRegions(project.doc).length > 0 || project.media.some((m) => m.kind === "video") || !!voiceover);
    if (
      !(canSmartDuck || (sfxReq && !/auto.?mix|\bmix\b|level (the )?audio|balance (the )?audio/.test(req))) &&
      /auto.?mix|\bmix\b|level (the )?audio|balance (the )?audio|duck|louder|quieter|sound/.test(req)
    ) {
      steps.push({
        run: (p) => autoMixTool.execute({}, { project: p }),
        call: { name: autoMixTool.name, input: {} },
      });
    }
    if (canSmartDuck && duckReq) {
      const input = duckReq;
      steps.push({ run: (p) => autoDuckTool.execute(input, { project: p }), call: { name: autoDuckTool.name, input } });
    }

    // Loudness normalization ("normalize the loudness", "hit -14 LUFS").
    if (parseLoudness(req)) {
      const input = { on: true };
      steps.push({
        run: (p) => normalizeLoudnessTool.execute(input, { project: p }),
        call: { name: normalizeLoudnessTool.name, input },
      });
    }

    if (parseVoiceEnhance(req)) {
      const input = { on: true };
      steps.push({ run: (p) => enhanceVoiceTool.execute(input, { project: p }), call: { name: enhanceVoiceTool.name, input } });
    }

    const quality = parseQuality(req);
    if (quality) {
      steps.push({
        run: (p) => qualityTool.execute(quality, { project: p }),
        call: { name: qualityTool.name, input: quality },
      });
    }

    // ---- text: platform / music (text mode), then animate / style / background ----
    // Theme words ("neon", "bold") describe the text video's theme, not an extra
    // animation/effect, so they're stripped before the text parsers run.
    const tReq = textMode ? textInstr.replace(/\b(?:neon|bold|minimal|elegant|playful|corporate|retro|aurora|cinematic|handwritten)\b/g, " ") : req;
    if (textMode) {
      const plat = parsePlatform(textInstr);
      if (plat) {
        const input = { platform: plat };
        steps.push({ run: (p) => platformTool.execute(input, { project: p }), call: { name: platformTool.name, input } });
      }
      const tvGen = parseGenerateMusic(textInstr, project.media.some((m) => m.kind === "audio" && !isSynthSrc(m.src)));
      if (tvGen) {
        steps.push({ run: (p) => generateMusicTool.execute(tvGen, { project: p }), call: { name: generateMusicTool.name, input: tvGen } });
      } else if (/\b(?:music|song|soundtrack)\b/.test(textInstr) && project.media.some((m) => m.kind === "audio")) {
        steps.push({ run: (p) => musicTool.execute({}, { project: p }), call: { name: musicTool.name, input: {} } });
      }
      const tvBeat = parseBeatSync(textInstr);
      if (tvBeat) steps.push({ run: (p) => beatSyncTool.execute(tvBeat, { project: p }), call: { name: beatSyncTool.name, input: tvBeat } });
      const tvSfx = parseSfx(textInstr);
      if (tvSfx && "auto" in tvSfx) {
        const input = tvSfx.auto;
        steps.push({ run: (p) => autoSfxTool.execute(input, { project: p }), call: { name: autoSfxTool.name, input } });
      }
    }
    if (docHasText || textMode) {
      const anim = parseAnimateText(tReq);
      if (anim) {
        steps.push({ run: (p) => animateTextTool.execute(anim, { project: p }), call: { name: animateTextTool.name, input: anim } });
      }
      const style = parseStyleText(tReq);
      if (style) {
        steps.push({ run: (p) => styleTextTool.execute(style, { project: p }), call: { name: styleTextTool.name, input: style } });
      }
    }
    const bg = parseBackground(tReq);
    if (bg && (textMode || docHasText || !hasVisualMedia || /background/.test(tReq))) {
      steps.push({ run: (p) => setBackgroundTool.execute(bg, { project: p }), call: { name: setBackgroundTool.name, input: bg } });
    }

    if (steps.length === 0) {
      return {
        doc: project.doc,
        summary: this.helpMessage(project),
        toolCalls: [],
        durationSec: docDurationSec(project.doc),
      };
    }

    const summaries: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const step of steps) {
      try {
        const res = await step.run(project);
        summaries.push(res.summary);
        toolCalls.push(step.call);
      } catch (err) {
        summaries.push(err instanceof Error ? err.message : "One step couldn't run.");
      }
    }

    return {
      doc: project.doc,
      summary: summaries.join(" "),
      toolCalls,
      durationSec: docDurationSec(project.doc),
    };
  }

  private helpMessage(project: ProjectState): string {
    const hasVideo = project.media.some((m) => m.kind === "video");
    const hasImages = project.media.some((m) => m.kind === "image");
    if (isTextVideo(project.doc))
      return 'Try: "switch to the neon theme", "make it elegant", "letters pop in one by one", "words rise in", "add a wiggle", "use Bebas Neue font", "gradient text", "aurora background", "make it vertical", or "make the text animation slower".';
    if (!hasVideo && !hasImages)
      return 'No footage needed — try: "make a text video: Big news. We just launched. Try it free today." or "quote video: “Stay hungry, stay foolish.” — Steve Jobs" or "list video: 3 tips for better sleep\n1. No screens\n2. Cool room\n3. Same bedtime". Or add a video or photos to edit.';
    if (hasImages && !hasVideo)
      return 'Try: "make a slideshow", "make an interactive demo from these screenshots", "type email and password then click login", "highlight the sign-in button", "zoom into the menu", "zoom in over time", "make it 21:9", "golden-hour look", "use dissolve transitions", "export for instagram feed", or "make it high quality".';
    return 'Try: "cut a 60-second highlight", "remove filler words", "remove dead air", "cut the sentence about pricing", "keep only where they mention the product", "delete every um", "auto-reframe to vertical and keep me centered", "voice this over: \'…\'", "make it vertical with captions", "cinematic look", "reframe to 1600x900", "slow motion", "zoom in over time", "reverse the clip", "freeze frame at 3s", "add background music", "export for tiktok", or "make it 4K".';
  }
}
