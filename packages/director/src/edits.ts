/**
 * Pure edit-doc transforms — the editorial operations, expressed as
 * doc-in / doc-out functions. Each is deterministic and re-parsed through the
 * schema so the result is always valid. Tools (tools.ts) wrap these; the real
 * Claude Director will call the same operations.
 */
import {
  docDurationSec,
  parseEditDoc,
  sourceSpanSec,
  sourceTimeAt,
  type BlendMode,
  type ChromaKey,
  type ColorGrade,
  type Curves,
  type CurvePoint,
  type EditDoc,
  type ImageClip,
  type KeyframeEasing,
  type KeyframeProp,
  type Mask,
  type MediaAsset,
  type TransitionType,
  type VideoClip,
} from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Track ids that carry the MAIN footage/photos (as opposed to overlays like
 * titles, captions, b-roll PiP, fades or music). Speed / zoom / transition edits
 * apply to these, never to the overlays.
 */
const OVERLAY_TRACK_IDS = new Set([
  "titles",
  "captions",
  "broll",
  "fades",
  "music",
  "cursor",
  "callouts",
  "demo-text",
]);
const isMainVisualTrack = (id: string): boolean => !OVERLAY_TRACK_IDS.has(id);

// ---- Aspect ratios ---------------------------------------------------------

export type AspectKey =
  | "9:16" | "1:1" | "4:5" | "16:9" | "21:9" | "4:3" | "2.39:1" | "2:3";

export const ASPECTS: Record<AspectKey, { width: number; height: number; label: string }> = {
  "9:16": { width: 1080, height: 1920, label: "vertical (Reels/Shorts/TikTok)" },
  "1:1": { width: 1080, height: 1080, label: "square (feed)" },
  "4:5": { width: 1080, height: 1350, label: "portrait (feed)" },
  "16:9": { width: 1920, height: 1080, label: "widescreen" },
  "21:9": { width: 2560, height: 1080, label: "ultrawide / cinematic" },
  "4:3": { width: 1440, height: 1080, label: "classic (fullscreen 4:3)" },
  "2.39:1": { width: 2048, height: 856, label: "anamorphic scope (2.39:1)" },
  "2:3": { width: 1080, height: 1620, label: "tall portrait (2:3)" },
};

/** Every offered aspect key, for UI enumeration. */
export const ASPECT_KEYS = Object.keys(ASPECTS) as AspectKey[];

/**
 * Reframe to explicit composition dimensions: resize the frame and re-anchor
 * every clip (media re-centers frame-cover; text keeps its relative position).
 * Dimensions are rounded to even numbers so libx264/yuv420p export stays valid.
 */
export function reframeTo(doc: EditDoc, width: number, height: number): EditDoc {
  const targetW = Math.max(2, Math.round(width / 2) * 2);
  const targetH = Math.max(2, Math.round(height / 2) * 2);
  const oldW = doc.meta.width;
  const oldH = doc.meta.height;
  const clone: EditDoc = structuredClone(doc);
  clone.meta.width = targetW;
  clone.meta.height = targetH;

  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") {
        // Media is frame-cover: center it in the new frame.
        clip.transform.x = targetW / 2;
        clip.transform.y = targetH / 2;
      } else if (clip.kind === "text") {
        // Keep text at the same relative position.
        clip.transform.x = (clip.transform.x / oldW) * targetW;
        clip.transform.y = (clip.transform.y / oldH) * targetH;
      }
    }
  }
  return parseEditDoc(clone);
}

/** Reframe to a named aspect (delegates to reframeTo with the preset dims). */
export function reframe(doc: EditDoc, aspect: AspectKey): EditDoc {
  const target = ASPECTS[aspect];
  return reframeTo(doc, target.width, target.height);
}

// ---- Looks -----------------------------------------------------------------

export type LookKey =
  | "warm" | "cool" | "vivid" | "bw" | "cinematic" | "vintage" | "noir" | "vibrant"
  | "bleach-bypass" | "moody" | "golden-hour" | "matte" | "punch" | "none";

export const LOOK_PRESETS: Record<LookKey, ColorGrade & { label: string }> = {
  warm: { brightness: 1.03, contrast: 1.05, saturation: 1.08, warmth: 0.5, label: "warm & golden" },
  cool: { brightness: 1.0, contrast: 1.06, saturation: 1.04, warmth: 0.0, label: "cool & crisp" },
  vivid: { brightness: 1.02, contrast: 1.1, saturation: 1.35, warmth: 0.1, label: "punchy & vivid" },
  bw: { brightness: 1.02, contrast: 1.12, saturation: 0, warmth: 0, label: "black & white" },
  cinematic: { brightness: 0.98, contrast: 1.14, saturation: 0.95, warmth: 0.22, label: "cinematic teal-amber" },
  vintage: { brightness: 1.02, contrast: 0.95, saturation: 0.82, warmth: 0.55, label: "vintage film" },
  noir: { brightness: 0.96, contrast: 1.22, saturation: 0, warmth: 0, label: "high-contrast noir" },
  vibrant: { brightness: 1.04, contrast: 1.08, saturation: 1.45, warmth: 0.12, label: "vibrant pop" },
  "bleach-bypass": { brightness: 1.04, contrast: 1.32, saturation: 0.55, warmth: 0.05, label: "bleach-bypass (silvery, high-contrast)" },
  moody: { brightness: 0.9, contrast: 1.18, saturation: 0.85, warmth: 0.0, label: "moody & dark" },
  "golden-hour": { brightness: 1.05, contrast: 1.04, saturation: 1.12, warmth: 0.7, label: "golden hour" },
  matte: { brightness: 1.03, contrast: 0.88, saturation: 0.92, warmth: 0.12, label: "matte (lifted, soft)" },
  punch: { brightness: 1.03, contrast: 1.16, saturation: 1.3, warmth: 0.08, label: "punchy contrast" },
  none: { brightness: 1, contrast: 1, saturation: 1, warmth: 0, label: "no grade" },
};

/** Every offered look key, for UI enumeration and the apply_look tool enum. */
export const LOOK_KEYS = Object.keys(LOOK_PRESETS) as LookKey[];

/** Apply a color grade preset to every visual media clip. */
export function applyLook(doc: EditDoc, look: LookKey): EditDoc {
  const preset = LOOK_PRESETS[look];
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") {
        clip.look = {
          brightness: preset.brightness,
          contrast: preset.contrast,
          saturation: preset.saturation,
          warmth: preset.warmth,
        };
      }
    }
  }
  return parseEditDoc(clone);
}

/** A neutral (identity) color grade — no brightness/contrast/saturation/warmth change. */
export const NEUTRAL_GRADE: ColorGrade = { brightness: 1, contrast: 1, saturation: 1, warmth: 0 };

/**
 * Read the color grade currently on the first MAIN visual clip (video/image),
 * falling back to a neutral grade when there's no footage yet. Used to seed the
 * manual sliders and to compute relative NL adjustments ("brighter", "warmer").
 */
export function currentGrade(doc: EditDoc): ColorGrade {
  for (const track of doc.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") return { ...clip.look };
    }
  }
  return { ...NEUTRAL_GRADE };
}

