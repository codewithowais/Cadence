/**
 * First-run ease & discoverability — PURE logic (no React, no `@/` imports) so the
 * unit tests can import it directly.
 *
 *  - PROMPT_LIBRARY: every capability a creator can ask for, grouped by goal. Each
 *    prompt is verified (tests/suggestions.test.ts) to route through the StubDirector
 *    to at least one real tool in every context it claims to support.
 *  - nextSteps(): context-aware "what next?" chips derived from the doc + the tools
 *    the last Director edit called. Never suggests what's already applied.
 *  - closestIdeas(): the friendly answer to "I didn't understand that".
 *  - onboardingSteps(): the getting-started checklist from real editor signals.
 *  - pushRecent()/recallRecent(): composer prompt history.
 *  - fuzzyScore(): the ranking primitive the command palette uses.
 *
 * Nothing here edits a doc: every suggestion is a CommandAction the editor maps to
 * its EXISTING paths (the Director send handler, or an existing UI handler).
 */
import type { EditDoc } from "@cadence/core";
import { describeDoc } from "./status";

// ---- shared vocabulary ------------------------------------------------------------

/** What the project currently is (mirrors the Editor's QuickActions mode). */
export type EditorMode = "video" | "images" | "text" | "none";

/** Mirrors RoomsRail's RoomKey (kept structural so this file stays React-free). */
export type RoomTarget = "media" | "text" | "edit" | "design" | "words" | "demo" | "audio" | "deliver";

/** Non-prompt editor actions, each mapped to an existing handler in the Editor. */
export type UiCommand =
  | "undo"
  | "redo"
  | "export"
  | "play"
  | "addMedia"
  | "library"
  | "shortcuts"
  | "toggleChat"
  | "toggleCode"
  | "focusMode";

/** Everything a palette row / chip / checklist CTA can do. */
export type CommandAction =
  | { type: "prompt"; prompt: string }
  | { type: "room"; room: RoomTarget }
  | { type: "ui"; command: UiCommand };

/** Which projects a prompt works in. */
export type Needs =
  | "always" // works even on an empty project (creates a text video)
  | "content" // any project with something in it (video, photos or a text video)
  | "visual" // footage or photos
  | "video"
  | "images"
  | "text" // a text video
  | "music"; // any content AND an uploaded audio file

export type GoalKey = "shorter" | "social" | "captions" | "look" | "motion" | "sound" | "text" | "photos" | "quality";

export interface Goal {
  key: GoalKey;
  label: string;
  hint: string;
}

export const GOALS: Goal[] = [
  { key: "shorter", label: "Make it shorter", hint: "Highlights, filler & dead air" },
  { key: "social", label: "Get it social-ready", hint: "Vertical, square, platform presets" },
  { key: "captions", label: "Captions & titles", hint: "Burn-in captions, karaoke, lower-thirds" },
  { key: "look", label: "Look & feel", hint: "Color looks and grades" },
  { key: "motion", label: "Motion & timing", hint: "Punch-ins, slow-mo, fades, transitions" },
  { key: "sound", label: "Sound", hint: "Music, mix, loudness" },
  { key: "text", label: "Text videos", hint: "No footage needed" },
  { key: "photos", label: "Photos", hint: "Slideshows from pictures" },
  { key: "quality", label: "Quality", hint: "HD and 4K targets" },
];

export interface PromptIdea {
  id: string;
  goal: GoalKey;
  /** Short, button-safe label (see docs/agents/product-manager.md §4). */
  label: string;
  needs: Needs;
  /** What the Director is asked. Absent for UI-only capabilities (see `room`). */
  prompt?: string;
  /** A capability that lives in a room's controls rather than the Director. */
  room?: RoomTarget;
  /** Extra search words (synonyms) for the palette and closest-match ranking. */
  keywords?: string[];
}

const TEXT_ANNOUNCE = "make a bold announcement video: Big news. We just launched. Edit videos by typing. Try it free today.";
const TEXT_QUOTE = "make an elegant quote video: “The best way to predict the future is to create it.” — Peter Drucker";
const TEXT_LIST = "make a vertical list video: 3 tips for better sleep\n1. No screens after 10pm\n2. Keep the room cool\n3. Same bedtime every night";
const TEXT_NEON = "make a neon text video: Tonight only. Live music. Doors at 9.";

