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
import type { KaraokeOverlayMap, TextOverlayMap } from "./plan";

export type { KaraokeOverlayMap, TextOverlayMap };

/** True when a text clip is a karaoke caption (highlight on + per-word timings). */
function isKaraoke(clip: { kind: string; karaoke?: { enabled: boolean }; words?: unknown[] }): boolean {
  return clip.kind === "text" && !!clip.karaoke?.enabled && Array.isArray(clip.words) && clip.words.length > 0;
}

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
        // Karaoke captions are rendered as a per-word PNG sequence by
        // renderKaraokeOverlays; skip the single static PNG for them.
        if (isKaraoke(clip)) continue;
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

/**
 * Render every KARAOKE caption in `doc` to a transparent PNG SEQUENCE — one PNG per
 * word — under `dir`, returning clipId → per-word paths (index-aligned to
 * `clip.words`). Each PNG shows that word highlighted (rendered via the SAME canvas
 * drawText the preview uses), so `buildExportPlan` can overlay them gated word-by-word
 * (see KaraokeOverlayMap). Non-karaoke clips are untouched (they use the single-PNG
 * `renderTextOverlays` path). Returns an empty map when the doc has no karaoke
 * captions, so non-karaoke exports are byte-identical to before.
 */
export async function renderKaraokeOverlays(doc: EditDoc, dir: string): Promise<KaraokeOverlayMap> {
  const map: KaraokeOverlayMap = new Map();
  const { renderKaraokeWordPngs } = await import("@cadence/render-node");
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!isKaraoke(clip) || clip.kind !== "text") continue;
      const pngs = renderKaraokeWordPngs(doc, clip);
      const paths: string[] = [];
      for (let i = 0; i < pngs.length; i++) {
        const p = join(dir, `karaoke-${safe(clip.id)}-${i}.png`);
        await writeFile(p, pngs[i]!);
        paths.push(p);
      }
      if (paths.length > 0) map.set(clip.id, paths);
    }
  }
  return map;
}

/** True when a doc has any karaoke caption needing a per-word PNG sequence. */
export function docNeedsKaraokeOverlays(doc: EditDoc): boolean {
  return doc.tracks.some((t) => t.clips.some((c) => isKaraoke(c)));
}
