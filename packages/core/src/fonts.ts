/**
 * The bundled FONT LIBRARY — metadata only (pure; safe in any bundle).
 *
 * Every family here ships as real font files (OFL / Apache-licensed Google Fonts,
 * vendored from pinned @fontsource packages by `scripts/sync-fonts.ts` into
 * `apps/web/public/fonts/`). The browser loads them via @font-face and the node
 * canvas registers the SAME files with Skia, so a title set in "Bebas Neue" looks
 * identical in the preview and in the exported .mp4. `stack` always ends in a CSS
 * generic family so text still renders if a file is missing.
 */

export type FontCategory = "sans" | "display" | "serif" | "script" | "handwriting" | "mono";

export interface FontFace {
  /** @fontsource package id (also the folder name under /fonts). */
  readonly id: string;
  /** CSS family name used in `fontFamily`. */
  readonly family: string;
  readonly category: FontCategory;
  /** Bundled weights (normal style). */
  readonly weights: readonly number[];
  /** Bundled italic weights (subset of `weights`), if any. */
  readonly italics?: readonly number[];
  /** A short sample that shows the face's character in the picker. */
  readonly sample: string;
}

export const FONT_LIBRARY: readonly FontFace[] = [
  { id: "inter", family: "Inter", category: "sans", weights: [400, 700, 800], sample: "Clean & modern" },
  { id: "montserrat", family: "Montserrat", category: "sans", weights: [400, 700, 900], sample: "Bold statement" },
  { id: "poppins", family: "Poppins", category: "sans", weights: [400, 600, 800], sample: "Friendly headline" },
  { id: "space-grotesk", family: "Space Grotesk", category: "sans", weights: [400, 700], sample: "Tech forward" },
  { id: "raleway", family: "Raleway", category: "sans", weights: [400, 800], sample: "Elegant sans" },
  { id: "oswald", family: "Oswald", category: "display", weights: [400, 700], sample: "CONDENSED NEWS" },
  { id: "bebas-neue", family: "Bebas Neue", category: "display", weights: [400], sample: "BIG TITLES" },
  { id: "anton", family: "Anton", category: "display", weights: [400], sample: "LOUD & PROUD" },
  { id: "archivo-black", family: "Archivo Black", category: "display", weights: [400], sample: "Heavy Impact" },
  { id: "righteous", family: "Righteous", category: "display", weights: [400], sample: "Retro Groove" },
  { id: "bangers", family: "Bangers", category: "display", weights: [400], sample: "COMIC POW!" },
  { id: "press-start-2p", family: "Press Start 2P", category: "mono", weights: [400], sample: "GAME ON" },
  { id: "abril-fatface", family: "Abril Fatface", category: "serif", weights: [400], sample: "Editorial" },
  { id: "playfair-display", family: "Playfair Display", category: "serif", weights: [400, 700], italics: [400], sample: "Timeless story" },
  { id: "dm-serif-display", family: "DM Serif Display", category: "serif", weights: [400], italics: [400], sample: "Luxe quote" },
  { id: "fraunces", family: "Fraunces", category: "serif", weights: [400, 700], italics: [400], sample: "Warm & human" },
  { id: "merriweather", family: "Merriweather", category: "serif", weights: [400, 700], sample: "Readable serif" },
  { id: "lora", family: "Lora", category: "serif", weights: [400, 700], italics: [400], sample: "Literary" },
  { id: "roboto-slab", family: "Roboto Slab", category: "serif", weights: [400, 700], sample: "Sturdy slab" },
  { id: "lobster", family: "Lobster", category: "script", weights: [400], sample: "Weekend vibes" },
  { id: "pacifico", family: "Pacifico", category: "script", weights: [400], sample: "Surf's up" },
  { id: "dancing-script", family: "Dancing Script", category: "script", weights: [400, 700], sample: "With love" },
  { id: "caveat", family: "Caveat", category: "handwriting", weights: [400, 700], sample: "Handwritten note" },
  { id: "permanent-marker", family: "Permanent Marker", category: "handwriting", weights: [400], sample: "Marker scrawl" },
];

const GENERIC: Record<FontCategory, string> = {
  sans: "sans-serif",
  display: "sans-serif",
  serif: "serif",
  script: "cursive",
  handwriting: "cursive",
  mono: "monospace",
};

/** The CSS `font-family` stack for a bundled face ("'Bebas Neue', sans-serif"). */
export function fontStack(face: FontFace): string {
  return `'${face.family}', ${GENERIC[face.category]}`;
}

/** Find a bundled face by family name, id, or a stack that starts with it. */
export function findFont(nameOrStack: string): FontFace | undefined {
  const first = nameOrStack.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return FONT_LIBRARY.find((f) => f.family.toLowerCase() === first || f.id === first);
}

/** The font files bundled for one face: `{ file, weight, style }` (subset-agnostic). */
export function fontFiles(face: FontFace): { weight: number; style: "normal" | "italic" }[] {
  const out: { weight: number; style: "normal" | "italic" }[] = face.weights.map((w) => ({ weight: w, style: "normal" }));
  for (const w of face.italics ?? []) out.push({ weight: w, style: "italic" });
  return out;
}

/** The unicode subsets bundled per file (latin covers English; latin-ext adds accents). */
export const FONT_SUBSETS = ["latin", "latin-ext"] as const;

/** Relative path of one bundled font file under the fonts directory. */
export function fontFilePath(face: FontFace, subset: string, weight: number, style: "normal" | "italic"): string {
  return `${face.id}/${face.id}-${subset}-${weight}-${style}.woff2`;
}