/**
 * Manual color grade — set any of brightness/contrast/saturation/warmth on every
 * MAIN visual clip, MERGING with each clip's existing look (omitted fields keep
 * their current value). This is the edits-as-code primitive behind the Color
 * room's live sliders: pure, deterministic, and re-parsed through the schema so
 * the result is always valid and previews identically everywhere (cssFilter).
 * Faithful: only tone/color multipliers change, never content. Values are clamped
 * to the schema's ranges (multipliers 0–4; warmth 0–1).
 */
export function adjustColor(doc: EditDoc, partial: Partial<ColorGrade>): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video" && clip.kind !== "image") continue;
      const g = clip.look;
      clip.look = {
        ...g, // keep hueShift / curves when nudging brightness/contrast/etc.
        brightness: round(clamp(partial.brightness ?? g.brightness, 0, 4)),
        contrast: round(clamp(partial.contrast ?? g.contrast, 0, 4)),
        saturation: round(clamp(partial.saturation ?? g.saturation, 0, 4)),
        warmth: round(clamp(partial.warmth ?? g.warmth, 0, 1)),
      };
      changed++;
    }
  }
  if (changed === 0) throw new Error("Add a video or photos first — color grading needs a visual clip.");
  return parseEditDoc(clone);
}

// ---- Captions --------------------------------------------------------------

/**
 * Burn-in captions from the transcript, mapped through the current cuts. For
 * each video clip we take the transcript segments that fall inside its source
 * range and place a caption at the corresponding timeline time, so captions stay
 * in sync even after cutting/reordering.
 */
export function addCaptions(doc: EditDoc, transcript: Transcript): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  // Remove any prior captions track so re-running is idempotent.
  clone.tracks = clone.tracks.filter((t) => t.id !== "captions");

  const h = clone.meta.height;
  const w = clone.meta.width;
  // Size to the frame so captions fit in portrait as well as landscape.
  const fontSize = Math.round(Math.min(h * 0.05, w * 0.058));
  const maxChars = Math.max(16, Math.floor((w * 0.92) / (fontSize * 0.52)));
  const captions: unknown[] = [];
  let n = 0;

  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      // Source window the clip actually shows = [sourceIn, sourceIn + duration*speed)
      // (sourceSpanSec). A sped/slowed clip consumes more/less SOURCE than its
      // timeline duration, so we must map transcript SOURCE time back through speed:
      // timeline = clip.start + (segTime - sourceIn) / speed. Ignoring speed (the
      // old `sourceIn + duration`) mismatched the segments and drifted the captions.
      const speed = clip.speed ?? 1;
      const srcStart = clip.sourceIn;
      const srcEnd = clip.sourceIn + sourceSpanSec(clip);
      for (const seg of transcript.segments) {
        const s = Math.max(seg.start, srcStart);
        const e = Math.min(seg.end, srcEnd);
        if (e - s < 0.25) continue;
        const tlStart = clip.start + (s - srcStart) / speed;
        const tlDuration = (e - s) / speed;
        captions.push({
          id: `cap${n++}`,
          kind: "text",
          start: Math.round(tlStart * 1000) / 1000,
          duration: Math.round(tlDuration * 1000) / 1000,
          text: seg.text.length > maxChars ? seg.text.slice(0, maxChars - 1) + "…" : seg.text,
          fontSize,
          color: "#ffffff",
          background: "#0a0d12cc",
          align: "center",
          transform: { x: w / 2, y: h - Math.round(h * 0.12) },
          transitionInSec: 0.12,
        });
      }
    }
  }

  clone.tracks.push({ id: "captions", kind: "visual", clips: captions as never });
  return parseEditDoc(clone);
}

// ---- Auto-mix --------------------------------------------------------------

/** Level audio: normalize speech to full, duck any music track under it. */
export function autoMix(doc: EditDoc): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const hasMusic = clone.tracks.some((t) => t.id === "music");
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "video") clip.volume = 1;
      if (clip.kind === "audio") clip.volume = track.id === "music" ? 0.28 : 1;
    }
  }
  return parseEditDoc(clone);
}

// ---- Quality ---------------------------------------------------------------

export type QualityKey = "standard" | "high" | "ultra";

export function setQuality(doc: EditDoc, preset: QualityKey, aiUpscale = false): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const baseW = clone.meta.width;
  const baseH = clone.meta.height;
  // Anchor the upscale to the LONG edge so orientation doesn't blow up the frame:
  // 4K = 3840 on the long side (landscape 3840×2160, vertical 2160×3840).
  const longEdge = Math.max(baseW, baseH);
  const table: Record<QualityKey, { scale: number; sharpen: number; denoise: number }> = {
    standard: { scale: 1, sharpen: 0, denoise: 0 },
    high: { scale: Math.max(1, Math.round((2560 / longEdge) * 100) / 100), sharpen: 0.3, denoise: 0.2 },
    ultra: { scale: Math.max(1, Math.round((3840 / longEdge) * 100) / 100), sharpen: 0.5, denoise: 0.35 },
  };
  const q = table[preset];
  clone.quality = {
    preset,
    targetWidth: Math.round((baseW * q.scale) / 2) * 2,
    targetHeight: Math.round((baseH * q.scale) / 2) * 2,
    sharpen: q.sharpen,
    denoise: q.denoise,
    aiUpscale,
    faithful: true,
  };
  return parseEditDoc(clone);
}

// ---- Titles ----------------------------------------------------------------

export type TitleStyle = "card" | "lower-third";