export const PROMPT_LIBRARY: PromptIdea[] = [
  // Make it shorter
  { id: "highlight-60", goal: "shorter", label: "Cut a 60-second highlight", needs: "video", prompt: "cut a 60-second highlight of the best parts", keywords: ["shorter", "trim", "best", "boring", "recap", "condense", "summary"] },
  { id: "highlight-30", goal: "shorter", label: "Cut a 30-second teaser", needs: "video", prompt: "cut a 30-second highlight", keywords: ["shorter", "teaser", "trailer", "short", "promo"] },
  { id: "filler", goal: "shorter", label: "Remove ums & filler", needs: "video", prompt: "remove the filler words and pauses", keywords: ["um", "uh", "filler", "clean", "tighten", "stutter"] },
  { id: "dead-air", goal: "shorter", label: "Remove dead air", needs: "video", prompt: "remove dead air", keywords: ["silence", "pauses", "gaps", "quiet", "tighten", "shorter"] },

  // Social-ready
  { id: "vertical", goal: "social", label: "Make it vertical (9:16)", needs: "content", prompt: "make it vertical 9:16", keywords: ["portrait", "9:16", "phone", "tiktok", "reels", "shorts", "story"] },
  { id: "square", goal: "social", label: "Make it square (1:1)", needs: "content", prompt: "make it square 1:1", keywords: ["1:1", "instagram", "feed", "square"] },
  { id: "tiktok", goal: "social", label: "Ready for TikTok", needs: "content", prompt: "export for tiktok", keywords: ["tiktok", "vertical", "platform", "social"] },
  { id: "reels", goal: "social", label: "Ready for Instagram Reels", needs: "content", prompt: "export for instagram reels", keywords: ["instagram", "reels", "vertical", "platform"] },
  { id: "shorts", goal: "social", label: "Ready for YouTube Shorts", needs: "content", prompt: "export for youtube shorts", keywords: ["youtube", "shorts", "vertical", "platform"] },
  { id: "feed-45", goal: "social", label: "Instagram feed (4:5)", needs: "visual", prompt: "make it 4:5 for Instagram", keywords: ["4:5", "instagram", "feed", "portrait"] },
  { id: "auto-reframe", goal: "social", label: "Auto-reframe, keep me centered", needs: "video", prompt: "auto-reframe to vertical and keep me centered", keywords: ["center", "track", "follow", "subject", "reframe"] },
  { id: "vertical-captions", goal: "social", label: "Vertical with captions", needs: "video", prompt: "make it vertical with captions", keywords: ["vertical", "captions", "subtitles", "tiktok", "reels"] },

  // Captions & titles
  { id: "captions", goal: "captions", label: "Add captions", needs: "video", prompt: "add captions", keywords: ["subtitles", "subs", "text", "transcript", "cc", "caption"] },
  { id: "karaoke", goal: "captions", label: "Karaoke captions", needs: "video", prompt: "add word-by-word karaoke captions", keywords: ["karaoke", "highlight", "spoken", "word", "subtitles"] },
  { id: "captions-bold", goal: "captions", label: "Bold yellow captions", needs: "video", prompt: "make the captions bold and yellow", keywords: ["caption", "color", "yellow", "bold", "subtitles"] },
  { id: "captions-tiktok", goal: "captions", label: "TikTok-style captions", needs: "video", prompt: "captions in the TikTok style", keywords: ["tiktok", "caption", "subtitles", "viral"] },
  { id: "animated-title", goal: "captions", label: "Add an animated title", needs: "visual", prompt: 'add an animated title that says "Welcome"', keywords: ["title", "heading", "intro", "text", "kinetic", "animated"] },
  { id: "title-card", goal: "captions", label: "Simple title card", needs: "visual", prompt: 'add a title that says "My video"', keywords: ["title", "intro", "card", "heading", "text"] },
  { id: "lower-third", goal: "captions", label: "Name lower-third", needs: "video", prompt: 'add a lower third that says "Jane Doe, Host"', keywords: ["name", "lower", "third", "label", "introduce", "speaker"] },

  // Look & feel
  { id: "look-cinematic", goal: "look", label: "Cinematic look", needs: "visual", prompt: "give it a cinematic look", keywords: ["film", "movie", "color", "grade", "moody", "look"] },
  { id: "look-warm", goal: "look", label: "Warm look", needs: "visual", prompt: "give it a warm look", keywords: ["warm", "cozy", "sunny", "color", "grade", "look"] },
  { id: "look-vintage", goal: "look", label: "Vintage film look", needs: "visual", prompt: "vintage look", keywords: ["retro", "old", "film", "faded", "color", "look"] },
  { id: "look-bw", goal: "look", label: "Black & white", needs: "visual", prompt: "black and white", keywords: ["bw", "monochrome", "grayscale", "noir", "color", "look"] },
  { id: "look-golden", goal: "look", label: "Golden hour", needs: "visual", prompt: "golden-hour look", keywords: ["sunset", "golden", "warm", "color", "look"] },
  { id: "look-pop", goal: "look", label: "Make the colors pop", needs: "visual", prompt: "make the colors pop", keywords: ["vivid", "saturated", "bright", "vibrant", "color"] },
  { id: "color-controls", goal: "look", label: "Fine-tune color by hand", needs: "visual", room: "design", keywords: ["color", "grade", "brightness", "contrast", "saturation", "curves", "lut"] },

  // Motion & timing
  { id: "punch-in", goal: "motion", label: "Punch-in for emphasis", needs: "video", prompt: "punch in for emphasis at 2s", keywords: ["zoom", "emphasis", "punch", "push in"] },
  { id: "slow-mo", goal: "motion", label: "Slow motion", needs: "video", prompt: "slow motion", keywords: ["slow", "slowmo", "dramatic", "half"] },
  { id: "faster", goal: "motion", label: "Play it 2× faster", needs: "video", prompt: "make it 2x faster", keywords: ["fast", "quick", "timelapse", "hurry", "double"] },
  { id: "slow-zoom", goal: "motion", label: "Slow zoom in", needs: "visual", prompt: "zoom in over time", keywords: ["zoom", "push", "ken burns", "movement"] },
  { id: "fades", goal: "motion", label: "Fade in & out", needs: "content", prompt: "add a fade in and out", keywords: ["fade", "black", "intro", "outro", "ending"] },
  { id: "freeze", goal: "motion", label: "Freeze frame at 3s", needs: "video", prompt: "freeze frame at 3s", keywords: ["freeze", "pause", "still", "hold"] },
  { id: "reverse", goal: "motion", label: "Play it backwards", needs: "video", prompt: "reverse the clip", keywords: ["reverse", "backwards", "rewind"] },
  { id: "crossfades", goal: "motion", label: "Crossfade between cuts", needs: "visual", prompt: "use crossfade transitions", keywords: ["transition", "crossfade", "smooth", "blend", "cuts"] },
  { id: "broll", goal: "motion", label: "Picture-in-picture b-roll", needs: "video", prompt: "add b-roll as picture-in-picture", keywords: ["pip", "overlay", "broll", "inset", "picture"] },
  { id: "layouts", goal: "motion", label: "Split-screen layouts", needs: "visual", room: "design", keywords: ["split", "screen", "side by side", "grid", "pip", "layout", "collage"] },
  { id: "stabilize", goal: "motion", label: "Stabilize shaky footage", needs: "video", room: "design", keywords: ["shaky", "stable", "steady", "stabilize", "wobble"] },

  // Sound
  { id: "music", goal: "sound", label: "Background music", needs: "music", prompt: "add background music", keywords: ["song", "soundtrack", "track", "music", "beat"] },
  { id: "music-fade", goal: "sound", label: "Fade the music out", needs: "music", prompt: "fade the music out", keywords: ["music", "fade", "ending", "song"] },
  { id: "auto-mix", goal: "sound", label: "Auto-mix the audio", needs: "video", prompt: "auto-mix the audio", keywords: ["mix", "level", "balance", "duck", "sound", "volume"] },
  { id: "loudness", goal: "sound", label: "Even out loudness", needs: "video", prompt: "normalize the loudness", keywords: ["loud", "quiet", "volume", "normalize", "lufs", "level"] },
  { id: "clean-audio", goal: "sound", label: "Reduce background noise", needs: "video", room: "audio", keywords: ["noise", "hiss", "hum", "denoise", "clean", "audio"] },
  { id: "voiceover", goal: "sound", label: "Record a voice-over", needs: "content", room: "audio", keywords: ["voice", "narration", "record", "mic", "narrate"] },
  { id: "add-song", goal: "sound", label: "Upload a song", needs: "always", room: "media", keywords: ["song", "music", "mp3", "audio", "upload"] },

  // Text videos
  { id: "tv-announce", goal: "text", label: "Announcement text video", needs: "always", prompt: TEXT_ANNOUNCE, keywords: ["text video", "announce", "launch", "news", "promo", "words"] },
  { id: "tv-quote", goal: "text", label: "Quote text video", needs: "always", prompt: TEXT_QUOTE, keywords: ["text video", "quote", "saying", "inspiration"] },
  { id: "tv-list", goal: "text", label: "Tips list for Reels", needs: "always", prompt: TEXT_LIST, keywords: ["text video", "list", "tips", "steps", "howto"] },
  { id: "tv-neon", goal: "text", label: "Neon promo text video", needs: "always", prompt: TEXT_NEON, keywords: ["text video", "neon", "glow", "party", "event"] },
  { id: "theme-neon", goal: "text", label: "Try the Neon theme", needs: "text", prompt: "switch to the neon theme", keywords: ["theme", "neon", "glow", "style"] },
  { id: "theme-elegant", goal: "text", label: "Try the Elegant theme", needs: "text", prompt: "make it elegant", keywords: ["theme", "elegant", "serif", "classy", "style"] },
  { id: "theme-playful", goal: "text", label: "Try the Playful theme", needs: "text", prompt: "try the playful theme", keywords: ["theme", "playful", "fun", "style"] },
  { id: "theme-retro", goal: "text", label: "Try the Retro theme", needs: "text", prompt: "make it retro", keywords: ["theme", "retro", "80s", "style"] },
  { id: "letters-pop", goal: "text", label: "Letters pop in", needs: "text", prompt: "letters pop in one by one", keywords: ["animate", "letters", "pop", "animation"] },
  { id: "rise-in", goal: "text", label: "Rise in word by word", needs: "text", prompt: "words rise in one by one", keywords: ["animate", "rise", "animation", "word"] },
  { id: "typewriter", goal: "text", label: "Typewriter text", needs: "text", prompt: "typewriter text", keywords: ["animate", "typing", "typewriter", "animation"] },
  { id: "glitch", goal: "text", label: "Glitch text", needs: "text", prompt: "glitch text", keywords: ["glitch", "digital", "effect", "animation"] },
  { id: "gradient-text", goal: "text", label: "Gradient text", needs: "text", prompt: "gradient text", keywords: ["gradient", "color", "rainbow", "effect"] },
  { id: "aurora", goal: "text", label: "Aurora background", needs: "text", prompt: "aurora background", keywords: ["background", "gradient", "animated", "aurora", "colorful"] },
  { id: "wiggle", goal: "text", label: "Wiggle loop", needs: "text", prompt: "add a wiggle to the text", keywords: ["wiggle", "loop", "shake", "animation"] },
  { id: "slower-text", goal: "text", label: "Slower text animation", needs: "text", prompt: "make the text animation slower", keywords: ["slower", "calm", "pace", "animation"] },
  { id: "headline-font", goal: "text", label: "Big condensed headline font", needs: "text", prompt: "use Bebas Neue font", keywords: ["font", "typeface", "headline", "bold"] },

  // Photos
  { id: "slideshow", goal: "photos", label: "Photo slideshow", needs: "images", prompt: "make a slideshow from my photos", keywords: ["slideshow", "photos", "pictures", "montage"] },
  { id: "dissolves", goal: "photos", label: "Dissolve between photos", needs: "images", prompt: "use dissolve transitions", keywords: ["dissolve", "transition", "smooth", "photos"] },
  { id: "slide-transitions", goal: "photos", label: "Slide between photos", needs: "images", prompt: "use slide transitions", keywords: ["slide", "transition", "photos", "swipe"] },

  // Quality
  { id: "4k", goal: "quality", label: "Make it 4K", needs: "content", prompt: "make it 4K high quality", keywords: ["4k", "uhd", "sharp", "resolution", "quality", "upscale"] },
  { id: "hq", goal: "quality", label: "High quality", needs: "content", prompt: "make it high quality", keywords: ["hd", "1080", "sharp", "quality", "crisp"] },
];

