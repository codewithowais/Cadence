/**
 * CANVAS OPS — custom frame size / ratio, Fit-vs-Fill, and Magic resize.
 *
 * PURE (doc in → doc out, always re-parsed). Reuses `reframeTo` for the base re-anchor
 * (media re-centers, text videos re-lay out) and adds the pieces `reframeTo` leaves out:
 * text/shape/callout/cursor sizes follow the frame by fractions, the export's target
 * resolution stays in the new aspect (never distorts), and the doc's `meta.canvas` records
 * the fit/fill choice + the ratio the user asked for.
 */
import {
  CANVAS_PRESETS,
  SOCIAL_MAGIC_SET,
  findPreset,
  parseEditDoc,
  parseRatio,
  ratioLabel,
  sizeForRatio,
  validateCanvasSize,
  type CanvasSettings,
  type EditDoc,
} from "@cadence/core";
import { ASPECTS, reframeTo, type AspectKey } from "./edits";
import { isTextVideo } from "./textvideo";

export interface SetCanvasOptions {
  /** Explicit pixel size (either alone keeps the current ratio; both set it). */
  width?: number;
  height?: number;
  /** A ratio like "21:9" / "1.91:1" / "7:5" — sized at `longEdge`, `width` or `height`. */
  ratio?: string;
  /** Long edge in px when sizing from a ratio (default: short edge 1080). */
  longEdge?: number;
  presetId?: string;
  /** How footage adapts: fill (crop) or fit (contain + bars). Absent ⇒ unchanged. */
  fit?: "fill" | "fit";
  fill?: "blur" | "solid";
  fillColor?: string;
  blur?: number;
  /** Re-lay text/overlays by fractions of the frame (default true). */
  relayout?: boolean;
}

export interface SetCanvasResult {
  doc: EditDoc;
  width: number;
  height: number;
  /** Plain-language notes (rounded, capped…) for the Director summary / UI toast. */
  notes: string[];
}

/** The size a request resolves to against the current doc (validated + even). */
export function resolveCanvasSize(
  doc: EditDoc,
  o: Pick<SetCanvasOptions, "width" | "height" | "ratio" | "longEdge" | "presetId">,
): { width: number; height: number; notes: string[]; ratio?: string } {
  const cur = { width: doc.meta.width, height: doc.meta.height };
  let w: number;
  let h: number;
  let ratio: string | undefined;
  if (o.presetId && findPreset(o.presetId)) {
    const p = findPreset(o.presetId)!;
    w = p.width;
    h = p.height;
  } else if (o.ratio) {
    const r = parseRatio(o.ratio);
    if (!r) throw new Error(`"${o.ratio}" is not a usable ratio (try 21:9, 3:2 or 1.91:1).`);
    ratio = o.ratio.trim();
    const named = ASPECTS[ratio as AspectKey];
    const s =
      named && !o.width && !o.height && !o.longEdge
        ? { width: named.width, height: named.height }
        : sizeForRatio(r, { width: o.width, height: o.height, longEdge: o.longEdge });
    w = s.width;
    h = s.height;
  } else if (o.width && o.height) {
    w = o.width;
    h = o.height;
  } else if (o.width) {
    w = o.width;
    h = (o.width * cur.height) / cur.width;
  } else if (o.height) {
    h = o.height;
    w = (o.height * cur.width) / cur.height;
  } else {
    throw new Error("Give a size (width and height), or a ratio such as 21:9.");
  }
  const v = validateCanvasSize(w, h);
  if (!v.ok) throw new Error(v.issues.join(" "));
  return { width: v.width, height: v.height, notes: v.issues, ratio };
}

/** Merge canvas settings onto a doc (creating `meta.canvas` with defaults when absent). */
export function withCanvasSettings(doc: EditDoc, patch: Partial<CanvasSettings>): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const base = clone.meta.canvas ?? {
    fit: "fill" as const,
    fill: "blur" as const,
    fillColor: "#000000",
    blur: 0.6,
    linked: true,
    customPresets: [],
  };
  clone.meta.canvas = { ...base, ...patch };
  return parseEditDoc(clone);
}

/** Set the fit mode (and bar fill) without touching the frame size. */
export function setCanvasFit(
  doc: EditDoc,
  o: { fit: "fill" | "fit"; fill?: "blur" | "solid"; fillColor?: string; blur?: number },
): EditDoc {
  return withCanvasSettings(doc, {
    fit: o.fit,
    ...(o.fill ? { fill: o.fill } : {}),
    ...(o.fillColor ? { fillColor: o.fillColor } : {}),
    ...(o.blur !== undefined ? { blur: Math.max(0, Math.min(1, o.blur)) } : {}),
  });
}