/** Add a title card or lower-third at the start, with a fade in/out. */
export function addTitle(doc: EditDoc, text: string, style: TitleStyle = "card"): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const w = clone.meta.width;
  const h = clone.meta.height;
  const id = `title-${Date.now()}`;
  const clip =
    style === "lower-third"
      ? {
          id, kind: "text" as const, start: 0, duration: 3,
          text, fontSize: Math.round(h * 0.045), color: "#ffffff", align: "left" as const,
          background: "#0a0d12cc",
          transform: { x: Math.round(w * 0.06), y: Math.round(h * 0.82) },
          transitionInSec: 0.3, transitionOutSec: 0.3,
        }
      : {
          id, kind: "text" as const, start: 0, duration: 2.8,
          text, fontSize: Math.round(h * 0.09), color: "#ffffff", align: "center" as const,
          transform: { x: w / 2, y: h / 2 },
          transitionInSec: 0.4, transitionOutSec: 0.4,
        };

  let titles = clone.tracks.find((t) => t.id === "titles");
  if (!titles) {
    titles = { id: "titles", kind: "visual", clips: [] };
    clone.tracks.push(titles);
  }
  (titles.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

// ---- Background music ------------------------------------------------------

/**
 * Add a background-music track referencing an audio asset. The music clip spans
 * the whole timeline and starts ducked (low volume) so speech stays on top;
 * auto_mix re-asserts the duck. Music has no visual — it is silent in the canvas
 * preview but honored by the ffmpeg export (amix). Re-running replaces the track.
 */
export function addMusic(
  doc: EditDoc,
  asset: MediaAsset,
  opts: { volume?: number; startSec?: number; durationSec?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  // Ensure the audio asset is present in the doc's media so the export can find it.
  if (!clone.media.some((m) => m.id === asset.id)) clone.media.push(asset);
  clone.tracks = clone.tracks.filter((t) => t.id !== "music");

  const startSec = Math.max(0, opts.startSec ?? 0);
  const docDur = docDurationSec(clone);
  // Default the music clip to the SHORTER of the asset and the timeline (so a song
  // longer than the cut doesn't run past the video, and a short song isn't stretched)
  // — but an explicit `durationSec` always wins so music can be trimmed/offset/looped.
  const fallback = asset.durationSec ? Math.min(asset.durationSec, docDur || asset.durationSec) : docDur || 30;
  const duration = Math.max(0.1, opts.durationSec ?? fallback);
  const clip = {
    id: `music-${Date.now()}`,
    kind: "audio" as const,
    start: startSec,
    duration: round(duration),
    mediaId: asset.id,
    sourceIn: 0,
    volume: opts.volume ?? 0.28,
  };
  clone.tracks.push({ id: "music", kind: "audio", clips: [clip as never] });
  return parseEditDoc(clone);
}

/**
 * Carry the "music" / "voiceover" audio tracks (and the media assets they
 * reference) from `from` onto `doc`. Used when a builder like make_slideshow
 * rebuilds the whole doc from scratch — without this, re-running it silently drops
 * any background music / voice-over the user had attached. Pure + re-parsed
 * through the schema; a no-op when `from` has no audio tracks.
 */
export function carryOverAudio(doc: EditDoc, from: EditDoc): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  for (const trackId of ["music", "voiceover"]) {
    const track = from.tracks.find((t) => t.id === trackId);
    if (!track || track.clips.length === 0) continue;
    // Ensure each referenced audio asset exists in the rebuilt doc's media.
    for (const c of track.clips) {
      if (c.kind !== "audio") continue;
      const asset = from.media.find((m) => m.id === c.mediaId);
      if (asset && !clone.media.some((m) => m.id === asset.id)) clone.media.push(structuredClone(asset));
    }
    clone.tracks = clone.tracks.filter((t) => t.id !== trackId);
    clone.tracks.push(structuredClone(track));
  }
  return parseEditDoc(clone);
}

// ---- B-roll / overlay (picture-in-picture) ---------------------------------

export type BrollCorner = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * Overlay a b-roll image or video clip as a smaller picture-in-picture over the
 * main clip for [atSec, atSec+durationSec]. It lives on the top "broll" visual
 * track (painted last, so it sits over everything) with a fractional scale and a
 * corner-anchored transform. Faithful: it composites an existing clip, unchanged.
 */
export function addBroll(
  doc: EditDoc,
  asset: MediaAsset,
  opts: { atSec?: number; durationSec?: number; corner?: BrollCorner; size?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  if (!clone.media.some((m) => m.id === asset.id)) clone.media.push(asset);

  const W = clone.meta.width;
  const H = clone.meta.height;
  const size = Math.max(0.1, Math.min(1, opts.size ?? 0.35));
  const atSec = Math.max(0, opts.atSec ?? 0);
  const durationSec = Math.max(0.1, opts.durationSec ?? Math.min(4, docDurationSec(clone) || 4));
  const corner: BrollCorner = opts.corner ?? "center";

  // Anchor is the clip CENTER; margin keeps the PiP box inside the frame.
  const margin = 0.04;
  const half = size / 2;
  const cx: Record<BrollCorner, number> = {
    center: 0.5,
    "top-left": half + margin,
    "top-right": 1 - half - margin,
    "bottom-left": half + margin,
    "bottom-right": 1 - half - margin,
  };
  const cy: Record<BrollCorner, number> = {
    center: 0.5,
    "top-left": half + margin,
    "top-right": half + margin,
    "bottom-left": 1 - half - margin,
    "bottom-right": 1 - half - margin,
  };

  const clip: Record<string, unknown> = {
    id: `broll-${Date.now()}`,
    kind: asset.kind === "video" ? "video" : "image",
    start: round(atSec),
    duration: round(durationSec),
    mediaId: asset.id,
    transform: { x: round(cx[corner] * W), y: round(cy[corner] * H), scale: round(size) },
    transitionInSec: 0.25,
    transitionOutSec: 0.25,
  };
  if (asset.kind === "video") clip.sourceIn = 0;

  let broll = clone.tracks.find((t) => t.id === "broll");
  if (!broll) {
    broll = { id: "broll", kind: "visual", clips: [] };
    clone.tracks.push(broll);
  }
  (broll.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

// ---- Kinetic (animated) titles ---------------------------------------------

/** Animated-title styles offered by the kinetic-title tool. */
export type TitleAnimStyle = "kinetic" | "pop" | "bounce";

/**
 * Add an animated title, then hold. The animation is pure data on the text clip
 * (`anim`), resolved deterministically by `textKinetic` in core — so canvas,
 * Stage, and export agree:
 *  - "kinetic" — slides up from below and scales in.
 *  - "pop"     — scales in from small with an overshoot (no slide).
 *  - "bounce"  — drops in from above with a bounce settle.
 */
export function addKineticTitle(
  doc: EditDoc,
  text: string,
  style: TitleAnimStyle = "kinetic",
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const w = clone.meta.width;
  const h = clone.meta.height;
  const anim =
    style === "pop"
      ? { style: "pop" as const, fromX: 0, fromY: 0, fromScale: 0.4, durationSec: 0.5 }
      : style === "bounce"
        ? { style: "bounce" as const, fromX: 0, fromY: -Math.round(h * 0.12), fromScale: 0.85, durationSec: 0.8 }
        : { style: "kinetic" as const, fromX: 0, fromY: Math.round(h * 0.08), fromScale: 0.6, durationSec: 0.6 };
  const clip = {
    id: `ktitle-${Date.now()}`,
    kind: "text" as const,
    start: 0,
    duration: 3,
    text,
    fontSize: Math.round(h * 0.09),
    color: "#ffffff",
    align: "center" as const,
    transform: { x: w / 2, y: h / 2 },
    transitionInSec: 0.25,
    transitionOutSec: 0.4,
    anim,
  };

  let titles = clone.tracks.find((t) => t.id === "titles");
  if (!titles) {
    titles = { id: "titles", kind: "visual", clips: [] };
    clone.tracks.push(titles);
  }
  (titles.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

// ---- VFX overlays ----------------------------------------------------------

/**
 * Merge whole-frame VFX overlays onto the doc (vignette / grain / lightLeak).
 * Omitted fields keep their current value, so nudges accumulate. Pure and
 * re-parsed through the schema. Faithful: a finishing texture pass, no content
 * change. Values are clamped to the schema ranges (0..1; boolean).
 */
export function applyVfx(
  doc: EditDoc,
  partial: { vignette?: number; grain?: number; lightLeak?: boolean },
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const cur = clone.vfx;
  clone.vfx = {
    vignette: round(clamp(partial.vignette ?? cur.vignette, 0, 1)),
    grain: round(clamp(partial.grain ?? cur.grain, 0, 1)),
    lightLeak: partial.lightLeak ?? cur.lightLeak,
  };
  return parseEditDoc(clone);
}

// ---- Caption styling -------------------------------------------------------

export type CaptionPosition = "top" | "center" | "bottom";

export interface CaptionStyleOpts {
  fontFamily?: string;
  fontWeight?: "normal" | "medium" | "semibold" | "bold";
  color?: string;
  background?: string | null;
  outlineColor?: string;
  outlineWidth?: number;
  fontSize?: number;
  position?: CaptionPosition;
}

/**
 * Restyle the existing captions track — font family/weight, fill color, pill
 * background, stroked outline, size, and vertical position. Pure + re-parsed
 * through the schema. Applies to every text clip on the "captions" track; throws
 * a helpful error when there are no captions yet.
 */
export function styleCaptions(doc: EditDoc, opts: CaptionStyleOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const captions = clone.tracks.find((t) => t.id === "captions");
  const clips = captions?.clips.filter((c) => c.kind === "text") ?? [];
  if (clips.length === 0) {
    throw new Error("Add captions first — there's nothing to style yet.");
  }
  const h = clone.meta.height;
  const yFor: Record<CaptionPosition, number> = {
    top: Math.round(h * 0.12),
    center: Math.round(h * 0.5),
    bottom: h - Math.round(h * 0.12),
  };
  for (const clip of clips) {
    if (clip.kind !== "text") continue;
    if (opts.fontFamily !== undefined) clip.fontFamily = opts.fontFamily;
    if (opts.fontWeight !== undefined) clip.fontWeight = opts.fontWeight;
    if (opts.color !== undefined) clip.color = opts.color;
    if (opts.fontSize !== undefined) clip.fontSize = Math.max(1, Math.round(opts.fontSize));
    if (opts.background !== undefined) {
      if (opts.background === null) delete (clip as { background?: string }).background;
      else clip.background = opts.background;
    }
    if (opts.outlineWidth !== undefined || opts.outlineColor !== undefined) {
      clip.outline = {
        color: opts.outlineColor ?? clip.outline?.color ?? "#000000",
        width: opts.outlineWidth ?? clip.outline?.width ?? 0,
      };
    }
    if (opts.position !== undefined) clip.transform.y = yFor[opts.position];
  }
  return parseEditDoc(clone);
}

// ---- Punch-in emphasis -----------------------------------------------------

/**
 * Set a punch-in emphasis (scale pulse) on the video clip active at `atSec`. The
 * emphasis is pure data on the clip (`emphasis`), resolved by `emphasisScale` in
 * core so canvas, Stage, and export scale identically. Faithful: only zooms the
 * existing frame up and back.
 */
export function addEmphasis(
  doc: EditDoc,
  opts: { atSec?: number; durationSec?: number; zoom?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const durationSec = Math.max(0.2, opts.durationSec ?? 2);
  const zoom = Math.max(1, opts.zoom ?? 1.25);
  const atSec = Math.max(0, opts.atSec ?? 0);

  // Find the video clip whose timeline range contains atSec (fallback: first video).
  let target: { start: number; duration: number; emphasis?: unknown } | null = null;
  for (const track of clone.tracks) {
    if (track.id === "broll") continue; // don't punch-in the PiP itself
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      if (atSec >= clip.start && atSec < clip.start + clip.duration) {
        target = clip;
        break;
      }
      if (!target) target = clip; // remember the first as a fallback
    }
    if (target && atSec >= target.start && atSec < target.start + target.duration) break;
  }
  if (!target) throw new Error("Add a video first — punch-in needs footage.");

  // Clamp the window to the clip so the pulse fully lands inside it.
  const winStart = Math.max(atSec, target.start);
  const winEnd = Math.min(winStart + durationSec, target.start + target.duration);
  target.emphasis = { atSec: round(winStart), durationSec: round(Math.max(0.2, winEnd - winStart)), zoom: round(zoom) };
  return parseEditDoc(clone);
}

// ---- Speed ramp ------------------------------------------------------------

export type SpeedTarget = "slow" | "fast" | "normal";

const SPEED_TARGETS: Record<SpeedTarget, number> = { slow: 0.5, fast: 2, normal: 1 };

/** Resolve a raw speed number and/or a named target into a clamped multiplier. */
export function resolveSpeed(opts: { speed?: number; target?: SpeedTarget }): number {
  const raw = opts.speed ?? (opts.target ? SPEED_TARGETS[opts.target] : 1);
  return round(clamp(raw, 0.25, 4));
}

/**
 * Set the playback speed of the main video clip(s). <1 is slow-motion, >1 is
 * fast. The clip keeps its TIMELINE duration; only how much source it consumes
 * changes (see sourceTimeAt in core). If `atSec` is given, only the clip active
 * there is retimed; otherwise every main video clip is. Faithful: retime only.
 */
export function setSpeed(
  doc: EditDoc,
  opts: { speed?: number; target?: SpeedTarget; atSec?: number } = {},
): EditDoc {
  const speed = resolveSpeed(opts);
  const clone: EditDoc = structuredClone(doc);
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      if (opts.atSec !== undefined && !(opts.atSec >= clip.start && opts.atSec < clip.start + clip.duration)) {
        continue;
      }
      // Source-length guard: a fast clip reads `duration * speed` seconds of SOURCE
      // from `sourceIn` (see sourceSpanSec/export -ss/-t). If the media doesn't have
      // that much left, ffmpeg would truncate the segment shorter than its timeline
      // slot and the concat would desync. Clamp the per-clip speed so the read stays
      // inside the source. Only >1 (fast) can overrun; slow-mo reads less, never past
      // EOF. When the asset duration is unknown we can't guard, so we leave it.
      let effSpeed = speed;
      const asset = clone.media.find((m) => m.id === clip.mediaId);
      if (effSpeed > 1 && asset?.durationSec && asset.durationSec > clip.sourceIn) {
        const maxSpeed = round((asset.durationSec - clip.sourceIn) / clip.duration);
        if (maxSpeed >= 0.25 && maxSpeed < effSpeed) effSpeed = maxSpeed;
      }
      clip.speed = round(clamp(effSpeed, 0.25, 4));
      changed++;
    }
  }
  if (changed === 0) throw new Error("Add a video first — speed changes need footage.");
  return parseEditDoc(clone);
}

// ---- Zoom / crop (manual static reframe) -----------------------------------

/**
 * Statically zoom / reframe the main visual clip(s): set transform.scale (punch
 * in) and an optional pan (fraction of the frame from center). Distinct from the
 * animated punch-in emphasis — this is a fixed reframe honored by canvas
 * (transform.scale) and the ffmpeg plan (scale+crop). Faithful: crop/scale only.
 */
export function setZoom(
  doc: EditDoc,
  opts: { scale?: number; panXFrac?: number; panYFrac?: number; atSec?: number } = {},
): EditDoc {
  const scale = round(clamp(opts.scale ?? 1.3, 1, 4));
  const panXFrac = clamp(opts.panXFrac ?? 0, -0.5, 0.5);
  const panYFrac = clamp(opts.panYFrac ?? 0, -0.5, 0.5);
  const clone: EditDoc = structuredClone(doc);
  const W = clone.meta.width;
  const H = clone.meta.height;
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video" && clip.kind !== "image") continue;
      if (opts.atSec !== undefined && !(opts.atSec >= clip.start && opts.atSec < clip.start + clip.duration)) {
        continue;
      }
      clip.transform.scale = scale;
      clip.transform.x = round(W / 2 + panXFrac * W);
      clip.transform.y = round(H / 2 + panYFrac * H);
      changed++;
    }
  }
  if (changed === 0) throw new Error("Add a video or photos first — zoom needs a visual clip.");
  return parseEditDoc(clone);
}

// ---- Transition library ----------------------------------------------------

/**
 * Set the transition style of the main visual clips (slideshow photos / cut
 * clips): "crossfade" | "dip-to-black" | "slide" | "wipe" | … Non-first clips get
 * a default transition duration if they were hard cuts, and — crucially — the
 * track is RE-LAID so each clip OVERLAPS the previous one by its transition
 * duration. That overlap is what makes a real A→B dissolve: during it BOTH clips
 * are active (activeClipsAt returns both, and the canvas cross-dissolves the
 * incoming clip up over the outgoing one), and the ffmpeg export chains `xfade`
 * across the same overlap — so preview and export agree instead of hard-cutting
 * (or, worse, fading up from the black background with no outgoing clip beneath).
 * Slideshow photos are already laid with this overlap, so re-laying them is
 * idempotent. Faithful: reveal style + timing only, never content.
 */
export function setTransition(doc: EditDoc, type: TransitionType, transitionSec = 0.6): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    const visual = track.clips.filter((c) => c.kind === "video" || c.kind === "image");
    let prev: (typeof visual)[number] | null = null;
    visual.forEach((clip, i) => {
      if (clip.kind !== "video" && clip.kind !== "image") return;
      clip.transitionType = type;
      // First clip has no incoming transition; give the rest one if hard-cut.
      if (i > 0 && clip.transitionInSec <= 0) clip.transitionInSec = transitionSec;
      if (prev && clip.transitionInSec > 0) {
        // Clamp the overlap so it can't exceed either clip (keeps xfade offset >= 0).
        const xf = Math.min(clip.transitionInSec, prev.duration - 0.05, clip.duration - 0.05);
        if (xf > 0 && Math.abs(xf - clip.transitionInSec) > 1e-6) clip.transitionInSec = round(xf);
        // Overlap the incoming clip onto the previous one by the transition duration.
        clip.start = round(prev.start + prev.duration - clip.transitionInSec);
      } else if (prev) {
        // Hard cut: lay back-to-back (unchanged behavior).
        clip.start = round(prev.start + prev.duration);
      }
      prev = clip;
      changed++;
    });
  }
  if (changed === 0) throw new Error("Add a slideshow or video first — transitions need clips.");
  return parseEditDoc(clone);
}

