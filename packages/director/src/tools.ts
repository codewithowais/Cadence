/**
 * Director tools — the ONLY way the Director changes a project. Each tool is
 * typed (Zod input), self-describing, and operates on ProjectState. Every
 * capability is a tool; the Director's shape never changes as we add features.
 * The real Claude Director will call these exact tools.
 */
import { z } from "zod";
import {
  BackgroundGradient,
  BackgroundPattern,
  docDurationSec,
  EditDoc,
  SHAPE_KINDS,
  TEXT_ANIM_STYLES,
  TEXT_ANIM_UNITS,
  TEXT_EXIT_STYLES,
  TEXT_LOOP_STYLES,
  TextEffect,
  TextFillGradient,
  TransitionType,
  type BlendMode,
  type CurvePoint,
  type EditDoc as EditDocT,
  type KeyframeEasing,
  type KeyframeProp,
  type MediaAsset,
} from "@cadence/core";
// NOTE: only the TYPE is imported statically. The TTS provider values
// (selectTtsProvider/ttsConfigFromEnv/estimateSpeechSec) are lazy-imported inside
// generate_voiceover's execute() so the @cadence/understanding barrel — which
// eagerly pulls whisper-transcriber's `node:child_process` — never enters the
// client bundle graph when a browser component imports the director barrel.
import type { Transcript } from "@cadence/understanding";
import type { ProjectState } from "./project";
import { buildHighlightDoc } from "./highlight";
import { fillerCut } from "./filler";
import { buildSlideshowDoc } from "./slideshow";
import { buildDemo, type BuildDemoOptions } from "./demo";
import { addTrack, moveClipToTrack, removeTrack, reorderTrack, setTrack } from "./tracks";
import { addSfx, autoDuck, autoSfx, beatSync, generatedMusicOf, generateMusic, setVoiceEnhance } from "./audio";
import { MOOD_DEFS, SFX_DEFS, type MusicMood, type SfxKind } from "./sound-synth";
import { rollEdit, slipEdit, slideEdit } from "./trims";
import {
  buildTextVideo,
  restyleTextVideo,
  textVideoScenes,
  TEXT_VIDEO_FORMATS,
  TEXT_VIDEO_THEME_DEFS,
  TEXT_VIDEO_THEMES,
  type TextVideoAspect,
  type TextVideoFormat,
  type TextVideoPace,
  type TextVideoTheme,
} from "./textvideo";
import {
  animateText,
  setBackground,
  styleText,
  type AnimateTextInput,
  type SetBackgroundInput,
  type StyleTextInput,
} from "./text-ops";
import {
  addAdjustment,
  addBroll,
  addCallout,
  addCaptions,
  addCursor,
  addEmphasis,
  addShape,
  applyLayout,
  addFades,
  addKeyframe,
  addKineticTitle,
  addMarker,
  addMask,
  addMusic,
  addTitle,
  adjustColor,
  adjustCurves,
  adjustHsl,
  animate,
  applyLook,
  applyLut,
  applyVfx,
  audioFade,
  autoMix,
  autoReframe,
  addVoiceover,
  carryOverAudio,
  chromaKey,
  clearTransition,
  setCleanAudio,
  editByTranscript,
  freezeFrame,
  moveKeyframe,
  normalizeLoudness,
  reframe,
  reframeTo,
  regionBlur,
  removeKeyframe,
  removeSilence,
  reverseClip,
  setBlend,
  setPan,
  setPlatform,
  setQuality,
  setSpeed,
  setStabilize,
  setSpeedRamp,
  setTransition,
  setZoom,
  positionCaptions,
  styleCaptions,
  setKaraoke,
  typeText,
  type AspectKey,
  type BrollCorner,
  type CaptionStyleOpts,
  type KaraokeStyle,
  type LayoutKind,
  type SetKaraokeOptions,
  type LookKey,
  type PlatformKey,
  type QualityKey,
  type SpeedRampPreset,
  type SpeedTarget,
  type TitleAnimStyle,
  type TitleStyle,
  type TranscriptEditMode,
  type TranscriptEditUnit,
} from "./edits";

const KF_PROPS = ["x", "y", "scale", "rotation", "opacity", "volume"] as const;
const KF_EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out"] as const;
const PLATFORM_ENUM = [
  "youtube", "youtube-shorts", "tiktok", "reels", "instagram-feed", "instagram-story",
] as const;

const LOOK_KEYS = [
  "warm", "cool", "vivid", "bw", "cinematic", "vintage", "noir", "vibrant",
  "bleach-bypass", "moody", "golden-hour", "matte", "punch", "none",
] as const;

const ASPECT_ENUM = ["9:16", "1:1", "4:5", "16:9", "21:9", "4:3", "2.39:1", "2:3"] as const;

export interface ToolContext {
  project: ProjectState;
}

export interface ToolResult {
  summary: string;
  durationSec: number;
}

export interface DirectorTool<I> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

// ---- helpers ---------------------------------------------------------------

function sourceVideo(project: ProjectState): { media: MediaAsset; transcript: Transcript } {
  const media = project.media.find((m) => m.kind === "video");
  if (!media) throw new Error("Add a video first — this edit needs source footage.");
  const transcript = project.getTranscript(media.id);
  if (!transcript) throw new Error("Still understanding the video — try again in a moment.");
  return { media, transcript };
}

function images(project: ProjectState): MediaAsset[] {
  return project.media.filter((m) => m.kind === "image");
}

/** First audio asset in the project, for background music. */
function audioAsset(project: ProjectState): MediaAsset {
  const a = project.media.find((m) => m.kind === "audio");
  if (!a) throw new Error("Add a music/audio file first — this needs an audio track.");
  return a;
}

/** A media asset to overlay as b-roll: a chosen id, else the first non-main clip. */
function brollAsset(project: ProjectState, mediaId?: string): MediaAsset {
  if (mediaId) {
    const m = project.media.find((x) => x.id === mediaId);
    if (m) return m;
  }
  // Prefer an image or a second video/image not already the main footage.
  const img = project.media.find((m) => m.kind === "image");
  if (img) return img;
  const vids = project.media.filter((m) => m.kind === "video");
  if (vids.length > 1) return vids[1]!;
  if (vids.length === 1) return vids[0]!;
  throw new Error("Add a photo or a second clip to overlay as b-roll.");
}

function commit(project: ProjectState, doc: EditDocT, summary: string): ToolResult {
  project.setDoc(doc);
  return { summary, durationSec: docDurationSec(project.doc) };
}

// ---- set_timeline (keystone) ----------------------------------------------

export const setTimelineTool: DirectorTool<{ doc: EditDocT }> = {
  name: "set_timeline",
  description: "Replace the project's timeline with a complete, schema-valid edit-doc.",
  inputSchema: z.object({ doc: EditDoc }),
  async execute(input, ctx) {
    return commit(ctx.project, input.doc, "Set the timeline.");
  },
};

// ---- create_highlight ------------------------------------------------------

export const createHighlightTool: DirectorTool<{ targetSec: number }> = {
  name: "create_highlight",
  description: "Cut a highlight of the best segments up to a target duration.",
  inputSchema: z.object({ targetSec: z.number().positive().default(60) }),
  async execute(input, ctx) {
    const { media, transcript } = sourceVideo(ctx.project);
    const doc = buildHighlightDoc(media, transcript, { targetSec: input.targetSec, title: "Highlights" });
    const cuts = doc.tracks[0]?.clips.length ?? 0;
    return commit(
      ctx.project,
      doc,
      `Cut a ${Math.round(docDurationSec(doc))}s highlight — ${cuts} of ${transcript.segments.length} segments.`,
    );
  },
};

// ---- filler_cut ------------------------------------------------------------

export const fillerCutTool: DirectorTool<Record<string, never>> = {
  name: "filler_cut",
  description: "Remove filler-word segments and long pauses; tighten the video.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { media, transcript } = sourceVideo(ctx.project);
    const { doc, kept, dropped } = fillerCut(media, transcript);
    return commit(
      ctx.project,
      doc,
      `Tightened the cut — kept ${kept} segments, dropped ${dropped} filler/pauses (${Math.round(docDurationSec(doc))}s).`,
    );
  },
};

// ---- reframe ---------------------------------------------------------------