/** Scale text / shapes / callouts / cursors by the frame change (fractions, not px). */
function relayoutOverlays(doc: EditDoc, oldW: number, oldH: number): EditDoc {
  const wr = doc.meta.width / oldW;
  const hr = doc.meta.height / oldH;
  // Sizes follow the SMALLER axis change so text never outgrows a narrower frame.
  const s = Math.min(wr, hr);
  if (Math.abs(wr - 1) < 1e-6 && Math.abs(hr - 1) < 1e-6) return doc;
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "text") {
        clip.fontSize = Math.max(4, Math.round(clip.fontSize * s * 10) / 10);
        if (clip.maxWidth) clip.maxWidth = Math.max(8, Math.round(clip.maxWidth * wr));
        if (clip.outline?.width) clip.outline.width = Math.round(clip.outline.width * s * 10) / 10;
      } else if (clip.kind === "shape") {
        clip.transform.x = (clip.transform.x / oldW) * doc.meta.width;
        clip.transform.y = (clip.transform.y / oldH) * doc.meta.height;
        clip.w = Math.max(1, Math.round(clip.w * s));
        clip.h = Math.max(1, Math.round(clip.h * s));
        clip.strokeWidth = Math.round(clip.strokeWidth * s * 10) / 10;
      } else if (clip.kind === "callout") {
        clip.x *= wr;
        clip.y *= hr;
        clip.w = Math.max(1, clip.w * wr);
        clip.h = Math.max(1, clip.h * hr);
      } else if (clip.kind === "cursor") {
        for (const wp of clip.waypoints) {
          wp.x *= wr;
          wp.y *= hr;
        }
        clip.size = Math.max(8, Math.round(clip.size * s));
      }
    }
  }
  return parseEditDoc(clone);
}

/**
 * Change the canvas to a custom size / ratio and (optionally) the fit mode. Re-anchors
 * media, re-lays text/overlays by fractions, keeps the export target in the same aspect.
 */
export function setCanvasSize(doc: EditDoc, o: SetCanvasOptions): SetCanvasResult {
  const target = resolveCanvasSize(doc, o);
  const oldW = doc.meta.width;
  const oldH = doc.meta.height;
  let next: EditDoc =
    target.width === oldW && target.height === oldH ? doc : reframeTo(doc, target.width, target.height);
  // Text videos re-lay themselves out inside reframeTo; everything else follows here.
  if (o.relayout !== false && !isTextVideo(doc)) next = relayoutOverlays(next, oldW, oldH);

  // Keep the export target in the NEW aspect (a stale 1920×1080 target would distort a 9:16).
  const q = next.quality;
  if (q.targetWidth && q.targetHeight) {
    const clone: EditDoc = structuredClone(next);
    const same = Math.abs(q.targetWidth / q.targetHeight - target.width / target.height) < 0.01;
    if (same) {
      const k = target.width / oldW;
      clone.quality.targetWidth = Math.max(2, Math.round((q.targetWidth * k) / 2) * 2);
      clone.quality.targetHeight = Math.max(2, Math.round((q.targetHeight * k) / 2) * 2);
    } else {
      delete clone.quality.targetWidth;
      delete clone.quality.targetHeight;
    }
    next = parseEditDoc(clone);
  }

  const label = target.ratio ?? ratioLabel(target.width, target.height);
  const exact = CANVAS_PRESETS.find((p) => p.width === target.width && p.height === target.height);
  const patch: Partial<CanvasSettings> = {
    ratio: label,
    presetId: o.presetId ?? exact?.id,
  };
  if (o.fit) patch.fit = o.fit;
  if (o.fill) patch.fill = o.fill;
  if (o.fillColor) patch.fillColor = o.fillColor;
  if (o.blur !== undefined) patch.blur = Math.max(0, Math.min(1, o.blur));
  if (!patch.presetId) delete patch.presetId;
  const has = next.meta.canvas;
  if (!patch.presetId && has?.presetId) {
    // The old preset no longer describes this size.
    const clone: EditDoc = structuredClone(next);
    delete clone.meta.canvas!.presetId;
    next = parseEditDoc(clone);
  }
  next = withCanvasSettings(next, patch);
  return { doc: next, width: target.width, height: target.height, notes: target.notes };
}

// ---- Magic resize ----------------------------------------------------------

export interface MagicTarget {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** Resolve preset ids (or "social") to concrete targets; unknown ids are skipped. */
export function magicTargets(ids: readonly string[] | "social"): MagicTarget[] {
  const list = ids === "social" ? SOCIAL_MAGIC_SET : ids;
  const out: MagicTarget[] = [];
  for (const id of list) {
    const p = findPreset(id);
    if (p) out.push({ id: p.id, label: `${p.platform.split(" ·")[0]} ${p.name}`, width: p.width, height: p.height });
  }
  return out;
}

export interface MagicVariant extends MagicTarget {
  doc: EditDoc;
}

/**
 * Duplicate the doc into one variant per target size (each a full valid doc, retitled
 * "<title> — <label>"). Variants keep the source's fit mode unless `fit` overrides it;
 * a target equal to the source frame is still emitted (an "as is" copy).
 */
export function magicResize(
  doc: EditDoc,
  targets: readonly MagicTarget[],
  opts: { fit?: "fill" | "fit"; fill?: "blur" | "solid" } = {},
): MagicVariant[] {
  return targets.map((t) => {
    const { doc: d } = setCanvasSize(doc, { width: t.width, height: t.height, presetId: t.id, ...opts });
    const clone: EditDoc = structuredClone(d);
    clone.meta.title = `${doc.meta.title || "Untitled"} — ${t.label} ${t.width}×${t.height}`;
    return { ...t, doc: parseEditDoc(clone) };
  });
}
