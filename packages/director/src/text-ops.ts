/**
 * Pure text & background operations — animate / style any text clip and set
 * (gradient, animated, patterned) backgrounds. Shared by the Director tools, the
 * Text room, and the text inspector, so every surface edits the doc the same way.
 */
import {
  parseEditDoc,
  type BackgroundGradient,
  type BackgroundPattern,
  type EditDoc,
  type FontWeight,
  type TextAnim,
  type TextAnimStyle,
  type TextAnimUnit,
  type TextClip,
  type TextEffect,
  type TextExitStyle,
  type TextFillGradient,
  type TextLoopStyle,
} from "@cadence/core";

/** Which text clips an op applies to. */
export type TextTarget = "all" | "titles" | "captions" | { clipId: string };

const isCaptionTrack = (id: string): boolean => id === "captions";

/** Title-ish text: everything that isn't a caption / demo-typing overlay. */
function matches(target: TextTarget, trackId: string, clip: TextClip): boolean {
  if (typeof target === "object") return clip.id === target.clipId;
  if (target === "captions") return isCaptionTrack(trackId);
  if (target === "titles") return !isCaptionTrack(trackId) && trackId !== "demo-text";
  return trackId !== "demo-text";
}

function eachText(doc: EditDoc, target: TextTarget, fn: (clip: TextClip) => void): { doc: EditDoc; count: number } {
  const clone: EditDoc = structuredClone(doc);
  let count = 0;
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "text" || !matches(target, track.id, clip)) continue;
      fn(clip);
      count++;
    }
  }
  return { doc: parseEditDoc(clone), count };
}

export interface AnimateTextInput {
  target?: TextTarget;
  style?: TextAnimStyle;
  unit?: TextAnimUnit;
  durationSec?: number;
  delaySec?: number;
  exit?: TextExitStyle;
  exitSec?: number;
  loop?: TextLoopStyle;
  loopSpeed?: number;
  loopAmount?: number;
}

/**
 * Set intro / exit / loop animation on text clips. Only the fields given change.
 * Durations are clamped to the clip so an intro never outlasts its clip.
 */
export function animateText(doc: EditDoc, input: AnimateTextInput): { doc: EditDoc; count: number } {
  return eachText(doc, input.target ?? "titles", (clip) => {
    const a: TextAnim = clip.anim;
    if (input.style) {
      a.style = input.style;
      if (a.durationSec <= 0 || input.durationSec === undefined) {
        a.durationSec = input.style === "none" ? 0 : Math.min(clip.duration * 0.6, input.unit === "letter" || a.unit === "letter" ? 1 : 0.8);
      }
      // The legacy kinetic family animates FROM an offset; give it one if unset.
      if ((input.style === "kinetic" || input.style === "bounce") && a.fromY === 0 && a.fromX === 0) a.fromY = clip.fontSize * 0.6;
      if (input.style === "pop" && a.fromScale === 1) a.fromScale = 0.6;
    }
    if (input.unit) a.unit = input.unit;
    if (input.durationSec !== undefined) a.durationSec = Math.max(0, Math.min(input.durationSec, clip.duration));
    if (input.delaySec !== undefined) a.delaySec = Math.max(0, Math.min(input.delaySec, clip.duration * 0.8));
    if (input.exit) {
      a.exit.style = input.exit;
      a.exit.durationSec = Math.min(clip.duration * 0.4, input.exitSec ?? (a.exit.durationSec || 0.5));
    } else if (input.exitSec !== undefined) a.exit.durationSec = Math.min(clip.duration * 0.4, input.exitSec);
    if (input.loop) a.loop.style = input.loop;
    if (input.loopSpeed !== undefined) a.loop.speed = input.loopSpeed;
    if (input.loopAmount !== undefined) a.loop.amount = input.loopAmount;
  });
}

export interface StyleTextInput {
  target?: TextTarget;
  fontFamily?: string;
  fontWeight?: FontWeight;
  italic?: boolean;
  color?: string;
  uppercase?: boolean;
  letterSpacing?: number;
  /** Multiply font size (e.g. 1.2 = 20% bigger). */
  sizeScale?: number;
  effect?: TextEffect | null;
  fillGradient?: TextFillGradient | null;
  align?: "left" | "center" | "right";
}

/** Restyle text clips (font, weight, color, case, spacing, size, effect, gradient). */
export function styleText(doc: EditDoc, input: StyleTextInput): { doc: EditDoc; count: number } {
  return eachText(doc, input.target ?? "titles", (clip) => {
    if (input.fontFamily) clip.fontFamily = input.fontFamily;
    if (input.fontWeight) clip.fontWeight = input.fontWeight;
    if (input.italic !== undefined) clip.italic = input.italic;
    if (input.color) {
      clip.color = input.color;
      if (input.fillGradient === undefined) delete clip.fillGradient;
    }
    if (input.uppercase !== undefined) clip.uppercase = input.uppercase;
    if (input.letterSpacing !== undefined) clip.letterSpacing = input.letterSpacing;
    if (input.sizeScale) clip.fontSize = Math.max(8, Math.round(clip.fontSize * input.sizeScale));
    if (input.align) clip.align = input.align;
    if (input.effect === null) delete clip.effect;
    else if (input.effect) clip.effect = input.effect;
    if (input.fillGradient === null) delete clip.fillGradient;
    else if (input.fillGradient) clip.fillGradient = input.fillGradient;
  });
}

export interface SetBackgroundInput {
  color?: string;
  gradient?: BackgroundGradient | null;
  pattern?: BackgroundPattern | null;
  /** Only this solid clip; default = every background solid. */
  clipId?: string;
}

const FADE_IDS = new Set(["fade-in", "fade-out"]);

/**
 * Set the background: every background SOLID (not fade-to-black solids) gets the
 * color / gradient / pattern. A doc with no background solid gains one spanning
 * the timeline on a new bottom "Background" track (visible in text-only docs and
 * letterbox areas; footage paints over it).
 */
export function setBackground(doc: EditDoc, input: SetBackgroundInput): { doc: EditDoc; count: number } {
  const clone: EditDoc = structuredClone(doc);
  let count = 0;
  for (const track of clone.tracks) {
    if (track.id === "fades") continue;
    for (const clip of track.clips) {
      if (clip.kind !== "solid" || FADE_IDS.has(clip.id)) continue;
      if (input.clipId && clip.id !== input.clipId) continue;
      if (input.color) clip.color = input.color;
      if (input.gradient === null) delete clip.gradient;
      else if (input.gradient) clip.gradient = input.gradient;
      if (input.pattern === null) delete clip.pattern;
      else if (input.pattern) clip.pattern = input.pattern;
      count++;
    }
  }
  if (count === 0 && !input.clipId) {
    let end = 0;
    for (const t of clone.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
    clone.tracks.unshift({
      id: "background",
      kind: "visual",
      name: "Background",
      hidden: false,
      locked: false,
      muted: false,
      solo: false,
      clips: [
        {
          id: `bg-${clone.tracks.length}`,
          kind: "solid",
          start: 0,
          duration: Math.max(1, end || 5),
          color: input.color ?? input.gradient?.stops[0] ?? doc.meta.background,
          ...(input.gradient ? { gradient: input.gradient } : {}),
          ...(input.pattern ? { pattern: input.pattern } : {}),
        } as never,
      ],
    });
    if (input.color) clone.meta.background = input.color;
    count = 1;
  }
  return { doc: parseEditDoc(clone), count };
}
