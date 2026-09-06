/**
 * Pure edit-doc transforms — the editorial operations, expressed as
 * doc-in / doc-out functions. Each is deterministic and re-parsed through the
 * schema so the result is always valid. Tools (tools.ts) wrap these; the real
 * Claude Director will call the same operations.
 */
import {
  captionAnchorY,
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
  type Keyframe,
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
export const OVERLAY_TRACK_IDS = new Set([
  "titles",
  "captions",
  "broll",
  "fades",
  "music",
  "cursor",
  "callouts",
  "demo-text",
  "adjustments",
]);
/**
 * A "main" (magnetic) visual track carries the primary footage/photos and
 * gap-closes when clips move — as opposed to overlay lanes (titles, captions,
 * b-roll, fades, music, cursor, callouts). Reused by the track ops so a clip
 * dropped onto a magnetic track re-flows, while a drop onto an overlay lane keeps
 * its free position.
 */
export const isMainVisualTrack = (id: string): boolean => !OVERLAY_TRACK_IDS.has(id);

/**
 * Build a fresh track object for the mutable structuredClone before it is
 * re-parsed. Includes the additive metadata defaults (hidden/locked/muted/solo)
 * so the intermediate object satisfies the Track type; `clips` is passed through
 * (re-validated by parseEditDoc at the end of each op).
 */
function mkTrack(id: string, kind: EditDoc["tracks"][number]["kind"], clips: unknown[] = []): EditDoc["tracks"][number] {
  return { id, kind, clips: clips as never, hidden: false, locked: false, muted: false, solo: false };
}

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

  clone.tracks.push(mkTrack("captions", "visual", captions));
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
    titles = mkTrack("titles", "visual");
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
  clone.tracks.push(mkTrack("music", "audio", [clip]));
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
    broll = mkTrack("broll", "visual");
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
    titles = mkTrack("titles", "visual");
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

/** Vertical anchor for a caption. "free" leaves the clip's transform.y as-is. */
export type CaptionPosition = "top" | "center" | "bottom" | "free";

/** A drop-shadow spec for caption/title text (null clears any existing shadow). */
export interface CaptionShadowOpts {
  color?: string;
  blur?: number;
  offsetX?: number;
  offsetY?: number;
}

/** A background-panel spec (null on `box` clears it back to no panel / legacy pill). */
export interface CaptionBoxOpts {
  style?: "none" | "pill" | "box";
  color?: string;
  opacity?: number;
  radius?: number;
  padX?: number;
  padY?: number;
}

export interface CaptionStyleOpts {
  fontFamily?: string;
  fontWeight?: "normal" | "medium" | "semibold" | "bold";
  color?: string;
  /** Legacy pill color; null removes it (see also `box` for full control). */
  background?: string | null;
  outlineColor?: string;
  outlineWidth?: number;
  fontSize?: number;
  /** Vertical position preset; combined with `offset` (px) via captionAnchorY. */
  position?: CaptionPosition;
  /** Vertical offset (composition px) applied on top of `position`. */
  offset?: number;
  /** Horizontal text alignment. */
  align?: "left" | "center" | "right";
  italic?: boolean;
  uppercase?: boolean;
  letterSpacing?: number;
  lineHeight?: number;
  /** Word-wrap width (composition px); null clears wrapping (single line). */
  maxWidth?: number | null;
  /** Drop shadow; null clears it. */
  shadow?: CaptionShadowOpts | null;
  /** Background panel (none/pill/box); null clears it. */
  box?: CaptionBoxOpts | null;
  /** Restyle ONLY this caption clip (by id); otherwise every caption clip. */
  clipId?: string;
}

/** The mutable text-clip shape used while restyling inside a structuredClone. */
type MutableTextClip = {
  kind: string;
  id: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
  italic: boolean;
  uppercase: boolean;
  letterSpacing: number;
  lineHeight: number;
  maxWidth?: number;
  position?: CaptionPosition;
  positionOffset: number;
  background?: string;
  outline?: { color: string; width: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
  box?: { style: string; color?: string; opacity: number; radius?: number; padX?: number; padY?: number };
  transform: { x: number; y: number; scale: number; rotation: number; opacity: number };
};

/**
 * The caption text clips to restyle: every text clip on the "captions" track, or —
 * when `clipId` is given — just that one clip (searched on the captions track
 * first, then anywhere so a title/demo text clip can be targeted too). Returns
 * mutable references INSIDE `clone`.
 */
function captionStyleTargets(clone: EditDoc, clipId?: string): MutableTextClip[] {
  if (clipId) {
    for (const track of clone.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === "text" && clip.id === clipId) return [clip as unknown as MutableTextClip];
      }
    }
    return [];
  }
  const captions = clone.tracks.find((t) => t.id === "captions");
  return (captions?.clips.filter((c) => c.kind === "text") ?? []) as unknown as MutableTextClip[];
}

/**
 * Restyle caption text clips — font family/size/weight, italic, fill color,
 * alignment, letter spacing, uppercase, line height, wrap width, stroked outline,
 * drop shadow, background panel (none/pill/box + color/opacity/radius/padding), and
 * vertical position (preset + offset). Applies to every text clip on the
 * "captions" track, or ONE clip when `opts.clipId` is set. Every field is optional
 * and merges with the clip's current style, so the default caption look is
 * unchanged when nothing new is passed. Pure + re-parsed through the schema; throws
 * a helpful error when there are no captions yet.
 */
