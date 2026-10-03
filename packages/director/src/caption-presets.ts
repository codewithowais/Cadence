/**
 * Popular CAPTION STYLE PRESETS (CapCut / short-form look). Each preset is pure data
 * (style + karaoke word-highlight + entrance animation) resolved against the frame
 * height, and applied through the SAME engine ops the manual controls use
 * (`styleCaptions` · `positionCaptions` · `setKaraoke` · `animateText`) — so every
 * preset is undoable, previews on the shared canvas and exports identically.
 * Fonts are all bundled OFL faces (FONT_LIBRARY), so preview == export.
 */
import { parseEditDoc, type EditDoc } from "@cadence/core";
import { positionCaptions, setKaraoke, styleCaptions, type CaptionStyleOpts, type KaraokeStyle } from "./edits";
import { animateText } from "./text-ops";

export interface CaptionPresetSpec {
  style: CaptionStyleOpts & { position?: "top" | "center" | "bottom" };
  karaoke: { highlight: string; style: KaraokeStyle; scale?: number };
  anim: { style: "pop" | "rise" | "fade" | "none"; unit: "word" | "whole"; durationSec: number };
}

export interface CaptionPreset {
  key: string;
  label: string;
  hint: string;
  /** Resolve against the frame height `h` (px). */
  build(h: number): CaptionPresetSpec;
}

const px = (h: number, f: number): number => Math.max(1, Math.round(h * f));

export const CAPTION_PRESETS: readonly CaptionPreset[] = [
  {
    key: "hormozi",
    label: "Hormozi",
    hint: "Heavy white caps, the spoken word pops in yellow",
    build: (h) => ({
      style: {
        fontFamily: "Anton, sans-serif",
        fontWeight: "bold",
        italic: false,
        color: "#ffffff",
        uppercase: true,
        align: "center",
        letterSpacing: 1,
        fontSize: px(h, 0.07),
        outlineColor: "#000000",
        outlineWidth: px(h, 0.007),
        shadow: { color: "#000000", blur: 8, offsetX: 0, offsetY: 4 },
        box: null,
        background: null,
        position: "center",
      },
      karaoke: { highlight: "#ffe14a", style: "pop", scale: 1.2 },
      anim: { style: "none", unit: "whole", durationSec: 0 },
    }),
  },
  {
    key: "beast",
    label: "Beast",
    hint: "Loud comic caps with a green pop",
    build: (h) => ({
      style: {
        fontFamily: "Bangers, sans-serif",
        fontWeight: "bold",
        italic: false,
        color: "#ffffff",
        uppercase: true,
        align: "center",
        letterSpacing: 2,
        fontSize: px(h, 0.075),
        outlineColor: "#000000",
        outlineWidth: px(h, 0.009),
        shadow: { color: "#000000", blur: 0, offsetX: 3, offsetY: 5 },
        box: null,
        background: null,
        position: "center",
      },
      karaoke: { highlight: "#39ff6a", style: "pop", scale: 1.25 },
      anim: { style: "pop", unit: "word", durationSec: 0.3 },
    }),
  },
  {
    key: "neon",
    label: "Neon",
    hint: "Clean caps, the spoken word glows cyan",
    build: (h) => ({
      style: {
        fontFamily: "Montserrat, sans-serif",
        fontWeight: "bold",
        italic: false,
        color: "#e8f7ff",
        uppercase: true,
        align: "center",
        letterSpacing: 2,
        fontSize: px(h, 0.055),
        outlineWidth: 0,
        shadow: { color: "#000000", blur: 10, offsetX: 0, offsetY: 2 },
        box: { style: "pill", color: "#06121c", opacity: 0.72, radius: px(h, 0.03), padX: px(h, 0.03), padY: px(h, 0.014) },
        position: "bottom",
      },
      karaoke: { highlight: "#2ee6ff", style: "glow" },
      anim: { style: "rise", unit: "whole", durationSec: 0.25 },
    }),
  },
  {
    key: "pill",
    label: "Pill",
    hint: "Dark pill, amber fill on the spoken word",
    build: (h) => ({
      style: {
        fontFamily: "Inter, sans-serif",
        fontWeight: "semibold",
        italic: false,
        color: "#ffffff",
        uppercase: false,
        align: "center",
        letterSpacing: 0,
        fontSize: px(h, 0.05),
        outlineWidth: 0,
        shadow: null,
        box: { style: "pill", color: "#0a0d12", opacity: 0.88, radius: px(h, 0.035), padX: px(h, 0.028), padY: px(h, 0.014) },
        position: "bottom",
      },
      karaoke: { highlight: "#ffb347", style: "fill" },
      anim: { style: "pop", unit: "whole", durationSec: 0.2 },
    }),
  },
  {
    key: "underline",
    label: "Underline",
    hint: "Editorial serif, a pink underline tracks the word",
    build: (h) => ({
      style: {
        fontFamily: "Lora, serif",
        fontWeight: "bold",
        italic: true,
        color: "#ffffff",
        uppercase: false,
        align: "center",
        letterSpacing: 0,
        fontSize: px(h, 0.052),
        outlineWidth: 0,
        shadow: { color: "#000000", blur: 8, offsetX: 0, offsetY: 2 },
        box: null,
        background: null,
        position: "bottom",
      },
      karaoke: { highlight: "#ff5fa2", style: "underline" },
      anim: { style: "fade", unit: "whole", durationSec: 0.2 },
    }),
  },
  {
    key: "marker",
    label: "Marker",
    hint: "Hand-scrawled caps with a hot-pink highlight box",
    build: (h) => ({
      style: {
        fontFamily: "Permanent Marker, cursive",
        fontWeight: "normal",
        italic: false,
        color: "#ffffff",
        uppercase: true,
        align: "center",
        letterSpacing: 1,
        fontSize: px(h, 0.06),
        outlineColor: "#000000",
        outlineWidth: px(h, 0.006),
        shadow: null,
        box: null,
        background: null,
        position: "center",
      },
      karaoke: { highlight: "#ff3d8b", style: "box" },
      anim: { style: "rise", unit: "word", durationSec: 0.3 },
    }),
  },
];

