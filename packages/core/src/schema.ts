/**
 * Cadence edit-doc schema — the single source of truth for a project/video.
 *
 * PRINCIPLE (edits-as-code): the project is a declarative document. Store the
 * recipe, not opaque state. This schema is ENGINE-AGNOSTIC: it must be
 * renderable by any backend (canvas rasterizer today; Omniclip/WebCodecs in the
 * browser; MLT/ffmpeg later) without changing the Director or the document.
 */
import { z } from "zod";

/** A hex color like #RRGGBB or #RRGGBBAA. */
export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected #RRGGBB or #RRGGBBAA");

/** 2D transform applied to a visual clip, in canvas pixels / degrees. */
export const Transform = z.object({
  /** X of the clip's anchor, in composition pixels. */
  x: z.number().default(0),
  /** Y of the clip's anchor, in composition pixels. */
  y: z.number().default(0),
  /** Uniform scale multiplier. */
  scale: z.number().positive().default(1),
  /** Clockwise rotation in degrees. */
  rotation: z.number().default(0),
  /** 0..1 opacity. */
  opacity: z.number().min(0).max(1).default(1),
});
export type Transform = z.infer<typeof Transform>;

/**
 * Color grade / "look" — expressed as data so it previews identically in CSS
 * (client <video>/<img> filter), server canvas (ctx.filter), and export (ffmpeg).
 * brightness/contrast/saturation are multipliers (1 = neutral); warmth 0..1 adds
 * a warm overlay.
 */
/**
 * A tone-curve control point `[x, y]` in 0..1 (input level → output level).
 * Curves are a list of these, resolved to the ffmpeg `curves` filter's
 * "x0/y0 x1/y1 …" points string on export. Endpoints (0,*) and (1,*) anchor the
 * curve; interior points bend it. Faithful: a tonal remap, never a content change.
 */
export const CurvePoint = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export type CurvePoint = z.infer<typeof CurvePoint>;

/**
 * RGB tone curves — a master (all-channel) curve and optional per-channel curves.
 * Each is a list of control points resolved to the ffmpeg `curves` filter
 * (curves=master/red/green/blue='x/y …'). Optional + all-absent by default so
 * existing docs stay valid. CSS has no curve primitive, so the canvas preview
 * approximates curves (documented); the export is exact.
 */
export const Curves = z.object({
  master: z.array(CurvePoint).optional(),
  r: z.array(CurvePoint).optional(),
  g: z.array(CurvePoint).optional(),
  b: z.array(CurvePoint).optional(),
});
export type Curves = z.infer<typeof Curves>;

export const ColorGrade = z.object({
  brightness: z.number().min(0).default(1),
  contrast: z.number().min(0).default(1),
  saturation: z.number().min(0).default(1),
  warmth: z.number().min(0).max(1).default(0),
  /**
   * Hue rotation in DEGREES (0/absent = neutral). Previews via CSS/canvas
   * `hue-rotate()` and exports via the ffmpeg `hue=h=` filter. Optional so existing
   * docs/grades stay valid. Faithful: rotates hue only.
   */
  hueShift: z.number().optional(),
  /**
   * Optional RGB tone curves (master + per-channel), resolved to the ffmpeg
   * `curves` filter on export. Optional so existing docs stay valid; the canvas
   * approximates them (no CSS curve primitive — documented limit).
   */
  curves: Curves.optional(),
  /**
   * Optional 3D LUT (.cube) — an asset id / local file path of a color lookup
   * table applied as the creative "look" on top of the primary correction. On
   * export it becomes the ffmpeg `lut3d=file=<path>` filter (the path is resolved
   * through the SAME resolver/whitelist as media and escaped for the filtergraph;
   * lut3d reads a LOCAL file only — no arbitrary protocols). CSS/canvas have no
   * .cube primitive, so the LUT is EXPORT-ONLY: the canvas preview skips it
   * gracefully (documented, exactly like `curves`). Optional so existing docs stay
   * valid. Faithful: a color remap only, never a content change.
   */
  lut: z.string().optional(),
});
export type ColorGrade = z.infer<typeof ColorGrade>;

/** Ken Burns motion for stills: zoom (end scale, start = 1) + pan across the clip. */
export const KenBurns = z.object({
  zoom: z.number().min(0.1).default(1),
  panX: z.number().default(0),
  panY: z.number().default(0),
});
export type KenBurns = z.infer<typeof KenBurns>;

/**
 * Kinetic intro animation for a text clip — a deterministic slide + scale in,
 * resolved by a PURE helper (`textKinetic` in grade.ts) so it previews in the
 * browser (CSS transform) exactly as it renders on the server canvas and on
 * export (drawtext x/y expressions). Faithful: moves/scales the title only.
 */
export const TextAnim = z.object({
  /**
   * How the title animates in over `durationSec`, resolved by the PURE
   * `textKinetic` helper in grade.ts so canvas, Stage, and export agree:
   *  - "none"    — static (the default).
   *  - "kinetic" — slide + scale in, eased (ease-out cubic).
   *  - "pop"     — scale in with a small overshoot (ease-out-back).
   *  - "bounce"  — slide in with a damped bounce settle (ease-out-bounce).
   *  - "typewriter" — the text TYPES OUT one character at a time over
   *                   `durationSec`, with an optional blinking caret. The visible
   *                   substring is resolved by the PURE `typewriterText` helper in
   *                   grade.ts (canvas draws the substring; the ffmpeg export
   *                   sequences time-gated drawtext slices) — no slide/scale, so it
   *                   is the natural style for typing into a form field in a demo.
   */
  style: z.enum(["none", "kinetic", "pop", "bounce", "typewriter"]).default("none"),
  /** Offset (composition px) the text slides FROM, toward its resting x. */
  fromX: z.number().default(0),
  /** Offset (composition px) the text slides FROM, toward its resting y. */
  fromY: z.number().default(0),
  /** Scale the text grows FROM toward its resting 1 (e.g. 0.6). */
  fromScale: z.number().positive().default(1),
  /** How long the intro animation lasts, in seconds (0 = no animation). */
  durationSec: z.number().nonnegative().default(0),
  /**
   * Show a blinking caret while (and after) typing, for the "typewriter" style.
   * Ignored by every other style. Off by default so existing docs are unchanged.
   */
  caret: z.boolean().default(false),
});
export type TextAnim = z.infer<typeof TextAnim>;

/**
 * Punch-in emphasis for a video clip — a scale pulse over a timeline sub-range
 * [atSec, atSec+durationSec], resolved by a PURE helper (`emphasisScale` in
 * grade.ts). Faithful: only scales the existing frame up and back, no content
 * change.
 */
