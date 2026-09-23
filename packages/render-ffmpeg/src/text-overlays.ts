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
import { overlaySegmentSpecs, type AnimatedOverlayMap, type KaraokeOverlayMap, type OverlaySegment, type TextOverlayMap } from "./plan";

export type { AnimatedOverlayMap, KaraokeOverlayMap, TextOverlayMap };

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

/** True when a doc has any vector-shape clip needing a rasterized overlay. */
export function docNeedsShapeOverlays(doc: EditDoc): boolean {
  return doc.tracks.some((t) => t.clips.some((c) => c.kind === "shape"));
}

/**
 * Render every SHAPE clip (rect/ellipse/line/arrow) in `doc` to a transparent
 * composition-sized PNG under `dir`, returning clipId → path. `buildExportPlan`
 * overlays these time-gated to each clip's span — the SAME PNG-overlay path text and
 * callout labels use, so a shape looks identical in preview, node render, and export.
 * Empty map when the doc has no shapes (byte-identical to before). Uses the same
 * dynamic @cadence/render-node import so the native canvas never enters a client bundle.
 */
export async function renderShapeOverlays(doc: EditDoc, dir: string): Promise<TextOverlayMap> {
  const map: TextOverlayMap = new Map();
  const { renderShapeClipPng } = await import("@cadence/render-node");
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "shape") continue;
      const png = renderShapeClipPng(doc, clip);
      const p = join(dir, `shape-${safe(clip.id)}.png`);
      await writeFile(p, png);
      map.set(clip.id, p);
    }
  }
  return map;
}

/**
 * Rasterize every ANIMATED text / shape clip (intro/exit/loop animations,
 * transition ramps, keyframes) into overlay SEGMENTS — one still PNG per static
 * span and a PNG frame sequence per animated window, each frame drawn at its exact
 * output-frame time by the SAME shared drawing code as the preview — so the export
 * animates exactly like the preview instead of freezing text at rest. Static and
 * karaoke clips are skipped (they keep their existing single-PNG / per-word paths).
 */
export async function renderAnimatedOverlays(doc: EditDoc, dir: string): Promise<AnimatedOverlayMap> {
  const map: AnimatedOverlayMap = new Map();
  const { renderClipPngAt } = await import("@cadence/render-node");
  const fps = doc.meta.fps;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "text" && clip.kind !== "shape") continue;
      if (clip.kind === "shape" && track.hidden) continue;
      if (isKaraoke(clip)) continue;
      const specs = overlaySegmentSpecs(clip, fps);
      if (specs.length === 0) continue;
      const segs: OverlaySegment[] = [];
      for (let k = 0; k < specs.length; k++) {
        const sp = specs[k]!;
        const base = `anim-${safe(clip.id)}-${k}`;
        if (sp.kind === "still") {
          const p = join(dir, `${base}.png`);
          await writeFile(p, renderClipPngAt(doc, clip, sp.at));
          segs.push({ kind: "still", start: sp.start, end: sp.end, path: p });
        } else {
          for (let f = 0; f < sp.frames; f++) {
            const png = renderClipPngAt(doc, clip, (sp.at + f) / fps);
            await writeFile(join(dir, `${base}-${String(f).padStart(5, "0")}.png`), png);
          }
          segs.push({ kind: "seq", start: sp.start, end: sp.end, pattern: join(dir, `${base}-%05d.png`), frames: sp.frames, fps });
        }
      }
      map.set(clip.id, segs);
    }
  }
  return map;
}

/** True when a doc has any animated text/shape needing overlay segments. */
export function docNeedsAnimatedOverlays(doc: EditDoc): boolean {
  return doc.tracks.some((t) =>
    t.clips.some(
      (c) => (c.kind === "text" || c.kind === "shape") && !isKaraoke(c) && overlaySegmentSpecs(c, doc.meta.fps).length > 0,
    ),
  );
}