export function styleCaptions(doc: EditDoc, opts: CaptionStyleOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const clips = captionStyleTargets(clone, opts.clipId);
  if (clips.length === 0) {
    throw new Error(
      opts.clipId
        ? `No caption/text clip "${opts.clipId}" to style.`
        : "Add captions first — there's nothing to style yet.",
    );
  }
  const h = clone.meta.height;
  for (const clip of clips) {
    if (clip.kind !== "text") continue;
    if (opts.fontFamily !== undefined) clip.fontFamily = opts.fontFamily;
    if (opts.fontWeight !== undefined) clip.fontWeight = opts.fontWeight;
    if (opts.color !== undefined) clip.color = opts.color;
    if (opts.align !== undefined) clip.align = opts.align;
    if (opts.italic !== undefined) clip.italic = opts.italic;
    if (opts.uppercase !== undefined) clip.uppercase = opts.uppercase;
    if (opts.letterSpacing !== undefined) clip.letterSpacing = round(opts.letterSpacing);
    if (opts.lineHeight !== undefined) clip.lineHeight = Math.max(0.5, round(opts.lineHeight));
    if (opts.fontSize !== undefined) clip.fontSize = Math.max(1, Math.round(opts.fontSize));
    if (opts.maxWidth !== undefined) {
      if (opts.maxWidth === null) delete clip.maxWidth;
      else clip.maxWidth = Math.max(1, Math.round(opts.maxWidth));
    }
    if (opts.background !== undefined) {
      if (opts.background === null) delete clip.background;
      else clip.background = opts.background;
    }
    if (opts.outlineWidth !== undefined || opts.outlineColor !== undefined) {
      clip.outline = {
        color: opts.outlineColor ?? clip.outline?.color ?? "#000000",
        width: Math.max(0, opts.outlineWidth ?? clip.outline?.width ?? 0),
      };
    }
    if (opts.shadow !== undefined) {
      if (opts.shadow === null) delete clip.shadow;
      else {
        clip.shadow = {
          color: opts.shadow.color ?? clip.shadow?.color ?? "#000000",
          blur: Math.max(0, opts.shadow.blur ?? clip.shadow?.blur ?? 6),
          offsetX: opts.shadow.offsetX ?? clip.shadow?.offsetX ?? 0,
          offsetY: opts.shadow.offsetY ?? clip.shadow?.offsetY ?? 2,
        };
      }
    }
    if (opts.box !== undefined) {
      if (opts.box === null) delete clip.box;
      else {
        clip.box = {
          style: opts.box.style ?? clip.box?.style ?? "pill",
          ...(opts.box.color ?? clip.box?.color ? { color: opts.box.color ?? clip.box?.color } : {}),
          opacity: clamp(opts.box.opacity ?? clip.box?.opacity ?? 1, 0, 1),
          ...(opts.box.radius ?? clip.box?.radius ? { radius: Math.max(0, opts.box.radius ?? clip.box!.radius!) } : {}),
          ...(opts.box.padX ?? clip.box?.padX ? { padX: Math.max(0, opts.box.padX ?? clip.box!.padX!) } : {}),
          ...(opts.box.padY ?? clip.box?.padY ? { padY: Math.max(0, opts.box.padY ?? clip.box!.padY!) } : {}),
        };
      }
    }
    if (opts.position !== undefined || opts.offset !== undefined) {
      const anchor = opts.position ?? clip.position ?? "bottom";
      const offset = opts.offset ?? clip.positionOffset ?? 0;
      clip.position = anchor;
      clip.positionOffset = round(offset);
      const y = captionAnchorY(anchor, h, offset);
      if (y !== null) clip.transform.y = y;
    }
  }
  return parseEditDoc(clone);
}

/**
 * Position caption clips at a vertical anchor preset (top/center/bottom) with an
 * optional `offset` (composition px), resolved by the shared PURE `captionAnchorY`
 * (safe-margin aware) — so the caption sits at the same place in preview, canvas,
 * and export. Sets both the `position`/`positionOffset` metadata and the resolved
 * `transform.y`. Applies to every caption clip, or ONE when `clipId` is set. The
 * caption default is bottom; free x/y is still available via the transform. Pure +
 * re-parsed through the schema.
 */
