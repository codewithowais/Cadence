/**
 * Director tools — the ONLY way the Director changes a project. Each tool is
 * typed (Zod input), self-describing, and operates on ProjectState. Every
 * capability is a tool; the Director's shape never changes as we add features.
 * The real Claude Director will call these exact tools.
 */
import { z } from "zod";
import {
  docDurationSec,
  EditDoc,
  type BlendMode,
  type CurvePoint,
  type EditDoc as EditDocT,
  type KeyframeEasing,
  type KeyframeProp,
  type MediaAsset,
  type TransitionType,
} from "@cadence/core";
import type { Transcript } from "@cadence/understanding";
import type { ProjectState } from "./project";
import { buildHighlightDoc } from "./highlight";
import { fillerCut } from "./filler";
import { buildSlideshowDoc } from "./slideshow";
import { buildDemo, type BuildDemoOptions } from "./demo";
import {
  addBroll,
  addCallout,
  addCaptions,
  addCursor,
  addEmphasis,
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
  applyVfx,
  audioFade,
  autoMix,
  carryOverAudio,
  chromaKey,
  freezeFrame,
  normalizeLoudness,
  reframe,
  reframeTo,
  regionBlur,
  reverseClip,
  setBlend,
  setPan,
  setPlatform,
  setQuality,
  setSpeed,
  setTransition,
  setZoom,
  styleCaptions,
  typeText,
  type AspectKey,
  type BrollCorner,
  type CaptionStyleOpts,
  type LookKey,
  type PlatformKey,
  type QualityKey,
  type SpeedTarget,
  type TitleAnimStyle,
  type TitleStyle,
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

export const captionsTool: DirectorTool<Record<string, never>> = {
  name: "add_captions",
  description: "Burn in captions from the transcript, synced through the current cuts.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { transcript } = sourceVideo(ctx.project);
    const doc = addCaptions(ctx.project.doc, transcript);
    const capTrack = doc.tracks.find((t) => t.id === "captions");
    return commit(ctx.project, doc, `Added ${capTrack?.clips.length ?? 0} captions.`);
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
    "Restyle the captions: fontFamily, fontWeight (normal/medium/semibold/bold), color, background (hex or null to remove), outlineColor + outlineWidth, fontSize, and position (top/center/bottom).",
  inputSchema: z.object({
    fontFamily: z.string().optional(),
    fontWeight: z.enum(["normal", "medium", "semibold", "bold"]).optional(),
    color: z.string().optional(),
    background: z.string().nullable().optional(),
    outlineColor: z.string().optional(),
    outlineWidth: z.number().min(0).optional(),
    fontSize: z.number().positive().optional(),
    position: z.enum(["top", "center", "bottom"]).optional(),
  }),
  async execute(input, ctx) {
    const doc = styleCaptions(ctx.project.doc, input);
    return commit(ctx.project, doc, "Styled the captions.");
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

export const transitionTool: DirectorTool<{ type: TransitionType }> = {
  name: "set_transition",
  description:
    "Set the transition style between clips/photos: crossfade, dip-to-black, slide, or wipe.",
  inputSchema: z.object({ type: z.enum(["crossfade", "dip-to-black", "slide", "wipe"]) }),
  async execute(input, ctx) {
    const doc = setTransition(ctx.project.doc, input.type);
    return commit(ctx.project, doc, `Set ${input.type} transitions between clips.`);
  },
};

// ---- build_demo (interaction walkthrough from screenshots) -----------------

export const buildDemoTool: DirectorTool<{ perScreenSec?: number; transition?: TransitionType; login?: boolean }> = {
  name: "build_demo",
  description:
    "Turn the project's screenshots (image media, in order = screens) into an animated product walkthrough: each screenshot becomes a full-frame screen, sequenced with a transition. When `login` is set, screen 1 gets a demo interaction — a typed email + password (typewriter) and a cursor that moves to a button and clicks. Field/button positions are sensible defaults (no vision) the user can nudge with add_cursor / type_text / add_callout.",
  inputSchema: z.object({
    perScreenSec: z.number().positive().optional(),
    transition: z.enum(["crossfade", "dip-to-black", "slide", "wipe", "dissolve", "zoom", "smooth"]).optional(),
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

export const DIRECTOR_TOOLS = {
  set_timeline: setTimelineTool,
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
  zoom: zoomTool,
  set_transition: transitionTool,
  apply_vfx: vfxTool,
  style_captions: styleCaptionsTool,
  build_demo: buildDemoTool,
  add_cursor: addCursorTool,
  type_text: typeTextTool,
  add_callout: addCalloutTool,
  animate: animateTool,
  add_keyframe: addKeyframeTool,
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
  audio_fade: audioFadeTool,
  set_pan: setPanTool,
  normalize_loudness: normalizeLoudnessTool,
} as const;
