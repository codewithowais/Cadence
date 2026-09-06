/**
 * Design-room preset data (Wave 2).
 *
 * A richer, well-named catalogue of LOOKS, background PALETTES and (re-exported)
 * TEXT styles — all expressed as data over the EXISTING pure engine primitives
 * (`adjustColor` / `adjustHsl` for grades, `meta.background` for palettes,
 * `insertTextOverlay` for text). No engine feature, tool or schema is added here;
 * every apply routes through the editor's undoable `commit` path so a click is
 * instant AND undoable (fixes the look-latency split — looks no longer wait on a
 * Director round-trip).
 */
import type { ColorGrade, EditDoc } from "@cadence/core";
import { parseEditDoc } from "@cadence/core";
import { adjustColor, adjustCurves, adjustHsl, NEUTRAL_GRADE } from "@cadence/director";

/** A named graded look, grouped into a family so the gallery reads as sections. */
export interface LookPreset {
  key: string;
  label: string;
  /** Full target grade (merged onto every main visual clip). */
  grade: ColorGrade;
}

export interface LookFamily {
  key: string;
  label: string;
  looks: LookPreset[];
}

const g = (
  brightness: number,
  contrast: number,
  saturation: number,
  warmth: number,
  hueShift = 0,
): ColorGrade => ({ brightness, contrast, saturation, warmth, hueShift });

/**
 * Look families. Where a look matches one of the engine's LOOK_PRESETS grade
 * signatures its grade values are kept identical so the "Applied" strip names it
 * the same way (e.g. Cinematic → "Cinematic"). The extras are new named blends of
 * the same brightness/contrast/saturation/warmth/hue primitives.
 */
export const LOOK_FAMILIES: LookFamily[] = [
  {
    key: "cinematic",
    label: "Cinematic",
    looks: [
      { key: "cinematic", label: "Cinematic", grade: g(0.98, 1.14, 0.95, 0.22) },
      { key: "teal-orange", label: "Teal & Orange", grade: g(1.0, 1.16, 1.1, 0.3, 8) },
      { key: "blockbuster", label: "Blockbuster", grade: g(1.0, 1.2, 1.05, 0.28) },
      { key: "moody-blue", label: "Moody Blue", grade: g(0.9, 1.18, 0.8, 0.0) },
      { key: "golden-hour", label: "Golden Hour", grade: g(1.05, 1.04, 1.12, 0.7) },
      { key: "bleach-bypass", label: "Bleach Bypass", grade: g(1.04, 1.32, 0.55, 0.05) },
      { key: "noir", label: "Film Noir", grade: g(0.96, 1.22, 0, 0) },
    ],
  },
  {
    key: "warm",
    label: "Warm / Film",
    looks: [
      { key: "warm", label: "Kodak Warm", grade: g(1.03, 1.05, 1.08, 0.5) },
      { key: "portra", label: "Portra", grade: g(1.04, 1.0, 1.05, 0.4) },
      { key: "sunset", label: "Sunset", grade: g(1.02, 1.06, 1.2, 0.6) },
      { key: "amber-glow", label: "Amber Glow", grade: g(1.05, 1.02, 1.1, 0.65) },
      { key: "vintage", label: "Faded Film", grade: g(1.02, 0.95, 0.82, 0.55) },
    ],
  },
  {
    key: "cool",
    label: "Cool / Clean",
    looks: [
      { key: "cool", label: "Clean Cool", grade: g(1.0, 1.06, 1.04, 0.0) },
      { key: "arctic", label: "Arctic", grade: g(1.03, 1.08, 0.95, 0.0) },
      { key: "slate", label: "Slate", grade: g(0.98, 1.1, 0.9, 0.0) },
      { key: "overcast", label: "Overcast", grade: g(1.02, 0.96, 0.88, 0.05) },
    ],
  },
  {
    key: "vibrant",
    label: "Vibrant / Social",
    looks: [
      { key: "vivid", label: "Pop", grade: g(1.02, 1.1, 1.35, 0.1) },
      { key: "punch", label: "Punchy", grade: g(1.03, 1.16, 1.3, 0.08) },
      { key: "neon-night", label: "Neon Night", grade: g(1.0, 1.22, 1.55, 0.0) },
      { key: "candy", label: "Candy", grade: g(1.05, 1.05, 1.5, 0.15) },
    ],
  },
  {
    key: "mono",
    label: "Mono",
    looks: [
      { key: "bw", label: "True B&W", grade: g(1.02, 1.12, 0, 0) },
      { key: "hi-mono", label: "Hi-Contrast Mono", grade: g(0.98, 1.35, 0, 0) },
      { key: "silver", label: "Silver", grade: g(1.05, 1.1, 0, 0) },
      { key: "sepia", label: "Sepia", grade: g(1.02, 1.0, 0.25, 0.85) },
    ],
  },
  {
    key: "retro",
    label: "Retro",
    looks: [
      { key: "vhs", label: "VHS", grade: g(1.02, 0.92, 1.2, 0.2, 340) },
      { key: "chrome-80s", label: "80s Chrome", grade: g(1.0, 1.1, 1.3, 0.1, 20) },
      { key: "polaroid", label: "Faded Polaroid", grade: g(1.06, 0.9, 0.85, 0.5) },
      { key: "cross-process", label: "Cross-Process", grade: g(1.0, 1.15, 1.25, 0.2, 30) },
    ],
  },
];