/** Is a prompt idea usable in the current project? */
export function isAvailable(needs: Needs, mode: EditorMode, hasAudio: boolean): boolean {
  switch (needs) {
    case "always":
      return true;
    case "content":
      return mode !== "none";
    case "visual":
      return mode === "video" || mode === "images";
    case "video":
      return mode === "video";
    case "images":
      return mode === "images";
    case "text":
      return mode === "text";
    case "music":
      return mode !== "none" && hasAudio;
  }
}

/** A short, human reason an idea isn't available yet (for "needs footage" badges). */
export function needsLabel(needs: Needs): string {
  switch (needs) {
    case "always":
      return "";
    case "content":
      return "needs a project";
    case "visual":
      return "needs footage or photos";
    case "video":
      return "needs a video";
    case "images":
      return "needs photos";
    case "text":
      return "for text videos";
    case "music":
      return "needs a song";
  }
}

/** The action a library idea runs. */
export function ideaAction(idea: PromptIdea): CommandAction {
  return idea.prompt ? { type: "prompt", prompt: idea.prompt } : { type: "room", room: idea.room ?? "edit" };
}

const ideaById = new Map(PROMPT_LIBRARY.map((i) => [i.id, i]));
export function getIdea(id: string): PromptIdea | undefined {
  return ideaById.get(id);
}