export const reframeTool: DirectorTool<{ aspect?: AspectKey; width?: number; height?: number }> = {
  name: "reframe",
  description:
    "Reframe the composition to a new aspect ratio (9:16, 1:1, 4:5, 16:9, 21:9, 4:3, 2.39:1, 2:3) or to a custom width×height (pass width and height instead of aspect).",
  inputSchema: z
    .object({
      aspect: z.enum(ASPECT_ENUM).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .refine((v) => v.aspect !== undefined || (v.width !== undefined && v.height !== undefined), {
      message: "provide an aspect, or both width and height",
    }),
  async execute(input, ctx) {
    if (input.width !== undefined && input.height !== undefined) {
      const doc = reframeTo(ctx.project.doc, input.width, input.height);
      return commit(ctx.project, doc, `Reframed to ${doc.meta.width}×${doc.meta.height}.`);
    }
    const doc = reframe(ctx.project.doc, input.aspect!);
    return commit(ctx.project, doc, `Reframed to ${input.aspect}.`);
  },
};

// ---- add_captions ----------------------------------------------------------

export const captionsTool: DirectorTool<{ karaoke?: boolean; highlight?: string; karaokeStyle?: KaraokeStyle }> = {
  name: "add_captions",
  description:
    "Burn in captions from the transcript, synced through the current cuts. Every caption carries per-word timing; pass karaoke:true to make them highlight word-by-word as spoken (highlight = active-word color; karaokeStyle = color/fill/box).",
  inputSchema: z.object({
    karaoke: z.boolean().optional(),
    highlight: z.string().optional(),
    karaokeStyle: z.enum(["color", "fill", "box"]).optional(),
  }),
  async execute(input, ctx) {
    const { transcript } = sourceVideo(ctx.project);
    const doc = addCaptions(ctx.project.doc, transcript, {
      karaoke: input.karaoke,
      highlight: input.highlight,
      karaokeStyle: input.karaokeStyle,
    });
    const capTrack = doc.tracks.find((t) => t.id === "captions");
    return commit(
      ctx.project,
      doc,
      `Added ${capTrack?.clips.length ?? 0} captions${input.karaoke ? " (karaoke word-highlight)" : ""}.`,
    );
  },
};

// ---- set_karaoke -----------------------------------------------------------

export const setKaraokeTool: DirectorTool<SetKaraokeOptions> = {
  name: "set_karaoke",
  description:
    "Turn word-by-word karaoke highlighting on/off for captions (needs captions with per-word timing from add_captions). enabled (default true), highlight (active-word color), style (color/fill/box). Pass clipId to affect ONE caption; omit for all.",
  inputSchema: z.object({
    enabled: z.boolean().optional(),
    highlight: z.string().optional(),
    style: z.enum(["color", "fill", "box"]).optional(),
    clipId: z.string().optional(),
  }),
  async execute(input, ctx) {
    const doc = setKaraoke(ctx.project.doc, input);
    const on = input.enabled ?? true;
    return commit(ctx.project, doc, on ? "Enabled karaoke word-highlight on captions." : "Disabled karaoke highlight.");
  },
};

// ---- apply_look ------------------------------------------------------------

export const lookTool: DirectorTool<{ look: LookKey }> = {
  name: "apply_look",
  description:
    "Apply a color-grade preset (warm, cool, vivid, bw, cinematic, vintage, noir, vibrant, bleach-bypass, moody, golden-hour, matte, punch, none).",
  inputSchema: z.object({ look: z.enum(LOOK_KEYS) }),
  async execute(input, ctx) {
    const doc = applyLook(ctx.project.doc, input.look);
    return commit(ctx.project, doc, `Applied the ${input.look} look.`);
  },
};

// ---- adjust_color (manual grade) -------------------------------------------

export const adjustColorTool: DirectorTool<{ brightness?: number; contrast?: number; saturation?: number; warmth?: number }> = {
  name: "adjust_color",
  description:
    "Manually nudge the color grade on the main clips: brightness/contrast/saturation multipliers (1 = neutral) and warmth (0–1). Omitted fields keep their current value. Faithful — tone only, no content change.",
  inputSchema: z.object({
    brightness: z.number().min(0).max(4).optional(),
    contrast: z.number().min(0).max(4).optional(),
    saturation: z.number().min(0).max(4).optional(),
    warmth: z.number().min(0).max(1).optional(),
  }),
  async execute(input, ctx) {
    const doc = adjustColor(ctx.project.doc, input);
    const parts = Object.entries(input)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k} ${v}`);
    return commit(
      ctx.project,
      doc,
      parts.length ? `Adjusted the grade (${parts.join(", ")}).` : "Adjusted the color grade.",
    );
  },
};

// ---- add_title -------------------------------------------------------------

export const titleTool: DirectorTool<{ text: string; style?: TitleStyle }> = {
  name: "add_title",
  description: "Add a title card or lower-third with a fade in/out.",
  inputSchema: z.object({ text: z.string().min(1), style: z.enum(["card", "lower-third"]).optional() }),
  async execute(input, ctx) {
    const doc = addTitle(ctx.project.doc, input.text, input.style ?? "card");
    return commit(ctx.project, doc, `Added a ${input.style ?? "card"} title: “${input.text}”.`);
  },
};

// ---- add_fades -------------------------------------------------------------

export const fadesTool: DirectorTool<Record<string, never>> = {
  name: "add_fades",
  description: "Add a fade from black at the start and a fade to black at the end.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const doc = addFades(ctx.project.doc);
    return commit(ctx.project, doc, "Added fade in/out.");
  },
};

// ---- auto_mix --------------------------------------------------------------

export const autoMixTool: DirectorTool<Record<string, never>> = {
  name: "auto_mix",
  description: "Level speech to full and duck any music track under it.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const doc = autoMix(ctx.project.doc);
    return commit(ctx.project, doc, "Auto-mixed audio — leveled speech, ducked music.");
  },
};

// ---- make_slideshow --------------------------------------------------------

export const slideshowTool: DirectorTool<{ perImageSec?: number; look?: LookKey; title?: string }> = {
  name: "make_slideshow",
  description: "Build a video from a group of photos (Ken Burns + crossfades).",
  inputSchema: z.object({
    perImageSec: z.number().positive().optional(),
    look: z.enum(["warm", "cool", "vivid", "bw", "cinematic", "none"]).optional(),
    title: z.string().optional(),
  }),
  async execute(input, ctx) {
    const imgs = images(ctx.project);
    if (imgs.length === 0) throw new Error("Add some photos first to make a slideshow.");
    const built = buildSlideshowDoc(imgs, {
      perImageSec: input.perImageSec,
      look: input.look,
      title: input.title,
    });
    // buildSlideshowDoc returns a fresh doc; carry over any attached music /
    // voice-over so rebuilding the slideshow doesn't silently drop the audio.
    const doc = carryOverAudio(built, ctx.project.doc);
    const keptAudio = doc.tracks.some((t) => (t.id === "music" || t.id === "voiceover") && t.clips.length > 0);
    return commit(
      ctx.project,
      doc,
      `Made a ${Math.round(docDurationSec(doc))}s slideshow from ${imgs.length} photos${keptAudio ? " (kept your audio)" : ""}.`,
    );
  },
};

// ---- add_music -------------------------------------------------------------

export const musicTool: DirectorTool<{ mediaId?: string; volume?: number; startSec?: number; durationSec?: number }> = {
  name: "add_music",
  description:
    "Add a background-music track from an audio asset (starts ducked under speech). Optionally offset it with `startSec` and trim/extend it with `durationSec` (defaults to the shorter of the song and the timeline).",
  inputSchema: z.object({
    mediaId: z.string().optional(),
    volume: z.number().min(0).max(1).optional(),
    startSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().optional(),
  }),
  async execute(input, ctx) {
    const asset = input.mediaId
      ? ctx.project.media.find((m) => m.id === input.mediaId && m.kind === "audio") ?? audioAsset(ctx.project)
      : audioAsset(ctx.project);
    const doc = addMusic(ctx.project.doc, asset, {
      volume: input.volume,
      startSec: input.startSec,
      durationSec: input.durationSec,
    });
    const music = doc.tracks.find((t) => t.id === "music")?.clips[0];
    const dur = music?.kind === "audio" ? Math.round(music.duration) : undefined;
    return commit(
      ctx.project,
      doc,
      `Added background music (${asset.label ?? asset.src})${dur ? ` for ${dur}s` : ""}${input.startSec ? ` from ${input.startSec}s` : ""}, ducked under speech. ` +
        `(Music is silent in the preview — you'll hear it in the exported .mp4.)`,
    );
  },
};

// ---- add_broll -------------------------------------------------------------

export const brollTool: DirectorTool<{ mediaId?: string; atSec?: number; durationSec?: number; corner?: BrollCorner; size?: number }> = {
  name: "add_broll",
  description: "Overlay an image/video as picture-in-picture b-roll over the main clip for a time range.",
  inputSchema: z.object({
    mediaId: z.string().optional(),
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().optional(),
    corner: z.enum(["center", "top-left", "top-right", "bottom-left", "bottom-right"]).optional(),
    size: z.number().positive().max(1).optional(),
  }),
  async execute(input, ctx) {
    const asset = brollAsset(ctx.project, input.mediaId);
    const doc = addBroll(ctx.project.doc, asset, {
      atSec: input.atSec,
      durationSec: input.durationSec,
      corner: input.corner,
      size: input.size,
    });
    return commit(
      ctx.project,
      doc,
      `Overlaid b-roll (${asset.label ?? asset.src}) as picture-in-picture (${input.corner ?? "center"}).`,
    );
  },
};

// ---- add_kinetic_title -----------------------------------------------------

export const kineticTitleTool: DirectorTool<{ text: string; style?: TitleAnimStyle }> = {
  name: "add_kinetic_title",
  description:
    "Add an animated title. style: kinetic (slide + scale in), pop (scale in with an overshoot), or bounce (drops in with a bounce). Defaults to kinetic.",
  inputSchema: z.object({
    text: z.string().min(1),
    style: z.enum(["kinetic", "pop", "bounce"]).optional(),
  }),
  async execute(input, ctx) {
    const style = input.style ?? "kinetic";
    const doc = addKineticTitle(ctx.project.doc, input.text, style);
    const how =
      style === "pop" ? "pops in" : style === "bounce" ? "bounces in" : "slides + scales in";
    return commit(ctx.project, doc, `Added a ${style} title: “${input.text}” (${how}).`);
  },
};

// ---- apply_vfx (whole-frame overlays) --------------------------------------

export const vfxTool: DirectorTool<{ vignette?: number; grain?: number; lightLeak?: boolean }> = {
  name: "apply_vfx",
  description:
    "Add whole-frame finishing overlays: vignette (0–1 edge darkening), grain (0–1 film grain), and/or a warm lightLeak (on/off). Omitted fields keep their current value. Faithful — texture/tone only.",
  inputSchema: z
    .object({
      vignette: z.number().min(0).max(1).optional(),
      grain: z.number().min(0).max(1).optional(),
      lightLeak: z.boolean().optional(),
    })
    .refine((v) => v.vignette !== undefined || v.grain !== undefined || v.lightLeak !== undefined, {
      message: "provide a vignette, grain, or lightLeak value",
    }),
  async execute(input, ctx) {
    const doc = applyVfx(ctx.project.doc, input);
    const parts: string[] = [];
    if (input.vignette !== undefined) parts.push(`vignette ${input.vignette}`);
    if (input.grain !== undefined) parts.push(`grain ${input.grain}`);
    if (input.lightLeak !== undefined) parts.push(input.lightLeak ? "light leak on" : "light leak off");
    return commit(ctx.project, doc, `Applied VFX (${parts.join(", ")}).`);
  },
};

// ---- style_captions --------------------------------------------------------

export const styleCaptionsTool: DirectorTool<CaptionStyleOpts> = {
  name: "style_captions",
  description:
    "Fully restyle captions: fontFamily, fontSize, fontWeight (normal/medium/semibold/bold), italic, color, align (left/center/right), letterSpacing (px), uppercase, lineHeight, maxWidth (px word-wrap; null clears), outlineColor + outlineWidth, shadow ({color,blur,offsetX,offsetY} or null), background panel via box ({style:none/pill/box, color, opacity, radius, padX, padY} or null) or the legacy background (hex or null), and position (top/center/bottom/free) + offset (px). Pass clipId to style ONE caption clip; omit to style all. Omitted fields keep their value.",
  inputSchema: z.object({
    fontFamily: z.string().optional(),
    fontWeight: z.enum(["normal", "medium", "semibold", "bold"]).optional(),
    italic: z.boolean().optional(),
    color: z.string().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    letterSpacing: z.number().optional(),
    uppercase: z.boolean().optional(),
    lineHeight: z.number().positive().optional(),
    maxWidth: z.number().positive().nullable().optional(),
    background: z.string().nullable().optional(),
    box: z
      .object({
        style: z.enum(["none", "pill", "box"]).optional(),
        color: z.string().optional(),
        opacity: z.number().min(0).max(1).optional(),
        radius: z.number().min(0).optional(),
        padX: z.number().min(0).optional(),
        padY: z.number().min(0).optional(),
      })
      .nullable()
      .optional(),
    outlineColor: z.string().optional(),
    outlineWidth: z.number().min(0).optional(),
    shadow: z
      .object({
        color: z.string().optional(),
        blur: z.number().min(0).optional(),
        offsetX: z.number().optional(),
        offsetY: z.number().optional(),
      })
      .nullable()
      .optional(),
    fontSize: z.number().positive().optional(),
    position: z.enum(["top", "center", "bottom", "free"]).optional(),
    offset: z.number().optional(),
    clipId: z.string().optional(),
  }),
  async execute(input, ctx) {
    const doc = styleCaptions(ctx.project.doc, input);
    return commit(ctx.project, doc, "Styled the captions.");
  },
};

// ---- position_captions -----------------------------------------------------

export const positionCaptionsTool: DirectorTool<{
  anchor: "top" | "center" | "bottom" | "free";
  offset?: number;
  clipId?: string;
}> = {
  name: "position_captions",
  description:
    "Move captions to a vertical anchor preset — top, center, or bottom (the subtitle default) — with an optional offset in composition px (negative = up). Safe-margin aware. Pass clipId to move ONE caption clip; omit to move all.",
  inputSchema: z.object({
    anchor: z.enum(["top", "center", "bottom", "free"]),
    offset: z.number().optional(),
    clipId: z.string().optional(),
  }),
  async execute(input, ctx) {
    const doc = positionCaptions(ctx.project.doc, input);
    const where = input.anchor === "free" ? "their free position" : `the ${input.anchor}`;
    return commit(ctx.project, doc, `Moved the captions to ${where}.`);
  },
};

// ---- add_emphasis ----------------------------------------------------------

export const emphasisTool: DirectorTool<{ atSec?: number; durationSec?: number; zoom?: number }> = {
  name: "add_emphasis",
  description: "Punch in on the video (scale-up emphasis) over a sub-range for impact.",
  inputSchema: z.object({
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().optional(),
    zoom: z.number().min(1).max(3).optional(),
  }),
  async execute(input, ctx) {
    const doc = addEmphasis(ctx.project.doc, {
      atSec: input.atSec,
      durationSec: input.durationSec,
      zoom: input.zoom,
    });
    const z = input.zoom ?? 1.25;
    return commit(ctx.project, doc, `Added a punch-in emphasis (${z}× zoom at ${input.atSec ?? 0}s).`);
  },
};

// ---- set_quality -----------------------------------------------------------

export const qualityTool: DirectorTool<{ preset: QualityKey; aiUpscale?: boolean }> = {
  name: "set_quality",
  description: "Set output quality/enhancement (standard, high, ultra; optional AI upscale).",
  inputSchema: z.object({
    preset: z.enum(["standard", "high", "ultra"]),
    aiUpscale: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    const doc = setQuality(ctx.project.doc, input.preset, input.aiUpscale ?? false);
    const q = doc.quality;
    const note = input.aiUpscale
      ? " using AI super-resolution (faithful — no face/content changes)"
      : " with faithful sharpen + denoise (no face/content changes)";
    return commit(
      ctx.project,
      doc,
      `Quality set to ${input.preset}. On export it will render at ${q.targetWidth}×${q.targetHeight}${note}. ` +
        `(The preview stays at source resolution — real upscaling happens when you export.)`,
    );
  },
};

// ---- set_speed -------------------------------------------------------------

export const speedTool: DirectorTool<{ speed?: number; target?: SpeedTarget; atSec?: number }> = {
  name: "set_speed",
  description:
    "Retime the video: slow-motion (<1) or fast (>1). Pass a numeric `speed` (0.25–4) or a `target` (slow=0.5, fast=2, normal=1).",
  inputSchema: z
    .object({
      speed: z.number().min(0.25).max(4).optional(),
      target: z.enum(["slow", "fast", "normal"]).optional(),
      atSec: z.number().nonnegative().optional(),
    })
    .refine((v) => v.speed !== undefined || v.target !== undefined, {
      message: "provide a speed or a target",
    }),
  async execute(input, ctx) {
    const doc = setSpeed(ctx.project.doc, input);
    const applied = doc.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.kind === "video" && (c.speed ?? 1) !== 1);
    const speed = applied && applied.kind === "video" ? applied.speed : (input.speed ?? 1);
    const label = speed < 1 ? "slow-motion" : speed > 1 ? "sped up" : "normal speed";
    return commit(ctx.project, doc, `Set speed to ${speed}× (${label}).`);
  },
};

// ---- set_speed_ramp (time remap / speed curve) -----------------------------

const SPEED_RAMP_PRESET_ENUM = [
  "bullet-time",
  "hero",
  "ease-in-out",
  "ramp-up",
  "ramp-down",
] as const satisfies readonly SpeedRampPreset[];

export const speedRampTool: DirectorTool<{
  points?: [number, number][];
  preset?: SpeedRampPreset;
  atSec?: number;
}> = {
  name: "set_speed_ramp",
  description:
    "Speed ramp / time-remap curve (CapCut 'Curve'): vary playback speed across the clip. Pass `points` — control points [clipProgress 0..1, speedMultiplier 0.1..10] — for a custom curve, or a named `preset` (bullet-time, hero, ease-in-out, ramp-up, ramp-down). Optional `atSec` targets a single clip. The clip keeps its timeline length; only how fast it plays through the source varies.",
  inputSchema: z
    .object({
      points: z
        .array(z.tuple([z.number().min(0).max(1), z.number().min(0.1).max(10)]))
        .min(2)
        .optional(),
      preset: z.enum(SPEED_RAMP_PRESET_ENUM).optional(),
      atSec: z.number().nonnegative().optional(),
    })
    .refine((v) => v.points !== undefined || v.preset !== undefined, {
      message: "provide points or a preset",
    }),
  async execute(input, ctx) {
    const doc = setSpeedRamp(ctx.project.doc, input);
    const label = input.preset
      ? `Applied a "${input.preset}" speed ramp.`
      : `Applied a custom speed ramp (${input.points!.length} points).`;
    return commit(ctx.project, doc, label);
  },
};

// ---- zoom (manual static reframe) ------------------------------------------

export const zoomTool: DirectorTool<{ scale?: number; panXFrac?: number; panYFrac?: number; atSec?: number }> = {
  name: "zoom",
  description:
    "Statically punch in / reframe the shot: set a zoom `scale` (1–4, e.g. 1.5) and optional pan (panXFrac/panYFrac, fraction of frame from center). Distinct from the animated emphasis punch-in.",
  inputSchema: z.object({
    scale: z.number().min(1).max(4).optional(),
    panXFrac: z.number().min(-0.5).max(0.5).optional(),
    panYFrac: z.number().min(-0.5).max(0.5).optional(),
    atSec: z.number().nonnegative().optional(),
  }),
  async execute(input, ctx) {
    const doc = setZoom(ctx.project.doc, input);
    return commit(ctx.project, doc, `Reframed with a ${input.scale ?? 1.3}× static zoom.`);
  },
};

// ---- set_transition --------------------------------------------------------

export const transitionTool: DirectorTool<{
  type: TransitionType;
  clipId?: string;
  atSec?: number;
}> = {
  name: "set_transition",
  description:
    "Set the transition style — 50+ types grouped as Fades (crossfade, dip-to-black, dissolve, fadewhite, fadegrays…), Wipes (wipe, wiperight, wipeup, wipedown, wipetl…), Slides (slide, slideright, slideup…), Smooth, Covers, Reveals, Opens & Closes (circleopen, horzopen…), Shapes (circlecrop, rectcrop), Diagonals, Slices, Zoom (zoom, zoomin), and Effects (pixelize, radial, hblur, squeezeh, squeezev). By default it applies to EVERY cut/photo. Pass `clipId` (or `atSec`) to set only ONE cut's incoming boundary (a per-cut transition), leaving the others as they are.",
  inputSchema: z.object({
    type: TransitionType,
    clipId: z.string().optional(),
    atSec: z.number().nonnegative().optional(),
  }),
  async execute(input, ctx) {
    const doc = setTransition(ctx.project.doc, input.type, 0.6, {
      clipId: input.clipId,
      atSec: input.atSec,
    });
    const where =
      input.clipId !== undefined
        ? ` on cut “${input.clipId}”`
        : input.atSec !== undefined
          ? ` on the cut at ${input.atSec}s`
          : " between clips";
    return commit(ctx.project, doc, `Set ${input.type} transition${where}.`);
  },
};

export const clearTransitionTool: DirectorTool<{ clipId: string }> = {
  name: "clear_transition",
  description: "Turn one cut's incoming transition back into a hard cut (by clipId).",
  inputSchema: z.object({ clipId: z.string() }),
  async execute(input, ctx) {
    const doc = clearTransition(ctx.project.doc, input.clipId);
    return commit(ctx.project, doc, `Cleared the transition on cut “${input.clipId}”.`);
  },
};

// ---- build_demo (interaction walkthrough from screenshots) -----------------

export const buildDemoTool: DirectorTool<{ perScreenSec?: number; transition?: TransitionType; login?: boolean }> = {
  name: "build_demo",
  description:
    "Turn the project's screenshots (image media, in order = screens) into an animated product walkthrough: each screenshot becomes a full-frame screen, sequenced with a transition. When `login` is set, screen 1 gets a demo interaction — a typed email + password (typewriter) and a cursor that moves to a button and clicks. Field/button positions are sensible defaults (no vision) the user can nudge with add_cursor / type_text / add_callout.",
  inputSchema: z.object({
    perScreenSec: z.number().positive().optional(),
    transition: TransitionType.optional(),
    login: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    const imgs = images(ctx.project);
    if (imgs.length === 0) throw new Error("Add screenshots (images) first to build a demo.");
    const opts: BuildDemoOptions = {
      perScreenSec: input.perScreenSec,
      transition: input.transition,
      login: input.login,
    };
    const doc = buildDemo(imgs, opts);
    return commit(
      ctx.project,
      doc,
      `Built a ${Math.round(docDurationSec(doc))}s walkthrough from ${imgs.length} screen${imgs.length === 1 ? "" : "s"}` +
        `${input.login ? " with a typed login + click on screen 1" : ""}. ` +
        `Field/button positions are defaults — nudge them with add_cursor / type_text / add_callout.`,
    );
  },
};

// ---- add_cursor ------------------------------------------------------------

export const addCursorTool: DirectorTool<{
  waypoints: { x: number; y: number; atSec: number }[];
  clicks?: number[];
  size?: number;
  color?: string;
}> = {
  name: "add_cursor",
  description:
    "Add an animated mouse pointer that eases through `waypoints` (composition px, each with a timeline `atSec`) and fires a click ripple at each time in `clicks`.",
  inputSchema: z.object({
    waypoints: z
      .array(z.object({ x: z.number(), y: z.number(), atSec: z.number().nonnegative() }))
      .min(1),
    clicks: z.array(z.number().nonnegative()).optional(),
    size: z.number().positive().optional(),
    color: z.string().optional(),
  }),
  async execute(input, ctx) {
    const doc = addCursor(ctx.project.doc, input);
    return commit(
      ctx.project,
      doc,
      `Added a cursor through ${input.waypoints.length} waypoint${input.waypoints.length === 1 ? "" : "s"}` +
        `${input.clicks?.length ? ` with ${input.clicks.length} click${input.clicks.length === 1 ? "" : "s"}` : ""}.`,
    );
  },
};

// ---- type_text (typewriter) ------------------------------------------------

export const typeTextTool: DirectorTool<{
  text: string;
  x: number;
  y: number;
  atSec?: number;
  typeSec?: number;
  holdSec?: number;
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  background?: string;
}> = {
  name: "type_text",
  description:
    "Add a typewriter text clip that types `text` out at (x, y) in composition px over `typeSec`, then holds for `holdSec`. Great for typing into a form field in a demo.",
  inputSchema: z.object({
    text: z.string().min(1),
    x: z.number(),
    y: z.number(),
    atSec: z.number().nonnegative().optional(),
    typeSec: z.number().positive().optional(),
    holdSec: z.number().nonnegative().optional(),
    fontSize: z.number().positive().optional(),
    color: z.string().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    background: z.string().optional(),
  }),
  async execute(input, ctx) {
    const doc = typeText(ctx.project.doc, input);
    return commit(ctx.project, doc, `Typed “${input.text}” at (${Math.round(input.x)}, ${Math.round(input.y)}).`);
  },
};

// ---- add_callout -----------------------------------------------------------

export const addCalloutTool: DirectorTool<{
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  zoom?: number;
  dim?: boolean;
  color?: string;
  atSec?: number;
  durationSec?: number;
}> = {
  name: "add_callout",
  description:
    "Highlight a rectangular region {x,y,w,h} (composition px) with a bright rounded border, optionally dimming everything outside it, with an optional `label` and an optional `zoom` (1–4) toward the rect.",
  inputSchema: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    label: z.string().optional(),
    zoom: z.number().min(1).max(4).optional(),
    dim: z.boolean().optional(),
    color: z.string().optional(),
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().optional(),
  }),
  async execute(input, ctx) {
    const doc = addCallout(ctx.project.doc, input);
    return commit(
      ctx.project,
      doc,
      `Highlighted ${Math.round(input.w)}×${Math.round(input.h)} at (${Math.round(input.x)}, ${Math.round(input.y)})` +
        `${input.zoom && input.zoom > 1 ? ` and zoomed ${input.zoom}×` : ""}${input.label ? ` — “${input.label}”` : ""}.`,
    );
  },
};