export function findCaptionPreset(key: string): CaptionPreset | undefined {
  const k = key.trim().toLowerCase();
  return CAPTION_PRESETS.find((p) => p.key === k || p.label.toLowerCase() === k);
}

/** Options for {@link applyCaptionPreset}. */
export interface ApplyCaptionPresetOptions {
  /** Restyle ONE caption (by id); otherwise every caption. */
  clipId?: string;
  /** Turn word-highlight on with the preset's karaoke look (default true). */
  karaoke?: boolean;
}

/**
 * Apply a caption preset: restyle (font/color/outline/shadow/box/position), set the
 * karaoke highlight look (enabled when captions carry per-word timings), and the
 * entrance animation — all via the existing pure engine ops. Throws a helpful error
 * for an unknown key or when there are no captions yet.
 */
export function applyCaptionPreset(doc: EditDoc, key: string, opts: ApplyCaptionPresetOptions = {}): EditDoc {
  const preset = findCaptionPreset(key);
  if (!preset) throw new Error(`Unknown caption preset "${key}". Try: ${CAPTION_PRESETS.map((p) => p.key).join(", ")}.`);
  const spec = preset.build(doc.meta.height);
  const { position, ...style } = spec.style;
  let next = styleCaptions(doc, { ...style, clipId: opts.clipId });
  if (position) next = positionCaptions(next, { anchor: position, offset: 0, clipId: opts.clipId });
  next = setKaraoke(next, {
    enabled: opts.karaoke ?? true,
    highlight: spec.karaoke.highlight,
    style: spec.karaoke.style,
    scale: spec.karaoke.scale,
    clipId: opts.clipId,
  });
  if (spec.anim.style !== "none" && !opts.clipId) {
    next = animateText(next, { target: "captions", style: spec.anim.style, unit: spec.anim.unit, durationSec: spec.anim.durationSec }).doc;
  }
  return parseEditDoc(next);
}
