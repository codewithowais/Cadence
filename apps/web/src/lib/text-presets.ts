/**
 * Stickers + one-click text presets.
 *
 * These are thin, PURE wrappers over the engine's existing text/title fns
 * (`addTitle` / `addKineticTitle`), so a sticker or a styled title is just a
 * `text` clip on the "titles" overlay track — nothing new in the schema. After
 * the engine appends the clip we patch the freshly-added clip (the last one on
 * the titles track) with the preset's styling, its start time (the playhead),
 * and an optional placed position (composition fractions from the on-preview
 * placement gesture). Everything is re-parsed through the schema and returned to
 * the caller's undoable `commit` path.
 *
 * Emoji render as a large text clip. The PREVIEW (canvas + DOM) is always
 * correct; the ffmpeg export's emoji/font fidelity depends on the fonts present
 * on the render machine — the UI says so honestly.
 */
import { addKineticTitle, addTitle } from "@cadence/director";
import { parseEditDoc, type EditDoc, type FontWeight } from "@cadence/core";
import type { CSSProperties } from "react";

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** A discoverable set of emoji stickers. */
export const EMOJI_STICKERS = [
  "😀", "😂", "😍", "😎", "🤔", "😭", "🔥", "💯",
  "✨", "⭐", "❤️", "👍", "👀", "🎉", "🚀", "💀",
  "🙌", "👏", "💥", "❓",
] as const;

export interface InsertTextOpts {
  text: string;
  /** Timeline start (seconds); defaults to 0. */
  startSec?: number;
  /** Clip duration (seconds); defaults to the engine's title default. */
  durationSec?: number;
  /** Use the kinetic (animated) title base instead of the static card. */
  kinetic?: boolean;
  animStyle?: "kinetic" | "pop" | "bounce";
  titleStyle?: "card" | "lower-third";
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: FontWeight;
  color?: string;
  align?: "left" | "center" | "right";
  /** Pill background hex, or `null` to remove it. */
  background?: string | null;
  outline?: { color: string; width: number };
  /** Placed position as fractions (0..1) of the composition; defaults to center. */
  xFrac?: number;
  yFrac?: number;
}

/**
 * Insert a styled `text` overlay by reusing `addTitle` / `addKineticTitle`, then
 * patching the newly-added clip. Pure + re-parsed through the schema.
 */
export function insertTextOverlay(doc: EditDoc, opts: InsertTextOpts): EditDoc {
  const base = opts.kinetic
    ? addKineticTitle(doc, opts.text, opts.animStyle ?? "kinetic")
    : addTitle(doc, opts.text, opts.titleStyle ?? "card");
  const clone: EditDoc = structuredClone(base);
  const titles = clone.tracks.find((t) => t.id === "titles");
  const clip = titles?.clips[titles.clips.length - 1];
  if (!clip || clip.kind !== "text") return base;

  const w = clone.meta.width;
  const h = clone.meta.height;
  clip.start = round(Math.max(0, opts.startSec ?? 0));
  if (opts.durationSec != null) clip.duration = round(Math.max(0.1, opts.durationSec));
  if (opts.fontSize != null) clip.fontSize = Math.max(1, Math.round(opts.fontSize));
  if (opts.fontFamily) clip.fontFamily = opts.fontFamily;
  if (opts.fontWeight) clip.fontWeight = opts.fontWeight;
  if (opts.color) clip.color = opts.color;
  if (opts.align) clip.align = opts.align;
  if (opts.background !== undefined) {
    if (opts.background === null) delete (clip as { background?: string }).background;
    else clip.background = opts.background;
  }
  if (opts.outline) {
    clip.outline = { color: opts.outline.color, width: Math.max(0, Math.round(opts.outline.width)) };
  }
  const x = opts.xFrac != null ? Math.round(opts.xFrac * w) : Math.round(w / 2);
  const y = opts.yFrac != null ? Math.round(opts.yFrac * h) : Math.round(h / 2);
  clip.transform = { ...clip.transform, x, y };
  return parseEditDoc(clone);
}

/** Placement / timing for a one-click insert. */
export interface PlaceOpts {
  text?: string;
  startSec?: number;
  xFrac?: number;
  yFrac?: number;
}