// ---- add_shape -------------------------------------------------------------

export const addShapeTool: DirectorTool<{
  shape?: (typeof SHAPE_KINDS)[number];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  rotation?: number;
  atSec?: number;
  durationSec?: number;
}> = {
  name: "add_shape",
  description:
    "Add a vector SHAPE overlay — 'rect', 'ellipse', 'line', or 'arrow' (default rect) — centered at {x,y} (composition px; defaults to frame center) sized {w,h} (line/arrow: w = length). `fill`/`fillOpacity` paint rect/ellipse ('' = no fill); `stroke`/`strokeWidth` draw the outline or the line/arrow; `radius` rounds rectangle corners; `rotation` in degrees. Great for lower-third backing bars, highlight boxes, progress bars, and pointers. Faithful overlay.",
  inputSchema: z.object({
    shape: z.enum(SHAPE_KINDS).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    fill: z.string().optional(),
    fillOpacity: z.number().min(0).max(1).optional(),
    stroke: z.string().optional(),
    strokeWidth: z.number().min(0).optional(),
    radius: z.number().min(0).optional(),
    rotation: z.number().optional(),
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().optional(),
  }),
  async execute(input, ctx) {
    const doc = addShape(ctx.project.doc, input);
    return commit(ctx.project, doc, `Added a ${input.shape ?? "rect"} shape.`);
  },
};

