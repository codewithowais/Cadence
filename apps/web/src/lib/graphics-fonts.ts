/**
 * Fonts used by text PARTS inside shapes (CTA labels, badge words, lower-third
 * names, counters). A canvas never lazy-loads a web font, so the preview asks the
 * browser to load each face first (the bundled faces are declared in fonts.css —
 * the same files the export renderer registers, so preview == export).
 */
import { fontWeightToCss, type EditDoc } from "@cadence/core";

/** CSS font shorthands (at a nominal size) for every shape text part in `doc`. */
export function graphicFonts(doc: EditDoc): string[] {
  const set = new Set<string>();
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.kind !== "shape" || !c.parts) continue;
      for (const p of c.parts) {
        if (p.kind === "text") set.add(`${p.italic ? "italic " : ""}${fontWeightToCss(p.fontWeight)} 48px ${p.fontFamily}`);
      }
    }
  }
  return [...set];
}

/** Resolve once every font has loaded (or failed — the canvas then falls back). */
export async function loadGraphicFonts(fonts: string[]): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document) || fonts.length === 0) return;
  await Promise.all(fonts.map((f) => document.fonts.load(f).catch(() => [])));
}