// ---- fuzzy matching ---------------------------------------------------------------

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”"'’]/g, "")
    .replace(/×/g, "x");

const tokens = (s: string): string[] => norm(s).split(/[^a-z0-9:]+/).filter(Boolean);

/** Is `q` a subsequence of `s` (every char in order)? */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

/**
 * Score how well `query` matches `text` (+ optional extra keywords). 0 = no match.
 * Every query token must match somewhere: a word-prefix scores highest, then a
 * substring, then (for tokens ≥ 3 chars) an in-order subsequence of one word.
 * The whole query as a prefix of the text earns a bonus so exact starts win.
 */
export function fuzzyScore(query: string, text: string, keywords: string[] = []): number {
  const qTokens = tokens(query);
  if (qTokens.length === 0) return 0;
  const hay = norm(text);
  const words = tokens(text);
  const kw = keywords.flatMap(tokens);
  let score = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const w of words) {
      if (w === q) best = Math.max(best, 10);
      else if (w.startsWith(q)) best = Math.max(best, 8);
      else if (w.includes(q)) best = Math.max(best, 5);
      else if (q.length >= 3 && isSubsequence(q, w)) best = Math.max(best, 2);
    }
    for (const k of kw) {
      if (k === q) best = Math.max(best, 7);
      else if (k.startsWith(q)) best = Math.max(best, 6);
      else if (q.length >= 3 && k.includes(q)) best = Math.max(best, 3);
    }
    if (best === 0) return 0; // every token must land
    score += best;
  }
  const qn = norm(query).trim();
  if (hay.startsWith(qn)) score += 6;
  else if (hay.includes(qn)) score += 3;
  // Tighter matches win ties: "captions" ranks "Add captions" above "Vertical with captions".
  score += (qn.length / Math.max(hay.length, 1)) * 4;
  return score;
}