// ---- stabilize -------------------------------------------------------------

export const stabilizeTool: DirectorTool<{ on?: boolean; atSec?: number }> = {
  name: "stabilize",
  description:
    "Stabilize shaky footage on export (ffmpeg vidstab: detect + smooth, with auto-zoom to hide the shifted borders). Applies to the video clip at `atSec`, or all video clips. `on` defaults to true. Export-only — the live preview is unchanged. Faithful: smooths camera motion of the existing frames, invents nothing.",
  inputSchema: z.object({ on: z.boolean().optional(), atSec: z.number().nonnegative().optional() }),
  async execute(input, ctx) {
    const doc = setStabilize(ctx.project.doc, input.on ?? true, { atSec: input.atSec });
    return commit(ctx.project, doc, input.on === false ? "Turned off stabilization." : "Stabilization on (applied on export).");
  },
};

// ---- apply_layout (PiP / split-screen) -------------------------------------

export const applyLayoutTool: DirectorTool<{ layout: LayoutKind; clipIds?: string[] }> = {
  name: "apply_layout",
  description:
    "Arrange the video/photo clips into a LAYOUT: '2up' (side-by-side), '3up', 'pip' (picture-in-picture, second clip inset bottom-right), or 'grid' (2×2). Positions clips into fraction-of-frame cells with margins by setting each clip's transform — works at any aspect. Optionally target specific `clipIds`; otherwise the first visual clips are placed. Needs at least 2 clips.",
  inputSchema: z.object({
    layout: z.enum(["2up", "3up", "pip", "grid"]),
    clipIds: z.array(z.string()).optional(),
  }),
  async execute(input, ctx) {
    const doc = applyLayout(ctx.project.doc, input.layout, input.clipIds);
    return commit(ctx.project, doc, `Applied the ${input.layout} layout.`);
  },
};

// ---- animate (keyframes) ---------------------------------------------------

export const animateTool: DirectorTool<{
  prop: KeyframeProp;
  to: number;
  from?: number;
  easing?: KeyframeEasing;
  atSec?: number;
  track?: string;
}> = {
  name: "animate",
  description:
    "Animate a property over the whole clip with keyframes: prop (x|y|scale|rotation|opacity|volume) eases from an optional `from` (default: current value) to `to`, with `easing` (linear/ease-in/ease-out/ease-in-out). Optionally target the clip at `atSec` or a specific `track` (e.g. titles). Use for a zoom/push over time (scale) or fading a title in (opacity).",
  inputSchema: z.object({
    prop: z.enum(KF_PROPS),
    to: z.number(),
    from: z.number().optional(),
    easing: z.enum(KF_EASINGS).optional(),
    atSec: z.number().nonnegative().optional(),
    track: z.string().optional(),
  }),
  async execute(input, ctx) {
    const doc = animate(ctx.project.doc, input);
    return commit(
      ctx.project,
      doc,
      `Animated ${input.prop}${input.from !== undefined ? ` from ${input.from}` : ""} to ${input.to} (${input.easing ?? "ease-in-out"}).`,
    );
  },
};

// ---- add_keyframe ----------------------------------------------------------

export const addKeyframeTool: DirectorTool<{
  prop: KeyframeProp;
  t: number;
  value: number;
  easing?: KeyframeEasing;
  atSec?: number;
  track?: string;
}> = {
  name: "add_keyframe",
  description:
    "Add one animation keyframe to a clip: prop (x|y|scale|rotation|opacity|volume), t (0..1 clip-progress), value, and easing. Optionally target the clip at `atSec` or a specific `track`.",
  inputSchema: z.object({
    prop: z.enum(KF_PROPS),
    t: z.number().min(0).max(1),
    value: z.number(),
    easing: z.enum(KF_EASINGS).optional(),
    atSec: z.number().nonnegative().optional(),
    track: z.string().optional(),
  }),
  async execute(input, ctx) {
    const doc = addKeyframe(ctx.project.doc, input);
    return commit(ctx.project, doc, `Added a ${input.prop} keyframe (t=${input.t} → ${input.value}).`);
  },
};

// ---- move_keyframe / remove_keyframe (manual keyframe parity) ---------------

export const moveKeyframeTool: DirectorTool<{
  clipId: string;
  prop: KeyframeProp;
  fromT: number;
  toT: number;
  value?: number;
}> = {
  name: "move_keyframe",
  description:
    "Move an existing keyframe on a clip (by clipId): the `prop` keyframe at `fromT` (0..1 clip-progress) moves to `toT`, optionally changing its `value`.",
  inputSchema: z.object({
    clipId: z.string(),
    prop: z.enum(KF_PROPS),
    fromT: z.number().min(0).max(1),
    toT: z.number().min(0).max(1),
    value: z.number().optional(),
  }),
  async execute(input, ctx) {
    const doc = moveKeyframe(ctx.project.doc, input.clipId, input.prop, input.fromT, input.toT, input.value);
    return commit(ctx.project, doc, `Moved the ${input.prop} keyframe (t=${input.fromT} → ${input.toT}).`);
  },
};

export const removeKeyframeTool: DirectorTool<{ clipId: string; prop: KeyframeProp; t: number }> = {
  name: "remove_keyframe",
  description:
    "Delete a keyframe on a clip (by clipId): the `prop` keyframe at `t` (0..1 clip-progress). The clip falls back to its static value when its last keyframe is removed.",
  inputSchema: z.object({
    clipId: z.string(),
    prop: z.enum(KF_PROPS),
    t: z.number().min(0).max(1),
  }),
  async execute(input, ctx) {
    const doc = removeKeyframe(ctx.project.doc, input.clipId, input.prop, input.t);
    return commit(ctx.project, doc, `Removed the ${input.prop} keyframe (t=${input.t}).`);
  },
};

// ---- reverse_clip ----------------------------------------------------------

export const reverseClipTool: DirectorTool<{ atSec?: number }> = {
  name: "reverse_clip",
  description: "Play the video backwards (all main clips, or the one active at `atSec`).",
  inputSchema: z.object({ atSec: z.number().nonnegative().optional() }),
  async execute(input, ctx) {
    const doc = reverseClip(ctx.project.doc, input);
    return commit(ctx.project, doc, "Reversed the clip (plays backwards).");
  },
};

// ---- freeze_frame ----------------------------------------------------------

export const freezeFrameTool: DirectorTool<{ atSec?: number }> = {
  name: "freeze_frame",
  description:
    "Freeze-frame: hold the frame shown at `atSec` (or the clip's start) for the whole clip — a still hold for emphasis or titles-over-freeze.",
  inputSchema: z.object({ atSec: z.number().nonnegative().optional() }),
  async execute(input, ctx) {
    const doc = freezeFrame(ctx.project.doc, input);
    return commit(ctx.project, doc, `Froze the frame${input.atSec !== undefined ? ` at ${input.atSec}s` : ""}.`);
  },
};

// ---- add_marker ------------------------------------------------------------

