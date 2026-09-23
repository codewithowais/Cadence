/**
 * Director tools for the graphics pack — typed wrappers over the pure ops in
 * graphics.ts (registered at the end of DIRECTOR_TOOLS in tools.ts). The same ops
 * back the web gallery / inspector, so the AI and the manual UI edit identically.
 */
import { z } from "zod";
import {
  SHAPE_EXIT_STYLES,
  SHAPE_INTRO_STYLES,
  SHAPE_LOOP_STYLES,
  docDurationSec,
  type EditDoc,
} from "@cadence/core";
import type { ProjectState } from "./project";
import type { DirectorTool, ToolResult } from "./tools";
import {
  GRAPHIC_POSITIONS,
  GRAPHIC_PRESET_KEYS,
  addGraphic,
  animateShape,
  editGraphic,
  findGraphicPreset,
  graphicGroups,
  removeGraphic,
  type AddGraphicInput,
  type AnimateShapeInput,
  type EditGraphicPatch,
  type GraphicPosition,
} from "./graphics";

function commit(project: ProjectState, doc: EditDoc, summary: string): ToolResult {
  project.setDoc(doc);
  return { summary, durationSec: docDurationSec(project.doc) };
}

const Hex = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
const Position = z.enum(GRAPHIC_POSITIONS);
const Preset = z.enum(GRAPHIC_PRESET_KEYS as [string, ...string[]]);

const placed = (doc: EditDoc, groupId: string, preset: string, at: number): string => {
  const def = findGraphicPreset(preset)!;
  void doc;
  return `Added ${def.label.toLowerCase()} (${groupId}) at ${at.toFixed(1)}s — edit it in Design → Graphics.`;
};

// ---- add_graphic ----------------------------------------------------------------

export const addGraphicTool: DirectorTool<AddGraphicInput> = {
  name: "add_graphic",
  description:
    `Add a one-click animated GRAPHIC (editable afterwards): social CTAs (subscribe, like, follow, link-in-bio, swipe-up, comment), lower thirds (lt-bar, lt-underline, lt-boxed, lt-split, lt-pill, lt-line — text = name, subtext = title), countdowns (countdown-321, timer, timer-ring, countup), progress (progress-top, progress-bottom, progress-story, progress-ring), stickers (heart, star, badge-new, badge-sale, wow, sparkles, done) and hand-drawn annotations (circle-mark, arrow-mark, underline-mark, box-mark, check-mark, pointer-mark). ` +
    "`text`/`subtext` set the words, `color`/`accent` the colors, `amount` the count-from / seconds / count-to / segments, `position` one of 9 title-safe anchors, `scale` the size. Starts at `atSec` (default 0).",
  inputSchema: z.object({
    preset: Preset,
    text: z.string().max(80).optional(),
    subtext: z.string().max(120).optional(),
    color: Hex.optional(),
    accent: Hex.optional(),
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().max(3600).optional(),
    amount: z.number().optional(),
    position: Position.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    scale: z.number().min(0.2).max(4).optional(),
  }) as z.ZodType<AddGraphicInput>,
  async execute(input, ctx) {
    const { doc, groupId } = addGraphic(ctx.project.doc, input);
    return commit(ctx.project, doc, placed(doc, groupId, input.preset, input.atSec ?? 0));
  },
};

// ---- add_lower_third ----------------------------------------------------------------

export interface AddLowerThirdInput {
  name: string;
  title?: string;
  style?: "bar" | "underline" | "boxed" | "split" | "pill" | "line";
  color?: string;
  accent?: string;
  atSec?: number;
  durationSec?: number;
  position?: GraphicPosition;
}

export const addLowerThirdTool: DirectorTool<AddLowerThirdInput> = {
  name: "add_lower_third",
  description:
    "Add an ANIMATED lower third (name + title) in one of 6 styles: 'bar' (accent edge + sweeping bar, default), 'underline' (drawn underline), 'boxed' (stacked boxes), 'split' (two-tone strip), 'pill' (glass pill with avatar dot), 'line' (minimal rule + wipe). Bottom-left by default.",
  inputSchema: z.object({
    name: z.string().min(1).max(60),
    title: z.string().max(80).optional(),
    style: z.enum(["bar", "underline", "boxed", "split", "pill", "line"]).optional(),
    color: Hex.optional(),
    accent: Hex.optional(),
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().max(60).optional(),
    position: Position.optional(),
  }),
  async execute(input, ctx) {
    const preset = `lt-${input.style ?? "bar"}`;
    const { doc, groupId } = addGraphic(ctx.project.doc, {
      preset,
      text: input.name,
      subtext: input.title ?? "",
      color: input.color,
      accent: input.accent,
      atSec: input.atSec,
      durationSec: input.durationSec,
      position: input.position,
    });
    return commit(ctx.project, doc, placed(doc, groupId, preset, input.atSec ?? 0));
  },
};