// ---- doc facts --------------------------------------------------------------------

export interface DocFacts {
  portrait: boolean;
  square: boolean;
  captions: boolean;
  look: boolean;
  music: boolean;
  fades: boolean;
  titles: boolean;
  quality: boolean;
  theme: string | null;
  textVideo: boolean;
}

export function docFacts(doc: EditDoc): DocFacts {
  const s = describeDoc(doc);
  const track = (id: string) => doc.tracks.find((t) => t.id === id);
  return {
    portrait: doc.meta.height > doc.meta.width,
    square: doc.meta.height === doc.meta.width,
    captions: (track("captions")?.clips.length ?? 0) > 0,
    look: s.look !== null,
    music: s.music,
    fades: (track("fades")?.clips.length ?? 0) > 0,
    titles: (track("titles")?.clips.length ?? 0) > 0,
    quality: s.quality !== null,
    theme: doc.textVideo?.theme ?? null,
    textVideo: !!doc.textVideo,
  };
}

/** Ideas that are pointless because the doc already has them. */
function alreadyApplied(id: string, f: DocFacts): boolean {
  switch (id) {
    case "vertical":
    case "vertical-captions":
    case "tiktok":
    case "reels":
    case "shorts":
    case "auto-reframe":
      return f.portrait || (id === "vertical-captions" && f.captions);
    case "square":
      return f.square;
    case "feed-45":
      return f.portrait;
    case "captions":
    case "karaoke":
      return f.captions;
    case "captions-bold":
    case "captions-tiktok":
      return !f.captions; // only useful once captions exist
    case "look-cinematic":
    case "look-warm":
    case "look-vintage":
    case "look-bw":
    case "look-golden":
    case "look-pop":
      return f.look;
    case "music":
      return f.music;
    case "music-fade":
      return !f.music;
    case "fades":
      return f.fades;
    case "animated-title":
    case "title-card":
      return f.titles;
    case "4k":
    case "hq":
      return f.quality;
    case "theme-neon":
      return f.theme === "neon";
    case "theme-elegant":
      return f.theme === "elegant";
    case "theme-playful":
      return f.theme === "playful";
    case "theme-retro":
      return f.theme === "retro";
    default:
      return false;
  }
}