// ---- Fades -----------------------------------------------------------------

// ---- Interaction demo: cursor / typed text / callout -----------------------

/** How fast typewriter text types, in seconds per character (a sensible default). */
const TYPE_SEC_PER_CHAR = 0.075;

export interface CursorWaypointInput {
  x: number;
  y: number;
  atSec: number;
}

export interface AddCursorOpts {
  waypoints: CursorWaypointInput[];
  clicks?: number[];
  size?: number;
  color?: string;
  start?: number;
  duration?: number;
}

/**
 * Add an animated mouse-pointer overlay (a CursorClip) on the "cursor" track. The
 * pointer eases through `waypoints` (composition px, each with a timeline `atSec`)
 * and fires a click ripple at each time in `clicks`. Pure + re-parsed through the
 * schema. Faithful: a synthetic overlay, no content change. Positions are the
 * caller's to choose — exact field pixels can't be detected from a raw screenshot
 * without vision, so demos seed sensible defaults the user can nudge.
 */
export function addCursor(doc: EditDoc, opts: AddCursorOpts): EditDoc {
  if (!opts.waypoints || opts.waypoints.length === 0) {
    throw new Error("A cursor needs at least one waypoint.");
  }
  const clone: EditDoc = structuredClone(doc);
  const wps = [...opts.waypoints].sort((a, b) => a.atSec - b.atSec);
  const clicks = (opts.clicks ?? []).map((c) => round(Math.max(0, c)));
  const firstAt = wps[0]!.atSec;
  const lastAt = wps[wps.length - 1]!.atSec;
  const start = round(Math.max(0, opts.start ?? Math.min(firstAt, clicks[0] ?? firstAt)));
  const tail = 0.6; // let the last click ripple finish
  const naturalEnd = Math.max(lastAt, clicks.length ? Math.max(...clicks) : lastAt) + tail;
  const duration = round(Math.max(0.2, opts.duration ?? naturalEnd - start));

  const clip: Record<string, unknown> = {
    id: `cursor-${Date.now()}`,
    kind: "cursor",
    start,
    duration,
    waypoints: wps.map((w) => ({ x: round(w.x), y: round(w.y), atSec: round(w.atSec) })),
    clicks,
    size: opts.size ?? 48,
    ...(opts.color ? { color: opts.color } : {}),
  };
  let track = clone.tracks.find((t) => t.id === "cursor");
  if (!track) {
    track = { id: "cursor", kind: "visual", clips: [] };
    clone.tracks.push(track);
  }
  (track.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

export interface TypeTextOpts {
  text: string;
  x: number;
  y: number;
  atSec?: number;
  /** Seconds to type the whole string (defaults to a per-character rate). */
  typeSec?: number;
  /** Seconds to hold the fully-typed string after it finishes. */
  holdSec?: number;
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  background?: string;
  caret?: boolean;
}

/**
 * Add a typewriter TextClip on the "demo-text" track: `text` types out at (x, y)
 * over `typeSec`, then holds for `holdSec`. Uses the schema's "typewriter" anim
 * style (resolved by core's `typewriterText`), so canvas, Stage, and export
 * reveal it identically. Pure + re-parsed through the schema.
 */
export function typeText(doc: EditDoc, opts: TypeTextOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const h = clone.meta.height;
  const start = round(Math.max(0, opts.atSec ?? 0));
  const typeSec = round(Math.max(0.2, opts.typeSec ?? Math.max(0.4, opts.text.length * TYPE_SEC_PER_CHAR)));
  const holdSec = round(Math.max(0, opts.holdSec ?? 1.6));
  const clip = {
    id: `type-${Date.now()}-${Math.round(opts.y)}`,
    kind: "text" as const,
    start,
    duration: round(typeSec + holdSec),
    text: opts.text,
    fontSize: opts.fontSize ?? Math.round(h * 0.032),
    color: opts.color ?? "#ffffff",
    align: opts.align ?? "left",
    transform: { x: round(opts.x), y: round(opts.y) },
    ...(opts.background ? { background: opts.background } : {}),
    anim: { style: "typewriter" as const, durationSec: typeSec, caret: opts.caret ?? true },
  };
  let track = clone.tracks.find((t) => t.id === "demo-text");
  if (!track) {
    track = { id: "demo-text", kind: "visual", clips: [] };
    clone.tracks.push(track);
  }
  (track.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

export interface AddCalloutOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  zoom?: number;
  dim?: boolean;
  color?: string;
  atSec?: number;
  durationSec?: number;
}

/**
 * Add a callout / highlight box (a CalloutClip) on the "callouts" track: a bright
 * rounded border around {x,y,w,h}, the area outside optionally dimmed, an optional
 * label, and an optional zoom toward the rect. Pure + re-parsed through the schema.
 * Faithful: an overlay + optional magnify, no content change.
 */
export function addCallout(doc: EditDoc, opts: AddCalloutOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const start = round(Math.max(0, opts.atSec ?? 0));
  const duration = round(Math.max(0.2, opts.durationSec ?? Math.min(3, docDurationSec(clone) || 3)));
  const clip: Record<string, unknown> = {
    id: `callout-${Date.now()}`,
    kind: "callout",
    start,
    duration,
    x: round(opts.x),
    y: round(opts.y),
    w: round(Math.max(1, opts.w)),
    h: round(Math.max(1, opts.h)),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.color ? { color: opts.color } : {}),
    ...(opts.dim !== undefined ? { dim: opts.dim } : {}),
    ...(opts.zoom !== undefined ? { zoom: clamp(opts.zoom, 1, 4) } : {}),
  };
  let track = clone.tracks.find((t) => t.id === "callouts");
  if (!track) {
    track = { id: "callouts", kind: "visual", clips: [] };
    clone.tracks.push(track);
  }
  (track.clips as unknown[]).push(clip);
  return parseEditDoc(clone);
}

// ---- Keyframe animation ----------------------------------------------------

/** Any clip carrying a `keyframes` array (mutable during a structuredClone edit). */
type AnimatableClip = {
  kind: string;
  start: number;
  duration: number;
  volume?: number;
  transform?: { x: number; y: number; scale: number; rotation: number; opacity: number };
  keyframes?: { prop: KeyframeProp; t: number; value: number; easing: KeyframeEasing }[];
};

/** Whether a clip kind can carry a keyframe for `prop`. */
function clipSupportsProp(clip: AnimatableClip, prop: KeyframeProp): boolean {
  if (prop === "volume") return clip.kind === "video" || clip.kind === "audio";
  return clip.kind === "video" || clip.kind === "image" || clip.kind === "text" || clip.kind === "solid";
}

/** The clip's current static value for `prop` (the keyframe `from` fallback). */
function baseValueFor(clip: AnimatableClip, prop: KeyframeProp): number {
  if (prop === "volume") return typeof clip.volume === "number" ? clip.volume : 1;
  const t = clip.transform;
  const dflt = prop === "scale" || prop === "opacity" ? 1 : 0;
  return t ? (t[prop] ?? dflt) : dflt;
}

export interface AnimTargetOpts {
  prop: KeyframeProp;
  atSec?: number;
  /** Restrict to a track id (e.g. "titles"); otherwise pick a sensible default. */
  track?: string;
}

/**
 * Pick the clip to animate (a reference INSIDE `clone`, safe to mutate). Prefers a
 * clip active at `atSec`, then any clip supporting the prop. For volume it prefers
 * audio tracks; for visual props it prefers the MAIN visual track; a `track`
 * filter overrides both. Returns null when nothing suitable exists.
 */
function findAnimTarget(clone: EditDoc, opts: AnimTargetOpts): AnimatableClip | null {
  const activeAt = (clip: AnimatableClip): boolean =>
    opts.atSec === undefined || (opts.atSec >= clip.start && opts.atSec < clip.start + clip.duration);
  const tracks = opts.track ? clone.tracks.filter((t) => t.id === opts.track) : clone.tracks;
  const rank = (trackId: string, kind: string): number => {
    if (opts.track) return 0;
    if (opts.prop === "volume") return kind === "audio" ? 0 : 1;
    return isMainVisualTrack(trackId) ? 0 : 1;
  };
  const ordered = [...tracks].sort((a, b) => rank(a.id, a.kind) - rank(b.id, b.kind));
  for (const wantActive of [true, false]) {
    for (const track of ordered) {
      for (const clip of track.clips as unknown as AnimatableClip[]) {
        if (!clipSupportsProp(clip, opts.prop)) continue;
        if (wantActive && !activeAt(clip)) continue;
        return clip;
      }
    }
  }
  return null;
}

export interface AnimateOpts {
  prop: KeyframeProp;
  to: number;
  /** Start value; defaults to the clip's current static value for the prop. */
  from?: number;
  easing?: KeyframeEasing;
  atSec?: number;
  track?: string;
}

/**
 * Animate a property from `from` (default: its current value) to `to` over the
 * whole target clip — two keyframes at t=0 and t=1, resolved by core's PURE
 * `valueAt`. Replaces any existing keyframes for that prop on the clip. Faithful:
 * moves/scales/rotates/fades or re-levels the existing clip only.
 */
export function animate(doc: EditDoc, opts: AnimateOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const clip = findAnimTarget(clone, { prop: opts.prop, atSec: opts.atSec, track: opts.track });
  if (!clip) {
    throw new Error(
      `Nothing to animate — add ${opts.prop === "volume" ? "audio" : "a clip"} first${opts.track ? ` on the ${opts.track} track` : ""}.`,
    );
  }
  const from = opts.from ?? baseValueFor(clip, opts.prop);
  const easing = opts.easing ?? "ease-in-out";
  const others = (clip.keyframes ?? []).filter((k) => k.prop !== opts.prop);
  clip.keyframes = [
    ...others,
    { prop: opts.prop, t: 0, value: round(from), easing: "linear" },
    { prop: opts.prop, t: 1, value: round(opts.to), easing },
  ];
  return parseEditDoc(clone);
}

export interface AddKeyframeOpts {
  prop: KeyframeProp;
  /** Clip-progress 0..1. */
  t: number;
  value: number;
  easing?: KeyframeEasing;
  atSec?: number;
  track?: string;
}

/** Add a single keyframe to the target clip (merged with any existing ones). */
export function addKeyframe(doc: EditDoc, opts: AddKeyframeOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const clip = findAnimTarget(clone, { prop: opts.prop, atSec: opts.atSec, track: opts.track });
  if (!clip) throw new Error(`Nothing to keyframe — add ${opts.prop === "volume" ? "audio" : "a clip"} first.`);
  const kf = {
    prop: opts.prop,
    t: clamp(opts.t, 0, 1),
    value: round(opts.value),
    easing: opts.easing ?? ("linear" as KeyframeEasing),
  };
  clip.keyframes = [...(clip.keyframes ?? []), kf].sort((a, b) => a.t - b.t);
  return parseEditDoc(clone);
}

// ---- Reverse / freeze-frame ------------------------------------------------

/**
 * Play the main video clip(s) backwards. If `atSec` is given, only the clip active
 * there is reversed; otherwise every main video clip is. The source-time mapping
 * reverses in core's `sourceTimeAt`; the ffmpeg export adds reverse/areverse.
 */
export function reverseClip(doc: EditDoc, opts: { atSec?: number } = {}): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      if (opts.atSec !== undefined && !(opts.atSec >= clip.start && opts.atSec < clip.start + clip.duration)) continue;
      clip.reversed = true;
      changed++;
    }
  }
  if (changed === 0) throw new Error("Add a video first — reverse needs footage.");
  return parseEditDoc(clone);
}

