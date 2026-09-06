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
  build: (doc: EditDoc, opts: PlaceOpts) => EditDoc;
}

/** One-click styled text presets. */
export const TEXT_PRESETS: TextPreset[] = [
  {
    key: "bold-title",
    label: "Bold Title",
    sample: "BOLD TITLE",
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
];