// ---- next steps -------------------------------------------------------------------

export interface NextStep {
  id: string;
  label: string;
  action: CommandAction;
}

export interface NextStepContext {
  doc: EditDoc;
  mode: EditorMode;
  /** Tool names the latest Director edit called (empty = no edit yet). */
  lastTools: string[];
  /** An audio file is in the project (music can be added). */
  hasAudio: boolean;
  /** Max chips (default 3). */
  limit?: number;
}

/** Follow-ups that make sense right after a given tool, most useful first. */
const AFTER_TOOL: Record<string, string[]> = {
  create_highlight: ["captions", "vertical", "filler", "look-cinematic"],
  filler_cut: ["captions", "highlight-60", "vertical"],
  remove_silence: ["captions", "filler", "vertical"],
  edit_by_transcript: ["captions", "vertical", "look-cinematic"],
  reframe: ["captions", "animated-title", "look-cinematic", "letters-pop"],
  auto_reframe: ["captions", "look-cinematic", "fades"],
  set_platform: ["captions", "look-cinematic", "letters-pop", "fades"],
  add_captions: ["captions-tiktok", "vertical", "look-cinematic", "music"],
  style_captions: ["vertical", "look-cinematic", "music"],
  apply_look: ["music", "fades", "animated-title", "4k"],
  adjust_color: ["music", "fades", "4k"],
  add_title: ["look-cinematic", "fades", "music"],
  add_kinetic_title: ["look-cinematic", "fades", "music"],
  add_fades: ["music", "4k", "look-cinematic"],
  add_emphasis: ["captions", "look-cinematic", "fades"],
  set_speed: ["music", "fades", "captions"],
  animate: ["music", "fades", "animated-title"],
  add_broll: ["captions", "fades", "music"],
  add_music: ["auto-mix", "music-fade", "fades"],
  auto_mix: ["loudness", "fades", "4k"],
  normalize_loudness: ["fades", "4k"],
  set_quality: [],
  make_slideshow: ["vertical", "look-warm", "animated-title", "dissolves"],
  set_transition: ["music", "look-warm", "animated-title"],
  make_text_video: ["theme-neon", "theme-elegant", "vertical", "letters-pop", "aurora"],
  restyle_text_video: ["letters-pop", "vertical", "aurora"],
  animate_text: ["aurora", "gradient-text", "slower-text", "vertical"],
  style_text: ["letters-pop", "aurora", "vertical"],
  set_background: ["letters-pop", "gradient-text", "vertical"],
};

/** What a brand-new project should try first, per mode. */
const STARTERS: Record<EditorMode, string[]> = {
  video: ["highlight-60", "filler", "captions", "vertical", "look-cinematic", "fades", "4k"],
  images: ["vertical", "look-warm", "animated-title", "dissolves", "fades", "4k"],
  text: ["theme-neon", "theme-elegant", "vertical", "letters-pop", "aurora", "fades"],
  none: ["tv-announce", "tv-quote", "tv-list"],
};

/** The "you're nearly there" step: download the finished video. */
export const EXPORT_STEP: NextStep = { id: "export", label: "Download the video", action: { type: "ui", command: "export" } };

/**
 * Context-aware next steps after a Director edit. Pure: the same doc + tools
 * always give the same chips. Follow-ups for the tools just run come first, then
 * the mode's starters; anything already applied, unavailable in this project, or
 * just done is skipped. After a couple of edits the last chip becomes "Download
 * the video" so the path to a finished file is always one tap away.
 */
export function nextSteps(ctx: NextStepContext): NextStep[] {
  const limit = ctx.limit ?? 3;
  const facts = docFacts(ctx.doc);
  const justDone = new Set(ctx.lastTools);
  const order: string[] = [];
  for (const t of ctx.lastTools) for (const id of AFTER_TOOL[t] ?? []) order.push(id);
  for (const id of STARTERS[ctx.mode]) order.push(id);

  const out: NextStep[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const idea = getIdea(id);
    if (!idea || !idea.prompt) continue;
    if (!isAvailable(idea.needs, ctx.mode, ctx.hasAudio)) continue;
    if (alreadyApplied(id, facts)) continue;
    if (ranRecently(id, justDone)) continue;
    out.push({ id, label: idea.label, action: ideaAction(idea) });
  }

  const wantsExport = ctx.mode !== "none" && ctx.lastTools.length > 0 && (justDone.has("set_quality") || editWeight(facts) >= 2);
  if (wantsExport) return [...out.slice(0, limit - 1), EXPORT_STEP];
  return out.slice(0, limit);
}