export function positionCaptions(
  doc: EditDoc,
  opts: { anchor: CaptionPosition; offset?: number; clipId?: string },
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const clips = captionStyleTargets(clone, opts.clipId);
  if (clips.length === 0) {
    throw new Error(
      opts.clipId
        ? `No caption/text clip "${opts.clipId}" to position.`
        : "Add captions first — there's nothing to position yet.",
    );
  }
  const h = clone.meta.height;
  const offset = round(opts.offset ?? 0);
  for (const clip of clips) {
    if (clip.kind !== "text") continue;
    clip.position = opts.anchor;
    clip.positionOffset = offset;
    const y = captionAnchorY(opts.anchor, h, offset);
    if (y !== null) clip.transform.y = y;
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

// ---- Speed ramp (time remap / CapCut "Curve") ------------------------------

/**
 * Named speed-ramp presets → `[clipProgress, speedMultiplier]` control points.
 * Exported for the web UI's speed-curve editor and the Director tool.
 *  - bullet-time : fast → freeze-ish slow middle → fast (the classic hit).
 *  - hero        : normal → dramatic slow build → snap back up.
 *  - ease-in-out : slow, swell to fast at the middle, ease back to slow.
 *  - ramp-up     : accelerate steadily across the clip.
 *  - ramp-down   : decelerate steadily across the clip.
 */
export const SPEED_RAMP_PRESETS = {
  "bullet-time": [
    [0, 2],
    [0.4, 0.2],
    [0.6, 0.2],
    [1, 2],
  ],
  hero: [
    [0, 1],
    [0.25, 0.35],
    [0.6, 0.35],
    [1, 1.6],
  ],
  "ease-in-out": [
    [0, 0.5],
    [0.5, 1.6],
    [1, 0.5],
  ],
  "ramp-up": [
    [0, 0.4],
    [1, 2.5],
  ],
  "ramp-down": [
    [0, 2.5],
    [1, 0.4],
  ],
} as const satisfies Record<string, [number, number][]>;

export type SpeedRampPreset = keyof typeof SPEED_RAMP_PRESETS;

/**
 * Apply a SPEED RAMP (time-remap curve) to the main video clip(s). Pass explicit
 * `points` (`[clipProgress 0..1, speedMultiplier 0.1..10]`) or a named `preset`.
 * The ramp overrides the scalar `speed`; the clip keeps its TIMELINE duration and
 * the source-time mapping integrates the curve (see sourceTimeAt/speedRampIntegral
 * in core), so preview and export agree. If `atSec` is given only the clip active
 * there is ramped; otherwise every main video clip is. Faithful: retime only.
 */
export function setSpeedRamp(
  doc: EditDoc,
  opts: { points?: [number, number][]; preset?: SpeedRampPreset; atSec?: number } = {},
): EditDoc {
  const raw = opts.points ?? (opts.preset ? SPEED_RAMP_PRESETS[opts.preset] : undefined);
  if (!raw || raw.length < 2) {
    throw new Error("Provide at least two ramp control points or a preset.");
  }
  // Clamp into range and sort by progress so the curve is well-formed + monotonic-safe.
  const ramp: [number, number][] = raw
    .map(([p, m]) => [round(clamp(p, 0, 1)), round(clamp(m, 0.1, 10))] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const clone: EditDoc = structuredClone(doc);
  let changed = 0;
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      if (opts.atSec !== undefined && !(opts.atSec >= clip.start && opts.atSec < clip.start + clip.duration)) {
        continue;
      }
      clip.speedRamp = ramp.map(([p, m]) => [p, m] as [number, number]);
      changed++;
    }
  }
  if (changed === 0) throw new Error("Add a video first — a speed ramp needs footage.");
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
/** A visual clip whose transition + timeline position can be re-laid in place. */
type OverlapClip = {
  kind: string;
  start: number;
  duration: number;
  transitionInSec: number;
  transitionType: TransitionType;
};

/**
 * Re-lay a MAIN visual track's clips so each incoming clip that carries a
 * transition (`transitionInSec > 0`) OVERLAPS the previous one by that duration,
 * and hard cuts stay back-to-back. This is the exact overlap logic the global
 * `setTransition` uses, factored out so the per-cut path and `clearTransition`
 * lay the same geometry (the overlap is what makes preview + xfade export agree).
 * Mutates in place; respects each clip's OWN `transitionInSec` (does not force one).
 */
function relayVisualOverlaps(clips: OverlapClip[]): void {
  const visual = clips.filter((c) => c.kind === "video" || c.kind === "image");
  let prev: OverlapClip | null = null;
  for (const clip of visual) {
    if (prev && clip.transitionInSec > 0) {
      // Clamp the overlap so it can't exceed either clip (keeps xfade offset >= 0).
      const xf = Math.min(clip.transitionInSec, prev.duration - 0.05, clip.duration - 0.05);
      if (xf > 0 && Math.abs(xf - clip.transitionInSec) > 1e-6) clip.transitionInSec = round(xf);
      clip.start = round(prev.start + prev.duration - clip.transitionInSec);
    } else if (prev) {
      clip.start = round(prev.start + prev.duration);
    }
    prev = clip;
  }
}

/**
 * Set the transition style of the main visual clips.
 *
 * GLOBAL (default — `opts` empty): every main visual cut/photo gets `type`, each
 * non-first hard cut gets `transitionSec`, and the track is re-laid so each clip
 * overlaps the previous by its transition duration (a real A→B dissolve honored
 * by canvas + Stage + the ffmpeg `xfade` chain). Behavior is unchanged.
 *
 * PER-CUT (`opts.clipId` or `opts.atSec`): set ONLY the targeted clip's incoming
 * boundary — its `transitionType` becomes `type` and, if it was a hard cut, its
 * `transitionInSec` becomes `transitionSec`. The clip's own track is re-laid so
 * the new overlap exists while every OTHER cut keeps its current transition
 * (untouched). This is what the per-cut transitions gallery calls. `clipId` wins
 * over `atSec`; `atSec` picks the main-visual clip active at that time.
 *
 * Faithful: reveal style + timing only, never content.
 */
export function setTransition(
  doc: EditDoc,
  type: TransitionType,
  transitionSec = 0.6,
  opts: { clipId?: string; atSec?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const targeted = opts.clipId !== undefined || opts.atSec !== undefined;

  if (targeted) {
    let target: OverlapClip | null = null;
    let targetTrack: (typeof clone.tracks)[number] | null = null;
    for (const track of clone.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== "video" && clip.kind !== "image") continue;
        const match =
          opts.clipId !== undefined
            ? clip.id === opts.clipId
            : isMainVisualTrack(track.id) &&
              opts.atSec! >= clip.start &&
              opts.atSec! < clip.start + clip.duration;
        if (match) {
          target = clip as unknown as OverlapClip;
          targetTrack = track;
          break;
        }
      }
      if (target) break;
    }
    if (!target || !targetTrack) {
      throw new Error(
        opts.clipId !== undefined
          ? `No clip “${opts.clipId}” to set a transition on.`
          : `No clip at ${opts.atSec}s to set a transition on.`,
      );
    }
    target.transitionType = type;
    if (target.transitionInSec <= 0) target.transitionInSec = transitionSec;
    // Re-lay the overlap on a magnetic main track; overlay lanes keep free position.
    if (isMainVisualTrack(targetTrack.id)) {
      relayVisualOverlaps(targetTrack.clips as unknown as OverlapClip[]);
    }
    return parseEditDoc(clone);
  }

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

/**
 * Clear the transition on ONE clip's incoming boundary — turn it back into a hard
 * cut. There is no "none" value in `TransitionType`; a cut is simply
 * `transitionInSec = 0` (no reveal ramp on canvas/Stage, no `xfade` on export).
 * The clip's own main track is re-laid so the neighbour closes back to
 * back-to-back. `transitionType` is left as-is (inert while the duration is 0).
 */
export function clearTransition(doc: EditDoc, clipId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let targetTrack: (typeof clone.tracks)[number] | null = null;
  for (const track of clone.tracks) {
    let found = false;
    for (const clip of track.clips) {
      if (
        (clip.kind === "video" ||
          clip.kind === "image" ||
          clip.kind === "text" ||
          clip.kind === "solid") &&
        clip.id === clipId
      ) {
        clip.transitionInSec = 0;
        found = true;
      }
    }
    if (found) {
      targetTrack = track;
      break;
    }
  }
  if (!targetTrack) throw new Error(`No clip “${clipId}” to clear a transition on.`);
  if (isMainVisualTrack(targetTrack.id)) {
    relayVisualOverlaps(targetTrack.clips as unknown as OverlapClip[]);
  }
  return parseEditDoc(clone);
}

/**
 * Set a clip's OUTGOING fade — the reveal-out ramp used for a "fade out to black"
 * on the LAST clip of a sequence (there is no next clip to overlap, so this fades
 * against the black composition background). Sets only `transitionOutSec`; the
 * clip keeps its `transitionType` (so a slide/wipe out still uses its style, but a
 * plain crossfade — the default — reads as a fade to black). It does NOT re-lay the
 * track: the out-ramp never creates an overlap. This is the last-clip counterpart
 * to `setTransition`, giving a discoverable transition even when there is no
 * interior cut (e.g. a single-clip project). Faithful: reveal timing only.
 */
export function setFadeOut(doc: EditDoc, clipId: string, outSec = 0.6): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (
        clip.id === clipId &&
        (clip.kind === "video" || clip.kind === "image" || clip.kind === "text" || clip.kind === "solid")
      ) {
        clip.transitionOutSec = round(Math.max(0, Math.min(outSec, clip.duration - 0.05)));
        return parseEditDoc(clone);
      }
    }
  }
  throw new Error(`No clip “${clipId}” to fade out.`);
}

