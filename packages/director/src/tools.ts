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
  type EditDoc as EditDocT,
  type MediaAsset,
} from "@cadence/core";
import type { Transcript } from "@cadence/understanding";
import type { ProjectState } from "./project";
import { buildHighlightDoc } from "./highlight";
import { fillerCut } from "./filler";
import { buildSlideshowDoc } from "./slideshow";
import {
  addBroll,
  addCaptions,
  addEmphasis,
  addFades,
  addKineticTitle,
  addMusic,
  addTitle,
  applyLook,
  autoMix,
  reframe,
  setQuality,
  type AspectKey,
  type BrollCorner,
  type LookKey,
  type QualityKey,
  type TitleStyle,
} from "./edits";

const LOOK_KEYS = ["warm", "cool", "vivid", "bw", "cinematic", "vintage", "noir", "vibrant", "none"] as const;

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

export const reframeTool: DirectorTool<{ aspect: AspectKey }> = {
  name: "reframe",
  description: "Reframe the composition to a new aspect ratio (9:16, 1:1, 4:5, 16:9).",
  inputSchema: z.object({ aspect: z.enum(["9:16", "1:1", "4:5", "16:9"]) }),
  async execute(input, ctx) {
    const doc = reframe(ctx.project.doc, input.aspect);
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
  description: "Apply a color-grade preset (warm, cool, vivid, bw, cinematic, vintage, noir, vibrant, none).",
  inputSchema: z.object({ look: z.enum(LOOK_KEYS) }),
  async execute(input, ctx) {
    const doc = applyLook(ctx.project.doc, input.look);
    return commit(ctx.project, doc, `Applied the ${input.look} look.`);
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
    const doc = buildSlideshowDoc(imgs, {
      perImageSec: input.perImageSec,
      look: input.look,
      title: input.title,
    });
    return commit(
      ctx.project,
      doc,
      `Made a ${Math.round(docDurationSec(doc))}s slideshow from ${imgs.length} photos.`,
    );
  },
};

// ---- add_music -------------------------------------------------------------

export const musicTool: DirectorTool<{ mediaId?: string; volume?: number }> = {
  name: "add_music",
  description: "Add a background-music track from an audio asset (starts ducked under speech).",
  inputSchema: z.object({ mediaId: z.string().optional(), volume: z.number().min(0).max(1).optional() }),
  async execute(input, ctx) {
    const asset = input.mediaId
      ? ctx.project.media.find((m) => m.id === input.mediaId && m.kind === "audio") ?? audioAsset(ctx.project)
      : audioAsset(ctx.project);
    const doc = addMusic(ctx.project.doc, asset, { volume: input.volume });
    return commit(
      ctx.project,
      doc,
      `Added background music (${asset.label ?? asset.src}), ducked under speech. ` +
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

export const kineticTitleTool: DirectorTool<{ text: string }> = {
  name: "add_kinetic_title",
  description: "Add an animated title that slides up and scales in (kinetic).",
  inputSchema: z.object({ text: z.string().min(1) }),
  async execute(input, ctx) {
    const doc = addKineticTitle(ctx.project.doc, input.text);
    return commit(ctx.project, doc, `Added a kinetic title: “${input.text}” (slides + scales in).`);
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

export const DIRECTOR_TOOLS = {
  set_timeline: setTimelineTool,
  create_highlight: createHighlightTool,
  filler_cut: fillerCutTool,
  reframe: reframeTool,
  add_captions: captionsTool,
  apply_look: lookTool,
  auto_mix: autoMixTool,
  make_slideshow: slideshowTool,
  set_quality: qualityTool,
  add_title: titleTool,
  add_fades: fadesTool,
  add_music: musicTool,
  add_broll: brollTool,
  add_kinetic_title: kineticTitleTool,
  add_emphasis: emphasisTool,
} as const;