/** Map a suggestion back to the tool it would call, to avoid "do it again" chips. */
const IDEA_TOOL: Record<string, string> = {
  "highlight-60": "create_highlight",
  filler: "filler_cut",
  captions: "add_captions",
  "captions-tiktok": "set_platform",
  vertical: "reframe",
  "letters-pop": "animate_text",
  "slower-text": "animate_text",
  "gradient-text": "style_text",
  aurora: "set_background",
  "auto-mix": "auto_mix",
  loudness: "normalize_loudness",
  dissolves: "set_transition",
};
function ranRecently(id: string, justDone: Set<string>): boolean {
  const tool = IDEA_TOOL[id];
  return !!tool && justDone.has(tool);
}

/** How "finished" a doc looks — each applied polish counts once. */
function editWeight(f: DocFacts): number {
  return [f.captions, f.look, f.music, f.fades, f.titles, f.portrait || f.square, f.quality, f.textVideo].filter(Boolean).length;
}

// ---- "I didn't understand" ---------------------------------------------------------

const STOP = new Set([
  "a", "an", "the", "it", "to", "of", "and", "or", "my", "me", "i", "can", "you", "please", "make", "add", "give",
  "some", "this", "that", "with", "for", "in", "on", "at", "be", "is", "more", "bit", "little", "want", "would",
  "like", "could", "just", "all", "video", "clip", "into", "do", "get", "put", "up", "out", "so",
]);

/** Everyday words → the vocabulary the library uses. */
const SYNONYMS: Record<string, string[]> = {
  shorter: ["highlight", "trim", "shorter"],
  short: ["highlight", "shorter"],
  boring: ["highlight", "best"],
  long: ["highlight", "shorter"],
  trim: ["highlight", "trim"],
  subtitles: ["captions"],
  subtitle: ["captions"],
  subs: ["captions"],
  text: ["captions", "title", "text"],
  words: ["captions", "text"],
  portrait: ["vertical"],
  phone: ["vertical"],
  instagram: ["instagram", "vertical"],
  ig: ["instagram"],
  yt: ["youtube"],
  color: ["look", "color"],
  colour: ["look", "color"],
  colors: ["look", "color"],
  grade: ["look", "color"],
  filter: ["look"],
  moody: ["cinematic"],
  movie: ["cinematic"],
  film: ["cinematic", "vintage"],
  old: ["vintage"],
  retro: ["vintage", "retro"],
  song: ["music"],
  tune: ["music"],
  soundtrack: ["music"],
  sound: ["audio", "mix", "music"],
  audio: ["audio", "mix"],
  loud: ["loudness"],
  louder: ["loudness", "mix"],
  quieter: ["loudness", "mix"],
  noisy: ["noise"],
  noise: ["noise"],
  hiss: ["noise"],
  shaky: ["stabilize"],
  shake: ["stabilize"],
  steady: ["stabilize"],
  sharper: ["quality", "4k"],
  sharp: ["quality"],
  hd: ["quality"],
  blurry: ["quality"],
  zoom: ["zoom", "punch"],
  slow: ["slow"],
  slowmo: ["slow"],
  fast: ["faster"],
  quick: ["faster"],
  speed: ["faster", "slow"],
  intro: ["title", "fade"],
  outro: ["fade"],
  ending: ["fade"],
  heading: ["title"],
  name: ["lower", "third"],
  transition: ["transition", "crossfade"],
  transitions: ["transition", "crossfade"],
  smooth: ["crossfade", "transition"],
  photos: ["slideshow", "photos"],
  pictures: ["slideshow", "photos"],
  animate: ["animation", "animate"],
  animation: ["animation"],
  font: ["font"],
  theme: ["theme"],
  vibe: ["look", "theme"],
  style: ["look", "theme", "style"],
  background: ["background"],
  bg: ["background"],
  tiktok: ["tiktok"],
  reels: ["reels"],
  shorts: ["shorts"],
  square: ["square"],
  vertical: ["vertical"],
};

function expand(request: string): string[] {
  const out = new Set<string>();
  for (const t of tokens(request)) {
    if (STOP.has(t)) continue;
    out.add(t);
    for (const s of SYNONYMS[t] ?? []) out.add(s);
    // crude singular: "captions" ↔ "caption", "looks" → "look"
    if (t.length > 4 && t.endsWith("s")) out.add(t.slice(0, -1));
  }
  return [...out];
}