export const addMarkerTool: DirectorTool<{ t: number; label?: string }> = {
  name: "add_marker",
  description: "Add a timeline marker (chapter point / beat / note) at `t` seconds, with an optional label.",
  inputSchema: z.object({ t: z.number().nonnegative(), label: z.string().optional() }),
  async execute(input, ctx) {
    const doc = addMarker(ctx.project.doc, input.t, input.label);
    return commit(ctx.project, doc, `Added a marker at ${input.t}s${input.label ? ` — “${input.label}”` : ""}.`);
  },
};

// ---- set_platform (delivery presets) ---------------------------------------

export const platformTool: DirectorTool<{ platform: PlatformKey }> = {
  name: "set_platform",
  description:
    "Configure delivery for a platform (youtube, youtube-shorts, tiktok, reels, instagram-feed, instagram-story): reframes to the platform aspect, sets the quality preset, and sets the output fps.",
  inputSchema: z.object({ platform: z.enum(PLATFORM_ENUM) }),
  async execute(input, ctx) {
    const doc = setPlatform(ctx.project.doc, input.platform);
    return commit(
      ctx.project,
      doc,
      `Set delivery for ${input.platform}: ${doc.meta.width}×${doc.meta.height} @ ${doc.meta.fps}fps, ${doc.quality.preset} quality.`,
    );
  },
};

// ---- chroma_key (green screen) ---------------------------------------------

export const chromaKeyTool: DirectorTool<{ color?: string; similarity?: number; blend?: number; spill?: number }> = {
  name: "chroma_key",
  description:
    "Green-screen / chroma key: remove a background color from the overlay clip (or the main clip) so the layer beneath shows through. color (hex, default green), similarity (0.01–1), blend (0–1 edge softness), spill (0–1 spill suppression). Best on a b-roll overlay clip. Faithful — removes a background color only.",
  inputSchema: z.object({
    color: z.string().optional(),
    similarity: z.number().min(0.01).max(1).optional(),
    blend: z.number().min(0).max(1).optional(),
    spill: z.number().min(0).max(1).optional(),
  }),
  async execute(input, ctx) {
    const doc = chromaKey(ctx.project.doc, input);
    return commit(ctx.project, doc, `Keyed out the ${input.color ?? "green"} background (composites over the layer beneath).`);
  },
};

// ---- set_blend (blend modes) -----------------------------------------------

export const setBlendTool: DirectorTool<{ mode: BlendMode }> = {
  name: "set_blend",
  description:
    "Set how the overlay clip (or main clip) blends over the layer beneath: normal, screen, multiply, overlay, add, or soft-light. A non-normal blend makes the overlay a full-frame blend layer (a texture / double-exposure / leak).",
  inputSchema: z.object({
    mode: z.enum(["normal", "screen", "multiply", "overlay", "add", "soft-light"]),
  }),
  async execute(input, ctx) {
    const doc = setBlend(ctx.project.doc, input.mode);
    return commit(ctx.project, doc, `Set the blend mode to ${input.mode}.`);
  },
};

// ---- blur_region / pixelate_region -----------------------------------------

export const blurRegionTool: DirectorTool<{ type?: "blur" | "pixelate"; x: number; y: number; w: number; h: number; amount?: number; atSec?: number }> = {
  name: "blur_region",
  description:
    "Blur (or pixelate) a rectangular region {x,y,w,h} (composition px) of the main video — hide a face, plate, or logo. type: blur (default) or pixelate; amount 0–1 strength. Faithful — obscures a region only.",
  inputSchema: z.object({
    type: z.enum(["blur", "pixelate"]).optional(),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    amount: z.number().min(0).max(1).optional(),
    atSec: z.number().nonnegative().optional(),
  }),
  async execute(input, ctx) {
    const doc = regionBlur(ctx.project.doc, input);
    return commit(
      ctx.project,
      doc,
      `${input.type === "pixelate" ? "Pixelated" : "Blurred"} a ${Math.round(input.w)}×${Math.round(input.h)} region at (${Math.round(input.x)}, ${Math.round(input.y)}).`,
    );
  },
};

export const pixelateRegionTool: DirectorTool<{ x: number; y: number; w: number; h: number; amount?: number; atSec?: number }> = {
  name: "pixelate_region",
  description: "Pixelate (mosaic) a rectangular region {x,y,w,h} (composition px) of the main video — a compliance staple for hiding faces/plates.",
  inputSchema: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    amount: z.number().min(0).max(1).optional(),
    atSec: z.number().nonnegative().optional(),
  }),
  async execute(input, ctx) {
    const doc = regionBlur(ctx.project.doc, { ...input, type: "pixelate" });
    return commit(ctx.project, doc, `Pixelated a ${Math.round(input.w)}×${Math.round(input.h)} region at (${Math.round(input.x)}, ${Math.round(input.y)}).`);
  },
};

// ---- add_mask --------------------------------------------------------------

export const addMaskTool: DirectorTool<{ shape?: "rect" | "ellipse"; x: number; y: number; w: number; h: number; feather?: number; invert?: boolean }> = {
  name: "add_mask",
  description:
    "Mask the overlay clip (or main clip) to a shape {x,y,w,h} (composition px): reveal only inside the shape (rect or ellipse), or outside it with invert. feather softens the edge. Best on a b-roll overlay for a shaped reveal over the footage.",
  inputSchema: z.object({
    shape: z.enum(["rect", "ellipse"]).optional(),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    feather: z.number().min(0).optional(),
    invert: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    const doc = addMask(ctx.project.doc, input);
    return commit(
      ctx.project,
      doc,
      `Masked to a ${input.shape ?? "rect"} ${Math.round(input.w)}×${Math.round(input.h)}${input.invert ? " (outside)" : ""}.`,
    );
  },
};

// ---- adjust_curves ---------------------------------------------------------

export const adjustCurvesTool: DirectorTool<{ master?: CurvePoint[]; r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] }> = {
  name: "adjust_curves",
  description:
    "Set RGB tone curves on the main clips. Each channel is a list of control points [input, output] in 0..1 (e.g. master: [[0,0],[0.5,0.6],[1,1]] lifts mids). Provide master and/or per-channel r/g/b. Faithful — a tonal remap.",
  inputSchema: z.object({
    master: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).optional(),
    r: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).optional(),
    g: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).optional(),
    b: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).optional(),
  }),
  async execute(input, ctx) {
    const doc = adjustCurves(ctx.project.doc, input);
    return commit(ctx.project, doc, "Adjusted the tone curves.");
  },
};

// ---- adjust_hsl ------------------------------------------------------------

export const adjustHslTool: DirectorTool<{ hueShift?: number; saturation?: number }> = {
  name: "adjust_hsl",
  description:
    "Simple HSL grade on the main clips: hueShift (degrees, rotates all hues) and saturation (multiplier, 1 = neutral). Faithful — hue/saturation only. (Per-hue-range secondary saturation is not yet supported — this is a global nudge.)",
  inputSchema: z
    .object({
      hueShift: z.number().optional(),
      saturation: z.number().min(0).max(4).optional(),
    })
    .refine((v) => v.hueShift !== undefined || v.saturation !== undefined, {
      message: "provide a hueShift or a saturation",
    }),
  async execute(input, ctx) {
    const doc = adjustHsl(ctx.project.doc, input);
    const parts: string[] = [];
    if (input.hueShift !== undefined) parts.push(`hue ${input.hueShift}°`);
    if (input.saturation !== undefined) parts.push(`saturation ${input.saturation}`);
    return commit(ctx.project, doc, `Adjusted HSL (${parts.join(", ")}).`);
  },
};

// ---- apply_lut (.cube LUT import) ------------------------------------------

export const applyLutTool: DirectorTool<{ lut: string; clipId?: string }> = {
  name: "apply_lut",
  description:
    "Import a 3D LUT (.cube color lookup table) as the creative look, merged onto the main visual clips (or one clip by `clipId`). The LUT is applied on EXPORT (ffmpeg lut3d) as a color remap on top of the other grade; the canvas preview approximates the other grade fields but not the LUT (documented). Pass an empty `lut` to clear it. Faithful — color only.",
  inputSchema: z.object({ lut: z.string(), clipId: z.string().min(1).optional() }),
  async execute(input, ctx) {
    const doc = applyLut(ctx.project.doc, { lut: input.lut, clipId: input.clipId });
    return commit(
      ctx.project,
      doc,
      input.lut.trim() ? `Applied LUT “${input.lut}”.` : "Cleared the LUT.",
    );
  },
};

// ---- add_adjustment (adjustment layer) -------------------------------------

export const addAdjustmentTool: DirectorTool<{
  atSec?: number;
  durationSec?: number;
  look?: LookKey;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  warmth?: number;
}> = {
  name: "add_adjustment",
  description:
    "Add an ADJUSTMENT LAYER — a color grade that applies to EVERYTHING beneath it over a timeline window [atSec, atSec+durationSec], on its own topmost 'adjustments' track. Seed it from a `look` preset and/or explicit brightness/contrast/saturation/warmth. Unlike apply_look/adjust_color (which grade individual clips), this grades the whole composite for a span. Defaults span the whole timeline. Faithful — tone/color only.",
  inputSchema: z.object({
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().optional(),
    look: z.enum(LOOK_KEYS).optional(),
    brightness: z.number().min(0).max(4).optional(),
    contrast: z.number().min(0).max(4).optional(),
    saturation: z.number().min(0).max(4).optional(),
    warmth: z.number().min(0).max(1).optional(),
  }),
  async execute(input, ctx) {
    const { atSec, durationSec, look, ...gradeFields } = input;
    const grade = Object.values(gradeFields).some((v) => v !== undefined) ? gradeFields : undefined;
    const doc = addAdjustment(ctx.project.doc, { atSec, durationSec, look, grade });
    return commit(
      ctx.project,
      doc,
      `Added an adjustment layer${look ? ` (${look})` : ""}.`,
    );
  },
};

// ---- audio_fade ------------------------------------------------------------

export const audioFadeTool: DirectorTool<{ fadeInSec?: number; fadeOutSec?: number; track?: string }> = {
  name: "audio_fade",
  description:
    "Add an audio fade-in and/or fade-out (seconds) to the music/voice-over clips, or the main video audio when there is none. Optionally target a track id (e.g. music). Faithful — levels only.",
  inputSchema: z
    .object({
      fadeInSec: z.number().nonnegative().optional(),
      fadeOutSec: z.number().nonnegative().optional(),
      track: z.string().optional(),
    })
    .refine((v) => v.fadeInSec !== undefined || v.fadeOutSec !== undefined, {
      message: "provide a fadeInSec or fadeOutSec",
    }),
  async execute(input, ctx) {
    const doc = audioFade(ctx.project.doc, input);
    const parts: string[] = [];
    if (input.fadeInSec !== undefined) parts.push(`in ${input.fadeInSec}s`);
    if (input.fadeOutSec !== undefined) parts.push(`out ${input.fadeOutSec}s`);
    return commit(ctx.project, doc, `Added an audio fade (${parts.join(", ")}).`);
  },
};

