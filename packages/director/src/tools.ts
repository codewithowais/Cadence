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
  addCaptions,
  applyLook,
  autoMix,
  reframe,
  setQuality,
  type AspectKey,
  type LookKey,
  type QualityKey,
} from "./edits";

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
  description: "Apply a color-grade preset (warm, cool, vivid, bw, cinematic, none).",
  inputSchema: z.object({ look: z.enum(["warm", "cool", "vivid", "bw", "cinematic", "none"]) }),
  async execute(input, ctx) {
    const doc = applyLook(ctx.project.doc, input.look);
    return commit(ctx.project, doc, `Applied the ${input.look} look.`);
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
    const note = input.aiUpscale ? " (AI upscale requested — needs a gated model)" : "";
    return commit(
      ctx.project,
      doc,
      `Quality set to ${input.preset} → ${q.targetWidth}×${q.targetHeight}${note}.`,
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
} as const;