/**
 * Freeze-frame: hold the SOURCE frame shown at `atSec` (or the clip's head) for the
 * whole clip. Sets `freezeAtSec` on the video clip active at `atSec` (else the
 * first video clip). Held in preview via `sourceTimeAt`; exported via tpad clone.
 */
export function freezeFrame(doc: EditDoc, opts: { atSec?: number } = {}): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let target: import("@cadence/core").VideoClip | null = null;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      if (opts.atSec !== undefined && opts.atSec >= clip.start && opts.atSec < clip.start + clip.duration) {
        target = clip;
        break;
      }
      if (!target) target = clip;
    }
    if (target && opts.atSec !== undefined && opts.atSec >= target.start && opts.atSec < target.start + target.duration) break;
  }
  if (!target) throw new Error("Add a video first — freeze-frame needs footage.");
  const at = opts.atSec !== undefined ? opts.atSec : target.start;
  target.freezeAtSec = round(sourceTimeAt(target, at));
  return parseEditDoc(clone);
}

// ---- Markers ---------------------------------------------------------------

/** Add a timeline marker (chapter point / beat / note) at `t` seconds. */
export function addMarker(doc: EditDoc, t: number, label?: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const marker = label ? { t: round(Math.max(0, t)), label } : { t: round(Math.max(0, t)) };
  clone.markers = [...(clone.markers ?? []), marker].sort((a, b) => a.t - b.t);
  return parseEditDoc(clone);
}