// ---- add_progress_bar ----------------------------------------------------------------

export interface AddProgressBarInput {
  style?: "top" | "bottom" | "story" | "ring";
  color?: string;
  atSec?: number;
  durationSec?: number;
  segments?: number;
}

export const addProgressBarTool: DirectorTool<AddProgressBarInput> = {
  name: "add_progress_bar",
  description:
    "Add a PROGRESS indicator that fills over the whole video (default) or [atSec, atSec+durationSec]: 'top' (thin line across the top, default), 'bottom' (rounded bar with a knob), 'story' (Instagram-style segments; `segments` 2–12), 'ring' (circular percent ring).",
  inputSchema: z.object({
    style: z.enum(["top", "bottom", "story", "ring"]).optional(),
    color: Hex.optional(),
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().max(36000).optional(),
    segments: z.number().int().min(2).max(12).optional(),
  }),
  async execute(input, ctx) {
    const preset = `progress-${input.style ?? "top"}`;
    const { doc, groupId } = addGraphic(ctx.project.doc, {
      preset,
      color: input.color,
      atSec: input.atSec,
      durationSec: input.durationSec,
      ...(input.segments ? { amount: input.segments } : {}),
    });
    return commit(ctx.project, doc, placed(doc, groupId, preset, input.atSec ?? 0));
  },
};

// ---- add_countdown ----------------------------------------------------------------

export interface AddCountdownInput {
  style?: "321" | "timer" | "ring" | "countup";
  /** 321: count from (default 3); timer/ring: seconds (default 10); countup: target. */
  amount?: number;
  /** 321: the final word ("GO!"); countup: the label ("followers"). */
  text?: string;
  atSec?: number;
  position?: GraphicPosition;
  color?: string;
  accent?: string;
}

export const addCountdownTool: DirectorTool<AddCountdownInput> = {
  name: "add_countdown",
  description:
    "Add a COUNTDOWN / TIMER: '321' (each number pops in a sweeping ring, then `text` — default GO! — bursts; `amount` = count from, default 3), 'timer' (mm:ss pill ticking down `amount` seconds to 00:00), 'ring' (seconds inside an emptying ring), 'countup' (a number racing from 0 to `amount`, labelled `text`).",
  inputSchema: z.object({
    style: z.enum(["321", "timer", "ring", "countup"]).optional(),
    amount: z.number().positive().max(100000000).optional(),
    text: z.string().max(40).optional(),
    atSec: z.number().nonnegative().optional(),
    position: Position.optional(),
    color: Hex.optional(),
    accent: Hex.optional(),
  }),
  async execute(input, ctx) {
    const style = input.style ?? "321";
    const preset = style === "321" ? "countdown-321" : style === "ring" ? "timer-ring" : style;
    const { doc, groupId } = addGraphic(ctx.project.doc, {
      preset,
      amount: input.amount,
      ...(input.text !== undefined ? (style === "countup" ? { subtext: input.text } : { text: input.text }) : {}),
      atSec: input.atSec,
      position: input.position,
      color: input.color,
      accent: input.accent,
    });
    return commit(ctx.project, doc, placed(doc, groupId, preset, input.atSec ?? 0));
  },
};

// ---- edit_graphic ----------------------------------------------------------------

export type EditGraphicInput = EditGraphicPatch & { graphic?: string; remove?: boolean };

export const editGraphicTool: DirectorTool<EditGraphicInput> = {
  name: "edit_graphic",
  description:
    "Edit a graphic added with add_graphic / add_lower_third / add_countdown / add_progress_bar: `graphic` = its id (e.g. 'gfx-2', default: the most recent). Change `text`, `subtext`, `color`, `accent`, `atSec`, `durationSec`, `amount`, `position` (9 anchors), `scale`, or its motion (`intro`, `loop`, `exit`, `speed`); `remove: true` deletes it. The graphic is rebuilt in place from its preset.",
  inputSchema: z.object({
    graphic: z.string().optional(),
    remove: z.boolean().optional(),
    text: z.string().max(80).optional(),
    subtext: z.string().max(120).optional(),
    color: Hex.optional(),
    accent: Hex.optional(),
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().max(36000).optional(),
    amount: z.number().optional(),
    position: Position.optional(),
    scale: z.number().min(0.2).max(4).optional(),
    intro: z.enum(SHAPE_INTRO_STYLES).optional(),
    loop: z.enum(SHAPE_LOOP_STYLES).optional(),
    exit: z.enum(SHAPE_EXIT_STYLES).optional(),
    speed: z.number().min(0.2).max(4).optional(),
  }) as z.ZodType<EditGraphicInput>,
  async execute(input, ctx) {
    const groups = graphicGroups(ctx.project.doc);
    const id = input.graphic && input.graphic !== "last" ? input.graphic : groups[groups.length - 1]?.id;
    if (!id || !groups.some((g) => g.id === id || id.startsWith(`${g.id}-`))) {
      return { summary: "There's no graphic to edit yet — add one first (e.g. “add a subscribe button”).", durationSec: docDurationSec(ctx.project.doc) };
    }
    const { graphic: _g, remove, ...patch } = input;
    void _g;
    if (remove) return commit(ctx.project, removeGraphic(ctx.project.doc, id), `Removed ${id}.`);
    const doc = editGraphic(ctx.project.doc, id, patch);
    return commit(ctx.project, doc, `Updated ${id}.`);
  },
};

