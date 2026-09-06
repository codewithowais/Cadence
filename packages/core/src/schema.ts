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
 * ffmpeg export all read the same interpolation (export approximates it with a
 * piecewise-LINEAR time expression — the eased curve is a preview nicety, exactly
 * as the cursor path is eased in preview but linear on export). Faithful: keyframes
 * only move/scale/rotate/fade or re-level the existing clip, never a content change.
 *
 *  - x | y     — the clip's transform anchor (composition px).
 *  - scale     — uniform scale multiplier (1 = native).
 *  - rotation  — clockwise degrees.
 *  - opacity   — 0..1 (multiplies any transition ramp).
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
 * How a visual clip transitions in/out over its in/out ramp. All faithful — no
 * content change, only how the existing frames reveal/leave:
 *  - "crossfade"    — opacity ramp (the default; how every clip behaved before).
 *  - "dip-to-black" — fade out then in THROUGH black (opacity ramp against the
 *                     black composition background), i.e. a dip.
 *  - "slide"        — the frame slides in from the right / out to the left.
 *  - "wipe"         — the frame is revealed left-to-right (a hard-edged wipe).
 *  - "dissolve"     — a soft grain dissolve; opacity-based like crossfade in the
 *                     preview, its own xfade look on export.
 *  - "zoom"         — the frame scales in while it fades (a punchy reveal).
 *  - "smooth"       — a soft, feathered horizontal slide/reveal.
 * Resolved by PURE helpers in grade.ts (transitionMotion) so canvas, Stage and
 * the ffmpeg xfade map (crossfade→fade, dip-to-black→fadeblack, slide→slideleft,
 * wipe→wipeleft, dissolve→dissolve, zoom→zoomin, smooth→smoothleft — every name
 * verified against the ffmpeg xfade transition enum) all agree.
 */
export const TransitionType = z.enum([
  "crossfade",
  "dip-to-black",
  "slide",
  "wipe",
  "dissolve",
  "zoom",
  "smooth",
]);
export type TransitionType = z.infer<typeof TransitionType>;
const transitionType = TransitionType.default("crossfade");

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

/** A text / title clip drawn directly by the renderer (no media needed). */
export const TextClip = z.object({
  ...clipBase,
  kind: z.literal("text"),
  text: z.string(),
  fontFamily: z.string().default("sans-serif"),
  fontSize: z.number().positive().default(64),
  fontWeight: FontWeight.default("normal"),
  color: HexColor.default("#ffffff"),
  align: z.enum(["left", "center", "right"]).default("center"),
  transform: Transform.prefault({}),
  transitionInSec,
  transitionOutSec,
  transitionType,
  /** Optional pill background behind the text (used by captions). */
  background: HexColor.optional(),
  /** Optional stroked outline behind the text (readability over busy footage). */
  outline: TextOutline.optional(),
  /** Kinetic intro animation (slide + scale in); "none" by default. */
  anim: TextAnim.prefault({}),
  /** Optional animation keyframes (x/y/scale/rotation/opacity), resolved by `valueAt`. */
  keyframes: z.array(Keyframe).optional(),
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

export const Clip = z.discriminatedUnion("kind", [
  VideoClip,
  ImageClip,
  TextClip,
  AudioClip,
  SolidClip,
  CursorClip,
  CalloutClip,
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
 * never a content change.
 */
export const Vfx = z.object({
  vignette: z.number().min(0).max(1).default(0),
  grain: z.number().min(0).max(1).default(0),
  lightLeak: z.boolean().default(false),
});
export type Vfx = z.infer<typeof Vfx>;

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