// ---- set_pan ---------------------------------------------------------------

export const setPanTool: DirectorTool<{ pan: number; track?: string }> = {
  name: "set_pan",
  description:
    "Pan audio in the stereo field: -1 hard left, 0 center, 1 hard right. Applies to the music/voice-over clips, or the main video audio when there is none.",
  inputSchema: z.object({ pan: z.number().min(-1).max(1), track: z.string().optional() }),
  async execute(input, ctx) {
    const doc = setPan(ctx.project.doc, input.pan, { track: input.track });
    const where = input.pan < 0 ? "left" : input.pan > 0 ? "right" : "center";
    return commit(ctx.project, doc, `Panned audio ${input.pan} (${where}).`);
  },
};

// ---- normalize_loudness ----------------------------------------------------

export const normalizeLoudnessTool: DirectorTool<{ on?: boolean }> = {
  name: "normalize_loudness",
  description:
    "Toggle loudness normalization of the final mix to a streaming target (EBU R128, -14 LUFS) on export via ffmpeg loudnorm. On by default. (Applied at export — the preview is unchanged.)",
  inputSchema: z.object({ on: z.boolean().optional() }),
  async execute(input, ctx) {
    const on = input.on ?? true;
    const doc = normalizeLoudness(ctx.project.doc, on);
    return commit(
      ctx.project,
      doc,
      on
        ? "Loudness normalization on — the export will hit ~-14 LUFS. (Applied at export.)"
        : "Loudness normalization off.",
    );
  },
};

// ---- clean_audio -----------------------------------------------------------

export const cleanAudioTool: DirectorTool<{ on?: boolean }> = {
  name: "clean_audio",
  description:
    "Toggle clean-audio noise reduction (denoise) of the final mix on export via ffmpeg afftdn (FFT denoise — reduces steady background hiss/hum; a stronger arnndn model is used automatically when ARNNDN_MODEL is configured). Off by default. (Applied at export — the preview is unchanged.)",
  inputSchema: z.object({ on: z.boolean().optional() }),
  async execute(input, ctx) {
    const on = input.on ?? true;
    const doc = setCleanAudio(ctx.project.doc, on);
    return commit(
      ctx.project,
      doc,
      on
        ? "Clean audio on — the export will denoise the mix (afftdn). (Applied at export — the preview is unchanged.)"
        : "Clean audio off.",
    );
  },
};

// ---- edit_by_transcript (text-based editing) -------------------------------

export const editByTranscriptTool: DirectorTool<{ phrase: string; mode?: TranscriptEditMode; unit?: TranscriptEditUnit }> = {
  name: "edit_by_transcript",
  description:
    "Content-driven cut from the transcript: remove (or keep only) the spans whose words match a phrase, rebuilding the video from the remaining source spans (word-accurate). mode: remove (default) or keep. unit: segment (whole sentences containing the phrase — 'cut the sentence about …', 'keep only where they mention …') or word (the exact matched words — 'delete every um').",
  inputSchema: z.object({
    phrase: z.string().min(1),
    mode: z.enum(["remove", "keep"]).optional(),
    unit: z.enum(["word", "segment"]).optional(),
  }),
  async execute(input, ctx) {
    const { media, transcript } = sourceVideo(ctx.project);
    const res = editByTranscript(media, transcript, {
      phrase: input.phrase,
      mode: input.mode,
      unit: input.unit,
    });
    if (!res.matched) {
      throw new Error(`Couldn't find “${input.phrase}” in the transcript — nothing to ${input.mode === "keep" ? "keep" : "cut"}.`);
    }
    const mode = input.mode ?? "remove";
    const verb = mode === "keep" ? "Kept only" : "Removed";
    return commit(
      ctx.project,
      res.doc,
      `${verb} “${input.phrase}” — ${res.kept} span${res.kept === 1 ? "" : "s"} remain, ` +
        `${res.removed} ${input.unit === "word" ? "match" : "segment"}${res.removed === 1 ? "" : "es"} ${mode === "keep" ? "isolated" : "cut"} ` +
        `(-${Math.round(res.removedSec)}s, now ${Math.round(docDurationSec(res.doc))}s).`,
    );
  },
};

// ---- remove_silence (dead-air removal) -------------------------------------

export const removeSilenceTool: DirectorTool<{ thresholdSec?: number }> = {
  name: "remove_silence",
  description:
    "Remove dead air: keep every spoken segment but drop the inter-segment gaps longer than a threshold (default ~0.6s), tightening pacing. Distinct from filler_cut (which drops filler-heavy segments).",
  inputSchema: z.object({ thresholdSec: z.number().positive().max(10).optional() }),
  async execute(input, ctx) {
    const { media, transcript } = sourceVideo(ctx.project);
    const res = removeSilence(media, transcript, { thresholdSec: input.thresholdSec });
    return commit(
      ctx.project,
      res.doc,
      `Removed dead air — dropped ${res.gapsDropped} gap${res.gapsDropped === 1 ? "" : "s"} over ${input.thresholdSec ?? 0.6}s ` +
        `(-${Math.round(res.removedSec)}s, kept all ${res.segments} segments, now ${Math.round(docDurationSec(res.doc))}s).`,
    );
  },
};

// ---- auto_reframe (subject-aware; free centered + gated tracking) ----------