// ---- animate_shape ----------------------------------------------------------------

export const animateShapeTool: DirectorTool<AnimateShapeInput> = {
  name: "animate_shape",
  description:
    `Animate vector SHAPES (one \`clipId\`, else every plain shape): intro \`style\` (${SHAPE_INTRO_STYLES.join(", ")}) over \`durationSec\` after \`delaySec\`; \`exit\` (${SHAPE_EXIT_STYLES.join(", ")}) over \`exitSec\`; continuous \`loop\` (${SHAPE_LOOP_STYLES.join(", ")}) at \`loopSpeed\` cycles/s and \`loopAmount\` 0–1. 'none' everywhere makes a shape static again. Preview == export.`,
  inputSchema: z.object({
    clipId: z.string().optional(),
    style: z.enum(SHAPE_INTRO_STYLES).optional(),
    durationSec: z.number().nonnegative().max(10).optional(),
    delaySec: z.number().nonnegative().max(30).optional(),
    exit: z.enum(SHAPE_EXIT_STYLES).optional(),
    exitSec: z.number().nonnegative().max(10).optional(),
    loop: z.enum(SHAPE_LOOP_STYLES).optional(),
    loopSpeed: z.number().min(0.05).max(8).optional(),
    loopAmount: z.number().min(0).max(1).optional(),
  }),
  async execute(input, ctx) {
    const { doc, count } = animateShape(ctx.project.doc, input);
    if (count === 0) return { summary: "No shapes to animate — add one first (Design → Shapes).", durationSec: docDurationSec(ctx.project.doc) };
    return commit(ctx.project, doc, `Animated ${count} shape${count === 1 ? "" : "s"}.`);
  },
};

// ---- natural-language routing (used by the StubDirector) ------------------------------------

/** One planned graphics tool call parsed from a plain-language request. */
export interface GraphicsRequest {
  tool: DirectorTool<never>;
  input: Record<string, unknown>;
}

function parsePosition(req: string): GraphicPosition | undefined {
  if (/top[- ]left/.test(req)) return "top-left";
  if (/top[- ]right/.test(req)) return "top-right";
  if (/bottom[- ]left/.test(req)) return "bottom-left";
  if (/bottom[- ]right/.test(req)) return "bottom-right";
  if (/\b(?:at|on|in) the top\b|\btop of\b/.test(req)) return "top";
  if (/\b(?:at|on|in) the bottom\b|\bbottom of\b/.test(req)) return "bottom";
  if (/\bin the (?:middle|cent(?:er|re))\b|\bcent(?:er|re)d?\b/.test(req)) return "center";
  return undefined;
}