/** Clear a clip's outgoing fade (turn a fade-to-black back into a hard end). */
export function clearFadeOut(doc: EditDoc, clipId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (
        clip.id === clipId &&
        (clip.kind === "video" || clip.kind === "image" || clip.kind === "text" || clip.kind === "solid")
      ) {
        clip.transitionOutSec = 0;
        return parseEditDoc(clone);
      }
    }
  }
  throw new Error(`No clip “${clipId}” to clear a fade on.`);
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
    track = mkTrack("cursor", "visual");
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
    track = mkTrack("demo-text", "visual");
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
    track = mkTrack("callouts", "visual");
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

// ---- Manual keyframe ops (timeline diamond editor) -------------------------
//
// These target ONE clip by id (the manual UI always knows which diamond it is
// editing), unlike animate/addKeyframe which pick a clip heuristically for the
// AI. `t` is CLIP-PROGRESS 0..1 (0 = clip start, 1 = clip end) — the exact unit
// `valueAt` and `addKeyframe` already use — NOT clip-relative seconds. Each op is
// pure (structuredClone + parseEditDoc) and keeps `keyframes` sorted so `valueAt`
// (and its ffmpeg mirror) stay correct.

/** Two keyframes are "the same" when their times differ by less than this (0..1). */
const KF_T_EPS = 1e-3;

/** An identified, mutable clip inside a structuredClone (safe to mutate). */
type IdentifiedClip = AnimatableClip & { id: string };

/** Find the clip with `clipId` inside the clone (a reference safe to mutate), or null. */
function findClipById(clone: EditDoc, clipId: string): IdentifiedClip | null {
  for (const track of clone.tracks) {
    for (const clip of track.clips as unknown as IdentifiedClip[]) {
      if (clip.id === clipId) return clip;
    }
  }
  return null;
}

/**
 * The keyframes on `clip` for one `prop`, sorted by time (0..1 clip-progress).
 * Returns a NEW array (never the clip's own). Handy for the timeline diamond
 * editor to lay out one prop's sub-lane. Pure — no mutation.
 */
export function clipKeyframes(clip: { keyframes?: Keyframe[] }, prop: KeyframeProp): Keyframe[] {
  return (clip.keyframes ?? []).filter((k) => k.prop === prop).sort((a, b) => a.t - b.t);
}