/** Insert an emoji sticker as a large, pop-in text clip (centered by default). */
export function insertSticker(doc: EditDoc, emoji: string, opts: PlaceOpts = {}): EditDoc {
  return insertTextOverlay(doc, {
    text: emoji,
    startSec: opts.startSec,
    durationSec: 3,
    kinetic: true,
    animStyle: "pop",
    fontSize: Math.round(doc.meta.height * 0.16),
    xFrac: opts.xFrac,
    yFrac: opts.yFrac,
  });
}

export interface TextPreset {
  key: string;
  label: string;
  /** Placeholder used when the user typed nothing. */
  sample: string;
  /** Approximate CSS so the Design gallery can render a live "Aa" preview chip. */
  previewStyle?: CSSProperties;
  build: (doc: EditDoc, opts: PlaceOpts) => EditDoc;
}

/** One-click styled text presets. */
export const TEXT_PRESETS: TextPreset[] = [
  {
    key: "bold-title",
    label: "Bold Title",
    sample: "BOLD TITLE",
    previewStyle: { fontFamily: "Montserrat, sans-serif", fontWeight: 800, color: "#ffffff", textShadow: "0 1px 2px #000, 0 0 2px #000" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "BOLD TITLE",
        startSec: o.startSec,
        durationSec: 3,
        kinetic: true,
        animStyle: "pop",
        fontFamily: "Montserrat, sans-serif",
        fontWeight: "bold",
        fontSize: Math.round(doc.meta.height * 0.11),
        color: "#ffffff",
        outline: { color: "#000000", width: Math.round(doc.meta.height * 0.004) },
        xFrac: o.xFrac,
        yFrac: o.yFrac,
      }),
  },
  {
    key: "subtitle",
    label: "Subtitle",
    sample: "Subtitle text",
    previewStyle: { fontFamily: "Inter, sans-serif", fontWeight: 500, color: "#ffffff", background: "#0a0d12cc", padding: "2px 6px", borderRadius: "4px" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "Subtitle text",
        startSec: o.startSec,
        durationSec: 3,
        fontFamily: "Inter, sans-serif",
        fontWeight: "medium",
        fontSize: Math.round(doc.meta.height * 0.05),
        color: "#ffffff",
        background: "#0a0d12cc",
        xFrac: o.xFrac,
        yFrac: o.yFrac ?? 0.85,
      }),
  },
  {
    key: "handwritten",
    label: "Handwritten",
    sample: "handwritten",
    previewStyle: { fontFamily: '"Segoe Script", "Comic Sans MS", cursive', color: "#ffffff" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "handwritten",
        startSec: o.startSec,
        durationSec: 3,
        kinetic: true,
        animStyle: "kinetic",
        fontFamily: '"Segoe Script", "Comic Sans MS", cursive',
        fontSize: Math.round(doc.meta.height * 0.08),
        color: "#ffffff",
        xFrac: o.xFrac,
        yFrac: o.yFrac,
      }),
  },
  {
    key: "meme",
    label: "Meme",
    sample: "TOP TEXT",
    previewStyle: { fontFamily: "Impact, sans-serif", fontWeight: 700, color: "#ffffff", textShadow: "0 0 3px #000, 0 1px 2px #000", letterSpacing: "0.02em" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "TOP TEXT",
        startSec: o.startSec,
        durationSec: 3,
        fontFamily: "Impact, sans-serif",
        fontWeight: "bold",
        fontSize: Math.round(doc.meta.height * 0.09),
        color: "#ffffff",
        outline: { color: "#000000", width: Math.round(doc.meta.height * 0.006) },
        xFrac: o.xFrac,
        yFrac: o.yFrac ?? 0.14,
      }),
  },
  {
    key: "lower-third",
    label: "Lower Third",
    sample: "Name · Title",
    previewStyle: { fontFamily: "Inter, sans-serif", fontWeight: 600, color: "#0a0d12", background: "#f76f53", padding: "2px 6px", borderRadius: "3px" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "Name · Title",
        startSec: o.startSec,
        durationSec: 4,
        titleStyle: "lower-third",
        fontFamily: "Inter, sans-serif",
        fontWeight: "semibold",
        fontSize: Math.round(doc.meta.height * 0.045),
        color: "#0a0d12",
        background: "#f76f53",
        align: "left",
        xFrac: o.xFrac ?? 0.28,
        yFrac: o.yFrac ?? 0.82,
      }),
  },
  {
    key: "caption-box",
    label: "Caption Box",
    sample: "Caption",
    previewStyle: { fontFamily: "Inter, sans-serif", fontWeight: 600, color: "#ffffff", background: "#000000cc", padding: "2px 6px", borderRadius: "4px" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "Caption",
        startSec: o.startSec,
        durationSec: 3,
        fontFamily: "Inter, sans-serif",
        fontWeight: "semibold",
        fontSize: Math.round(doc.meta.height * 0.05),
        color: "#ffffff",
        background: "#000000cc",
        yFrac: o.yFrac ?? 0.86,
        xFrac: o.xFrac,
      }),
  },
  {
    key: "big-bold",
    label: "Big Bold Center",
    sample: "BIG",
    previewStyle: { fontFamily: "Montserrat, sans-serif", fontWeight: 800, color: "#ffffff", textTransform: "uppercase", textShadow: "0 2px 6px #000" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "BIG STATEMENT",
        startSec: o.startSec,
        durationSec: 3,
        kinetic: true,
        animStyle: "bounce",
        fontFamily: "Montserrat, sans-serif",
        fontWeight: "bold",
        fontSize: Math.round(doc.meta.height * 0.16),
        color: "#ffffff",
        outline: { color: "#000000", width: Math.round(doc.meta.height * 0.004) },
        xFrac: o.xFrac,
        yFrac: o.yFrac,
      }),
  },
  {
    key: "quote",
    label: "Quote",
    sample: "“Quote”",
    previewStyle: { fontFamily: "Georgia, 'Times New Roman', serif", fontStyle: "italic", color: "#ffffff", textShadow: "0 1px 3px #000" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) ? `“${o.text.trim()}”` : "“A memorable quote”",
        startSec: o.startSec,
        durationSec: 4,
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: Math.round(doc.meta.height * 0.07),
        color: "#ffffff",
        xFrac: o.xFrac,
        yFrac: o.yFrac,
      }),
  },
  {
    key: "neon",
    label: "Neon Glow",
    sample: "NEON",
    previewStyle: { fontFamily: "Montserrat, sans-serif", fontWeight: 700, color: "#45d3c4", textShadow: "0 0 6px #45d3c4, 0 0 12px #45d3c4" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "NEON",
        startSec: o.startSec,
        durationSec: 3,
        kinetic: true,
        animStyle: "pop",
        fontFamily: "Montserrat, sans-serif",
        fontWeight: "bold",
        fontSize: Math.round(doc.meta.height * 0.1),
        color: "#45d3c4",
        outline: { color: "#0affea", width: Math.round(doc.meta.height * 0.003) },
        xFrac: o.xFrac,
        yFrac: o.yFrac,
      }),
  },
  {
    key: "typewriter",
    label: "Typewriter",
    sample: "type…",
    previewStyle: { fontFamily: '"Courier New", monospace', fontWeight: 600, color: "#ffffff", letterSpacing: "0.04em" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "typed out",
        startSec: o.startSec,
        durationSec: 3,
        fontFamily: '"Courier New", monospace',
        fontWeight: "semibold",
        fontSize: Math.round(doc.meta.height * 0.06),
        color: "#ffffff",
        background: "#0a0d12aa",
        xFrac: o.xFrac,
        yFrac: o.yFrac,
      }),
  },
  {
    key: "minimal-serif",
    label: "Minimal Serif",
    sample: "Serif",
    previewStyle: { fontFamily: "Georgia, 'Times New Roman', serif", color: "#ffffff", letterSpacing: "0.02em" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "Minimal",
        startSec: o.startSec,
        durationSec: 3,
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: Math.round(doc.meta.height * 0.075),
        color: "#ffffff",
        xFrac: o.xFrac,
        yFrac: o.yFrac,
      }),
  },
  {
    key: "outline",
    label: "Outline",
    sample: "Aa",
    previewStyle: { fontFamily: "Montserrat, sans-serif", fontWeight: 800, color: "transparent", WebkitTextStroke: "1px #ffffff" },
    build: (doc, o) =>
      insertTextOverlay(doc, {
        text: (o.text && o.text.trim()) || "OUTLINE",
        startSec: o.startSec,
        durationSec: 3,
        fontFamily: "Montserrat, sans-serif",
        fontWeight: "bold",
        fontSize: Math.round(doc.meta.height * 0.11),
        color: "#00000000",
        outline: { color: "#ffffff", width: Math.round(doc.meta.height * 0.004) },
        xFrac: o.xFrac,
        yFrac: o.yFrac,
      }),
  },
];
