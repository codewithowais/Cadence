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

/** A clip that plays a slice of a video asset. */
export const VideoClip = z.object({
  ...clipBase,
  kind: z.literal("video"),
  mediaId: z.string().min(1),
  /** Offset into the source media where this clip starts, in seconds. */
  sourceIn: z.number().nonnegative().default(0),
  transform: Transform.prefault({}),
  volume: z.number().min(0).max(1).default(1),
});
export type VideoClip = z.infer<typeof VideoClip>;

/** A still image clip. */
export const ImageClip = z.object({
  ...clipBase,
  kind: z.literal("image"),
  mediaId: z.string().min(1),
  transform: Transform.prefault({}),
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

export const Clip = z.discriminatedUnion("kind", [
  VideoClip,
  ImageClip,
  TextClip,
  AudioClip,
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
