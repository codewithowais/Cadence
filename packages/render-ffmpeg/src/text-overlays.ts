/**
 * Rasterize every text-bearing clip to a transparent PNG for the ffmpeg export.
 *
 * WHY: the bundled ffmpeg (`ffmpeg-static`) ships WITHOUT libfreetype, so it has no
 * `drawtext` filter — any export with captions, titles, kinetic titles, or callout
 * labels used to fail. Instead we render each such clip's TEXT to a transparent,
 * composition-sized PNG using the SAME canvas engine that draws the live preview
 * (@cadence/render-node), then `buildExportPlan` overlays those PNGs (time-gated)
 * INSTEAD of emitting `drawtext`. This works with ANY ffmpeg build AND gives perfect
 * preview↔export text parity.
 *
 * The @cadence/render-node import is DYNAMIC (`await import`) so the native Skia
 * canvas never enters a client bundle — this module is only ever reached from the
 * server-side export driver (runExport / the export route).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EditDoc } from "@cadence/core";
import type { TextOverlayMap } from "./plan";

export type { TextOverlayMap };

/** True when a doc has any text-bearing clip that needs a rasterized overlay. */
export function docNeedsTextOverlays(doc: EditDoc): boolean {
  return doc.tracks.some((t) =>
    t.clips.some((c) => c.kind === "text" || (c.kind === "callout" && !!c.label)),
  );
}

/** Filesystem-safe fragment from a clip id (ids are simple, but be defensive). */
function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Render all text clips (caption/title/kinetic/typewriter) and callout LABELS in
 * `doc` to transparent PNGs under `dir`, returning clipId → path. Text is rendered
 * at its resting/final state (animations settled — see render-node's textRestTime);
 * ANIMATED text (kinetic slide/scale, typewriter, text keyframes) is therefore
 * exported as a STATIC frame at rest, while the preview still animates (a documented
 * limitation of this pass). Static captions/titles are pixel-perfect.
 */
export async function renderTextOverlays(doc: EditDoc, dir: string): Promise<TextOverlayMap> {
  const map: TextOverlayMap = new Map();
  // Dynamic import keeps the native canvas out of any client bundle.
  const { renderTextClipPng, renderCalloutLabelPng } = await import("@cadence/render-node");
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "text") {
        const png = renderTextClipPng(doc, clip);
        const p = join(dir, `text-${safe(clip.id)}.png`);
        await writeFile(p, png);
        map.set(clip.id, p);
      } else if (clip.kind === "callout") {
        const png = renderCalloutLabelPng(doc, clip);
        if (png) {
          const p = join(dir, `callout-${safe(clip.id)}.png`);
          await writeFile(p, png);
          map.set(clip.id, p);
        }
      }
    }
  }
  return map;
}
