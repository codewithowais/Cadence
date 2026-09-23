"use client";

/**
 * The preview's SYNTHETIC layers — backgrounds (solid / gradient / animated /
 * pattern), text (every animation, effect, font), shapes, callouts, and cursors —
 * drawn on a <canvas> by the SAME @cadence/core drawing functions the export uses,
 * so the preview is exactly what exports.
 *
 * Z-order: synthetic clips on tracks BELOW the lowest active media track draw on
 * the "under" canvas (beneath the <video>/<img> layers); everything else draws on
 * the "over" canvas. The under canvas also paints the doc background.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeClipsAt,
  drawCallout,
  drawCursor,
  drawShape,
  drawSolid,
  drawText,
  textFont,
  type Clip,
  type EditDoc,
  type TextClip,
} from "@cadence/core";

type Layer = "under" | "over";

const SYNTHETIC = new Set(["solid", "text", "shape", "callout", "cursor"]);

/** Load every font the doc's text uses, then re-render (canvas can't lazy-load fonts). */
function useFontsReady(doc: EditDoc): number {
  const [tick, setTick] = useState(0);
  const fonts = useMemo(() => {
    const set = new Set<string>();
    for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "text") set.add(textFont(c as TextClip).replace(/\d+(\.\d+)?px/, "48px"));
    return [...set];
  }, [doc]);
  useEffect(() => {
    if (typeof document === "undefined" || !("fonts" in document)) return;
    let alive = true;
    const bump = () => alive && setTick((n) => n + 1);
    Promise.all(fonts.map((f) => document.fonts.load(f).catch(() => []))).then(bump, bump);
    document.fonts.addEventListener?.("loadingdone", bump);
    return () => {
      alive = false;
      document.fonts.removeEventListener?.("loadingdone", bump);
    };
  }, [fonts]);
  return tick;
}

export function SyntheticLayer({
  doc,
  timeSec,
  layer,
  width,
  height,
}: {
  doc: EditDoc;
  timeSec: number;
  layer: Layer;
  /** Displayed CSS size of the composition frame. */
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fontTick = useFontsReady(doc);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || width <= 0 || height <= 0) return;
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const bw = Math.max(1, Math.round(width * dpr));
    const bh = Math.max(1, Math.round(height * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = doc.meta.width;
    const H = doc.meta.height;
    const s = bw / W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(s, 0, 0, s, 0, 0);

    const active = activeClipsAt(doc, timeSec);
    const trackIndex = new Map(doc.tracks.map((t, i) => [t.id, i]));
    let mediaIdx = Infinity;
    for (const { clip, track } of active) {
      if (clip.kind === "video" || clip.kind === "image") mediaIdx = Math.min(mediaIdx, trackIndex.get(track.id) ?? 0);
    }
    const mine = active.filter(({ clip, track }) => {
      if (!SYNTHETIC.has(clip.kind)) return false;
      const under = (trackIndex.get(track.id) ?? 0) < mediaIdx && clip.kind !== "callout" && clip.kind !== "cursor";
      return layer === "under" ? under : !under;
    });

    if (layer === "under") {
      ctx.fillStyle = doc.meta.background;
      ctx.fillRect(0, 0, W, H);
    }
    const opts = { pxScale: s };
    // Content first (track order = z-order), then callouts, then cursors on top.
    const order = (c: Clip): number => (c.kind === "cursor" ? 2 : c.kind === "callout" ? 1 : 0);
    for (const { clip } of [...mine].sort((a, b) => order(a.clip) - order(b.clip))) {
      ctx.save();
      try {
        if (clip.kind === "solid") drawSolid(ctx, clip, W, H, timeSec);
        else if (clip.kind === "text") drawText(ctx, clip, timeSec, opts);
        else if (clip.kind === "shape") drawShape(ctx, clip, timeSec, opts);
        else if (clip.kind === "callout") drawCallout(ctx, clip, W, H);
        else if (clip.kind === "cursor") drawCursor(ctx, clip, timeSec);
      } finally {
        ctx.restore();
      }
    }
  }, [doc, timeSec, layer, width, height, fontTick]);

  return (
    <canvas
      ref={ref}
      data-layer={layer}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
