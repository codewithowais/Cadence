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
export const ColorGrade = z.object({
  brightness: z.number().min(0).default(1),
  contrast: z.number().min(0).default(1),
  saturation: z.number().min(0).default(1),
  warmth: z.number().min(0).max(1).default(0),
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
  /** "none" (static) or "kinetic" (slide + scale in over `durationSec`). */
  style: z.enum(["none", "kinetic"]).default("none"),
  /** Offset (composition px) the text slides FROM, toward its resting x. */
  fromX: z.number().default(0),
  /** Offset (composition px) the text slides FROM, toward its resting y. */
  fromY: z.number().default(0),
  /** Scale the text grows FROM toward its resting 1 (e.g. 0.6). */
  fromScale: z.number().positive().default(1),
  /** How long the intro animation lasts, in seconds (0 = no animation). */
  durationSec: z.number().nonnegative().default(0),
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
 * Resolved by PURE helpers in grade.ts (transitionMotion) so canvas, Stage and
 * the ffmpeg xfade map (crossfade→fade, dip-to-black→fadeblack, slide→slideleft,
 * wipe→wipeleft) all agree.
 */
export const TransitionType = z.enum(["crossfade", "dip-to-black", "slide", "wipe"]);
export type TransitionType = z.infer<typeof TransitionType>;
const transitionType = TransitionType.default("crossfade");

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
});
export type ImageClip = z.infer<typeof ImageClip>;

/** A text / title clip drawn directly by the renderer (no media needed). */
export const TextClip = z.object({
  ...clipBase,
  kind: z.literal("text"),
  text: z.string(),
  fontFamily: z.string().default("sans-serif"),
  fontSize: z.number().positive().default(64),
  color: HexColor.default("#ffffff"),
  align: z.enum(["left", "center", "right"]).default("center"),
  transform: Transform.prefault({}),
  transitionInSec,
  transitionOutSec,
  transitionType,
  /** Optional pill background behind the text (used by captions). */
  background: HexColor.optional(),
  /** Kinetic intro animation (slide + scale in); "none" by default. */
  anim: TextAnim.prefault({}),
});
export type TextClip = z.infer<typeof TextClip>;

/** An audio-only clip (has no visual representation). */
export const AudioClip = z.object({
  ...clipBase,
  kind: z.literal("audio"),
  mediaId: z.string().min(1),
  sourceIn: z.number().nonnegative().default(0),
  volume: z.number().min(0).max(1).default(1),
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
});
export type SolidClip = z.infer<typeof SolidClip>;

export const Clip = z.discriminatedUnion("kind", [
  VideoClip,
  ImageClip,
  TextClip,
  AudioClip,
  SolidClip,
]);
export type Clip = z.infer<typeof Clip>;

/** Visual tracks paint bottom-to-top; audio tracks are mixed. */
export const TrackKind = z.enum(["visual", "audio"]);
export type TrackKind = z.infer<typeof TrackKind>;

export const Track = z.object({
  id: z.string().min(1),
  kind: TrackKind,
  clips: z.array(Clip).default([]),
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