// ---- Platform delivery presets ---------------------------------------------

export type PlatformKey =
  | "youtube" | "youtube-shorts" | "tiktok" | "reels" | "instagram-feed" | "instagram-story";

/**
 * Delivery presets → aspect + quality + fps. Reuses `reframe` (aspect) and
 * `setQuality` (upscale/sharpen) so a platform export is just those two, one fps.
 */
export const PLATFORM_PRESETS: Record<
  PlatformKey,
  { aspect: AspectKey; quality: QualityKey; fps: number; label: string }
> = {
  youtube: { aspect: "16:9", quality: "high", fps: 30, label: "YouTube (16:9)" },
  "youtube-shorts": { aspect: "9:16", quality: "high", fps: 30, label: "YouTube Shorts (9:16)" },
  tiktok: { aspect: "9:16", quality: "high", fps: 30, label: "TikTok (9:16)" },
  reels: { aspect: "9:16", quality: "high", fps: 30, label: "Instagram Reels (9:16)" },
  "instagram-feed": { aspect: "4:5", quality: "high", fps: 30, label: "Instagram Feed (4:5)" },
  "instagram-story": { aspect: "9:16", quality: "high", fps: 30, label: "Instagram Story (9:16)" },
};

export const PLATFORM_KEYS = Object.keys(PLATFORM_PRESETS) as PlatformKey[];