/** Flat list of every look (for matching + search). */
export const ALL_LOOKS: LookPreset[] = LOOK_FAMILIES.flatMap((f) => f.looks);

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.02;

/** True when the doc's current grade matches this look's grade (b/c/s/w + hue). */
export function looksActive(look: LookPreset, grade: ColorGrade): boolean {
  const h = grade.hueShift ?? 0;
  const lh = look.grade.hueShift ?? 0;
  return (
    near(grade.brightness, look.grade.brightness) &&
    near(grade.contrast, look.grade.contrast) &&
    near(grade.saturation, look.grade.saturation) &&
    near(grade.warmth, look.grade.warmth) &&
    Math.abs(((h - lh + 540) % 360) - 180) < 1
  );
}

/** True when the doc carries no (neutral) grade — the "Original" card is active. */
export function isNeutralGrade(grade: ColorGrade): boolean {
  return looksActive({ key: "none", label: "Original", grade: { ...NEUTRAL_GRADE, hueShift: 0 } }, grade);
}

/**
 * Apply a look INSTANTLY and undoably (pure, client-side). Merges the full grade
 * onto every main visual clip via `adjustColor`, then sets the hue via `adjustHsl`
 * so a hue-tinted look (VHS, cross-process) reproduces and a hue-free look resets
 * any prior tint. Throws (like `adjustColor`) when there's no visual clip yet.
 */
export function applyLookPreset(doc: EditDoc, look: LookPreset): EditDoc {
  const withGrade = adjustColor(doc, {
    brightness: look.grade.brightness,
    contrast: look.grade.contrast,
    saturation: look.grade.saturation,
    warmth: look.grade.warmth,
  });
  return adjustHsl(withGrade, { hueShift: look.grade.hueShift ?? 0 });
}

/** Reset the grade to neutral (clears brightness/contrast/sat/warmth, hue and curves). */
export function clearLook(doc: EditDoc): EditDoc {
  const flat = adjustColor(doc, { ...NEUTRAL_GRADE });
  const noHue = adjustHsl(flat, { hueShift: 0 });
  return adjustCurves(noHue, {});
}

// ---- Background palette ------------------------------------------------------

/** A curated swatch — sets the composition background (`meta.background`). */
export interface Swatch {
  key: string;
  label: string;
  color: string;
}

/**
 * The background palette. Setting one changes `meta.background`, the colour shown
 * behind fit-to-frame content and in any letterbox bars (e.g. after a 2.39:1
 * reframe). Solid only — gradient backgrounds would need a schema extension
 * (`SolidClip`/`meta.background` is a single hex today), so they're deliberately
 * out of scope for this UI-only wave.
 */
export const BG_SWATCHES: Swatch[] = [
  { key: "ink", label: "Ink", color: "#0a0d12" },
  { key: "black", label: "Black", color: "#000000" },
  { key: "charcoal", label: "Charcoal", color: "#1a1d24" },
  { key: "slate", label: "Slate", color: "#2b3240" },
  { key: "bone", label: "Bone", color: "#e8e2d4" },
  { key: "paper", label: "Paper White", color: "#f7f5ef" },
  { key: "white", label: "White", color: "#ffffff" },
  { key: "amber", label: "Vermilion", color: "#f76f53" },
  { key: "teal", label: "Teal", color: "#45d3c4" },
  { key: "coral", label: "Coral", color: "#ff6b6b" },
  { key: "magenta", label: "Magenta", color: "#d63cff" },
  { key: "lime", label: "Lime", color: "#b6f549" },
  { key: "sky", label: "Sky", color: "#57b6ff" },
  { key: "violet", label: "Violet", color: "#8b7cff" },
  { key: "sunflower", label: "Sunflower", color: "#ffd23c" },
];

/** Set the composition background colour (pure + re-parsed through the schema). */
export function setBackground(doc: EditDoc, color: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  clone.meta = { ...clone.meta, background: color };
  return parseEditDoc(clone);
}

const norm = (c?: string): string => (c ?? "").trim().toLowerCase();

/** True when the doc's background matches this swatch. */
export function backgroundActive(swatch: Swatch, doc: EditDoc): boolean {
  return norm(doc.meta.background) === norm(swatch.color);
}