export const autoReframeTool: DirectorTool<{ aspect?: AspectKey; width?: number; height?: number; pan?: boolean; subjectTracking?: boolean }> = {
  name: "auto_reframe",
  description:
    "Auto-reframe to a target aspect (default 9:16) while keeping the subject framed. FREE: reframes + centers the subject, with an optional gentle keyframed settle-pan (pan). subjectTracking is a MONEY-GATED upgrade (a vision model would keyframe a crop path that follows the speaker) — off by default and NOT performed here; the free centered reframe is produced instead.",
  inputSchema: z.object({
    aspect: z.enum(ASPECT_ENUM).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    pan: z.boolean().optional(),
    subjectTracking: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    const doc = autoReframe(ctx.project.doc, {
      aspect: input.aspect,
      width: input.width,
      height: input.height,
      pan: input.pan,
      subjectTracking: input.subjectTracking,
    });
    const gated = input.subjectTracking
      ? " (Subject tracking is a gated upgrade — needs a vision provider; used the free centered reframe instead.)"
      : "";
    return commit(
      ctx.project,
      doc,
      `Auto-reframed to ${doc.meta.width}×${doc.meta.height}, subject centered${input.pan ? " with a settle-pan" : ""}.${gated}`,
    );
  },
};

// ---- generate_voiceover (TTS; money-gated) ---------------------------------

export const generateVoiceoverTool: DirectorTool<{ text: string; voice?: string; startSec?: number; volume?: number }> = {
  name: "generate_voiceover",
  description:
    "Generate a spoken voice-over from text (TTS) and add it as a 'voiceover' audio track. Requires a configured TTS provider (TTS_PROVIDER=cli|api) — money-gated; when none is configured it fails gracefully with a clear message. Faithful: adds a new audio track, never alters the footage.",
  inputSchema: z.object({
    text: z.string().min(1),
    voice: z.string().optional(),
    startSec: z.number().nonnegative().optional(),
    volume: z.number().min(0).max(1).optional(),
  }),
  async execute(input, ctx) {
    // Lazy-imported from the narrow ./tts subpath (NOT the barrel) — the barrel
    // re-exports whisper-transcriber.ts (node builtins + fs.realpath), and Turbopack
    // traces even dynamic imports through the client graph (Editor.tsx → director
    // barrel → tools.ts), which pulled the transcriber into the client bundle and
    // tripped the "dynamic filesystem access → trace whole project" build failure.
    const { selectTtsProvider, ttsConfigFromEnv, estimateSpeechSec } = await import("@cadence/understanding/tts");
    const provider = selectTtsProvider(ttsConfigFromEnv());
    if (!(await provider.isAvailable())) {
      // Graceful, honest gate — surfaced verbatim by the Director.
      throw new Error(
        `Can't generate a voice-over: no TTS provider is configured (money-gated). ` +
          `Set TTS_PROVIDER=cli (TTS_CLI_COMMAND) or TTS_PROVIDER=api (TTS_API_URL + TTS_API_KEY) to enable it.`,
      );
    }
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const outputPath = join(tmpdir(), `cadence-vo-${Date.now()}.mp3`);
    const result = await provider.synthesize({ text: input.text, outputPath, voice: input.voice, format: "mp3" });
    const durationSec = result.durationSec ?? estimateSpeechSec(input.text);
    const asset = {
      id: `vo-${Date.now()}`,
      kind: "audio" as const,
      src: result.outputPath,
      durationSec,
      label: "voice-over",
    };
    const doc = addVoiceover(ctx.project.doc, asset, { startSec: input.startSec, volume: input.volume, durationSec });
    return commit(
      ctx.project,
      doc,
      `Generated a ${Math.round(durationSec)}s voice-over (${provider.label}) and added it as a voiceover track.`,
    );
  },
};

// ---- track management (multi-layer) ----------------------------------------

export const addTrackTool: DirectorTool<{ kind: "visual" | "audio"; name?: string; afterTrackId?: string }> = {
  name: "add_track",
  description:
    "Add a new empty track (a layer). kind: visual (composites over lower visual tracks) or audio (mixed in). Optionally set a `name` and insert it directly ABOVE `afterTrackId` (higher z-order); otherwise it goes on top. Array order = z-order.",
  inputSchema: z.object({
    kind: z.enum(["visual", "audio"]),
    name: z.string().optional(),
    afterTrackId: z.string().optional(),
  }),
  async execute(input, ctx) {
    const doc = addTrack(ctx.project.doc, input);
    return commit(ctx.project, doc, `Added a ${input.kind} track${input.name ? ` “${input.name}”` : ""}.`);
  },
};

export const removeTrackTool: DirectorTool<{ trackId: string }> = {
  name: "remove_track",
  description: "Remove a track and every clip on it. Refuses on a locked track.",
  inputSchema: z.object({ trackId: z.string().min(1) }),
  async execute(input, ctx) {
    const doc = removeTrack(ctx.project.doc, input.trackId);
    return commit(ctx.project, doc, `Removed track “${input.trackId}”.`);
  },
};

export const setTrackTool: DirectorTool<{ trackId: string; name?: string; hidden?: boolean; locked?: boolean; muted?: boolean; solo?: boolean }> = {
  name: "set_track",
  description:
    "Set a track's metadata: name, hidden (exclude from render), locked (block edits), muted (drop from the audio mix), solo (when any audio track solos, only soloed audio plays). Omitted fields keep their current value.",
  inputSchema: z
    .object({
      trackId: z.string().min(1),
      name: z.string().optional(),
      hidden: z.boolean().optional(),
      locked: z.boolean().optional(),
      muted: z.boolean().optional(),
      solo: z.boolean().optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.hidden !== undefined ||
        v.locked !== undefined ||
        v.muted !== undefined ||
        v.solo !== undefined,
      { message: "provide at least one of name/hidden/locked/muted/solo" },
    ),
  async execute(input, ctx) {
    const { trackId, ...opts } = input;
    const doc = setTrack(ctx.project.doc, trackId, opts);
    const parts = Object.entries(opts)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k} ${v}`);
    return commit(ctx.project, doc, `Set track “${trackId}” (${parts.join(", ")}).`);
  },
};

export const reorderTrackTool: DirectorTool<{ trackId: string; toIndex: number }> = {
  name: "reorder_track",
  description:
    "Change a track's z-order by moving it to `toIndex` in the track array (0 = bottom of the stack, higher = painted on top). Reorders layers without touching clips.",
  inputSchema: z.object({ trackId: z.string().min(1), toIndex: z.number().int().nonnegative() }),
  async execute(input, ctx) {
    const doc = reorderTrack(ctx.project.doc, input.trackId, input.toIndex);
    return commit(ctx.project, doc, `Moved track “${input.trackId}” to z-index ${input.toIndex}.`);
  },
};

export const moveClipTool: DirectorTool<{ clipId: string; trackId?: string; atSec?: number }> = {
  name: "move_clip",
  description:
    "Move a clip to another track (`trackId`) and/or to a new start time (`atSec`). Dropping onto a magnetic/main visual track re-flows the lane (gap-close); onto an overlay/free lane it keeps the given start. Omit `trackId` to reposition within the clip's current track. Refuses on a locked track.",
  inputSchema: z
    .object({
      clipId: z.string().min(1),
      trackId: z.string().optional(),
      atSec: z.number().nonnegative().optional(),
    })
    .refine((v) => v.trackId !== undefined || v.atSec !== undefined, {
      message: "provide a trackId and/or atSec",
    }),
  async execute(input, ctx) {
    const current = ctx.project.doc.tracks.find((t) => t.clips.some((c) => c.id === input.clipId));
    if (!current) throw new Error(`No clip “${input.clipId}” on any track.`);
    const toTrackId = input.trackId ?? current.id;
    const doc = moveClipToTrack(ctx.project.doc, input.clipId, toTrackId, input.atSec);
    const where = input.trackId && input.trackId !== current.id ? ` to track “${input.trackId}”` : "";
    const at = input.atSec !== undefined ? ` at ${input.atSec}s` : "";
    return commit(ctx.project, doc, `Moved clip “${input.clipId}”${where}${at}.`);
  },
};

// ---- roll / slip / slide trims (advanced trim modes) -----------------------

export const rollEditTool: DirectorTool<{ clipId: string; deltaSec: number }> = {
  name: "roll_edit",
  description:
    "Roll the cut between a clip (clipId) and its NEXT neighbour on the main track: shift the shared boundary by deltaSec (positive = later, negative = earlier). The outgoing clip grows/shrinks and the incoming one shrinks/grows to match — both neighbours' outer edges and the total length stay fixed, and the incoming clip's head moves so the media stays continuous. Clamped to a min clip length and available source.",
  inputSchema: z.object({ clipId: z.string().min(1), deltaSec: z.number() }),
  async execute(input, ctx) {
    const doc = rollEdit(ctx.project.doc, input.clipId, input.deltaSec);
    return commit(ctx.project, doc, `Rolled the cut after “${input.clipId}” by ${input.deltaSec}s.`);
  },
};

export const slipEditTool: DirectorTool<{ clipId: string; deltaSec: number }> = {
  name: "slip_edit",
  description:
    "Slip a clip (clipId): shift WHAT IT SHOWS by deltaSec (source seconds) while its timeline start and duration stay fixed — only its source in/out moves. Positive reveals later source, negative earlier. Neighbours are untouched. Clamped so the source window stays inside the media.",
  inputSchema: z.object({ clipId: z.string().min(1), deltaSec: z.number() }),
  async execute(input, ctx) {
    const doc = slipEdit(ctx.project.doc, input.clipId, input.deltaSec);
    return commit(ctx.project, doc, `Slipped “${input.clipId}” source by ${input.deltaSec}s.`);
  },
};

export const slideEditTool: DirectorTool<{ clipId: string; deltaSec: number }> = {
  name: "slide_edit",
  description:
    "Slide a clip (clipId) along the timeline by deltaSec: the previous neighbour's duration grows/shrinks and the next neighbour's shrinks/grows to absorb it, so the clip's own duration and the total length stay fixed. Positive slides later, negative earlier. Clamped to a min clip length and available source. Needs a neighbour on both sides.",
  inputSchema: z.object({ clipId: z.string().min(1), deltaSec: z.number() }),
  async execute(input, ctx) {
    const doc = slideEdit(ctx.project.doc, input.clipId, input.deltaSec);
    return commit(ctx.project, doc, `Slid “${input.clipId}” by ${input.deltaSec}s.`);
  },
};

// ---- text video (Canva-style: a whole video from words) ----------------------

const TV_THEME_ENUM = TEXT_VIDEO_THEMES;
const TV_FORMAT_ENUM = TEXT_VIDEO_FORMATS;

export const makeTextVideoTool: DirectorTool<{
  script: string;
  theme?: TextVideoTheme;
  format?: TextVideoFormat;
  aspect?: TextVideoAspect;
  pace?: TextVideoPace;
}> = {
  name: "make_text_video",
  description:
    "Make a complete video from TEXT alone (no footage needed): split `script` into timed scenes (auto-detects a quote, a numbered/bulleted list, or a story; or force `format`), each an animated-typography scene on a themed background with scene transitions. `theme`: bold | minimal | neon | elegant | playful | corporate | retro | aurora | cinematic | handwritten. `aspect` 16:9 | 9:16 | 1:1 | 4:5. `pace` slow | normal | fast (reading speed). Keeps existing music/voice-over. Every scene stays editable.",
  inputSchema: z.object({
    script: z.string().min(1),
    theme: z.enum(TV_THEME_ENUM).optional(),
    format: z.enum(TV_FORMAT_ENUM).optional(),
    aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional(),
    pace: z.enum(["slow", "normal", "fast"]).optional(),
  }),
  async execute(input, ctx) {
    const doc = buildTextVideo(ctx.project.doc, input);
    const n = textVideoScenes(doc).length;
    const theme = TEXT_VIDEO_THEME_DEFS[doc.textVideo!.theme as TextVideoTheme].label;
    return commit(
      ctx.project,
      doc,
      `Made a ${n}-scene ${theme.toLowerCase()} text video (${doc.textVideo!.format}, ${Math.round(docDurationSec(doc))}s, ${doc.meta.width}×${doc.meta.height}). Edit any scene in the Text room, or ask for another theme.`,
    );
  },
};

export const restyleTextVideoTool: DirectorTool<{ theme: TextVideoTheme }> = {
  name: "restyle_text_video",
  description: "Switch a text video to another theme (fonts, colors, backgrounds, motion, transitions), keeping every scene's words and timing.",
  inputSchema: z.object({ theme: z.enum(TV_THEME_ENUM) }),
  async execute(input, ctx) {
    const doc = restyleTextVideo(ctx.project.doc, input.theme);
    return commit(ctx.project, doc, `Restyled the text video as ${TEXT_VIDEO_THEME_DEFS[input.theme].label}.`);
  },
};

const TEXT_TARGET = z
  .union([z.enum(["all", "titles", "captions"]), z.object({ clipId: z.string().min(1) })])
  .optional();

export const animateTextTool: DirectorTool<AnimateTextInput> = {
  name: "animate_text",
  description:
    "Animate text clips: intro `style` (fade, rise, drop, slide-left, slide-right, zoom-in, stomp, blur-in, wipe, baseline, tumble, spin, flip, neon, glitch, scramble, typewriter, pop, bounce, kinetic, none) over `durationSec`, staggered by `unit` (whole | line | word | letter), after `delaySec`; `exit` (fade, rise, sink, slide-left, slide-right, zoom-out, blow-up, blur-out, wipe, tumble, none); `loop` emphasis (breathe, float, wiggle, flicker, pulse, shake, wave, none). `target`: titles (default) | all | captions | {clipId}.",
  inputSchema: z.object({
    target: TEXT_TARGET,
    style: z.enum(TEXT_ANIM_STYLES).optional(),
    unit: z.enum(TEXT_ANIM_UNITS).optional(),
    durationSec: z.number().nonnegative().optional(),
    delaySec: z.number().nonnegative().optional(),
    exit: z.enum(TEXT_EXIT_STYLES).optional(),
    exitSec: z.number().nonnegative().optional(),
    loop: z.enum(TEXT_LOOP_STYLES).optional(),
    loopSpeed: z.number().min(0.05).max(8).optional(),
    loopAmount: z.number().min(0).max(1).optional(),
    speedScale: z.number().positive().max(4).optional(),
  }) as z.ZodType<AnimateTextInput>,
  async execute(input, ctx) {
    const { doc, count } = animateText(ctx.project.doc, input);
    if (count === 0) throw new Error("There's no text to animate yet — add a title or make a text video first.");
    const parts = [input.speedScale && (input.speedScale > 1 ? "slower" : "faster"), input.style && `${input.style}${input.unit && input.unit !== "whole" ? ` by ${input.unit}` : ""}`, input.exit && `${input.exit} exit`, input.loop && `${input.loop} loop`].filter(Boolean);
    return commit(ctx.project, doc, `Animated ${count} text clip${count === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}.`);
  },
};

export const styleTextTool: DirectorTool<StyleTextInput> = {
  name: "style_text",
  description:
    "Restyle text clips: `fontFamily` (a bundled face like \"'Bebas Neue', sans-serif\"), `fontWeight`, `italic`, `color`, `uppercase`, `letterSpacing`, `sizeScale` (1.2 = 20% bigger), `align`, `effect` {style: lift|hollow|splice|echo|glitch|neon|highlight|none, color?, intensity?, offset?} (null removes), `fillGradient` {stops:[2-4 hex], angle} (null removes). `target`: titles (default) | all | captions | {clipId}.",
  inputSchema: z.object({
    target: TEXT_TARGET,
    fontFamily: z.string().optional(),
    fontWeight: z.enum(["normal", "medium", "semibold", "bold"]).optional(),
    italic: z.boolean().optional(),
    color: z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).optional(),
    uppercase: z.boolean().optional(),
    letterSpacing: z.number().optional(),
    sizeScale: z.number().positive().max(5).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    effect: TextEffect.nullable().optional(),
    fillGradient: TextFillGradient.nullable().optional(),
  }) as z.ZodType<StyleTextInput>,
  async execute(input, ctx) {
    const { doc, count } = styleText(ctx.project.doc, input);
    if (count === 0) throw new Error("There's no text to style yet — add a title or make a text video first.");
    return commit(ctx.project, doc, `Restyled ${count} text clip${count === 1 ? "" : "s"}.`);
  },
};

export const setBackgroundTool: DirectorTool<SetBackgroundInput> = {
  name: "set_background",
  description:
    "Set the background: a solid `color`, a `gradient` {kind: linear|radial, angle, stops:[2-5 hex], motion: none|drift|spin|pulse|aurora, speed}, and/or a subtle `pattern` {kind: dots|grid|lines|diagonal, color, opacity, scale} (null removes either). Applies to every background scene (or one `clipId`); adds a full-length background layer when there is none.",
  inputSchema: z.object({
    color: z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).optional(),
    gradient: BackgroundGradient.nullable().optional(),
    pattern: BackgroundPattern.nullable().optional(),
    clipId: z.string().optional(),
  }) as z.ZodType<SetBackgroundInput>,
  async execute(input, ctx) {
    const { doc, count } = setBackground(ctx.project.doc, input);
    const what = input.gradient ? `${input.gradient.motion && input.gradient.motion !== "none" ? `${input.gradient.motion} ` : ""}gradient` : input.pattern ? `${input.pattern.kind} pattern` : "color";
    return commit(ctx.project, doc, `Set a ${what} background on ${count} scene${count === 1 ? "" : "s"}.`);
  },
};

// ---- Sound made easy: generated music / SFX / ducking / beat sync / voice ----

const MOOD_ENUM = ["lofi", "upbeat", "cinematic", "corporate", "ambient"] as const;
const SFX_ENUM = ["whoosh", "pop", "click", "ding", "riser", "boom"] as const;

export const generateMusicTool: DirectorTool<{ mood?: MusicMood; bpm?: number; durationSec?: number; seed?: number; volume?: number }> = {
  name: "generate_music",
  description:
    "Compose a royalty-free background-music bed locally (procedural synthesis — no library, no licence, free) and lay it on the music track, fitted to the video: the tempo is nudged so whole bars end exactly with the video, and it resolves to a clean ending. Moods: lofi (chill), upbeat (pop), cinematic, corporate, ambient. Optional bpm, durationSec, seed (variation), volume. Replaces any existing music.",
  inputSchema: z.object({
    mood: z.enum(MOOD_ENUM).optional(),
    bpm: z.number().min(40).max(200).optional(),
    durationSec: z.number().positive().max(600).optional(),
    seed: z.number().int().nonnegative().optional(),
    volume: z.number().min(0).max(1).optional(),
  }),
  async execute(input, ctx) {
    const doc = generateMusic(ctx.project.doc, input);
    const g = generatedMusicOf(doc);
    const mood = g?.recipe.mood ?? input.mood ?? "lofi";
    return commit(
      ctx.project,
      doc,
      `Composed a ${MOOD_DEFS[mood].label.toLowerCase()} bed (${g ? `${Math.round(g.arrangement.bpm)} BPM, ${g.arrangement.bars} bars, ` : ""}${Math.round(g?.recipe.durationSec ?? 0)}s) fitted to your video — royalty-free, made on your machine. You'll hear it in the preview and the export.`,
    );
  },
};