export interface SetKeyframeInput {
  prop: KeyframeProp;
  /** Clip-progress 0..1 (0 = clip start, 1 = clip end). */
  t: number;
  value: number;
  easing?: KeyframeEasing;
}

/**
 * Upsert a keyframe at time `t` on `clipId`'s `keyframes[]`: replace the existing
 * keyframe for `prop` at ~`t` (within KF_T_EPS) if there is one, otherwise insert
 * a new one, keeping the array sorted. The op the timeline "add keyframe at
 * playhead" button and diamond drag-to-set-value both call.
 */
export function setKeyframe(doc: EditDoc, clipId: string, input: SetKeyframeInput): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const clip = findClipById(clone, clipId);
  if (!clip) throw new Error(`No clip “${clipId}” to keyframe.`);
  if (!clipSupportsProp(clip, input.prop)) {
    throw new Error(`This ${clip.kind} clip can't be keyframed on “${input.prop}”.`);
  }
  const t = round(clamp(input.t, 0, 1));
  const kf: Keyframe = {
    prop: input.prop,
    t,
    value: round(input.value),
    easing: input.easing ?? ("linear" as KeyframeEasing),
  };
  const kfs = [...(clip.keyframes ?? [])];
  const idx = kfs.findIndex((k) => k.prop === input.prop && Math.abs(k.t - t) < KF_T_EPS);
  if (idx >= 0) kfs[idx] = kf;
  else kfs.push(kf);
  clip.keyframes = kfs.sort((a, b) => a.t - b.t);
  return parseEditDoc(clone);
}

/**
 * Move a keyframe in time (and optionally change its value): find `prop`'s
 * keyframe at ~`fromT` on `clipId` and move it to `toT`, keeping easing (unless a
 * new `value` is given) and re-sorting. The op a diamond horizontal-drag calls.
 */
export function moveKeyframe(
  doc: EditDoc,
  clipId: string,
  prop: KeyframeProp,
  fromT: number,
  toT: number,
  value?: number,
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const clip = findClipById(clone, clipId);
  if (!clip) throw new Error(`No clip “${clipId}” to keyframe.`);
  const kfs = [...(clip.keyframes ?? [])];
  const idx = kfs.findIndex((k) => k.prop === prop && Math.abs(k.t - fromT) < KF_T_EPS);
  if (idx < 0) throw new Error(`No “${prop}” keyframe near t=${round(fromT)} to move.`);
  const cur = kfs[idx]!;
  kfs[idx] = {
    prop,
    t: round(clamp(toT, 0, 1)),
    value: value !== undefined ? round(value) : cur.value,
    easing: cur.easing,
  };
  clip.keyframes = kfs.sort((a, b) => a.t - b.t);
  return parseEditDoc(clone);
}

/**
 * Delete `prop`'s keyframe at ~`t` on `clipId`. Throws if none matches (the UI
 * only deletes a diamond it can see). When the last keyframe is removed the
 * `keyframes` array is dropped entirely so the clip falls back to its static
 * transform/volume (valueAt returns the base).
 */
export function removeKeyframe(doc: EditDoc, clipId: string, prop: KeyframeProp, t: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const clip = findClipById(clone, clipId);
  if (!clip) throw new Error(`No clip “${clipId}” to keyframe.`);
  const kfs = clip.keyframes ?? [];
  const next = kfs.filter((k) => !(k.prop === prop && Math.abs(k.t - t) < KF_T_EPS));
  if (next.length === kfs.length) throw new Error(`No “${prop}” keyframe near t=${round(t)} to remove.`);
  clip.keyframes = next.length > 0 ? next : undefined;
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

// ---- LUT import (.cube) -----------------------------------------------------

export interface ApplyLutOpts {
  /** Asset id / local file path of the .cube LUT. Empty string clears the LUT. */
  lut: string;
  /** Target one clip by id; otherwise every MAIN visual clip. */
  clipId?: string;
}

/**
 * Import a 3D LUT (.cube) as the creative look. Sets `look.lut` on the target
 * clip(s) — one clip when `clipId` is given, otherwise every MAIN visual clip
 * (mirroring adjustColor / adjustCurves) — MERGING with each clip's existing look
 * (brightness/contrast/curves/etc. are preserved). An empty `lut` clears it. The
 * LUT is applied on EXPORT (ffmpeg `lut3d`); the canvas preview approximates the
 * other grade fields but not the LUT (documented, like curves). Pure + re-parsed.
 * Faithful: a color remap only, never a content change.
 */
export function applyLut(doc: EditDoc, opts: ApplyLutOpts): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const lut = opts.lut.trim() || undefined;
  let changed = 0;
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "video" && clip.kind !== "image") continue;
      if (opts.clipId) {
        if (clip.id !== opts.clipId) continue;
      } else if (!isMainVisualTrack(track.id)) {
        continue;
      }
      clip.look = { ...clip.look, lut };
      changed++;
    }
  }
  if (changed === 0) {
    throw new Error(
      opts.clipId
        ? `No visual clip "${opts.clipId}" to apply the LUT to.`
        : "Add a video or photos first — a LUT needs a visual clip.",
    );
  }
  return parseEditDoc(clone);
}

// ---- Adjustment layer ------------------------------------------------------

export interface AddAdjustmentOpts {
  /** Window start on the timeline (seconds). Defaults to 0. */
  atSec?: number;
  /** Window length (seconds). Defaults to the rest of the timeline (min 0.2). */
  durationSec?: number;
  /** Explicit grade fields (merged over any `look` preset). */
  grade?: Partial<ColorGrade>;
  /** A named look preset to seed the grade from. */
  look?: LookKey;
}