function parseAt(req: string): number | undefined {
  const m = /\bat (\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/.exec(req);
  return m ? Number(m[1]) : undefined;
}

/**
 * Read graphics requests ("add a subscribe button", "progress bar at the bottom",
 * "3 2 1 countdown", "60 second timer", "circle it", "add a heart sticker") into
 * tool calls. `textMode` (a text-video build) skips countdown words, which there
 * describe the list format. Returns [] when nothing graphics-shaped is asked.
 */
export function parseGraphicsRequest(req: string, textMode = false): GraphicsRequest[] {
  const out: GraphicsRequest[] = [];
  const position = parsePosition(req);
  const atSec = parseAt(req);
  const base = { ...(position ? { position } : {}), ...(atSec !== undefined ? { atSec } : {}) };
  const add = (preset: string, extra: Record<string, unknown> = {}): void => {
    out.push({ tool: addGraphicTool as DirectorTool<never>, input: { preset, ...base, ...extra } });
  };

  // Social calls to action.
  if (/\bsubscribe\b/.test(req) && !/unsubscribe/.test(req)) add("subscribe");
  if (/\blike (?:button|cta|sticker|animation)|\b(?:add|put) a like\b|smash (?:that|the) like/.test(req)) add("like");
  if (/\bfollow (?:button|cta|sticker|animation)|\+ ?follow\b|\bfollow me (?:button|sticker)/.test(req)) add("follow");
  if (/link in (?:my |the )?bio/.test(req)) add("link-in-bio");
  if (/swipe[- ]?up/.test(req)) add("swipe-up");
  if (/comment (?:below|button|bubble|cta|sticker)|leave a comment/.test(req)) add("comment");

  // Progress indicators.
  if (/progress (?:bar|ring|indicator|line)|story (?:bar|segments)|loading bar/.test(req)) {
    const style = /ring|circle|circular|percent/.test(req) ? "ring" : /story|segments?/.test(req) ? "story" : /bottom|knob/.test(req) ? "bottom" : "top";
    const seg = /(\d+)\s*segments?/.exec(req);
    out.push({ tool: addProgressBarTool as DirectorTool<never>, input: { style, ...(atSec !== undefined ? { atSec } : {}), ...(seg ? { segments: Number(seg[1]) } : {}) } });
  }

  // Countdowns, timers, count-ups.
  if (!textMode) {
    const secs = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|seconds?|secs?|s)\b(?:[- ](?:long|countdown|timer))?/.exec(req);
    const seconds = secs ? Math.round(Number(secs[1]) * (/^m/.test(secs[2]!) ? 60 : 1)) : undefined;
    if (/count[- ]?up|counter (?:to|up)|number (?:counting|that counts)/.test(req)) {
      const to = /(?:to|up to|reach(?:es|ing)?)\s+(\d[\d,]*)/.exec(req);
      const label = /\d[\d,]*\s+(followers|subscribers|views|likes|users|customers|downloads|members)/.exec(req);
      out.push({ tool: addCountdownTool as DirectorTool<never>, input: { style: "countup", ...(to ? { amount: Number(to[1]!.replace(/,/g, "")) } : {}), ...(label ? { text: label[1] } : {}), ...base } });
    } else if (/\btimer\b|stopwatch|clock counting down|mm:ss/.test(req)) {
      out.push({ tool: addCountdownTool as DirectorTool<never>, input: { style: /ring|circle/.test(req) ? "ring" : "timer", ...(seconds ? { amount: seconds } : {}), ...base } });
    } else if (/count ?down|\b3[-, ]+2[-, ]+1\b|three,? two,? one/.test(req)) {
      const from = /from (\d+)/.exec(req);
      out.push({ tool: addCountdownTool as DirectorTool<never>, input: { style: "321", ...(from ? { amount: Number(from[1]) } : {}), ...base } });
    }
  }

  // Stickers.
  const stickerVerb = /\b(?:add|put|drop|stick|place|throw|pop|slap|include)\b|sticker/.test(req);
  if (stickerVerb) {
    if (/\bhearts?\b/.test(req) && !/like button/.test(req)) add("heart");
    if (/\bstars?\b/.test(req)) add("star");
    if (/sparkles?|twinkl/.test(req)) add("sparkles");
    if (/\bnew\b.*\b(?:badge|burst|sticker)|new! ?badge|\bnew badge/.test(req)) add("badge-new");
    if (/\bsale\b.*\b(?:badge|burst|sticker)|sale badge/.test(req)) add("badge-sale");
    if (/\bwow\b/.test(req)) add("wow");
    if (/check ?mark sticker|done sticker|green check/.test(req)) add("done");
  }

  // Hand-drawn annotations.
  if (/circle (?:it|this|that|him|her|them|the \w+)|hand[- ]?drawn circle|scribble(?:d)? circle|draw a circle/.test(req)) add("circle-mark");
  if (/curved arrow|hand[- ]?drawn arrow|draw an arrow|arrow pointing/.test(req)) add("arrow-mark");
  if (/underline (?:it|this|that|the \w+)|scribble underline|squiggl/.test(req)) add("underline-mark");
  if (/box (?:it|this|that) in|draw a box/.test(req)) add("box-mark");
  if (/tick mark|draw a (?:check|tick)/.test(req)) add("check-mark");

  // Motion for plain shapes ("make the shapes pop in", "animate the arrow").
  const shapeAnim = /(?:animate|make) (?:the |my )?(?:shapes?|boxes|arrows?|rectangles?|circles?)\b/.exec(req);
  if (shapeAnim) {
    const style = /pop/.test(req) ? "pop" : /slide/.test(req) ? "slide-up" : /draw/.test(req) ? "draw" : /grow/.test(req) ? "grow" : /spin/.test(req) ? "spin" : "fade";
    const loop = /pulse|pulsing/.test(req) ? "pulse" : /bounc/.test(req) ? "bounce" : /wiggl/.test(req) ? "wiggle" : /float/.test(req) ? "float" : undefined;
    out.push({ tool: animateShapeTool as DirectorTool<never>, input: { style, ...(loop ? { loop } : {}) } });
  }
  return out;
}