export const addSfxTool: DirectorTool<{ kind: SfxKind; atSec: number; volume?: number }> = {
  name: "add_sfx",
  description:
    "Add one procedurally-generated sound effect (whoosh, pop, click, ding, riser, boom) so its hit lands at `atSec` on the timeline (a whoosh peaks on the moment, a riser builds INTO it). Free and local.",
  inputSchema: z.object({
    kind: z.enum(SFX_ENUM),
    atSec: z.number().nonnegative(),
    volume: z.number().min(0).max(1).optional(),
  }),
  async execute(input, ctx) {
    const doc = addSfx(ctx.project.doc, input);
    return commit(ctx.project, doc, `Added a ${SFX_DEFS[input.kind].label.toLowerCase()} at ${Math.round(input.atSec * 100) / 100}s.`);
  },
};

export const autoSfxTool: DirectorTool<{ style?: "subtle" | "punchy" }> = {
  name: "auto_sfx",
  description:
    "Sound-design the edit automatically: a whoosh on every transition / scene change and a pop on every text pop-in (never on captions). style=punchy also adds clicks on hard cuts, a boom on the opening title and a riser into the last scene. Replaces previous sound effects.",
  inputSchema: z.object({ style: z.enum(["subtle", "punchy"]).optional() }),
  async execute(input, ctx) {
    const { doc, events } = autoSfx(ctx.project.doc, input);
    if (events.length === 0) {
      return commit(ctx.project, doc, "No transitions or text pop-ins to put sound effects on yet.");
    }
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const parts = [...counts].map(([k, n]) => `${n} ${k}${n === 1 ? "" : k.endsWith("sh") ? "es" : "s"}`);
    return commit(ctx.project, doc, `Added ${events.length} sound effect${events.length === 1 ? "" : "s"} (${parts.join(", ")}) timed to your cuts and text.`);
  },
};

export const autoDuckTool: DirectorTool<{ depthDb?: number; bedVolume?: number; attackSec?: number; releaseSec?: number }> = {
  name: "auto_duck",
  description:
    "Smart ducking: ride the music DOWN only while someone speaks (voice-over, captions, transcript speech) and bring it back up between sentences, as editable volume keyframes. depthDb (default -12), bedVolume (music level between lines, 0..1), attackSec/releaseSec ramps.",
  inputSchema: z.object({
    depthDb: z.number().min(-40).max(-1).optional(),
    bedVolume: z.number().min(0).max(1).optional(),
    attackSec: z.number().min(0.02).max(2).optional(),
    releaseSec: z.number().min(0.02).max(4).optional(),
  }),
  async execute(input, ctx) {
    const transcripts = ctx.project.media
      .filter((m) => m.kind === "video")
      .map((m) => ctx.project.getTranscript(m.id))
      .filter((t): t is Transcript => !!t);
    const { doc, regions, mode } = autoDuck(ctx.project.doc, { ...input, transcripts });
    const depth = Math.round(input.depthDb ?? -12);
    return commit(
      ctx.project,
      doc,
      mode === "flat"
        ? `Ducked the music ${depth} dB under the speech.`
        : `Ducked the music ${depth} dB under ${regions.length} spoken passage${regions.length === 1 ? "" : "s"} — it swells back between sentences.`,
    );
  },
};

export const enhanceVoiceTool: DirectorTool<{ on?: boolean }> = {
  name: "enhance_voice",
  description:
    "One-click voice enhance on export: high-pass (rumble out), gentle compression, mud cut + presence boost, de-ess and a safety limiter on the VOICE only (the video's own audio + voice-over, never the music). (Applied at export — the preview plays the untreated voice.)",
  inputSchema: z.object({ on: z.boolean().optional() }),
  async execute(input, ctx) {
    const on = input.on ?? true;
    const doc = setVoiceEnhance(ctx.project.doc, on);
    return commit(
      ctx.project,
      doc,
      on
        ? "Voice enhance on — the export gets a clean, present, broadcast-style voice (HPF · compressor · presence EQ · de-ess · limiter). (Applied at export — the preview is unchanged.)"
        : "Voice enhance off.",
    );
  },
};

export const beatSyncTool: DirectorTool<{ every?: "beat" | "bar" }> = {
  name: "beat_sync",
  description:
    "Cut to the beat: re-time slideshow photos or text-video scenes so every scene change lands on a beat (every=beat) or a bar line (every=bar). Uses the generated music's exact beat grid, else the timeline's beat markers. Generated music is re-fitted to end on the final bar.",
  inputSchema: z.object({ every: z.enum(["beat", "bar"]).optional() }),
  async execute(input, ctx) {
    const { doc, cuts } = beatSync(ctx.project.doc, input);
    return commit(ctx.project, doc, `Synced ${cuts} cut${cuts === 1 ? "" : "s"} to the ${input.every ?? "beat"} — every scene change now lands on the music.`);
  },
};

export const DIRECTOR_TOOLS = {
  set_timeline: setTimelineTool,
  edit_by_transcript: editByTranscriptTool,
  remove_silence: removeSilenceTool,
  auto_reframe: autoReframeTool,
  generate_voiceover: generateVoiceoverTool,
  create_highlight: createHighlightTool,
  filler_cut: fillerCutTool,
  reframe: reframeTool,
  add_captions: captionsTool,
  apply_look: lookTool,
  adjust_color: adjustColorTool,
  auto_mix: autoMixTool,
  make_slideshow: slideshowTool,
  set_quality: qualityTool,
  add_title: titleTool,
  add_fades: fadesTool,
  add_music: musicTool,
  add_broll: brollTool,
  add_kinetic_title: kineticTitleTool,
  add_emphasis: emphasisTool,
  set_speed: speedTool,
  set_speed_ramp: speedRampTool,
  zoom: zoomTool,
  set_transition: transitionTool,
  clear_transition: clearTransitionTool,
  apply_vfx: vfxTool,
  style_captions: styleCaptionsTool,
  position_captions: positionCaptionsTool,
  set_karaoke: setKaraokeTool,
  build_demo: buildDemoTool,
  add_cursor: addCursorTool,
  type_text: typeTextTool,
  add_callout: addCalloutTool,
  add_shape: addShapeTool,
  apply_layout: applyLayoutTool,
  stabilize: stabilizeTool,
  animate: animateTool,
  add_keyframe: addKeyframeTool,
  move_keyframe: moveKeyframeTool,
  remove_keyframe: removeKeyframeTool,
  reverse_clip: reverseClipTool,
  freeze_frame: freezeFrameTool,
  add_marker: addMarkerTool,
  set_platform: platformTool,
  chroma_key: chromaKeyTool,
  set_blend: setBlendTool,
  blur_region: blurRegionTool,
  pixelate_region: pixelateRegionTool,
  add_mask: addMaskTool,
  adjust_curves: adjustCurvesTool,
  adjust_hsl: adjustHslTool,
  apply_lut: applyLutTool,
  add_adjustment: addAdjustmentTool,
  audio_fade: audioFadeTool,
  set_pan: setPanTool,
  normalize_loudness: normalizeLoudnessTool,
  clean_audio: cleanAudioTool,
  add_track: addTrackTool,
  remove_track: removeTrackTool,
  set_track: setTrackTool,
  reorder_track: reorderTrackTool,
  move_clip: moveClipTool,
  roll_edit: rollEditTool,
  slip_edit: slipEditTool,
  slide_edit: slideEditTool,
  make_text_video: makeTextVideoTool,
  restyle_text_video: restyleTextVideoTool,
  animate_text: animateTextTool,
  style_text: styleTextTool,
  set_background: setBackgroundTool,
  generate_music: generateMusicTool,
  add_sfx: addSfxTool,
  auto_sfx: autoSfxTool,
  auto_duck: autoDuckTool,
  enhance_voice: enhanceVoiceTool,
  beat_sync: beatSyncTool,
} as const;