/**
 * Add an ADJUSTMENT LAYER — a color grade spanning [atSec, atSec+durationSec] on
 * its own topmost "adjustments" track (created on first use). The grade is seeded
 * from a `look` preset and/or explicit `grade` fields (explicit fields win); the
 * layer grades EVERYTHING beneath it over its window in all three renderers (the
 * canvas post-composite pass + the ffmpeg `enable`-gated chain). The track is
 * pushed LAST, so array-order z-order places it over all footage. Pure + re-parsed;
 * additive (an empty adjustments track and a neutral grade are both valid).
 */
export function addAdjustment(doc: EditDoc, opts: AddAdjustmentOpts = {}): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const start = round(Math.max(0, opts.atSec ?? 0));
  const rest = docDurationSec(clone) - start;
  const duration = round(Math.max(0.2, opts.durationSec ?? (rest > 0.2 ? rest : 3)));
  const preset = opts.look ? LOOK_PRESETS[opts.look] : undefined;
  const g = opts.grade ?? {};
  const grade: ColorGrade = {
    brightness: round(clamp(g.brightness ?? preset?.brightness ?? 1, 0, 4)),
    contrast: round(clamp(g.contrast ?? preset?.contrast ?? 1, 0, 4)),
    saturation: round(clamp(g.saturation ?? preset?.saturation ?? 1, 0, 4)),
    warmth: round(clamp(g.warmth ?? preset?.warmth ?? 0, 0, 1)),
    ...(g.hueShift !== undefined ? { hueShift: round(g.hueShift) } : {}),
    ...(g.curves ? { curves: g.curves } : {}),
    ...(g.lut ? { lut: g.lut } : {}),
  };
  const clip: Record<string, unknown> = {
    id: `adjustment-${Date.now()}`,
    kind: "adjustment",
    start,
    duration,
    grade,
  };
  let track = clone.tracks.find((t) => t.id === "adjustments");
  if (!track) {
    track = mkTrack("adjustments", "visual");
    clone.tracks.push(track);
  }
  (track.clips as unknown[]).push(clip);
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

/**
 * Toggle clean-audio noise reduction of the final mix. On export this inserts an
 * FFT denoise (`afftdn`) into the mixed-audio chain BEFORE `loudnorm` — a faithful,
 * model-free default (a stronger `arnndn` model is used automatically when
 * ARNNDN_MODEL is configured). EXPORT-ONLY, exactly like `normalizeLoudness`: the
 * canvas/browser preview is unchanged. Faithful: attenuates noise only.
 */
export function setCleanAudio(doc: EditDoc, on = true): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  clone.cleanAudio = on;
  return parseEditDoc(clone);
}

// ---- Transcript-based (text) editing ---------------------------------------