function ideaTokens(idea: PromptIdea): Set<string> {
  const set = new Set<string>();
  for (const t of tokens(`${idea.label} ${idea.prompt ?? ""} ${(idea.keywords ?? []).join(" ")}`)) {
    if (STOP.has(t)) continue;
    set.add(t);
    if (t.length > 4 && t.endsWith("s")) set.add(t.slice(0, -1));
  }
  return set;
}

export interface ClosestContext {
  mode: EditorMode;
  hasAudio: boolean;
  limit?: number;
}

/**
 * The closest things the Director CAN do for a request it didn't understand.
 * Ranks available ideas by overlap with the request (after stop-words and
 * everyday synonyms: "shorter" → highlight, "subtitles" → captions…). With no
 * overlap at all it falls back to the mode's starters, so there's always
 * something to tap.
 */
export function closestIdeas(request: string, ctx: ClosestContext): PromptIdea[] {
  const limit = ctx.limit ?? 3;
  const want = expand(request);
  const pool = PROMPT_LIBRARY.filter((i) => isAvailable(i.needs, ctx.mode, ctx.hasAudio));
  const scored = pool
    .map((idea, index) => {
      const have = ideaTokens(idea);
      let score = 0;
      for (const w of want) {
        if (have.has(w)) score += 3;
        else if (w.length >= 4 && [...have].some((h) => h.startsWith(w) || w.startsWith(h))) score += 1;
      }
      return { idea, score, index };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.idea);
  if (scored.length > 0) return scored.slice(0, limit);
  return STARTERS[ctx.mode]
    .map(getIdea)
    .filter((i): i is PromptIdea => !!i && isAvailable(i.needs, ctx.mode, ctx.hasAudio))
    .slice(0, limit);
}

// ---- onboarding checklist ---------------------------------------------------------

export type OnboardingStepId = "content" | "edit" | "preview" | "export";

export interface OnboardingSignals {
  /** There's something to play (footage, photos, or a text video). */
  hasContent: boolean;
  /** The doc changed after content existed (any edit: Director, chip, manual). */
  edited: boolean;
  /** The preview was played. */
  previewed: boolean;
  /** An .mp4 export was started. */
  exported: boolean;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  hint: string;
  done: boolean;
}

export function onboardingSteps(s: OnboardingSignals): OnboardingStep[] {
  return [
    { id: "content", label: "Add footage or start from text", hint: "Upload a video or photos — or type a script, no footage needed.", done: s.hasContent },
    { id: "edit", label: "Make your first edit", hint: "Tap a suggestion or just describe it: “make it vertical”.", done: s.hasContent && s.edited },
    { id: "preview", label: "Preview it", hint: "Press Space or the play button to watch your edit.", done: s.hasContent && s.previewed },
    { id: "export", label: "Download your video", hint: "Render a real .mp4, ready to post.", done: s.exported },
  ];
}

export function onboardingProgress(steps: OnboardingStep[]): { done: number; total: number; next: OnboardingStep | null } {
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, next: steps.find((s) => !s.done) ?? null };
}

// ---- recent prompts ---------------------------------------------------------------

export const RECENT_MAX = 20;

/** Newest first; case-insensitive de-dupe (re-running a prompt moves it to the top). */
export function pushRecent(list: readonly string[], prompt: string, max = RECENT_MAX): string[] {
  const p = prompt.trim();
  if (!p) return [...list];
  const key = p.toLowerCase();
  return [p, ...list.filter((x) => x.trim().toLowerCase() !== key)].slice(0, max);
}

/**
 * Walk the history from the composer. `index` null = the live draft. `dir` "older"
 * (↑) goes back in time, "newer" (↓) forward; stepping past the newest returns to
 * the draft (`index: null, text: null`). Stops at the oldest entry.
 */
export function recallRecent(
  list: readonly string[],
  index: number | null,
  dir: "older" | "newer",
): { index: number | null; text: string | null } {
  if (list.length === 0) return { index: null, text: null };
  if (dir === "older") {
    const next = index === null ? 0 : Math.min(index + 1, list.length - 1);
    return { index: next, text: list[next]! };
  }
  if (index === null) return { index: null, text: null };
  if (index <= 0) return { index: null, text: null };
  return { index: index - 1, text: list[index - 1]! };
}