export const Emphasis = z.object({
  /** Timeline time (seconds) the punch-in window starts. */
  atSec: z.number().nonnegative().default(0),
  /** How long the punch-in window lasts, in seconds (0 = off). */
  durationSec: z.number().nonnegative().default(0),
  /** Peak scale multiplier at the center of the window (e.g. 1.25). */
  zoom: z.number().positive().default(1),
});
export type Emphasis = z.infer<typeof Emphasis>;

/**
 * A single animation keyframe. `prop` names the animatable property; `t` is
 * clip-progress (0 = clip start, 1 = clip end); `value` is the target; `easing`
 * describes how the value eases INTO this keyframe from the previous one.
 *
 * All keyframes are resolved by the ONE PURE `valueAt(keyframes, prop, progress,
 * base)` helper in grade.ts, so the canvas preview, the browser Stage, and the
 * ffmpeg export all read the same interpolation. On export, x/y/rotation/opacity on
 * an OVERLAY layer clip carry the EASED curve (a piecewise time expression matching
 * `valueAt` segment-for-segment — see `keyframeTransformExpr` in render-ffmpeg), so
 * a moving/rotating/fading PiP renders at parity with preview; scale (zoompan) and
 * volume are approximated with a piecewise-LINEAR time expression (the eased curve
 * is a preview nicety there, exactly as the cursor path is eased in preview but
 * linear on export). Faithful: keyframes only move/scale/rotate/fade or re-level the
 * existing clip, never a content change.
 *
 *  - x | y     — the clip's transform anchor (composition px). Exported on overlay
 *                layer clips (time-varying overlay position); base-track full-frame
 *                clips honor x/y statically (documented export limit).
 *  - scale     — uniform scale multiplier (1 = native); exported via zoompan.
 *  - rotation  — clockwise degrees. Exported on overlay layer clips (rotate filter).
 *  - opacity   — 0..1 (multiplies any transition ramp); exported on overlay layer
 *                clips (per-frame alpha).
 *  - volume    — 0..1 audio level (video/audio clips only).
 */
export const KeyframeProp = z.enum(["x", "y", "scale", "rotation", "opacity", "volume"]);
export type KeyframeProp = z.infer<typeof KeyframeProp>;

/** Easing applied to a keyframe segment (how the value eases INTO the keyframe). */
export const KeyframeEasing = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]);
export type KeyframeEasing = z.infer<typeof KeyframeEasing>;

export const Keyframe = z.object({
  prop: KeyframeProp,
  /** Clip-progress 0..1 (0 = clip start, 1 = clip end). */
  t: z.number().min(0).max(1),
  value: z.number(),
  easing: KeyframeEasing.default("linear"),
});
export type Keyframe = z.infer<typeof Keyframe>;

/** Media kinds we can ingest. */
export const MediaKind = z.enum(["video", "audio", "image"]);
export type MediaKind = z.infer<typeof MediaKind>;