/** Lowercase alphanumeric+apostrophe tokens of a phrase (for word matching). */
function tokenizePhrase(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalize a single transcript word for comparison (drop punctuation, lowercase). */
function normWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/** Normalize free text (segment/phrase) to a collapsed, punctuation-free lowercase string. */
function normText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Word-accurate matches of `tokens` (a phrase) in a flat word list. Returns
 * inclusive `[startIdx, endIdx]` index ranges into `words`, non-overlapping.
 */
function findWordMatches(words: { text: string }[], tokens: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (tokens.length === 0) return out;
  let i = 0;
  while (i <= words.length - tokens.length) {
    let ok = true;
    for (let k = 0; k < tokens.length; k++) {
      if (normWord(words[i + k]!.text) !== tokens[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push([i, i + tokens.length - 1]);
      i += tokens.length;
    } else {
      i++;
    }
  }
  return out;
}

/** How `edit_by_transcript` selects content. */
export type TranscriptEditMode = "remove" | "keep";
export type TranscriptEditUnit = "word" | "segment";

export interface TranscriptEditOptions {
  /** The phrase / pattern to match in the transcript. */
  phrase: string;
  /** "remove" the matched spans (default) or "keep" only them. */
  mode?: TranscriptEditMode;
  /**
   * Granularity: "segment" cuts/keeps whole sentences containing the phrase
   * (great for "cut the sentence about …" / "keep only where they mention …");
   * "word" cuts/keeps just the matched word spans (great for "delete every 'um'").
   */
  unit?: TranscriptEditUnit;
  width?: number;
  height?: number;
  fps?: number;
  title?: string;
}

export interface TranscriptEditResult {
  doc: EditDoc;
  /** Number of source spans KEPT (laid as clips). */
  kept: number;
  /** Number of spans/segments removed by the edit. */
  removed: number;
  /** Seconds of source removed relative to the naive full-segment concat. */
  removedSec: number;
  /** Whether the phrase matched anything at all. */
  matched: boolean;
}

/**
 * Content-driven cut: given the source video's transcript, rebuild the timeline
 * from the SOURCE spans that survive a phrase match — word-accurate, in the same
 * edits-as-code spirit as highlight/filler but driven by what's SAID.
 *
 *  - mode "remove" (default): drop the spans matching `phrase`, concatenate the rest.
 *  - mode "keep": keep ONLY the spans matching `phrase`.
 *  - unit "segment" (default): operate on whole sentences (transcript segments)
 *    whose text contains the phrase.
 *  - unit "word": operate on the exact matched word spans (e.g. delete every "um"),
 *    keeping the surrounding words of each segment intact.
 *
 * Pure + re-parsed through the schema; the kept spans are laid back-to-back so the
 * result always renders. Faithful: it only re-sequences existing source, never a
 * content change.
 */
export function editByTranscript(
  media: MediaAsset,
  transcript: Transcript,
  opts: TranscriptEditOptions,
): TranscriptEditResult {
  const mode: TranscriptEditMode = opts.mode ?? "remove";
  const unit: TranscriptEditUnit = opts.unit ?? "segment";
  const width = opts.width ?? media.width ?? 1920;
  const height = opts.height ?? media.height ?? 1080;
  const tokens = tokenizePhrase(opts.phrase);
  const phraseNorm = normText(opts.phrase);

  // Kept SOURCE spans [start,end] (source seconds), in chronological order.
  const keptSpans: Array<{ start: number; end: number }> = [];
  let matched = false;
  let removed = 0;
  // Baseline (naive) content seconds = the sum of all segment durations, so
  // removedSec is meaningful regardless of unit.
  const baselineSec = transcript.segments.reduce((s, seg) => s + Math.max(0, seg.end - seg.start), 0);

  if (unit === "segment") {
    for (const seg of transcript.segments) {
      const contains = phraseNorm.length > 0 && normText(seg.text).includes(phraseNorm);
      if (contains) matched = true;
      const keepThis = mode === "keep" ? contains : !contains;
      if (keepThis) keptSpans.push({ start: seg.start, end: seg.end });
      else removed++;
    }
  } else {
    // Word unit: match on the flat word list, then rebuild kept runs, breaking at
    // segment boundaries so we never bridge a natural pause/silence.
    const matches = findWordMatches(transcript.words, tokens);
    matched = matches.length > 0;
    removed = matches.length;
    const removedIdx = new Set<number>();
    for (const [a, b] of matches) for (let i = a; i <= b; i++) removedIdx.add(i);

    if (mode === "keep") {
      // Keep only the matched word spans.
      for (const [a, b] of matches) {
        keptSpans.push({ start: transcript.words[a]!.start, end: transcript.words[b]!.end });
      }
    } else {
      // Keep everything EXCEPT the matched words, grouped by segment so a segment's
      // surviving words become one span (approx — uses segment bounds when the
      // segment carries no per-word timings).
      for (const seg of transcript.segments) {
        const segWords = seg.words ?? [];
        if (segWords.length === 0) {
          // No word timings on this segment — keep it whole unless a match falls in it.
          const hasMatch = matches.some(([a, b]) => {
            const ms = transcript.words[a]?.start ?? -1;
            const me = transcript.words[b]?.end ?? -1;
            return me > seg.start && ms < seg.end;
          });
          if (!hasMatch) keptSpans.push({ start: seg.start, end: seg.end });
          continue;
        }
        // Group consecutive non-removed words in this segment into runs.
        let runStart: number | null = null;
        let runEnd = 0;
        for (const w of segWords) {
          const gi = transcript.words.indexOf(w);
          const isRemoved = gi >= 0 && removedIdx.has(gi);
          if (isRemoved) {
            if (runStart !== null) {
              keptSpans.push({ start: runStart, end: runEnd });
              runStart = null;
            }
          } else {
            if (runStart === null) runStart = w.start;
            runEnd = w.end;
          }
        }
        if (runStart !== null) keptSpans.push({ start: runStart, end: runEnd });
      }
    }
  }

  // Lay the kept source spans back-to-back on the timeline.
  const clips: Array<Record<string, unknown>> = [];
  let pos = 0;
  let kept = 0;
  let keptSec = 0;
  for (const span of keptSpans) {
    const dur = Math.max(0.05, span.end - span.start);
    clips.push({
      id: `te${kept}`,
      kind: "video",
      start: round(pos),
      duration: round(dur),
      mediaId: media.id,
      sourceIn: round(span.start),
      transform: { x: width / 2, y: height / 2 },
    });
    pos += dur;
    keptSec += dur;
    kept++;
  }

  const doc = parseEditDoc({
    version: 1,
    meta: {
      title: opts.title ?? `${media.label ?? "clip"} (transcript edit)`,
      width,
      height,
      fps: opts.fps ?? 30,
      background: "#0a0d12",
    },
    media: [media],
    tracks: [{ id: "video", kind: "visual", clips }],
  });

  return { doc, kept, removed, removedSec: round(Math.max(0, baselineSec - keptSec)), matched };
}

// ---- Silence / dead-air removal --------------------------------------------

export interface RemoveSilenceOptions {
  /** Inter-segment gaps LONGER than this (seconds) are removed. Default 0.6s. */
  thresholdSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  title?: string;
}

export interface RemoveSilenceResult {
  doc: EditDoc;
  /** Segments kept (all of them — silence removal drops gaps, not content). */
  segments: number;
  /** Number of inter-segment gaps that exceeded the threshold and were dropped. */
  gapsDropped: number;
  /** Seconds of dead-air removed. */
  removedSec: number;
}

/**
 * Silence / dead-air removal: keep EVERY spoken segment, but drop the inter-segment
 * gaps longer than `thresholdSec`, tightening pacing. Distinct from `filler_cut`
 * (which drops filler-heavy segments) — here no content is cut, only the dead air
 * between sentences. A gap up to the threshold is preserved IN-SOURCE (natural
 * rhythm); anything beyond it is removed by concatenating the next segment right
 * after. Leading dead-air before the first segment is dropped for free (the first
 * clip starts at the segment). Pure + re-parsed. Faithful: re-sequences source only.
 */
export function removeSilence(
  media: MediaAsset,
  transcript: Transcript,
  opts: RemoveSilenceOptions = {},
): RemoveSilenceResult {
  const threshold = Math.max(0, opts.thresholdSec ?? 0.6);
  const width = opts.width ?? media.width ?? 1920;
  const height = opts.height ?? media.height ?? 1080;
  const segs = transcript.segments;

  const clips: Array<Record<string, unknown>> = [];
  let pos = 0;
  let gapsDropped = 0;
  let removedSec = 0;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const speech = Math.max(0.05, seg.end - seg.start);
    const gapAfter = i < segs.length - 1 ? Math.max(0, segs[i + 1]!.start - seg.end) : 0;
    // Keep up to `threshold` of the trailing pause IN-SOURCE (natural pacing);
    // drop the excess dead-air beyond it.
    const keptGap = Math.min(gapAfter, threshold);
    if (gapAfter > threshold) {
      gapsDropped++;
      removedSec += gapAfter - keptGap;
    }
    clips.push({
      id: `sil${i}`,
      kind: "video",
      start: round(pos),
      duration: round(speech + keptGap),
      mediaId: media.id,
      sourceIn: round(seg.start),
      transform: { x: width / 2, y: height / 2 },
    });
    pos += speech + keptGap;
  }

  const doc = parseEditDoc({
    version: 1,
    meta: {
      title: opts.title ?? `${media.label ?? "clip"} (silence removed)`,
      width,
      height,
      fps: opts.fps ?? 30,
      background: "#0a0d12",
    },
    media: [media],
    tracks: [{ id: "video", kind: "visual", clips }],
  });

  return { doc, segments: segs.length, gapsDropped, removedSec: round(removedSec) };
}

// ---- Auto-reframe (subject-aware, FREE + gated tracking) --------------------

export interface AutoReframeOptions {
  aspect?: AspectKey;
  width?: number;
  height?: number;
  /** Add a subtle keyframed settle-pan toward frame center (free flourish). */
  pan?: boolean;
  /**
   * MONEY-GATED upgrade. When true a VISION provider would drive a keyframed crop
   * path that follows the subject; there is none wired here, so this is recorded
   * as intent only and the free CENTERED reframe is produced. The tool surfaces
   * the honest "subject tracking is a gated upgrade" message. Off by default.
   */
  subjectTracking?: boolean;
}

/**
 * Auto-reframe to a target aspect while keeping the subject framed. The FREE path
 * reuses `reframe`/`reframeTo` (which re-anchors every media clip to the frame
 * CENTER — the subject stays centered), and can add an optional gentle keyframed
 * settle-pan toward center. `subjectTracking` is a documented, MONEY-GATED upgrade
 * (a vision model would keyframe a crop path that follows the speaker) — it is NOT
 * performed here; the flag is accepted and the free centered reframe is returned.
 * Pure + re-parsed. Faithful: reframes/centers/eases the existing frame only.
 */
export function autoReframe(doc: EditDoc, opts: AutoReframeOptions = {}): EditDoc {
  const reframed =
    opts.width !== undefined && opts.height !== undefined
      ? reframeTo(doc, opts.width, opts.height)
      : reframe(doc, opts.aspect ?? "9:16");
  if (!opts.pan) return reframed;

  // Free settle-pan: ease each main video clip's horizontal anchor from a small
  // offset back to the centered position over the clip, so the subject drifts
  // toward center (a keyframed approximation of "keep me centered" in motion).
  const clone: EditDoc = structuredClone(reframed);
  const cx = clone.meta.width / 2;
  const offset = round(clone.meta.width * 0.06);
  for (const track of clone.tracks) {
    if (!isMainVisualTrack(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      const others = (clip.keyframes ?? []).filter((k) => k.prop !== "x");
      clip.keyframes = [
        ...others,
        { prop: "x", t: 0, value: round(cx - offset), easing: "linear" },
        { prop: "x", t: 1, value: round(cx), easing: "ease-out" },
      ];
    }
  }
  return parseEditDoc(clone);
}

// ---- Voice-over (TTS) audio track ------------------------------------------

/**
 * Add a generated (or supplied) voice-over as a "voiceover" audio track. Mirrors
 * `addMusic` (adds the asset to media, one audio clip on a dedicated track), but
 * the VO plays at full volume by default and is NOT ducked. `carryOverAudio`
 * already preserves the "voiceover" track across rebuilds. Pure + re-parsed.
 */
export function addVoiceover(
  doc: EditDoc,
  asset: MediaAsset,
  opts: { startSec?: number; volume?: number; durationSec?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  if (!clone.media.some((m) => m.id === asset.id)) clone.media.push(asset);
  clone.tracks = clone.tracks.filter((t) => t.id !== "voiceover");
  const startSec = Math.max(0, opts.startSec ?? 0);
  const duration = Math.max(0.1, opts.durationSec ?? asset.durationSec ?? 3);
  const clip = {
    id: `vo-${Date.now()}`,
    kind: "audio" as const,
    start: round(startSec),
    duration: round(duration),
    mediaId: asset.id,
    sourceIn: 0,
    volume: opts.volume ?? 1,
  };
  clone.tracks.push(mkTrack("voiceover", "audio", [clip]));
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
  clone.tracks.push(mkTrack("fades", "visual", clips));
  return parseEditDoc(clone);
}