/**
 * Configure the doc for a delivery platform: reframe to the platform aspect, set
 * the quality preset, and set the output fps (meta + quality). Reuses reframe +
 * setQuality so preview and export agree. Pure + re-parsed through the schema.
 */
export function setPlatform(doc: EditDoc, platform: PlatformKey): EditDoc {
  const preset = PLATFORM_PRESETS[platform];
  const reframed = reframe(doc, preset.aspect);
  const graded = setQuality(reframed, preset.quality);
  const clone: EditDoc = structuredClone(graded);
  clone.meta.fps = preset.fps;
  clone.quality.fps = preset.fps;
  return parseEditDoc(clone);
}

// ---- VFX compositing: chroma key / blend mode / mask -----------------------

/**
 * The clips a compositing effect (chroma / blend / mask) should target: the
 * OVERLAY (b-roll) media clips when present (they composite over the base — the
 * canonical green-screen / shaped-reveal / blend-layer case), otherwise the MAIN
 * visual media clips (canvas previews them; the export honors the effect on the
 * overlay path). Returns mutable references INSIDE `clone`.
 */
function compositeTargets(clone: EditDoc): (VideoClip | ImageClip)[] {
  const broll = clone.tracks.find((t) => t.id === "broll");
  const brollMedia = (broll?.clips ?? []).filter(
    (c): c is VideoClip | ImageClip => c.kind === "video" || c.kind === "image",
  );
  if (brollMedia.length > 0) return brollMedia;
  const out: (VideoClip | ImageClip)[] = [];
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") out.push(clip);
    }
  }
  return out;
}

/**
 * Chroma key (green/blue screen) on the compositing clip(s): the key `color` is
 * made transparent so the layer beneath shows through. Pure + re-parsed. Best on an
 * OVERLAY (b-roll) clip; on export the keyed clip composites through the overlay
 * path (ffmpeg chromakey + optional despill). Faithful: removes a background color.
 */
export function chromaKey(
  doc: EditDoc,
  opts: { color?: string; similarity?: number; blend?: number; spill?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const targets = compositeTargets(clone);
  if (targets.length === 0) throw new Error("Add a clip to key first — green screen needs a visual clip (ideally an overlay).");
  const chroma: ChromaKey = {
    color: opts.color ?? "#00d000",
    similarity: clamp(opts.similarity ?? 0.3, 0.01, 1),
    blend: clamp(opts.blend ?? 0.1, 0, 1),
    spill: clamp(opts.spill ?? 0, 0, 1),
  };
  for (const clip of targets) clip.chroma = chroma;
  return parseEditDoc(clone);
}

/** Set the blend mode on the compositing clip(s) (how they blend over the base). */
export function setBlend(doc: EditDoc, mode: BlendMode): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const targets = compositeTargets(clone);
  if (targets.length === 0) throw new Error("Add a clip first — a blend mode needs a visual clip (ideally an overlay).");
  for (const clip of targets) clip.blendMode = mode;
  return parseEditDoc(clone);
}

/**
 * Add a shape mask (rect/ellipse, optional feather + invert) to the compositing
 * clip(s): reveal only inside the shape (or outside when inverted). Pure +
 * re-parsed. Canvas clips to the shape; export builds a geq alpha over the overlay.
 */
export function addMask(
  doc: EditDoc,
  opts: { shape?: "rect" | "ellipse"; x: number; y: number; w: number; h: number; feather?: number; invert?: boolean },
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const targets = compositeTargets(clone);
  if (targets.length === 0) throw new Error("Add a clip first — a mask needs a visual clip (ideally an overlay).");
  const mask: Mask = {
    shape: opts.shape ?? "rect",
    x: round(opts.x),
    y: round(opts.y),
    w: round(Math.max(1, opts.w)),
    h: round(Math.max(1, opts.h)),
    feather: Math.max(0, opts.feather ?? 0),
    invert: opts.invert ?? false,
  };
  for (const clip of targets) clip.mask = mask;
  return parseEditDoc(clone);
}