/** A source asset referenced by clips. `src` is a local path or URL. */
export const MediaAsset = z.object({
  id: z.string().min(1),
  kind: MediaKind,
  src: z.string().min(1),
  /** Source duration in seconds (video/audio). */
  durationSec: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  label: z.string().optional(),
  /**
   * Whether the source carries an audio stream. Optional and defaulted-absent so
   * existing docs stay valid; when explicitly `false` (a muted screen-recording,
   * a silent clip), the ffmpeg export synthesizes silence (anullsrc) for that clip
   * instead of mapping a non-existent `[idx:a]` pad — so a multi-video concat/
   * crossfade with a silent source still exports. Undefined ⇒ assume audio present
   * (the prior behavior).
   */
  hasAudio: z.boolean().optional(),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

/** Fields shared by every clip. Times are in seconds on the project timeline. */
const clipBase = {
  id: z.string().min(1),
  /** Start time on the timeline, in seconds. */
  start: z.number().nonnegative(),
  /** How long the clip occupies the timeline, in seconds. */
  duration: z.number().positive(),
};

/** Crossfade-in / -out durations in seconds (0 = hard cut). Shared by visual clips. */
const transitionInSec = z.number().nonnegative().default(0);
const transitionOutSec = z.number().nonnegative().default(0);

/**
 * How a visual clip transitions in/out over its in/out ramp — a SUPERSET of the
 * original 7 styles plus the full useful ffmpeg `xfade` transition set (50+ total).
 * All faithful: no content change, only how the existing frames reveal / leave.
 *
 * BACKWARD COMPATIBILITY: the original 7 values (crossfade, dip-to-black, slide,
 * wipe, dissolve, zoom, smooth) are KEPT verbatim and behave EXACTLY as before —
 * existing docs parse and render identically. Every NEW value is a literal ffmpeg
 * xfade `transition` name, so the export maps it to itself (see `xfadeTransition`
 * in render-ffmpeg/plan.ts); the original 7 keep their historical aliases
 * (crossfade→fade, dip-to-black→fadeblack, slide→slideleft, wipe→wipeleft,
 * dissolve→dissolve, zoom→zoomin, smooth→smoothleft).
 *
 * Resolved for preview by PURE helpers in grade.ts (transitionMotion /
 * transitionStyle) so the browser Stage and the server canvas approximate every
 * type — fades/dissolve/pixelize → opacity; slides/smooths/covers/reveals/squeeze
 * → translate; wipes/opens/closes/crops → clip-path inset; circles/radial →
 * clip-path circle; zoom → scale — and any unhandled value falls back to a clean
 * opacity crossfade so the preview never breaks. Grouped names below feed the
 * UI helpers `TRANSITION_TYPES` (ordered list) and `TRANSITION_GROUPS`
 * (name → { label, group }) so a gallery can render them grouped + labeled.
 * Every name here is a documented ffmpeg xfade transition.
 */
export const TRANSITION_TYPES = [
  // --- fades / dissolves (opacity-family) ---
  "crossfade", // legacy → xfade fade
  "dip-to-black", // legacy → xfade fadeblack
  "dissolve", // legacy → xfade dissolve
  "fadewhite",
  "fadegrays",
  "fadefast",
  "fadeslow",
  // --- wipes (hard-edged directional reveal) ---
  "wipe", // legacy → xfade wipeleft
  "wiperight",
  "wipeup",
  "wipedown",
  "wipetl",
  "wipetr",
  "wipebl",
  "wipebr",
  // --- slides (frame slides in) ---
  "slide", // legacy → xfade slideleft
  "slideright",
  "slideup",
  "slidedown",
  // --- smooths (soft/feathered directional slide) ---
  "smooth", // legacy → xfade smoothleft
  "smoothright",
  "smoothup",
  "smoothdown",
  // --- covers (incoming frame slides over) ---
  "coverleft",
  "coverright",
  "coverup",
  "coverdown",
  // --- reveals (outgoing frame slides away) ---
  "revealleft",
  "revealright",
  "revealup",
  "revealdown",
  // --- opens / closes (reveal from / to center) ---
  "circleopen",
  "circleclose",
  "horzopen",
  "horzclose",
  "vertopen",
  "vertclose",
  // --- crops / shapes ---
  "circlecrop",
  "rectcrop",
  // --- diagonals ---
  "diagtl",
  "diagtr",
  "diagbl",
  "diagbr",
  // --- slices ---
  "hlslice",
  "hrslice",
  "vuslice",
  "vdslice",
  // --- zoom ---
  "zoom", // legacy → xfade zoomin
  "zoomin",
  // --- effects ---
  "pixelize",
  "hblur",
  "distance",
  "radial",
  "squeezeh",
  "squeezev",
] as const;

export const TransitionType = z.enum(TRANSITION_TYPES);
export type TransitionType = z.infer<typeof TransitionType>;
const transitionType = TransitionType.default("crossfade");

/** UI metadata for one transition: a short human label + the group it belongs to. */
export interface TransitionMeta {
  label: string;
  group: string;
}

/**
 * name → { label, group } for EVERY TransitionType, so the web gallery can render
 * all 50+ transitions grouped and labeled without hardcoding the list. Groups are
 * ordered as in `TRANSITION_TYPES`. Additive/metadata only — never affects parsing.
 */
export const TRANSITION_GROUPS: Record<TransitionType, TransitionMeta> = {
  // Fades
  crossfade: { label: "Crossfade", group: "Fades" },
  "dip-to-black": { label: "Dip to Black", group: "Fades" },
  dissolve: { label: "Dissolve", group: "Fades" },
  fadewhite: { label: "Fade to White", group: "Fades" },
  fadegrays: { label: "Fade to Grays", group: "Fades" },
  fadefast: { label: "Fade Fast", group: "Fades" },
  fadeslow: { label: "Fade Slow", group: "Fades" },
  // Wipes
  wipe: { label: "Wipe Left", group: "Wipes" },
  wiperight: { label: "Wipe Right", group: "Wipes" },
  wipeup: { label: "Wipe Up", group: "Wipes" },
  wipedown: { label: "Wipe Down", group: "Wipes" },
  wipetl: { label: "Wipe Top-Left", group: "Wipes" },
  wipetr: { label: "Wipe Top-Right", group: "Wipes" },
  wipebl: { label: "Wipe Bottom-Left", group: "Wipes" },
  wipebr: { label: "Wipe Bottom-Right", group: "Wipes" },
  // Slides
  slide: { label: "Slide Left", group: "Slides" },
  slideright: { label: "Slide Right", group: "Slides" },
  slideup: { label: "Slide Up", group: "Slides" },
  slidedown: { label: "Slide Down", group: "Slides" },
  // Smooths
  smooth: { label: "Smooth Left", group: "Smooth" },
  smoothright: { label: "Smooth Right", group: "Smooth" },
  smoothup: { label: "Smooth Up", group: "Smooth" },
  smoothdown: { label: "Smooth Down", group: "Smooth" },
  // Covers
  coverleft: { label: "Cover Left", group: "Covers" },
  coverright: { label: "Cover Right", group: "Covers" },
  coverup: { label: "Cover Up", group: "Covers" },
  coverdown: { label: "Cover Down", group: "Covers" },
  // Reveals
  revealleft: { label: "Reveal Left", group: "Reveals" },
  revealright: { label: "Reveal Right", group: "Reveals" },
  revealup: { label: "Reveal Up", group: "Reveals" },
  revealdown: { label: "Reveal Down", group: "Reveals" },
  // Opens & Closes
  circleopen: { label: "Circle Open", group: "Opens & Closes" },
  circleclose: { label: "Circle Close", group: "Opens & Closes" },
  horzopen: { label: "Horizontal Open", group: "Opens & Closes" },
  horzclose: { label: "Horizontal Close", group: "Opens & Closes" },
  vertopen: { label: "Vertical Open", group: "Opens & Closes" },
  vertclose: { label: "Vertical Close", group: "Opens & Closes" },
  // Shapes
  circlecrop: { label: "Circle Crop", group: "Shapes" },
  rectcrop: { label: "Rectangle Crop", group: "Shapes" },
  // Diagonals
  diagtl: { label: "Diagonal Top-Left", group: "Diagonals" },
  diagtr: { label: "Diagonal Top-Right", group: "Diagonals" },
  diagbl: { label: "Diagonal Bottom-Left", group: "Diagonals" },
  diagbr: { label: "Diagonal Bottom-Right", group: "Diagonals" },
  // Slices
  hlslice: { label: "Slice Left", group: "Slices" },
  hrslice: { label: "Slice Right", group: "Slices" },
  vuslice: { label: "Slice Up", group: "Slices" },
  vdslice: { label: "Slice Down", group: "Slices" },
  // Zoom
  zoom: { label: "Zoom", group: "Zoom" },
  zoomin: { label: "Zoom In", group: "Zoom" },
  // Effects
  pixelize: { label: "Pixelize", group: "Effects" },
  hblur: { label: "Blur", group: "Effects" },
  distance: { label: "Distance", group: "Effects" },
  radial: { label: "Radial", group: "Effects" },
  squeezeh: { label: "Squeeze Horizontal", group: "Effects" },
  squeezev: { label: "Squeeze Vertical", group: "Effects" },
};

/**
 * Chroma key (green/blue screen) on a visual clip: the `color` is made
 * transparent so the layer BENEATH shows through. Resolved to the ffmpeg
 * `chromakey` filter (color:similarity:blend, verified against ffmpeg-filters.html)
 * plus an optional `despill=type=…:mix=spill` pass. Optional so existing docs stay
 * valid. Composites best when the keyed clip is an OVERLAY (b-roll) over the main
 * footage; the canvas preview approximates the key by dropping the fill. Faithful:
 * removes a background color, never alters the subject.
 */
export const ChromaKey = z.object({
  /** The key color to remove (green screen by default). */
  color: HexColor.default("#00d000"),
  /** 0.01 (exact color only) .. 1 (matches everything) — ffmpeg chromakey `similarity`. */
  similarity: z.number().min(0.01).max(1).default(0.3),
  /** 0 (hard edge) .. 1 (soft edge) — ffmpeg chromakey `blend`. */
  blend: z.number().min(0).max(1).default(0.1),
  /** 0 (off) .. 1 — spill suppression strength (ffmpeg `despill` mix); 0 skips despill. */
  spill: z.number().min(0).max(1).default(0),
});
export type ChromaKey = z.infer<typeof ChromaKey>;

/**
 * How a visual clip composites over the layer beneath it. Canvas maps these to
 * `globalCompositeOperation`; the ffmpeg export maps them to `blend=all_mode=…`
 * (screen/multiply/overlay/addition/softlight — every name verified against
 * ffmpeg-filters.html). "normal" is a plain over-composite (the default; how every
 * clip behaved before). A non-normal blend on an OVERLAY (b-roll) clip covers the
 * frame and blends over the base — a finishing/texture/double-exposure layer.
 */
export const BlendMode = z.enum(["normal", "screen", "multiply", "overlay", "add", "soft-light"]);
export type BlendMode = z.infer<typeof BlendMode>;

/**
 * Blur or pixelate (mosaic) a rectangular REGION of a clip — hiding a face, plate,
 * or logo. Coordinates are composition px, top-left anchored. Resolved on export by
 * cropping the region, running `boxblur` (blur) or `pixelize` (pixelate) on it, and
 * overlaying it back (all verified against ffmpeg-filters.html). The canvas preview
 * approximates the obscured region. Faithful: obscures a region, no content change.
 */
export const RegionFx = z.object({
  type: z.enum(["blur", "pixelate"]),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** 0..1 strength (blur radius / mosaic block size scale). */
  amount: z.number().min(0).max(1).default(0.5),
});
export type RegionFx = z.infer<typeof RegionFx>;

/**
 * A mask that reveals only PART of a visual clip — inside the shape (or outside it
 * when `invert`). Coordinates are composition px, top-left anchored. The canvas
 * previews it with a clip path + a feathered edge; the ffmpeg export builds a
 * shaped alpha with `geq` (rect/ellipse, feather, invert) so the masked clip
 * composites over the layer beneath (best on an OVERLAY/b-roll clip). Optional so
 * existing docs stay valid. Faithful: hides part of the frame, no content change.
 */
export const Mask = z.object({
  shape: z.enum(["rect", "ellipse"]).default("rect"),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** Feather (soft edge) width in composition px (0 = hard edge). */
  feather: z.number().min(0).default(0),
  /** Reveal the OUTSIDE of the shape instead of the inside. */
  invert: z.boolean().default(false),
});
export type Mask = z.infer<typeof Mask>;

/**
 * A speed ramp (time-remap curve): ordered control points
 * `[clipProgress 0..1, speedMultiplier 0.1..10]`. The multiplier is the playback
 * rate at that point in the clip (1 = real time, <1 slow-mo, >1 fast); the
 * source-time mapping integrates it piecewise (see `speedRampIntegral`). Every
 * multiplier is > 0, so the mapping is strictly monotonic (playback always moves
 * forward). Faithful — retimes, never generates frames.
 */
export const SpeedRamp = z.array(z.tuple([z.number().min(0).max(1), z.number().min(0.1).max(10)]));
export type SpeedRamp = z.infer<typeof SpeedRamp>;

/** A clip that plays a slice of a video asset. */
export const VideoClip = z.object({
  ...clipBase,
  kind: z.literal("video"),
  mediaId: z.string().min(1),
  /** Offset into the source media where this clip starts, in seconds. */
  sourceIn: z.number().nonnegative().default(0),
  /**
   * Playback-speed multiplier (1 = real time). <1 is slow-motion, >1 is fast.
   * The clip still occupies `duration` seconds of the TIMELINE; speed only
   * changes how much SOURCE it consumes: source spans `duration * speed`
   * seconds (see sourceTimeAt in engine.ts). Faithful — retimes, no new frames.
   */
  speed: z.number().min(0.25).max(4).default(1),
  /**
   * Optional SPEED RAMP (time remap / CapCut "Curve"): control points
   * `[clipProgress 0..1, speedMultiplier 0.1..10]`. When present it OVERRIDES the
   * scalar `speed` — the source-time mapping integrates the piecewise-linear ramp
   * (see `speedRampIntegral` / `sourceTimeAt` in engine.ts), so a clip can slow
   * down then speed up within its timeline slot. Absent ⇒ the scalar `speed` is
   * used exactly as before (no behavior change). Additive + optional so existing
   * docs stay valid. Faithful: retimes existing frames, never synthesizes new ones.
   */
  speedRamp: SpeedRamp.optional(),
  transform: Transform.prefault({}),
  volume: z.number().min(0).max(1).default(1),
  look: ColorGrade.prefault({}),
  transitionInSec,
  transitionOutSec,
  transitionType,
  /** Optional punch-in emphasis (scale pulse over a timeline sub-range). */
  emphasis: Emphasis.optional(),
  /**
   * Optional animation keyframes (x/y/scale/rotation/opacity + volume), resolved
   * by the PURE `valueAt` helper. Optional so existing docs are unchanged; when
   * present they override the corresponding static transform/volume value.
   */
  keyframes: z.array(Keyframe).optional(),
  /**
   * Play this clip backwards. Optional + defaulted-off so existing docs stay
   * valid. The source-time mapping is reversed by `sourceTimeAt` (shared by
   * canvas + Stage) and the ffmpeg export adds `reverse`/`areverse`.
   */
  reversed: z.boolean().default(false),
  /**
   * Hold one SOURCE frame (this many seconds into the media) for the whole clip
   * duration — a freeze-frame. Optional (undefined ⇒ not frozen). `sourceTimeAt`
   * returns this constant when set; the ffmpeg export grabs the frame (`-ss`) and
   * clones it with `tpad=stop_mode=clone`.
   */
  freezeAtSec: z.number().nonnegative().optional(),
  /**
   * Stabilize shaky footage on export (ffmpeg vidstab two-pass: `vidstabdetect`
   * writes a per-clip transforms sidecar, `vidstabtransform` smooths). EXPORT-ONLY
   * — the live preview is unchanged (like loudnorm / cleanAudio), a documented
   * limitation. Optional + defaulted-off so existing docs are byte-identical.
   * Faithful: smooths camera motion of the EXISTING frames, invents nothing.
   */
  stabilize: z.boolean().default(false),
  /** Optional chroma key (green/blue screen) — composites over the layer beneath. */
  chroma: ChromaKey.optional(),
  /** How this clip composites over the layer beneath ("normal" = plain over). */
  blendMode: BlendMode.default("normal"),
  /** Optional blur/pixelate over a rectangular region (hide a face/plate/logo). */
  regionFx: RegionFx.optional(),
  /** Optional shape mask — reveal only inside (or outside) the shape. */
  mask: Mask.optional(),
  /** Audio fade-in / fade-out over the clip edges, in seconds (0 = none; ffmpeg afade). */
  fadeInSec: z.number().nonnegative().default(0),
  fadeOutSec: z.number().nonnegative().default(0),
  /** Stereo pan: -1 hard left … 0 center … 1 hard right (ffmpeg pan). */
  pan: z.number().min(-1).max(1).default(0),
});
export type VideoClip = z.infer<typeof VideoClip>;

/** A still image clip (with optional Ken Burns motion). */
export const ImageClip = z.object({
  ...clipBase,
  kind: z.literal("image"),
  mediaId: z.string().min(1),
  transform: Transform.prefault({}),
  look: ColorGrade.prefault({}),
  motion: KenBurns.prefault({}),
  transitionInSec,
  transitionOutSec,
  transitionType,
  /** Optional animation keyframes (x/y/scale/rotation/opacity), resolved by `valueAt`. */
  keyframes: z.array(Keyframe).optional(),
  /** Optional chroma key (green/blue screen) — composites over the layer beneath. */
  chroma: ChromaKey.optional(),
  /** How this clip composites over the layer beneath ("normal" = plain over). */
  blendMode: BlendMode.default("normal"),
  /** Optional blur/pixelate over a rectangular region (hide a face/plate/logo). */
  regionFx: RegionFx.optional(),
  /** Optional shape mask — reveal only inside (or outside) the shape. */
  mask: Mask.optional(),
});
export type ImageClip = z.infer<typeof ImageClip>;

/**
 * Font-weight for a text/caption clip. Named weights resolve to a CSS/canvas
 * weight by `fontWeightToCss` in grade.ts (medium→500, semibold→600) so the
 * canvas, the browser preview, and export agree. Defaulted so existing docs stay
 * valid.
 */
export const FontWeight = z.enum(["normal", "medium", "semibold", "bold"]);
export type FontWeight = z.infer<typeof FontWeight>;

/**
 * A stroked outline behind caption/title text — drawn with strokeText on the
 * canvas and `borderw`/`bordercolor` on the ffmpeg drawtext. `width` is 0 (no
 * outline) by default; the whole object is optional so existing docs are valid.
 */
export const TextOutline = z.object({
  color: HexColor.default("#000000"),
  /** Stroke width in composition px (0 = no outline). */
  width: z.number().min(0).default(0),
});
export type TextOutline = z.infer<typeof TextOutline>;

/**
 * A drop shadow behind caption/title text — drawn with the canvas `shadow*`
 * context props (color / blur / offset) and mirrored into the ffmpeg export
 * because captions rasterize through the SAME canvas `drawText`. Whole object is
 * optional so existing docs are valid; `blur` 0 with 0 offset is effectively off.
 */
export const TextShadow = z.object({
  color: HexColor.default("#000000"),
  /** Gaussian blur radius in composition px. */
  blur: z.number().min(0).default(6),
  /** Horizontal shadow offset in composition px. */
  offsetX: z.number().default(0),
  /** Vertical shadow offset in composition px. */
  offsetY: z.number().default(2),
});
export type TextShadow = z.infer<typeof TextShadow>;

/**
 * Background panel behind caption/title text. Supersedes the simple `background`
 * pill on a TextClip when present (that field still works when `box` is absent, so
 * existing docs are unchanged):
 *  - "none" — no panel (even if a legacy `background` is set).
 *  - "pill" — a rounded capsule sized to the text (the classic caption look).
 *  - "box"  — a rectangle with an explicit corner `radius`.
 * `color` falls back to the clip's `background` (then a default) when omitted, and
 * `opacity` multiplies the fill alpha. Padding is in composition px; when absent it
 * derives from the font size (matching the historical pill padding).
 */
export const CaptionBoxStyle = z.enum(["none", "pill", "box"]);
export type CaptionBoxStyle = z.infer<typeof CaptionBoxStyle>;

export const TextBackground = z.object({
  style: CaptionBoxStyle.default("pill"),
  /** Panel fill color; falls back to the clip's `background`, then a dark default. */
  color: HexColor.optional(),
  /** 0..1 opacity multiplier on the panel fill. */
  opacity: z.number().min(0).max(1).default(1),
  /** Corner radius (composition px). Absent ⇒ pill uses an auto capsule radius. */
  radius: z.number().min(0).optional(),
  /** Horizontal padding (composition px). Absent ⇒ derives from font size. */
  padX: z.number().min(0).optional(),
  /** Vertical padding (composition px). Absent ⇒ derives from font size. */
  padY: z.number().min(0).optional(),
});
export type TextBackground = z.infer<typeof TextBackground>;

/**
 * Caption/title vertical position preset (the common subtitle anchors). Resolved
 * to a `transform.y` by the PURE `captionAnchorY` helper in grade.ts (shared by the
 * director op, the canvas, and the UI wave) so the preset + offset always agree
 * with the free x/y already carried by `transform`. "free" means the transform is
 * authoritative (no preset). Optional so existing docs stay valid.
 */
export const CaptionPosition = z.enum(["top", "center", "bottom", "free"]);
export type CaptionPosition = z.infer<typeof CaptionPosition>;

/**
 * One word of a caption with its ABSOLUTE (timeline-second) start/end — the timing
 * that drives word-by-word "karaoke" highlighting. Populated by `add_captions` from
 * the transcript segment's word timings, mapped through the clip's cut/speed into
 * timeline seconds. Optional on a TextClip (absent ⇒ a plain static caption), so
 * existing docs stay valid. Shared, engine-agnostic data: the canvas highlights the
 * active word per frame (preview + canvas) and the ffmpeg export emits one gated PNG
 * per word (see render-ffmpeg), so all three agree.
 */
export const CaptionWord = z.object({
  text: z.string(),
  /** Absolute timeline second the word starts being spoken. */
  start: z.number().nonnegative(),
  /** Absolute timeline second the word stops being spoken. */
  end: z.number().nonnegative(),
});
export type CaptionWord = z.infer<typeof CaptionWord>;

/**
 * Karaoke (word-by-word highlight) settings for a caption. When `enabled` AND the
 * clip carries `words`, the renderer highlights the word whose [start,end] contains
 * the frame time; every other word draws in the base color. `style` picks HOW the
 * active word is emphasized:
 *  - "color" — recolor just the active word to `highlight` (the default).
 *  - "fill"  — a filled `highlight` pill behind the active word (dark ink on top).
 *  - "box"   — a `highlight` stroked box around the active word.
 * All defaulted / optional so absent ⇒ today's static caption (fully backward
 * compatible). Faithful: a text emphasis only, never a content change.
 */
export const Karaoke = z.object({
  enabled: z.boolean().default(false),
  /** Highlight color for the active word (recolor / fill / box, per `style`). */
  highlight: HexColor.default("#ffd54a"),
  style: z.enum(["color", "fill", "box"]).default("color"),
});
export type Karaoke = z.infer<typeof Karaoke>;

/** A text / title clip drawn directly by the renderer (no media needed). */
export const TextClip = z.object({
  ...clipBase,
  kind: z.literal("text"),
  text: z.string(),
  fontFamily: z.string().default("sans-serif"),
  fontSize: z.number().positive().default(64),
  fontWeight: FontWeight.default("normal"),
  /** Italic slant. Off by default so existing docs render identically. */
  italic: z.boolean().default(false),
  color: HexColor.default("#ffffff"),
  align: z.enum(["left", "center", "right"]).default("center"),
  /** Extra spacing between characters, composition px (0 = normal tracking). */
  letterSpacing: z.number().default(0),
  /** UPPERCASE the text at render time (source text unchanged). Off by default. */
  uppercase: z.boolean().default(false),
  /** Line height as a multiple of font size, used when text wraps. */
  lineHeight: z.number().positive().default(1.2),
  /**
   * Max text width (composition px) for word-wrap into multiple lines. Absent ⇒
   * the text stays on a single line (the historical behavior), so existing docs
   * are unchanged.
   */
  maxWidth: z.number().positive().optional(),
  transform: Transform.prefault({}),
  transitionInSec,
  transitionOutSec,
  transitionType,
  /**
   * Vertical position preset (top/center/bottom/free) — METADATA that the director
   * resolves into `transform.y` via `captionAnchorY`; the renderer honors the
   * resulting `transform.y`. Absent ⇒ the transform is authoritative.
   */
  position: CaptionPosition.optional(),
  /** Vertical offset (composition px) applied on top of the `position` preset. */
  positionOffset: z.number().default(0),
  /** Optional pill background behind the text (used by captions; see also `box`). */
  background: HexColor.optional(),
  /** Optional richer background panel (none/pill/box + color/opacity/radius/padding). */
  box: TextBackground.optional(),
  /** Optional stroked outline behind the text (readability over busy footage). */
  outline: TextOutline.optional(),
  /** Optional drop shadow behind the text (readability over busy footage). */
  shadow: TextShadow.optional(),
  /** Kinetic intro animation (slide + scale in); "none" by default. */
  anim: TextAnim.prefault({}),
  /** Optional animation keyframes (x/y/scale/rotation/opacity), resolved by `valueAt`. */
  keyframes: z.array(Keyframe).optional(),
  /**
   * Per-word timing (absolute timeline seconds) for word-by-word "karaoke"
   * highlighting. Populated by `add_captions` from the transcript; absent ⇒ a plain
   * caption. Additive/optional so existing docs stay valid.
   */
  words: z.array(CaptionWord).optional(),
  /**
   * Karaoke (word-by-word highlight) settings. When `karaoke.enabled` AND `words`
   * are present the renderer highlights the active word per frame; absent/disabled ⇒
   * today's static caption. Additive/optional — fully backward compatible.
   */
  karaoke: Karaoke.optional(),
});
export type TextClip = z.infer<typeof TextClip>;

/**
 * Curated caption/title fonts offered in the UI. Every entry is a stack backed
 * by a CSS GENERIC FAMILY (sans-serif / serif / monospace / cursive) so it
 * always resolves — in the browser preview and on the canvas — even when the
 * named face is not installed. Real TTF bundling for the ffmpeg export is a
 * follow-up; export falls back to the platform's default drawtext font.
 */
export const CAPTION_FONTS = [
  "sans-serif",
  "Inter, sans-serif",
  "Helvetica, Arial, sans-serif",
  "Arial, sans-serif",
  "Roboto, sans-serif",
  "Montserrat, sans-serif",
  "Georgia, serif",
  "Times New Roman, serif",
  "Courier New, monospace",
  "Impact, sans-serif",
] as const;
export type CaptionFont = (typeof CAPTION_FONTS)[number];

/** An audio-only clip (has no visual representation). */
export const AudioClip = z.object({
  ...clipBase,
  kind: z.literal("audio"),
  mediaId: z.string().min(1),
  sourceIn: z.number().nonnegative().default(0),
  volume: z.number().min(0).max(1).default(1),
  /** Optional volume keyframes (0..1), resolved by `valueAt`; e.g. audio fades/ducks. */
  keyframes: z.array(Keyframe).optional(),
  /** Audio fade-in / fade-out over the clip edges, in seconds (0 = none; ffmpeg afade). */
  fadeInSec: z.number().nonnegative().default(0),
  fadeOutSec: z.number().nonnegative().default(0),
  /** Stereo pan: -1 hard left … 0 center … 1 hard right (ffmpeg pan). */
  pan: z.number().min(-1).max(1).default(0),
});
export type AudioClip = z.infer<typeof AudioClip>;

/** A solid color fill — full-frame backgrounds, letterbox, and fades to/from black. */
export const SolidClip = z.object({
  ...clipBase,
  kind: z.literal("solid"),
  color: HexColor.default("#000000"),
  transform: Transform.prefault({}),
  transitionInSec,
  transitionOutSec,
  transitionType,
  /** Optional animation keyframes (x/y/scale/rotation/opacity), resolved by `valueAt`. */
  keyframes: z.array(Keyframe).optional(),
});
export type SolidClip = z.infer<typeof SolidClip>;

/**
 * One point the pointer eases THROUGH, in composition pixels, reached at `atSec`
 * (TIMELINE seconds). A CursorClip's waypoints are resolved by the PURE
 * `cursorPositionAt` helper in grade.ts so the pointer sits at the same place in
 * the canvas preview, the browser Stage, and the ffmpeg export.
 */
export const CursorWaypoint = z.object({
  x: z.number(),
  y: z.number(),
  /** Timeline time (seconds) the pointer reaches this waypoint. */
  atSec: z.number().nonnegative().default(0),
});
export type CursorWaypoint = z.infer<typeof CursorWaypoint>;

/**
 * An animated mouse-pointer overlay for product walkthroughs / interaction demos.
 * The pointer eases between `waypoints` (ease-in-out) and each time in `clicks`
 * triggers an expanding click ripple. Purely data-driven — position and ripples
 * are resolved by PURE helpers (`cursorPositionAt`, `cursorRipples`) so canvas,
 * Stage, and export agree. Faithful: a synthetic overlay, never a content change.
 */
export const CursorClip = z.object({
  ...clipBase,
  kind: z.literal("cursor"),
  /** Points (composition px) the pointer eases through, ordered by `atSec`. */
  waypoints: z.array(CursorWaypoint).min(1),
  /** Timeline times (seconds) at which a click ripple fires. */
  clicks: z.array(z.number().nonnegative()).default([]),
  /** Pointer size (px, the arrow's long edge). */
  size: z.number().positive().default(48),
  /** Pointer fill color. */
  color: HexColor.default("#ffffff"),
  /** How long each click ripple lasts, in seconds. */
  rippleSec: z.number().positive().default(0.45),
});
export type CursorClip = z.infer<typeof CursorClip>;

/**
 * A callout / highlight box over a rectangular region of the frame — for
 * pointing at a field, button, or menu in a walkthrough. Draws a bright rounded
 * border around {x,y,w,h} (composition px, top-left anchored), optionally dims
 * everything OUTSIDE the rect, shows an optional `label`, and can `zoom` the frame
 * toward the rect (scale about the rect's center). All extras are defaulted so the
 * clip is valid with just a rect. Faithful: an overlay + optional magnify, never a
 * content change. The zoom transform is resolved by the PURE `calloutTransform`
 * helper and the border position by `calloutScreenRect`, shared by canvas + export.
 */
export const CalloutClip = z.object({
  ...clipBase,
  kind: z.literal("callout"),
  /** Left edge of the highlighted rect, composition px. */
  x: z.number(),
  /** Top edge of the highlighted rect, composition px. */
  y: z.number(),
  /** Width of the highlighted rect, composition px. */
  w: z.number().positive(),
  /** Height of the highlighted rect, composition px. */
  h: z.number().positive(),
  /** Optional caption drawn just above (or below) the rect. */
  label: z.string().optional(),
  /** Border color (defaults to the amber action color). */
  color: HexColor.default("#ffcf70"),
  /** Border thickness, composition px. */
  borderWidth: z.number().min(0).default(4),
  /** Corner radius of the rounded border, composition px. */
  radius: z.number().min(0).default(12),
  /** Dim everything outside the rect. */
  dim: z.boolean().default(true),
  /** 0..1 strength of the outside dim when `dim` is on. */
  dimOpacity: z.number().min(0).max(1).default(0.55),
  /** Scale the frame toward the rect's center (1 = no zoom). */
  zoom: z.number().min(1).default(1),
});
export type CalloutClip = z.infer<typeof CalloutClip>;

/**
 * Whole-composition VFX overlays — a finishing pass applied on top of the fully
 * composited frame (all clips already drawn). Expressed as data so it previews on
 * the canvas exactly as it renders on export:
 *  - vignette  — 0..1 darkening toward the frame edges (radial gradient on the
 *                canvas; the `vignette` filter, angle-scaled, on export).
 *  - grain     — 0..1 procedural film grain (seeded noise on the canvas; the
 *                `noise=alls=N:allf=t+u` filter on export).
 *  - lightLeak — a warm light-leak wash (a diagonal warm gradient screen-blended
 *                on the canvas; a warm color source `blend=all_mode=screen` on
 *                export).
 * All DEFAULTED (off) so existing docs stay valid. Faithful: tone/texture only,
 * never a content change. (Defined here — before the Clip union — so an
 * AdjustmentClip can carry an optional Vfx; the whole-doc finishing pass reuses it.)
 */
export const Vfx = z.object({
  vignette: z.number().min(0).max(1).default(0),
  grain: z.number().min(0).max(1).default(0),
  lightLeak: z.boolean().default(false),
});
export type Vfx = z.infer<typeof Vfx>;

/**
 * An ADJUSTMENT LAYER — a color grade (+ optional whole-frame Vfx) that applies to
 * EVERYTHING BENEATH it over a timeline range [start, start+duration]. Unlike a
 * per-clip `look`, an adjustment grades the FINAL composited frame, gated to its
 * window, so one grade can span many clips. It lives on its OWN (topmost visual)
 * track — array order is z-order, so an adjustment placed on the last track sits
 * over all footage. The renderers apply it as a POST-COMPOSITE pass:
 *  - canvas: re-grades the whole frame while the clip is active (the LUT field, if
 *            any, is export-only — the same documented limit as per-clip LUTs);
 *  - ffmpeg: appends the grade's eq/curves/colorbalance/hue (+ lut3d) to the
 *            composited stream, each gated by `enable='between(t,start,end)'`.
 * Every nested field is defaulted/optional (grade prefaults to neutral, vfx is
 * optional), so an adjustment clip is valid with just id/kind/start/duration and
 * existing docs are unaffected. Faithful: a color/tone remap only, no content change.
 */
export const AdjustmentClip = z.object({
  ...clipBase,
  kind: z.literal("adjustment"),
  /** The color grade applied to everything beneath, over the clip's window. */
  grade: ColorGrade.prefault({}),
  /** Optional whole-frame finishing (vignette / grain) gated to the clip's window. */
  vfx: Vfx.optional(),
});
export type AdjustmentClip = z.infer<typeof AdjustmentClip>;

/** The vector shapes the Design room / `add_shape` can place. */
export const SHAPE_KINDS = ["rect", "ellipse", "line", "arrow"] as const;
export const ShapeKind = z.enum(SHAPE_KINDS);
export type ShapeKind = z.infer<typeof ShapeKind>;

/**
 * A vector SHAPE overlay — rectangle, ellipse, line, or arrow — for annotations,
 * lower-third backing bars, highlight boxes, progress bars, and pointers. Drawn by
 * the SAME canvas engine that paints the live preview and (for export) rasterized to
 * a transparent composition-sized PNG that ffmpeg overlays — so preview, node-canvas
 * render, and export agree (the "one pure helper → three renderers" rule; shapes reuse
 * the text/callout PNG-overlay path). Positioned by `transform` (center anchor), like
 * every other visual clip, so keyframes/animation just work. Faithful: a synthetic
 * overlay, never a content change.
 *
 * Geometry: `w`×`h` is the shape's box in composition px (centered on transform.x/y).
 * For `line`/`arrow`, `w` is the length, the shape is horizontal before `rotation`,
 * and `strokeWidth` is the thickness. `fill` paints rect/ellipse interiors (""=no
 * fill, outline only); `stroke`+`strokeWidth` draw the outline (rect/ellipse) or the
 * line/arrow itself; `radius` rounds rectangle corners. All additive/defaulted so
 * existing docs are unaffected.
 */
export const ShapeClip = z.object({
  ...clipBase,
  kind: z.literal("shape"),
  shape: ShapeKind.default("rect"),
  /** Shape box in composition px (line/arrow: `w` is length, `strokeWidth` the thickness). */
  w: z.number().positive().default(320),
  h: z.number().positive().default(180),
  /** Fill color for rect/ellipse. Empty string ⇒ no fill (outline only). */
  fill: z.union([HexColor, z.literal("")]).default("#2f6690"),
  /** Fill opacity 0..1 (independent of the transform's whole-shape opacity). */
  fillOpacity: z.number().min(0).max(1).default(1),
  /** Outline color (rect/ellipse), and the color of a line/arrow. "" ⇒ none. */
  stroke: z.union([HexColor, z.literal("")]).default(""),
  /** Outline / line thickness in px (line & arrow always draw with this). */
  strokeWidth: z.number().min(0).default(0),
  /** Rounded-corner radius for `rect` (px; ignored by other shapes). */
  radius: z.number().min(0).default(0),
  transform: Transform.prefault({}),
  transitionInSec,
  transitionOutSec,
  transitionType,
  /** Optional animation keyframes (x/y/scale/rotation/opacity), resolved by `valueAt`. */
  keyframes: z.array(Keyframe).optional(),
});
export type ShapeClip = z.infer<typeof ShapeClip>;

export const Clip = z.discriminatedUnion("kind", [
  VideoClip,
  ImageClip,
  TextClip,
  AudioClip,
  SolidClip,
  CursorClip,
  CalloutClip,
  AdjustmentClip,
  ShapeClip,
]);
export type Clip = z.infer<typeof Clip>;

/** Visual tracks paint bottom-to-top; audio tracks are mixed. */
export const TrackKind = z.enum(["visual", "audio"]);
export type TrackKind = z.infer<typeof TrackKind>;

/**
 * A track (a horizontal lane of clips). ARRAY ORDER IS Z-ORDER: earlier tracks
 * paint first (bottom of the stack), later tracks paint over them — the single
 * source of truth honored by `activeClipsAt` (canvas + Stage) and the ffmpeg
 * export's layer compositing. There is deliberately NO `z` field; reordering a
 * layer means reordering the `tracks` array (see `reorderTrack`).
 *
 * The metadata fields are all additive (optional / defaulted-off) so every
 * existing EditDoc still parses:
 *  - name   — header label in the timeline UI (falls back to `id`).
 *  - hidden — exclude the track from every render (visual layers are skipped by
 *             `activeClipsAt`; the ffmpeg export skips a hidden track's clips and
 *             hidden audio).
 *  - locked — UI-only edit guard; the pure track ops refuse to move clips on /
 *             remove a locked track.
 *  - muted  — audio track dropped from the export mix.
 *  - solo   — audio solo: when ANY audio track solos, only soloed audio plays.
 */
export const Track = z.object({
  id: z.string().min(1),
  kind: TrackKind,
  clips: z.array(Clip).default([]),
  /** Header label for the timeline UI; falls back to `id` when absent. */
  name: z.string().optional(),
  /** Exclude this track from every render (skipped by activeClipsAt + export). */
  hidden: z.boolean().default(false),
  /** UI-only: block edits/selection on this track's clips (pure ops refuse moves). */
  locked: z.boolean().default(false),
  /** Audio track: drop it from the export mix. */
  muted: z.boolean().default(false),
  /** Audio track: when any audio track solos, only soloed audio plays. */
  solo: z.boolean().default(false),
});
export type Track = z.infer<typeof Track>;

export const Meta = z.object({
  title: z.string().default("Untitled"),
  fps: z.number().positive().default(30),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  background: HexColor.default("#000000"),
});
export type Meta = z.infer<typeof Meta>;

/** Output quality / enhancement settings, applied at export. */
export const QualityPreset = z.enum(["standard", "high", "ultra"]);
export type QualityPreset = z.infer<typeof QualityPreset>;

export const Quality = z.object({
  preset: QualityPreset.default("standard"),
  /** Target output resolution (upscale/downscale at export). */
  targetWidth: z.number().int().positive().optional(),
  targetHeight: z.number().int().positive().optional(),
  /** Target output fps (frame interpolation at export when higher than source). */
  fps: z.number().positive().optional(),
  sharpen: z.number().min(0).max(1).default(0),
  denoise: z.number().min(0).max(1).default(0),
  /** AI super-resolution — requires a gated model/API/CLI; off by default. */
  aiUpscale: z.boolean().default(false),
  /** Which enhance provider to use when aiUpscale is on (see @cadence/enhance). */
  enhanceProvider: z.string().optional(),
  /**
   * Faithful = detail-preserving upscale only. MUST NOT alter faces, identity,
   * or content (no generative redraw). Always true; kept explicit as a contract.
   */
  faithful: z.boolean().default(true),
});
export type Quality = z.infer<typeof Quality>;

/**
 * A timeline marker (a labeled point in TIMELINE seconds) — chapter points, beat
 * hits, review notes. Persisted on the doc so they survive round-trips and can
 * drive chapters/exports. `label` is optional. Defaulted-empty so existing docs
 * stay valid.
 */
export const Marker = z.object({
  /** Timeline time in seconds. */
  t: z.number().nonnegative(),
  label: z.string().optional(),
});
export type Marker = z.infer<typeof Marker>;

/**
 * The whole project as a declarative document. `version` is the schema version
 * so stored docs can be migrated. This object is what the Director emits and
 * what the DB versions.
 */
export const EditDoc = z.object({
  version: z.literal(1),
  meta: Meta.prefault({}),
  media: z.array(MediaAsset).default([]),
  tracks: z.array(Track).default([]),
  quality: Quality.prefault({}),
  /** Whole-frame finishing overlays (vignette / grain / light-leak); off by default. */
  vfx: Vfx.prefault({}),
  /** Timeline markers (chapter points / beats / notes); empty by default. */
  markers: z.array(Marker).default([]),
  /**
   * Normalize the final mix to a broadcast/streaming loudness target (EBU R128)
   * on export via the ffmpeg `loudnorm` filter (I=-14 LUFS, TP=-1.5 dBTP, LRA=11 —
   * a sensible streaming target). Off by default so existing docs/exports are
   * unchanged. Faithful: levels only, no content change.
   */
  loudnorm: z.boolean().default(false),
  /**
   * Clean the final mix's audio (noise reduction) on export. When on, the export
   * inserts an FFT denoise (`afftdn`) into the final mixed-audio chain BEFORE
   * `loudnorm` (denoise, then normalize) — a good, model-free default. If an
   * `arnndn` model path is configured via env (`ARNNDN_MODEL`), the export prefers
   * the stronger model-based `arnndn` denoiser instead; otherwise `afftdn` ships as
   * the default. Off by default so existing docs/exports are byte-identical, and a
   * no-op on audioless docs (nothing to denoise). Like `loudnorm`, this is
   * EXPORT-ONLY — the canvas/browser preview does not denoise (documented). Faithful:
   * attenuates steady background noise only, never a content change.
   */
  cleanAudio: z.boolean().default(false),
});
export type EditDoc = z.infer<typeof EditDoc>;

/** Parse + fully-default an unknown value into a valid EditDoc (throws on error). */
export function parseEditDoc(input: unknown): EditDoc {
  return EditDoc.parse(input);
}

/** Safe parse variant returning zod's result union. */
export function safeParseEditDoc(input: unknown) {
  return EditDoc.safeParse(input);
}