// ---- Region blur / pixelate (hide a face/plate/logo) -----------------------

/**
 * Blur or pixelate a rectangular REGION of the main video clip(s) — hide a face,
 * plate, or logo. Coordinates are composition px. Applies to the main visual clip
 * active at `atSec` (or all main visual clips). Pure + re-parsed. Export crops the
 * region, runs boxblur/pixelize, and overlays it back; canvas approximates.
 */
export function regionBlur(
  doc: EditDoc,
  opts: { type?: "blur" | "pixelate"; x: number; y: number; w: number; h: number; amount?: number; atSec?: number },
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video" && clip.kind !== "image") continue;
      if (opts.atSec !== undefined && !(opts.atSec >= clip.start && opts.atSec < clip.start + clip.duration)) continue;
      clip.regionFx = {
        type: opts.type ?? "blur",
        x: round(opts.x),
        y: round(opts.y),
        w: round(Math.max(1, opts.w)),
        h: round(Math.max(1, opts.h)),
        amount: clamp(opts.amount ?? 0.5, 0, 1),
      };
      changed++;
    }
  }
  if (changed === 0) throw new Error("Add a video or photos first — blur/pixelate needs a visual clip.");
  return parseEditDoc(clone);
}

// ---- Color: curves + HSL ---------------------------------------------------

/**
 * Set RGB tone curves on the main visual clip(s). Each channel is a list of
 * control points [x, y] in 0..1. Merges with the clip's current look (other grade
 * fields untouched). Pure + re-parsed. Export uses the ffmpeg `curves` filter.
 */
export function adjustCurves(
  doc: EditDoc,
  curves: { master?: CurvePoint[]; r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] },
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const norm = (pts?: CurvePoint[]): CurvePoint[] | undefined =>
    pts && pts.length ? pts.map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)] as CurvePoint) : undefined;
  const c: Curves = {
    master: norm(curves.master),
    r: norm(curves.r),
    g: norm(curves.g),
    b: norm(curves.b),
  };
  const hasAny = c.master || c.r || c.g || c.b;
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video" && clip.kind !== "image") continue;
      clip.look = { ...clip.look, curves: hasAny ? c : undefined };
      changed++;
    }
  }
  if (changed === 0) throw new Error("Add a video or photos first — curves need a visual clip.");
  return parseEditDoc(clone);
}

/**
 * Simple HSL grade on the main visual clip(s): `hueShift` (degrees) rotates hue and
 * `saturation` (multiplier, 1 = neutral) scales it. Merges with the current look.
 * Pure + re-parsed. Export uses ffmpeg `hue` (hueShift) + eq saturation. NOTE:
 * per-hue-range (secondary) saturation is deferred — this is a GLOBAL HSL nudge.
 */
export function adjustHsl(
  doc: EditDoc,
  opts: { hueShift?: number; saturation?: number },
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video" && clip.kind !== "image") continue;
      clip.look = {
        ...clip.look,
        hueShift: opts.hueShift !== undefined ? round(((opts.hueShift % 360) + 360) % 360) : clip.look.hueShift,
        saturation: opts.saturation !== undefined ? round(clamp(opts.saturation, 0, 4)) : clip.look.saturation,
      };
      changed++;
    }
  }
  if (changed === 0) throw new Error("Add a video or photos first — HSL needs a visual clip.");
  return parseEditDoc(clone);
}

// ---- Audio depth: fades / pan / loudness -----------------------------------

/**
 * Set an audio fade-in / fade-out on audio clips (music/VO) and, when there are
 * none, on the main video clips. Seconds; 0 clears. Pure + re-parsed. Export uses
 * ffmpeg `afade`. Faithful: levels only.
 */
export function audioFade(
  doc: EditDoc,
  opts: { fadeInSec?: number; fadeOutSec?: number; track?: string } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const setFade = (clip: { fadeInSec: number; fadeOutSec: number }): void => {
    if (opts.fadeInSec !== undefined) clip.fadeInSec = Math.max(0, round(opts.fadeInSec));
    if (opts.fadeOutSec !== undefined) clip.fadeOutSec = Math.max(0, round(opts.fadeOutSec));
  };
  let changed = 0;
  // Prefer audio clips (music / VO); if a specific track is named, only that one.
  const audioTracks = clone.tracks.filter(
    (t) => t.kind === "audio" && (!opts.track || t.id === opts.track),
  );
  for (const track of audioTracks) {
    for (const clip of track.clips) {
      if (clip.kind === "audio") {
        setFade(clip);
        changed++;
      }
    }
  }
  if (changed === 0) {
    // No audio clips → fade the main video clips' audio instead.
    for (const track of clone.tracks) {
      if (!isMainVisualTrack(track.id)) continue;
      for (const clip of track.clips) {
        if (clip.kind === "video") {
          setFade(clip);
          changed++;
        }
      }
    }
  }
  if (changed === 0) throw new Error("Add audio or a video first — a fade needs an audio or video clip.");
  return parseEditDoc(clone);
}

/**
 * Set the stereo pan (-1 left … 0 center … 1 right) on audio clips (music/VO), or
 * the main video clips when there are none. Pure + re-parsed. Export uses ffmpeg
 * `pan`. Faithful: repositions in the stereo field only.
 */
export function setPan(doc: EditDoc, pan: number, opts: { track?: string } = {}): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const p = round(clamp(pan, -1, 1));
  let changed = 0;
  const audioTracks = clone.tracks.filter(
    (t) => t.kind === "audio" && (!opts.track || t.id === opts.track),
  );
  for (const track of audioTracks) {
    for (const clip of track.clips) {
      if (clip.kind === "audio") {
        clip.pan = p;
        changed++;
      }
    }
  }
  if (changed === 0) {
    for (const track of clone.tracks) {
      if (!isMainVisualTrack(track.id)) continue;
      for (const clip of track.clips) {
        if (clip.kind === "video") {
          clip.pan = p;
          changed++;
        }
      }
    }
  }
  if (changed === 0) throw new Error("Add audio or a video first — panning needs an audio or video clip.");
  return parseEditDoc(clone);
}

/** Toggle EBU R128 loudness normalization of the final mix (ffmpeg loudnorm). */
export function normalizeLoudness(doc: EditDoc, on = true): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  clone.loudnorm = on;
  return parseEditDoc(clone);
}

/** Add a fade from black at the start and a fade to black at the end. */
export function addFades(doc: EditDoc, inSec = 0.6, outSec = 0.6): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const total = docDurationSec(clone);
  if (total <= 0) return clone;
  const clips: unknown[] = [
    { id: "fade-in", kind: "solid", start: 0, duration: Math.min(inSec, total), color: "#000000", transitionOutSec: Math.min(inSec, total) },
  ];
  if (total > outSec) {
    clips.push({ id: "fade-out", kind: "solid", start: total - outSec, duration: outSec, color: "#000000", transitionInSec: outSec });
  }
  clone.tracks = clone.tracks.filter((t) => t.id !== "fades");
  clone.tracks.push({ id: "fades", kind: "visual", clips: clips as never });
  return parseEditDoc(clone);
}
