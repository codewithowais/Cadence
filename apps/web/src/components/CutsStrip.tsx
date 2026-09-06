"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  clipProgress,
  speedRampIntegral,
  transitionStyle,
  valueAt,
  TRANSITION_GROUPS,
  TRANSITION_TYPES,
  type Clip,
  type EditDoc,
  type KeyframeEasing,
  type KeyframeProp,
  type Track,
  type TrackKind,
  type TransitionType,
} from "@cadence/core";
import { clipKeyframes, SPEED_RAMP_PRESETS, type SpeedRampPreset } from "@cadence/director";
import { fmtTime } from "@/lib/format";
import { computeWaveform } from "@/lib/waveform";
import { findClip, isMainSequentialTrack, maxTimelineDuration, MIN_CLIP_SEC, type TrimEdge } from "@/lib/edit-ops";
import { hasAnyTransition, mainCutCount } from "@/lib/transition-ops";

/** The media whose audio the waveform should visualize (prefers the base video). */
export interface WaveformSource {
  mediaId: string;
  file?: File;
  url?: string;
}

/** Track-flag toggles surfaced on the header (subset of the schema's booleans). */
export type TrackFlag = "hidden" | "locked" | "muted" | "solo";

/**
 * Timeline trim mode (Wave E). "normal" keeps the existing move/trim/reorder
 * behaviour; the three advanced modes re-purpose a horizontal drag on a MAIN
 * sequential video/image clip into a roll / slip / slide edit.
 */
export type TrimMode = "normal" | "roll" | "slip" | "slide";

/**
 * Direct-manipulation callbacks. Each returns a doc mutation that the editor
 * routes through its commit/undo history — the CutsStrip never mutates the doc
 * itself. `coalesceKey` lets a live drag collapse into a single undo step.
 */
export interface TimelineEdit {
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  onTrim: (clipId: string, edge: TrimEdge, edgeTime: number, coalesceKey: string) => void;
  onReorder: (clipId: string, toSeqIndex: number) => void;
  onSplitAt: (clipId: string, atSec: number) => void;
  onDuplicate: (clipId: string) => void;
  onRippleDelete: (clipId: string) => void;
  onDelete: (clipId: string) => void;
  onSetClipVolume: (clipId: string, volume: number, coalesceKey: string) => void;
  onMove: (clipId: string, dir: "earlier" | "later") => void;
  markers: number[];
  onAddMarker: () => void;
  onRemoveMarker: (t: number) => void;
  // ---- Track management (Wave A) ------------------------------------------
  /** Add an empty visual/overlay or audio track. */
  onAddTrack: (kind: TrackKind) => void;
  /** Remove a track and its clips (the header guards non-empty / base removal). */
  onRemoveTrack: (trackId: string) => void;
  /** Rename a track (header label only). */
  onRenameTrack: (trackId: string, name: string) => void;
  /** Toggle one of a track's boolean flags (hidden/locked/muted/solo). */
  onSetTrackFlag: (trackId: string, flag: TrackFlag, value: boolean) => void;
  /** Move a track to a new z-index in the doc's `tracks` array (0 = bottom). */
  onReorderTrack: (trackId: string, toIndex: number) => void;
  /** Move a clip onto another track at a (snapped) start; magnetic lanes gap-close. */
  onMoveClipToTrack: (clipId: string, toTrackId: string, toStartSec?: number) => void;
  // ---- Per-cut transitions (Wave C — P1-1) --------------------------------
  /** Set one cut's incoming transition (type + duration in seconds). */
  onSetTransition: (clipId: string, type: TransitionType, durSec: number) => void;
  /** Turn one cut back into a hard cut (clear its transition). */
  onClearTransition: (clipId: string) => void;
  /**
   * Apply one transition type + duration to EVERY cut on the main visual
   * track(s) at once (popover "Apply to all cuts" + toolbar "Auto"). Batched
   * into a single undo step by the editor.
   */
  onApplyTransitionToAll: (type: TransitionType, durSec: number) => void;
  /** Hard-cut every main-track boundary (clear all transitions) — one undo step. */
  onRemoveAllTransitions: () => void;
  /** Fade the last clip out to black (its outgoing ramp) — a transition with no cut. */
  onSetFadeOut: (clipId: string, durSec: number) => void;
  /** Remove a clip's fade-out-to-black. */
  onClearFadeOut: (clipId: string) => void;
  // ---- On-timeline keyframes (Wave C — P1-2) ------------------------------
  /** Upsert a keyframe on a clip (add-at-playhead / value edit / easing change). */
  onSetKeyframe: (
    clipId: string,
    input: { prop: KeyframeProp; t: number; value: number; easing?: KeyframeEasing },
  ) => void;
  /** Move a keyframe in time (diamond drag); coalesced into one undo step. */
  onMoveKeyframe: (clipId: string, prop: KeyframeProp, fromT: number, toT: number, value?: number) => void;
  /** Remove a keyframe (right-click / menu on a diamond). */
  onRemoveKeyframe: (clipId: string, prop: KeyframeProp, t: number) => void;
  // ---- Audio fade handles (Wave C — P1-5) ---------------------------------
  /** Set one clip's fade-in / fade-out (corner drag); coalesced into one undo. */
  onSetAudioFade: (
    clipId: string,
    fade: { fadeInSec?: number; fadeOutSec?: number },
    coalesceKey: string,
  ) => void;
  // ---- Roll / slip / slide trims (Wave E) ---------------------------------
  // Each shifts a MAIN-track cut by `deltaSec`, routed through the pure
  // @cadence/director op → the editor's undoable commit. During a live drag the
  // CutsStrip passes the pre-drag `baseDoc` so the cumulative delta always
  // applies to the same baseline (idempotent) and the whole drag coalesces into
  // one undo step; the inspector's ±0.1s steppers omit it (a discrete nudge onto
  // the freshest doc).
  /** Roll the cut between this clip and its next neighbour. */
  onRoll: (clipId: string, deltaSec: number, coalesceKey: string, baseDoc?: EditDoc) => void;
  /** Slip the clip's source in/out (timeline position fixed). */
  onSlip: (clipId: string, deltaSec: number, coalesceKey: string, baseDoc?: EditDoc) => void;
  /** Slide the clip along the timeline; its neighbours absorb the move. */
  onSlide: (clipId: string, deltaSec: number, coalesceKey: string, baseDoc?: EditDoc) => void;
  // ---- Speed ramp / time remap (CapCut "Curve") ---------------------------
  /**
   * Apply a speed ramp to a VIDEO clip: a named `preset` or explicit
   * `[clipProgress 0..1, speedMultiplier]` control points. During a live curve
   * drag pass a `coalesceKey` so the whole gesture collapses into one undo step.
   */
  onSetSpeedRamp: (
    clipId: string,
    arg: { preset?: SpeedRampPreset; points?: [number, number][] },
    coalesceKey?: string,
  ) => void;
  /** Set a video clip's CONSTANT speed (clears any ramp); coalesced per clip. */
  onSetConstantSpeed: (clipId: string, speed: number, coalesceKey: string) => void;
  /** Remove a video clip's speed ramp — revert to its constant speed. */
  onClearSpeedRamp: (clipId: string) => void;
  // ---- Drag-and-drop from the Media grid (B4) ------------------------------
  /**
   * Drop a Media-grid tile onto a lane: insert that media as a clip on `trackId`
   * at the snapped `startSec`. Routed through the editor's undoable commit path.
   */
  onDropMedia: (mediaId: string, trackId: string, startSec: number) => void;
}

/** MIME types the Media grid sets on a tile drag; used to gate lane drops by family. */
export const MEDIA_DND_ID = "application/x-cadence-media";
export const MEDIA_DND_AUDIO = "application/x-cadence-audio";
export const MEDIA_DND_VISUAL = "application/x-cadence-visual";

/**
 * MIME type a transition swatch sets when dragged from the gallery onto a cut.
 * Mirrors the Media-grid `onDropMedia` plumbing: the payload is `type|durSec` so
 * the drop can reuse the popover's picked duration.
 */
export const TRANSITION_DND_ID = "application/x-cadence-transition";

/** Read a transition-swatch drag off a DataTransfer, or null if it isn't one. */
function readTransitionDrag(dt: DataTransfer): { type: TransitionType; durSec: number } | null {
  if (!Array.from(dt.types).includes(TRANSITION_DND_ID)) return null;
  const raw = dt.getData(TRANSITION_DND_ID);
  if (!raw) return { type: "crossfade", durSec: 0.6 }; // payload only readable on drop
  const [type, dur] = raw.split("|");
  return { type: (type || "crossfade") as TransitionType, durSec: Number(dur) || 0.6 };
}

interface CutsStripProps {
  doc: EditDoc;
  timeSec: number;
  durationSec: number;
  onSeek: (t: number) => void;
  waveform?: WaveformSource | null;
  edit: TimelineEdit;
}

const TRACK_COLORS: Record<string, string> = {
  video: "bg-teal/25 border-teal/50 text-teal",
  image: "bg-teal/25 border-teal/50 text-teal",
  text: "bg-amber/20 border-amber/50 text-amber",
  audio: "bg-elevated border-line text-muted",
  solid: "bg-line/40 border-line text-faint",
  adjustment: "bg-amber-deep/25 border-amber-deep/60 text-amber-bright",
};

const ZOOM_MIN = 1;
const ZOOM_MAX = 24;
/** Pixels within which a drag snaps to a neighbor edge / playhead / marker. */
const SNAP_PX = 8;
/** Width of the sticky track-header gutter (px). */
const GUTTER_PX = 152;

/** Read a Media-grid drag off a DataTransfer, or null if it isn't one. */
function readMediaDrag(dt: DataTransfer): { visual: boolean; audio: boolean } | null {
  const types = Array.from(dt.types);
  if (!types.includes(MEDIA_DND_ID)) return null;
  return { visual: types.includes(MEDIA_DND_VISUAL), audio: types.includes(MEDIA_DND_AUDIO) };
}

function clipLabel(clip: Clip): string {
  if (clip.kind === "text") return `“${clip.text.slice(0, 18)}”`;
  if (clip.kind === "audio") return "audio";
  if (clip.kind === "solid") return "solid";
  if (clip.kind === "adjustment") return "adjustment";
  return fmtTime(clip.duration);
}

/** A readable header label for a track: its name, else a humanized id. */
function trackLabel(track: Track): string {
  if (track.name && track.name.trim()) return track.name;
  return track.id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** True when `clip` may live on a track of `kind` (media-family compatibility). */
function clipFitsTrack(clip: Clip, kind: TrackKind): boolean {
  return clip.kind === "audio" ? kind === "audio" : kind === "visual";
}

/** True when a clip participates in a main track's gapless back-to-back reflow. */
function isSequentialOn(track: Track, clip: Clip): boolean {
  return track.kind === "audio" ? clip.kind === "audio" : clip.kind === "video" || clip.kind === "image";
}

/**
 * Whether `clip` on `track` can take a roll / slip / slide edit (Wave E), and its
 * position among the track's sequential video/image clips. Mirrors the engine's
 * gating (`packages/director/src/trims.ts`): a MAIN sequential VISUAL track that
 * isn't locked, carrying a video/image clip. Slip additionally needs real source
 * (video); roll needs a NEXT neighbour; slide needs a neighbour on BOTH sides.
 */
interface TrimEligibility {
  /** Base gate: a main-track video/image clip on an unlocked visual track. */
  main: boolean;
  roll: boolean;
  slip: boolean;
  slide: boolean;
}

function trimEligibility(track: Track, clip: Clip): TrimEligibility {
  const main =
    track.kind === "visual" &&
    isMainSequentialTrack(track) &&
    !track.locked &&
    (clip.kind === "video" || clip.kind === "image");
  if (!main) return { main: false, roll: false, slip: false, slide: false };
  const seq = track.clips.filter((c) => c.kind === "video" || c.kind === "image");
  const idx = seq.findIndex((c) => c.id === clip.id);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < seq.length - 1;
  return {
    main: true,
    roll: hasNext,
    slip: clip.kind === "video",
    slide: hasPrev && hasNext,
  };
}

/** Whether a given trim mode can act on this clip (normal is always allowed). */
function eligibleForMode(mode: TrimMode, track: Track, clip: Clip): boolean {
  if (mode === "normal") return true;
  const e = trimEligibility(track, clip);
  return mode === "roll" ? e.roll : mode === "slip" ? e.slip : e.slide;
}

/** Plain-language copy for the trim-mode segmented control + its tooltips. */
const TRIM_MODES: { mode: TrimMode; label: string; hint: string }[] = [
  { mode: "normal", label: "Normal", hint: "Normal: drag to move clips or trim their edges" },
  { mode: "roll", label: "Roll", hint: "Roll: move the cut between two clips (both edges stay put)" },
  { mode: "slip", label: "Slip", hint: "Slip: change what's shown without moving the clip" },
  { mode: "slide", label: "Slide", hint: "Slide: move the clip; the neighbours adjust to fit" },
];

// ---- waveform (unchanged behavior) -----------------------------------------

function useWaveformPeaks(source: WaveformSource | null | undefined): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const src = source?.file ?? source?.url ?? null;
  const mediaId = source?.mediaId ?? null;

  useEffect(() => {
    if (!mediaId || !src) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    setPeaks(null);
    computeWaveform(mediaId, src)
      .then((result) => {
        if (!cancelled) setPeaks(result);
      })
      .catch(() => {
        if (!cancelled) setPeaks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId, src]);

  return peaks;
}

function WaveformStrip({ peaks }: { peaks: number[] }) {
  const H = 100;
  const W = 1000;
  const d = useMemo(() => {
    const n = peaks.length;
    if (n === 0) return "";
    const cx = W / n;
    const cy = H / 2;
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = i * cx;
      const a = Math.max(0.015, peaks[i]!);
      top.push(`${x.toFixed(2)},${(cy - a * cy).toFixed(2)}`);
      bottom.push(`${x.toFixed(2)},${(cy + a * cy).toFixed(2)}`);
    }
    return `M${top.join("L")}L${bottom.reverse().join("L")}Z`;
  }, [peaks]);

  return (
    <svg aria-hidden="true" className="h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" focusable="false">
      <path d={d} className="fill-teal/25" />
    </svg>
  );
}

// ---- tiny inline icons -----------------------------------------------------

function Icon({ path, filled }: { path: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 9a3 3 0 100 6 3 3 0 000-6z",
  eyeOff: "M3 3l18 18 M10.6 10.6a3 3 0 004.2 4.2 M9.9 5.2A9.5 9.5 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.3 4 M6.1 6.1A17 17 0 002 12s3.5 7 10 7a9.6 9.6 0 003.9-.8",
  lock: "M6 11h12v9H6z M9 11V7a3 3 0 016 0v4",
  unlock: "M6 11h12v9H6z M9 11V7a3 3 0 015.9-.8",
  mute: "M4 9v6h4l5 4V5L8 9H4z M17 9l4 4 M21 9l-4 4",
  sound: "M4 9v6h4l5 4V5L8 9H4z M16 8a5 5 0 010 8",
  handle: "M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01",
  close: "M6 6l12 12 M18 6L6 18",
  plus: "M12 5v14 M5 12h14",
};

// ---- drag state ------------------------------------------------------------

type DragKind =
  | "trim-left"
  | "trim-right"
  | "move"
  | "seek"
  | "fade-in"
  | "fade-out"
  | "roll"
  | "slip"
  | "slide"
  | null;

interface DragState {
  kind: DragKind;
  clipId: string;
  trackId: string;
  pointerId: number;
  startX: number;
  /** Geometry captured at drag start so edge math is independent of live commits. */
  origStart: number;
  origEnd: number;
  /**
   * Pre-drag doc snapshot (roll/slip/slide only). The cumulative delta is always
   * applied to THIS baseline so re-applying every frame is idempotent and the
   * whole drag coalesces into one undo step.
   */
  baseDoc: EditDoc | null;
  /** Fade seconds captured at drag start (for fade-in / fade-out handle drags). */
  origFadeIn: number;
  origFadeOut: number;
  moved: boolean;
  /** A within-main-track reorder resolves to a sequential index. */
  dropIndex: number | null;
  /** A cross-track / free move resolves to a destination track + snapped start. */
  dropTrackId: string | null;
  dropStart: number | null;
}

// ---- transitions / keyframes (Wave C) --------------------------------------

/** One gallery entry: the engine type + its human label + its group heading. */
interface TransitionEntry {
  type: TransitionType;
  label: string;
  group: string;
}

/** All 55 transitions, in engine order, labelled from `TRANSITION_GROUPS`. */
const TRANSITIONS: TransitionEntry[] = TRANSITION_TYPES.map((type) => ({
  type,
  label: TRANSITION_GROUPS[type].label,
  group: TRANSITION_GROUPS[type].group,
}));

/**
 * The gallery grouped by `group`, groups in first-seen (engine) order. Rendered
 * as a group heading followed by that group's swatches; the search box filters
 * this list live by label / type across every group.
 */
const TRANSITION_GALLERY: { group: string; items: TransitionEntry[] }[] = (() => {
  const order: string[] = [];
  const byGroup = new Map<string, TransitionEntry[]>();
  for (const entry of TRANSITIONS) {
    let bucket = byGroup.get(entry.group);
    if (!bucket) {
      bucket = [];
      byGroup.set(entry.group, bucket);
      order.push(entry.group);
    }
    bucket.push(entry);
  }
  return order.map((group) => ({ group, items: byGroup.get(group)! }));
})();

/** A synthetic incoming clip used only to drive the hover mini-preview math. */
type PreviewClip = Parameters<typeof transitionStyle>[0];
function makePreviewClip(type: TransitionType): PreviewClip {
  return {
    kind: "solid",
    id: "preview",
    start: 0,
    duration: 2,
    transitionType: type,
    transitionInSec: 1,
    transitionOutSec: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  } as unknown as PreviewClip;
}

/**
 * A tiny looping A→B animation of one transition, driven by the SAME pure
 * `transitionStyle` primitives the Stage + export read — so the hover preview
 * shows exactly what applying it will do. Lightweight: one rAF loop writes the
 * incoming layer's style directly (no per-frame React re-render), and it only
 * mounts while a swatch is hovered/focused.
 */
function TransitionMiniPreview({ type, size = 132 }: { type: TransitionType; size?: number }) {
  const frontRef = useRef<HTMLDivElement>(null);
  const w = size;
  const h = Math.round((size * 9) / 16);
  useEffect(() => {
    const clip = makePreviewClip(type);
    let raf = 0;
    let startTs: number | null = null;
    const DUR = 1300; // ms of the reveal
    const HOLD = 500; // ms fully revealed before looping
    const frame = (ts: number) => {
      if (startTs === null) startTs = ts;
      const e = (ts - startTs) % (DUR + HOLD);
      const p = e < DUR ? e / DUR : 1;
      const st = transitionStyle(clip, p, w, h);
      const el = frontRef.current;
      if (el) {
        el.style.opacity = String(st.opacity);
        el.style.transform = `translate(${st.translateXPct}%, ${st.translateYPct}%) scale(${st.scaleMul})`;
        el.style.clipPath = st.clipPath === "none" ? "" : st.clipPath;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [type, w, h]);
  return (
    <div
      aria-hidden
      className="relative overflow-hidden rounded-md border border-line"
      style={{ width: w, height: h }}
    >
      {/* Outgoing frame "A" (teal). */}
      <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, var(--color-teal) 0%, color-mix(in srgb, var(--color-teal) 55%, black) 100%)" }} />
      {/* Incoming frame "B" (amber) — the layer the transition animates in. */}
      <div
        ref={frontRef}
        className="absolute inset-0 will-change-transform"
        style={{ background: "linear-gradient(135deg, var(--color-amber) 0%, color-mix(in srgb, var(--color-amber) 55%, black) 100%)" }}
      />
      <span className="absolute left-1 top-1 rounded bg-black/30 px-1 text-[8px] font-semibold leading-none text-white/90">A</span>
      <span className="absolute right-1 bottom-1 rounded bg-black/30 px-1 text-[8px] font-semibold leading-none text-white/90">B</span>
    </div>
  );
}

/** Which animatable props a clip kind supports (mirrors core's clipSupportsProp). */
function animatableProps(clip: Clip): KeyframeProp[] {
  if (clip.kind === "audio") return ["volume"];
  if (clip.kind === "video") return ["x", "y", "scale", "rotation", "opacity", "volume"];
  if (clip.kind === "image" || clip.kind === "text" || clip.kind === "solid") {
    return ["x", "y", "scale", "rotation", "opacity"];
  }
  return [];
}

/** A clip's STATIC value for `prop` (the keyframe baseline `valueAt` falls back to). */
function baseValue(clip: Clip, prop: KeyframeProp): number {
  if (prop === "volume") return clip.kind === "video" || clip.kind === "audio" ? clip.volume : 1;
  const t = "transform" in clip ? clip.transform : undefined;
  const dflt = prop === "scale" || prop === "opacity" ? 1 : 0;
  return t ? (t[prop] ?? dflt) : dflt;
}

/** Human label + formatting for a keyframe prop's value input. */
const PROP_META: Record<KeyframeProp, { label: string; step: number; unit: string }> = {
  x: { label: "X", step: 1, unit: "px" },
  y: { label: "Y", step: 1, unit: "px" },
  scale: { label: "Scale", step: 0.05, unit: "×" },
  rotation: { label: "Rotation", step: 1, unit: "°" },
  opacity: { label: "Opacity", step: 0.05, unit: "" },
  volume: { label: "Volume", step: 0.05, unit: "" },
};

const EASINGS: KeyframeEasing[] = ["linear", "ease-in", "ease-out", "ease-in-out"];

interface TrackDragState {
  trackId: string;
  kind: TrackKind;
  pointerId: number;
  startY: number;
  moved: boolean;
}

export function CutsStrip({ doc, timeSec, durationSec, onSeek, waveform, edit }: CutsStripProps) {
  const total = durationSec || 1;
  const peaks = useWaveformPeaks(waveform);
  const { selectedClipId } = edit;

  // Display order: TOP layer first (CapCut/Premiere mental model). The doc's
  // `tracks` array is bottom→top (z-order); we reverse each kind group for the
  // headers/lanes while keeping audio grouped beneath the visual layers.
  const displayTracks = useMemo(() => {
    const visual = doc.tracks.filter((t) => t.kind === "visual");
    const audio = doc.tracks.filter((t) => t.kind === "audio");
    return [...visual.reverse(), ...audio.reverse()];
  }, [doc.tracks]);
  const visualCount = useMemo(() => doc.tracks.filter((t) => t.kind === "visual").length, [doc.tracks]);
  const anyAudioSolo = useMemo(() => doc.tracks.some((t) => t.kind === "audio" && t.solo), [doc.tracks]);
  // Bulk-transition gating: how many cut boundaries exist + is anything applied.
  const cutCount = useMemo(() => mainCutCount(doc), [doc]);
  const anyTransition = useMemo(() => hasAnyTransition(doc), [doc]);

  // Zoom multiplier: at 1 the whole timeline fits the lane width (matching the
  // previous %-based look); >1 makes it wider and horizontally scrollable.
  const [zoom, setZoom] = useState(1);
  const [laneWidth, setLaneWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  // Live geometry of each lane + header row, keyed by track id, for hit-testing
  // cross-track clip drags and track-reorder drags by pointer Y.
  const laneRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const headerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneWidth(el.clientWidth));
    ro.observe(el);
    setLaneWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const contentWidth = Math.max(laneWidth, laneWidth * zoom);
  const pxPerSec = contentWidth > 0 ? contentWidth / total : 0;
  const secToPx = useCallback((s: number) => s * pxPerSec, [pxPerSec]);
  const pxToSec = useCallback((px: number) => (pxPerSec > 0 ? px / pxPerSec : 0), [pxPerSec]);

  // Zoom anchored to the PLAYHEAD (CapCut-style). Without this the strip grows
  // left-anchored and the frame you were looking at slides off to the side — the
  // "zoom goes the wrong way" bug. We flag a zoom, then re-center on the playhead
  // once the new width is laid out.
  const centerOnPlayhead = useRef(false);
  // When set, the next zoom re-centers on THIS time (double-click zoom-to-clip)
  // instead of the playhead — so the clip you zoomed into stays under the cursor.
  const centerAtTime = useRef<number | null>(null);
  const clampZoom = (n: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(n * 10) / 10));
  const zoomTo = useCallback((next: number) => {
    centerOnPlayhead.current = true;
    setZoom(clampZoom(next));
  }, []);
  const zoomAt = useCallback((next: number, atSec: number) => {
    centerAtTime.current = atSec;
    setZoom(clampZoom(next));
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const at = centerAtTime.current;
    if (at != null) {
      centerAtTime.current = null;
      centerOnPlayhead.current = false;
      if (el && pxPerSec > 0) el.scrollLeft = Math.max(0, at * pxPerSec - el.clientWidth / 2);
      return;
    }
    if (!centerOnPlayhead.current) return;
    centerOnPlayhead.current = false;
    if (el && pxPerSec > 0) el.scrollLeft = Math.max(0, timeSec * pxPerSec - el.clientWidth / 2);
  }, [zoom, pxPerSec, timeSec]);

  /** Zoom so `clip` fills ~80% of the lane, then center it (double-click a clip). */
  const zoomToClip = useCallback(
    (clip: Clip) => {
      if (clip.duration <= 0 || total <= 0) return;
      zoomAt((0.8 * total) / clip.duration, clip.start + clip.duration / 2);
    },
    [total, zoomAt],
  );

  // Snap targets rebuilt per render: all clip edges + playhead + markers + ends.
  // Each edge remembers which clip it belongs to so a drag can ignore its own.
  const snapTargets = useMemo(() => {
    const arr: { t: number; clipId?: string }[] = [{ t: 0 }, { t: total }, { t: timeSec }];
    for (const track of doc.tracks)
      for (const c of track.clips) {
        arr.push({ t: c.start, clipId: c.id });
        arr.push({ t: c.start + c.duration, clipId: c.id });
      }
    for (const m of edit.markers) arr.push({ t: m });
    return arr;
  }, [doc, total, timeSec, edit.markers]);

  const snap = useCallback(
    (sec: number, excludeClipId?: string): number => {
      const thresh = pxToSec(SNAP_PX);
      let best = sec;
      let bestD = thresh;
      for (const { t, clipId } of snapTargets) {
        if (clipId && clipId === excludeClipId) continue; // never snap to the dragged clip's own edges
        const d = Math.abs(t - sec);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      return best;
    },
    [snapTargets, pxToSec],
  );

  const drag = useRef<DragState | null>(null);
  const trackDrag = useRef<TrackDragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ trackId: string; x: number } | null>(null);
  // A transition swatch being dragged from the gallery is hovering THIS cut clip.
  const [transitionDropClipId, setTransitionDropClipId] = useState<string | null>(null);
  // Track-reorder insertion line: the kind group + top-first slot the header will land in.
  const [trackDrop, setTrackDrop] = useState<{ kind: TrackKind; index: number } | null>(null);
  // Inline rename editor state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  // Per-cut transition popover: the clip being edited + its anchor screen rect +
  // which edge it targets — "in" (interior cut / first-clip fade-in-from-black)
  // or "out" (last-clip fade-out-to-black).
  const [transitionEdit, setTransitionEdit] = useState<
    { clipId: string; x: number; y: number; edge: "in" | "out"; isStart: boolean } | null
  >(null);
  // Whether the selected clip's keyframe editor is expanded (tucked by default).
  const [kfOpen, setKfOpen] = useState(false);
  // Whether the selected video clip's speed-ramp editor is expanded (tucked).
  const [speedOpen, setSpeedOpen] = useState(false);
  // Timeline trim mode (Wave E): Normal · Roll · Slip · Slide. Local to the strip.
  const [trimMode, setTrimMode] = useState<TrimMode>("normal");

  const findTrackById = useCallback((id: string): Track | undefined => doc.tracks.find((t) => t.id === id), [doc.tracks]);

  /** The lane (track) the pointer Y is currently over, or null. */
  const trackAtY = useCallback((clientY: number): Track | null => {
    for (const [id, el] of laneRefs.current) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return findTrackById(id) ?? null;
    }
    return null;
  }, [findTrackById]);

  // Follow the playhead: when time advances past the visible edge (playback or a
  // seek off-screen), scroll to keep it in view. It only reacts to time changes,
  // so it never fights a manual scroll, and it stands down during a drag.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || drag.current || pxPerSec <= 0 || contentWidth <= laneWidth + 1) return;
    const x = timeSec * pxPerSec;
    const pad = el.clientWidth * 0.12;
    if (x < el.scrollLeft + pad) el.scrollLeft = Math.max(0, x - pad);
    else if (x > el.scrollLeft + el.clientWidth - pad) el.scrollLeft = x - el.clientWidth + pad;
  }, [timeSec, pxPerSec, contentWidth, laneWidth]);

  const selected = selectedClipId ? findClip(doc, selectedClipId) : null;

  // ---- clip pointer handlers -----------------------------------------------

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, track: Track, edge: DragKind) => {
    if (track.locked) return; // locked lane: clips are click-through for seek only
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const fadeIn = clip.kind === "video" || clip.kind === "audio" ? clip.fadeInSec : 0;
    const fadeOut = clip.kind === "video" || clip.kind === "audio" ? clip.fadeOutSec : 0;
    // Wave E: in an advanced trim mode, a body / edge drag on an eligible main
    // clip becomes a roll / slip / slide. Fade-corner and seek drags are left
    // alone, and an ineligible clip (overlay, last clip for roll, …) falls back
    // to the Normal behaviour so nothing regresses.
    const isBodyOrEdge = edge === "move" || edge === "trim-left" || edge === "trim-right";
    const advanced =
      trimMode !== "normal" && isBodyOrEdge && eligibleForMode(trimMode, track, clip);
    drag.current = {
      kind: advanced ? (trimMode as DragKind) : edge ?? "move",
      clipId: clip.id,
      trackId: track.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      origStart: clip.start,
      origEnd: clip.start + clip.duration,
      origFadeIn: fadeIn,
      origFadeOut: fadeOut,
      baseDoc: advanced ? doc : null,
      moved: false,
      dropIndex: null,
      dropTrackId: null,
      dropStart: null,
    };
  };

  const laneRectX = useCallback(() => {
    return lanesRef.current?.getBoundingClientRect().left ?? 0;
  }, []);

  // ---- HTML5 drag-and-drop from the Media grid (B4) -------------------------
  // A tile drag carries the media id + a family marker (audio/visual). We gate
  // the drop by lane kind + lock, reuse the same insert-line indicator that
  // clip-moves draw, and route the insert through the undoable commit path.
  const dropFitsLane = (info: { visual: boolean; audio: boolean }, track: Track | null): boolean =>
    !!track && !track.locked && (track.kind === "audio" ? info.audio : info.visual);

  const handleMediaDragOver = useCallback(
    (e: React.DragEvent) => {
      const info = readMediaDrag(e.dataTransfer);
      if (!info) return; // not a Media-grid drag (e.g. an OS file drop bubbles up)
      const track = trackAtY(e.clientY);
      if (!dropFitsLane(info, track)) {
        setDropIndicator(null);
        e.dataTransfer.dropEffect = "none";
        return;
      }
      e.preventDefault(); // allow the drop
      e.dataTransfer.dropEffect = "copy";
      const x = e.clientX - laneRectX() + (scrollRef.current?.scrollLeft ?? 0);
      const start = Math.max(0, snap(pxToSec(x)));
      setDropIndicator({ trackId: track!.id, x: secToPx(start) });
    },
    [trackAtY, laneRectX, snap, pxToSec, secToPx],
  );

  const handleMediaDrop = useCallback(
    (e: React.DragEvent) => {
      const info = readMediaDrag(e.dataTransfer);
      setDropIndicator(null);
      if (!info) return;
      const track = trackAtY(e.clientY);
      if (!dropFitsLane(info, track)) return;
      e.preventDefault();
      const mediaId = e.dataTransfer.getData(MEDIA_DND_ID);
      if (!mediaId) return;
      const x = e.clientX - laneRectX() + (scrollRef.current?.scrollLeft ?? 0);
      const start = Math.max(0, snap(pxToSec(x)));
      edit.onDropMedia(mediaId, track!.id, start);
    },
    [trackAtY, laneRectX, snap, pxToSec, edit],
  );

  const handleMediaDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDropIndicator(null);
  }, []);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      // ---- track-reorder drag (header handle) ------------------------------
      const td = trackDrag.current;
      if (td) {
        if (!td.moved && Math.abs(e.clientY - td.startY) < 3) return;
        td.moved = true;
        const others = displayTracks.filter((t) => t.kind === td.kind && t.id !== td.trackId);
        let index = 0;
        for (const t of others) {
          const el = headerRefs.current.get(t.id);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (e.clientY > r.top + r.height / 2) index++;
        }
        setTrackDrop({ kind: td.kind, index });
        return;
      }

      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) < 3) return;
      d.moved = true;

      if (rafRef.current != null) return; // throttle to one update per frame
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const cur = drag.current;
        if (!cur) return;
        const found = findClip(doc, cur.clipId);
        if (!found) return;
        const { track, clip } = found;
        const deltaSec = pxToSec(e.clientX - cur.startX);

        if (cur.kind === "trim-right") {
          const edgeTime = snap(cur.origEnd + deltaSec, cur.clipId);
          edit.onTrim(cur.clipId, "right", edgeTime, `trim-${cur.clipId}`);
          return;
        }
        if (cur.kind === "trim-left") {
          const edgeTime = snap(cur.origStart + deltaSec, cur.clipId);
          edit.onTrim(cur.clipId, "left", edgeTime, `trim-${cur.clipId}`);
          return;
        }

        // ---- audio fade handles ------------------------------------------
        // Left handle drags RIGHT to lengthen the fade-in; right handle drags
        // LEFT to lengthen the fade-out. setClipFade clamps each to [0, duration].
        if (cur.kind === "fade-in") {
          const next = Math.max(0, cur.origFadeIn + deltaSec);
          edit.onSetAudioFade(cur.clipId, { fadeInSec: next }, `fade-${cur.clipId}`);
          return;
        }
        if (cur.kind === "fade-out") {
          const next = Math.max(0, cur.origFadeOut - deltaSec);
          edit.onSetAudioFade(cur.clipId, { fadeOutSec: next }, `fade-${cur.clipId}`);
          return;
        }

        // ---- roll / slip / slide (Wave E) --------------------------------
        // Cumulative delta from drag-start, always applied to the captured
        // baseDoc so it stays idempotent; one coalesced undo step per drag.
        if (cur.kind === "roll" || cur.kind === "slip" || cur.kind === "slide") {
          const base = cur.baseDoc ?? undefined;
          const key = `${cur.kind}-${cur.clipId}`;
          if (cur.kind === "roll") edit.onRoll(cur.clipId, deltaSec, key, base);
          else if (cur.kind === "slip") edit.onSlip(cur.clipId, deltaSec, key, base);
          else edit.onSlide(cur.clipId, deltaSec, key, base);
          return;
        }

        // ---- move: cross-track aware -------------------------------------
        const overTrack = trackAtY(e.clientY);
        const target = overTrack && clipFitsTrack(clip, overTrack.kind) && !overTrack.locked ? overTrack : track;

        const withinSameMain =
          target.id === cur.trackId && isMainSequentialTrack(target) && isSequentialOn(target, clip);

        if (withinSameMain) {
          // Reorder: find the sequential drop index from the cursor x.
          const xInLane = e.clientX - laneRectX() + (scrollRef.current?.scrollLeft ?? 0);
          const seq = target.clips.filter((c) => isSequentialOn(target, c));
          let idx = seq.length - 1;
          for (let i = 0; i < seq.length; i++) {
            const c = seq[i]!;
            const mid = secToPx(c.start + c.duration / 2);
            if (xInLane < mid) { idx = i; break; }
          }
          cur.kind = "move";
          cur.dropIndex = idx;
          cur.dropTrackId = null;
          cur.dropStart = null;
          const targetClip = seq[idx];
          setDropIndicator({ trackId: target.id, x: targetClip ? secToPx(targetClip.start) : contentWidth });
        } else {
          // Cross-track drop or free reposition on an overlay lane.
          const newStart = Math.max(0, snap(cur.origStart + deltaSec, cur.clipId));
          cur.dropIndex = null;
          cur.dropTrackId = target.id;
          cur.dropStart = newStart;
          setDropIndicator({ trackId: target.id, x: secToPx(newStart) });
        }
      });
    },
    [doc, pxToSec, secToPx, snap, edit, laneRectX, contentWidth, displayTracks, trackAtY],
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      // ---- finish a track-reorder drag -------------------------------------
      const td = trackDrag.current;
      if (td) {
        trackDrag.current = null;
        const drop = trackDrop;
        setTrackDrop(null);
        if (td.moved && drop) {
          const dragged = findTrackById(td.trackId);
          if (dragged) {
            const arr = doc.tracks.filter((t) => t.id !== td.trackId);
            const kin = arr.filter((t) => t.kind === dragged.kind); // array (bottom-first) order
            const bi = Math.max(0, Math.min(kin.length - drop.index, kin.length)); // top-first → bottom-first
            let dest: number;
            if (kin.length === 0) dest = arr.length;
            else if (bi < kin.length) dest = arr.indexOf(kin[bi]!);
            else dest = arr.indexOf(kin[kin.length - 1]!) + 1;
            edit.onReorderTrack(td.trackId, dest);
          }
        }
        void e;
        return;
      }

      const d = drag.current;
      drag.current = null;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setDropIndicator(null);
      if (!d) return;
      if (!d.moved) {
        // A click (no drag) = select the clip and seek to its head.
        const found = findClip(doc, d.clipId);
        edit.onSelectClip(d.clipId);
        if (found) onSeek(found.clip.start + 0.001);
        return;
      }
      if (d.kind === "move" && d.dropIndex != null) {
        edit.onReorder(d.clipId, d.dropIndex);
      } else if (d.kind === "move" && d.dropTrackId) {
        edit.onMoveClipToTrack(d.clipId, d.dropTrackId, d.dropStart ?? undefined);
      }
      void e;
    },
    [doc, edit, onSeek, trackDrop, findTrackById],
  );

  useEffect(() => {
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  const onHeaderHandleDown = (e: React.PointerEvent, track: Track) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    trackDrag.current = { trackId: track.id, kind: track.kind, pointerId: e.pointerId, startY: e.clientY, moved: false };
  };

  // Click an empty area of a lane / the ruler → seek there.
  const seekFromPointer = (e: React.PointerEvent) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0);
    onSeek(Math.max(0, Math.min(pxToSec(x), total)));
  };

  const playheadX = secToPx(timeSec);

  // Ruler ticks — roughly one per ~80px, at "nice" second intervals.
  const ticks = useMemo(() => {
    if (pxPerSec <= 0) return [];
    const targetPx = 80;
    const rawStep = targetPx / pxPerSec;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s >= rawStep) ?? 600;
    const out: number[] = [];
    for (let t = 0; t <= total + 1e-6; t += step) out.push(Math.round(t * 100) / 100);
    return out;
  }, [pxPerSec, total]);

  // ---- rename helpers ------------------------------------------------------
  const beginRename = (track: Track) => {
    setEditingId(track.id);
    setDraftName(track.name ?? trackLabel(track));
  };
  const commitRename = () => {
    if (editingId) {
      const name = draftName.trim();
      const track = findTrackById(editingId);
      if (track && name && name !== (track.name ?? "")) edit.onRenameTrack(editingId, name);
    }
    setEditingId(null);
  };

  const requestRemove = (track: Track) => {
    if (track.kind === "visual" && visualCount <= 1) {
      if (typeof window !== "undefined") window.alert("This is the base video track — add another visual layer before removing it.");
      return;
    }
    const hasClips = track.clips.length > 0;
    if (hasClips && typeof window !== "undefined" && !window.confirm(`Remove “${trackLabel(track)}” and its ${track.clips.length} clip${track.clips.length === 1 ? "" : "s"}?`)) return;
    edit.onRemoveTrack(track.id);
  };

  return (
    <section aria-label="Timeline" className="border-t border-line-soft bg-panel/40 px-4 pb-4 pt-3">
      {/* Toolbar */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="uppercase tracking-wider text-faint">Timeline</span>
        <span className="text-line">·</span>
        <span className="text-muted">
          {trimMode !== "normal"
            ? TRIM_MODES.find((m) => m.mode === trimMode)?.hint
            : selected
              ? "trim edges · drag to reorder or onto another track"
              : "click a cut to select · drag the ruler to scan"}
        </span>

        {/* Trim-mode selector (Wave E) — Normal · Roll · Slip · Slide. */}
        <span
          role="group"
          aria-label="Timeline trim mode"
          className="ml-2 inline-flex overflow-hidden rounded-md border border-line bg-elevated"
        >
          {TRIM_MODES.map(({ mode, label, hint }) => {
            const on = trimMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setTrimMode(mode)}
                aria-pressed={on}
                title={hint}
                className={[
                  "px-2 py-1 text-[11px] transition border-l border-line first:border-l-0",
                  on ? "bg-amber/15 text-amber" : "text-muted hover:text-text",
                ].join(" ")}
              >
                {label}
              </button>
            );
          })}
        </span>

        {/* One-tap bulk transitions — the biggest ease win. "Auto" carpets every
            cut with a tasteful crossfade; "Remove all" hard-cuts everything. */}
        <span
          role="group"
          aria-label="Transitions for all cuts"
          className="ml-2 inline-flex items-center gap-1.5"
        >
          <span className="text-faint">Transitions</span>
          <button
            type="button"
            onClick={() => edit.onApplyTransitionToAll("crossfade", 0.5)}
            disabled={cutCount < 1}
            title="Auto: add a smooth crossfade (0.5s) to every cut on the main track"
            aria-label="Auto: apply a crossfade to every cut"
            className="rounded-md border border-amber/40 bg-amber/10 px-2 py-1 font-medium text-amber transition hover:bg-amber/20 disabled:opacity-40 disabled:hover:bg-amber/10"
          >
            ✦ Auto
          </button>
          <button
            type="button"
            onClick={edit.onRemoveAllTransitions}
            disabled={!anyTransition}
            title="Remove every transition — hard-cut the whole timeline"
            aria-label="Remove all transitions"
            className="rounded-md border border-line bg-elevated px-2 py-1 text-muted transition hover:text-text disabled:opacity-40"
          >
            Remove all
          </button>
        </span>

        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => selected && edit.onSplitAt(selected.clip.id, timeSec)}
            disabled={!selected}
            title="Split the selected clip at the playhead (S)"
            className="rounded-md border border-line bg-elevated px-2 py-1 text-muted transition hover:text-text disabled:opacity-40"
          >
            Split
          </button>
          <button
            type="button"
            onClick={edit.onAddMarker}
            title="Add a marker at the playhead (M)"
            className="rounded-md border border-line bg-elevated px-2 py-1 text-muted transition hover:text-text"
          >
            + Marker
          </button>
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          <button
            type="button"
            onClick={() => zoomTo(ZOOM_MIN)}
            disabled={zoom <= ZOOM_MIN}
            title="Zoom out so the whole timeline fits the lane"
            className="rounded-md border border-line bg-elevated px-2 py-1 text-muted transition hover:text-text disabled:opacity-40"
          >
            Fit
          </button>
          <button
            type="button"
            onClick={() => zoomTo(zoom - 1)}
            disabled={zoom <= ZOOM_MIN}
            aria-label="Zoom out timeline"
            className="grid h-6 w-6 place-items-center rounded-md border border-line bg-elevated text-muted transition hover:text-text disabled:opacity-40"
          >
            −
          </button>
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.5}
            value={zoom}
            onChange={(e) => zoomTo(Number(e.target.value))}
            aria-label={`Timeline zoom: ${zoom}×`}
            title={`Zoom ${zoom}×`}
            style={{ accentColor: "var(--color-teal)" }}
            className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-line"
          />
          <button
            type="button"
            onClick={() => zoomTo(zoom + 1)}
            disabled={zoom >= ZOOM_MAX}
            aria-label="Zoom in timeline"
            className="grid h-6 w-6 place-items-center rounded-md border border-line bg-elevated text-muted transition hover:text-text disabled:opacity-40"
          >
            +
          </button>
          <span className="w-9 shrink-0 text-right tabular-nums text-faint">{zoom}×</span>
        </span>
      </div>

      {/* Header gutter (sticky-left) + horizontally-scrolling lanes. They share
          the editor's vertical scroll, so headers stay aligned to their lanes. */}
      <div className="flex">
        {/* Track-header gutter */}
        <div className="relative shrink-0 pr-2" style={{ width: GUTTER_PX }}>
          {/* spacer aligning the header list with the ruler (h-5 + mb-1) */}
          <div className="mb-1 h-5" aria-hidden />
          <div className="relative flex flex-col gap-1.5">
            {trackDrop && (
              <TrackInsertLine displayTracks={displayTracks} drop={trackDrop} />
            )}
            {displayTracks.map((track) => (
              <TrackHeader
                key={track.id}
                track={track}
                editing={editingId === track.id}
                draftName={draftName}
                dimmed={track.hidden || (track.kind === "audio" && anyAudioSolo && !track.solo)}
                registerRef={(el) => {
                  if (el) headerRefs.current.set(track.id, el);
                  else headerRefs.current.delete(track.id);
                }}
                onHandleDown={(e) => onHeaderHandleDown(e, track)}
                onBeginRename={() => beginRename(track)}
                onDraftChange={setDraftName}
                onCommitRename={commitRename}
                onCancelRename={() => setEditingId(null)}
                onToggleFlag={(flag) => edit.onSetTrackFlag(track.id, flag, !track[flag])}
                onRemove={() => requestRemove(track)}
                canRemove={!(track.kind === "visual" && visualCount <= 1)}
              />
            ))}
          </div>
          {/* Add-track controls */}
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => edit.onAddTrack("visual")}
              className="flex items-center gap-1 rounded-md border border-line bg-elevated px-2 py-1 text-[10px] text-muted transition hover:border-teal/40 hover:text-text"
              title="Add a video / overlay layer"
              aria-label="Add a video or overlay track"
            >
              <Icon path={ICONS.plus} /> Video
            </button>
            <button
              type="button"
              onClick={() => edit.onAddTrack("audio")}
              className="flex items-center gap-1 rounded-md border border-line bg-elevated px-2 py-1 text-[10px] text-muted transition hover:border-teal/40 hover:text-text"
              title="Add an audio track"
              aria-label="Add an audio track"
            >
              <Icon path={ICONS.plus} /> Audio
            </button>
          </div>
        </div>

        {/* Scrollable lanes */}
        <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div
            ref={lanesRef}
            className="relative select-none"
            style={{ width: contentWidth || "100%" }}
            onDragOver={handleMediaDragOver}
            onDrop={handleMediaDrop}
            onDragLeave={handleMediaDragLeave}
          >
            {/* Ruler */}
            <div
              className="relative mb-1 h-5 cursor-text border-b border-line-soft/60"
              onPointerDown={seekFromPointer}
              role="presentation"
            >
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 flex h-full flex-col items-start" style={{ left: secToPx(t) }}>
                  <span className="h-1.5 w-px bg-line" />
                  <span className="pl-1 text-[9px] tabular-nums text-faint">{fmtTime(t)}</span>
                </span>
              ))}
              {/* Markers */}
              {edit.markers.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(m);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    edit.onRemoveMarker(m);
                  }}
                  title={`Marker ${fmtTime(m)} · click to jump · right-click to remove`}
                  aria-label={`Marker at ${fmtTime(m)}`}
                  className="absolute top-0 z-10 -ml-1.5 h-full w-3"
                  style={{ left: secToPx(m) }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" className="text-amber">
                    <path d="M6 11 1 3h10z" fill="currentColor" />
                  </svg>
                </button>
              ))}
            </div>

            {/* Playhead spanning tracks + waveform */}
            <div className="pointer-events-none absolute bottom-0 z-20 w-px bg-amber" style={{ left: playheadX, top: 24 }}>
              <span className="absolute -top-1 -left-[3px] h-1.5 w-1.5 rounded-full bg-amber" />
            </div>

            <div className="flex flex-col gap-1.5">
              {displayTracks.map((track) => {
                const laneDimmed = track.hidden || (track.kind === "audio" && anyAudioSolo && !track.solo);
                const isDropTarget = dropIndicator?.trackId === track.id;
                // Per-cut transition chips: on a magnetic (main) VISUAL track only,
                // every sequential video/image clip except the first sits over a cut.
                const showChips = isMainSequentialTrack(track) && track.kind === "visual" && !track.locked;
                const chipClips = showChips
                  ? track.clips.filter((c) => c.kind === "video" || c.kind === "image")
                  : [];
                return (
                  <div
                    key={track.id}
                    ref={(el) => {
                      if (el) laneRefs.current.set(track.id, el);
                      else laneRefs.current.delete(track.id);
                    }}
                    className={[
                      "relative h-9 rounded-lg transition",
                      track.locked ? "bg-line-soft/20" : "bg-line-soft/40",
                      laneDimmed ? "opacity-40" : "",
                      isDropTarget ? "ring-1 ring-amber/60" : "",
                    ].join(" ")}
                    style={track.locked ? { backgroundImage: "repeating-linear-gradient(45deg, transparent, transparent 6px, var(--color-line) 6px, var(--color-line) 7px)" } : undefined}
                    onPointerDown={(e) => {
                      if (e.target === e.currentTarget) seekFromPointer(e);
                    }}
                  >
                    {isDropTarget && (
                      <span className="pointer-events-none absolute inset-y-0 z-30 w-0.5 bg-amber" style={{ left: dropIndicator!.x }} />
                    )}
                    {track.clips.map((clip) => {
                      const left = secToPx(clip.start);
                      const width = Math.max(4, secToPx(clip.duration) - 2);
                      const active = timeSec >= clip.start && timeSec < clip.start + clip.duration;
                      const isSelected = clip.id === selectedClipId;
                      const color = TRACK_COLORS[clip.kind] ?? TRACK_COLORS.audio;
                      const draggable = !track.locked;
                      // Wave E: does the active trim mode apply to this clip?
                      const modeEligible = trimMode !== "normal" && eligibleForMode(trimMode, track, clip);
                      const modeHint = modeEligible
                        ? trimMode === "roll"
                          ? "drag to roll the cut with the next clip"
                          : trimMode === "slip"
                            ? "drag to slip what's shown (the clip stays put)"
                            : "drag to slide the clip; neighbours adjust"
                        : null;
                      return (
                        <div
                          key={clip.id}
                          role="button"
                          tabIndex={track.locked ? -1 : 0}
                          aria-pressed={isSelected}
                          aria-label={`${clip.kind} clip, ${fmtTime(clip.duration)}${isSelected ? ", selected" : ""}${track.locked ? ", locked" : ""}`}
                          onKeyDown={(e) => {
                            if (track.locked) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              edit.onSelectClip(clip.id);
                              onSeek(clip.start + 0.001);
                            }
                          }}
                          onPointerDown={(e) => onClipPointerDown(e, clip, track, "move")}
                          onDoubleClick={(e) => {
                            if (track.locked) return;
                            e.stopPropagation();
                            edit.onSelectClip(clip.id);
                            zoomToClip(clip);
                          }}
                          // Drag-a-transition: a main-visual video/image clip is a drop
                          // target for a swatch dragged from the gallery (mirrors the
                          // Media-grid drop plumbing). Dropping sets its incoming cut.
                          onDragOver={
                            showChips && (clip.kind === "video" || clip.kind === "image")
                              ? (e) => {
                                  if (!readTransitionDrag(e.dataTransfer)) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = "copy";
                                  if (transitionDropClipId !== clip.id) setTransitionDropClipId(clip.id);
                                }
                              : undefined
                          }
                          onDragLeave={
                            showChips && (clip.kind === "video" || clip.kind === "image")
                              ? (e) => {
                                  if (e.currentTarget === e.target) setTransitionDropClipId(null);
                                }
                              : undefined
                          }
                          onDrop={
                            showChips && (clip.kind === "video" || clip.kind === "image")
                              ? (e) => {
                                  const info = readTransitionDrag(e.dataTransfer);
                                  setTransitionDropClipId(null);
                                  if (!info) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  edit.onSetTransition(clip.id, info.type, info.durSec);
                                }
                              : undefined
                          }
                          title={modeHint ? `${clip.kind} · ${modeHint}` : `${clip.kind} · ${fmtTime(clip.duration)}${track.locked ? " · locked" : " · double-click to zoom to it"}`}
                          className={[
                            "group absolute inset-y-0 overflow-hidden rounded-md border px-2 text-left text-[11px] leading-9 outline-none transition",
                            color,
                            track.locked
                              ? "pointer-events-none cursor-default"
                              : modeEligible
                                ? "cursor-ew-resize"
                                : draggable
                                  ? "cursor-grab active:cursor-grabbing"
                                  : "cursor-pointer",
                            transitionDropClipId === clip.id
                              ? "z-20 ring-2 ring-amber brightness-110"
                              : isSelected
                                ? "z-10 ring-2 ring-amber shadow-[0_0_0_1px_var(--color-amber)]"
                                : active
                                  ? "ring-2 ring-amber/70"
                                  : modeEligible
                                    ? "ring-1 ring-inset ring-teal/50"
                                    : "hover:brightness-125",
                          ].join(" ")}
                          style={{ left, width }}
                        >
                          {/* Audio fade ramps (video/audio) — subtle triangles at the edges. */}
                          {(clip.kind === "video" || clip.kind === "audio") && clip.fadeInSec > 0 && (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-y-0 left-0 bg-teal/25"
                              style={{
                                width: Math.min(width, secToPx(clip.fadeInSec)),
                                clipPath: "polygon(0 100%, 100% 0, 100% 100%)",
                              }}
                            />
                          )}
                          {(clip.kind === "video" || clip.kind === "audio") && clip.fadeOutSec > 0 && (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-y-0 right-0 bg-teal/25"
                              style={{
                                width: Math.min(width, secToPx(clip.fadeOutSec)),
                                clipPath: "polygon(0 0, 0 100%, 100% 100%)",
                              }}
                            />
                          )}
                          <span className="pointer-events-none block truncate">{clipLabel(clip)}</span>
                          {/* Slip affordance: a subtle "source shifting" hatch + double-arrow so
                              it's obvious the underlying footage moves, not the clip. */}
                          {trimMode === "slip" && modeEligible && (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-0 flex items-center justify-center text-teal/70"
                              style={{ backgroundImage: "repeating-linear-gradient(-45deg, transparent, transparent 5px, rgba(45,212,191,0.12) 5px, rgba(45,212,191,0.12) 6px)" }}
                            >
                              <span className="rounded bg-panel/70 px-1 text-[9px] leading-none">⇄ source</span>
                            </span>
                          )}
                          {/* Trim handles — only meaningful once selected, but always grabbable. */}
                          {!track.locked && (
                            <>
                              <span
                                onPointerDown={(e) => onClipPointerDown(e, clip, track, "trim-left")}
                                className={[
                                  "absolute inset-y-0 left-0 w-2 cursor-col-resize",
                                  isSelected ? "bg-amber/80" : "opacity-0 group-hover:bg-amber/40 group-hover:opacity-100",
                                ].join(" ")}
                                aria-hidden
                              />
                              <span
                                onPointerDown={(e) => onClipPointerDown(e, clip, track, "trim-right")}
                                className={[
                                  "absolute inset-y-0 right-0 w-2 cursor-col-resize",
                                  isSelected ? "bg-amber/80" : "opacity-0 group-hover:bg-amber/40 group-hover:opacity-100",
                                ].join(" ")}
                                aria-hidden
                              />
                            </>
                          )}
                          {/* Audio fade handles — top corners, shown when selected. */}
                          {!track.locked && isSelected && (clip.kind === "video" || clip.kind === "audio") && (
                            <>
                              <span
                                onPointerDown={(e) => onClipPointerDown(e, clip, track, "fade-in")}
                                role="slider"
                                aria-label={`Fade in: ${clip.fadeInSec.toFixed(1)}s — drag right to lengthen`}
                                aria-valuenow={Math.round(clip.fadeInSec * 10) / 10}
                                aria-valuemin={0}
                                aria-valuemax={Math.round(clip.duration * 10) / 10}
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const d = e.key === "ArrowRight" ? 0.1 : -0.1;
                                    edit.onSetAudioFade(clip.id, { fadeInSec: Math.max(0, clip.fadeInSec + d) }, `fade-${clip.id}`);
                                  }
                                }}
                                title="Fade in — drag right (or ←/→) to set"
                                className="absolute top-0 z-20 -mt-1 -ml-1.5 h-3 w-3 cursor-ew-resize rounded-full border border-panel bg-teal shadow"
                                style={{ left: Math.min(width, secToPx(clip.fadeInSec)) }}
                              />
                              <span
                                onPointerDown={(e) => onClipPointerDown(e, clip, track, "fade-out")}
                                role="slider"
                                aria-label={`Fade out: ${clip.fadeOutSec.toFixed(1)}s — drag left to lengthen`}
                                aria-valuenow={Math.round(clip.fadeOutSec * 10) / 10}
                                aria-valuemin={0}
                                aria-valuemax={Math.round(clip.duration * 10) / 10}
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const d = e.key === "ArrowLeft" ? 0.1 : -0.1;
                                    edit.onSetAudioFade(clip.id, { fadeOutSec: Math.max(0, clip.fadeOutSec + d) }, `fade-${clip.id}`);
                                  }
                                }}
                                title="Fade out — drag left (or ←/→) to set"
                                className="absolute top-0 z-20 -mt-1 -mr-1.5 h-3 w-3 cursor-ew-resize rounded-full border border-panel bg-teal shadow"
                                style={{ right: Math.min(width, secToPx(clip.fadeOutSec)) }}
                              />
                            </>
                          )}
                        </div>
                      );
                    })}
                    {/* Per-cut transition chips. Interior cuts (i>0) sit over the
                        cut boundary; the FIRST clip (i===0) carries a fade-in-from-
                        black chip at its head — so a single-clip project still has a
                        transition to add/change (the reported "can't change" case). */}
                    {chipClips.map((clip, i) => {
                      const isStart = i === 0;
                      const on = clip.transitionInSec > 0;
                      const selected = transitionEdit?.clipId === clip.id && transitionEdit.edge === "in";
                      const title = isStart
                        ? on
                          ? `Fade in from black: ${clip.transitionType} ${clip.transitionInSec.toFixed(1)}s — click to edit`
                          : "Fade in from black — click to add"
                        : on
                          ? `Transition: ${clip.transitionType} ${clip.transitionInSec.toFixed(1)}s — click to edit`
                          : "Hard cut — click to add a transition";
                      const aria = isStart
                        ? on
                          ? `Edit the fade in from black (${clip.transitionType})`
                          : "Add a fade in from black"
                        : on
                          ? `Edit transition on this cut (${clip.transitionType})`
                          : "Add a transition on this cut";
                      return (
                        <button
                          key={`xf-${clip.id}`}
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setTransitionEdit(
                              selected
                                ? null
                                : { clipId: clip.id, x: r.left + r.width / 2, y: r.bottom, edge: "in", isStart },
                            );
                          }}
                          title={title}
                          aria-label={aria}
                          aria-haspopup="dialog"
                          aria-expanded={selected}
                          className={[
                            "absolute top-1/2 z-30 grid h-4 w-4 -translate-y-1/2 place-items-center rounded-[3px] text-amber outline-none transition hover:scale-110",
                            // The head chip sits just inside the left edge; interior chips straddle the cut.
                            isStart ? "translate-x-0.5" : "-translate-x-1/2",
                          ].join(" ")}
                          style={{ left: secToPx(clip.start) }}
                        >
                          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden focusable="false">
                            <path
                              d="M6 1 11 6 6 11 1 6Z"
                              fill={on ? "var(--color-amber)" : "var(--color-panel)"}
                              stroke="var(--color-amber)"
                              strokeWidth={1.5}
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      );
                    })}
                    {/* Fade-out-to-black chip at the very end of the last clip. */}
                    {chipClips.length > 0 && (() => {
                      const last = chipClips[chipClips.length - 1]!;
                      const on = "transitionOutSec" in last && last.transitionOutSec > 0;
                      const selected = transitionEdit?.clipId === last.id && transitionEdit.edge === "out";
                      return (
                        <button
                          key={`fo-${last.id}`}
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setTransitionEdit(
                              selected
                                ? null
                                : { clipId: last.id, x: r.left + r.width / 2, y: r.bottom, edge: "out", isStart: false },
                            );
                          }}
                          title={on ? `Fade out to black ${last.transitionOutSec.toFixed(1)}s — click to edit` : "Fade out to black — click to add"}
                          aria-label={on ? "Edit the fade out to black" : "Add a fade out to black"}
                          aria-haspopup="dialog"
                          aria-expanded={selected}
                          className="absolute top-1/2 z-30 grid h-4 w-4 -translate-x-full -translate-y-1/2 place-items-center rounded-[3px] text-amber outline-none transition hover:scale-110"
                          style={{ left: secToPx(last.start + last.duration) }}
                        >
                          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden focusable="false">
                            <path
                              d="M6 1 11 6 6 11 1 6Z"
                              fill={on ? "var(--color-amber)" : "var(--color-panel)"}
                              stroke="var(--color-amber)"
                              strokeWidth={1.5}
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      );
                    })()}
                  </div>
                );
              })}

              {peaks && peaks.length > 0 && (
                <div className="relative h-7 overflow-hidden rounded-lg bg-line-soft/25" aria-label="Audio waveform">
                  <WaveformStrip peaks={peaks} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Inspector for the selected clip + its (tucked) keyframe editor */}
      {selected && (
        <>
          <ClipInspector
            doc={doc}
            found={selected}
            timeSec={timeSec}
            edit={edit}
            kfOpen={kfOpen}
            onToggleKf={() => setKfOpen((o) => !o)}
            speedOpen={speedOpen}
            onToggleSpeed={() => setSpeedOpen((o) => !o)}
          />
          {kfOpen && <KeyframeEditor clip={selected.clip} timeSec={timeSec} edit={edit} />}
          {speedOpen &&
            selected.clip.kind === "video" &&
            isMainSequentialTrack(selected.track) && (
              <SpeedRampEditor clip={selected.clip} edit={edit} />
            )}
        </>
      )}

      {/* Per-cut transition popover (fixed to the chip's screen position) */}
      {transitionEdit && (() => {
        const found = findClip(doc, transitionEdit.clipId);
        if (!found || (found.clip.kind !== "video" && found.clip.kind !== "image")) return null;
        return (
          <TransitionPopover
            clip={found.clip}
            x={transitionEdit.x}
            y={transitionEdit.y}
            edge={transitionEdit.edge}
            isStart={transitionEdit.isStart}
            cutCount={cutCount}
            edit={edit}
            onClose={() => setTransitionEdit(null)}
          />
        );
      })()}
    </section>
  );
}

// ---- per-cut transition popover --------------------------------------------

function TransitionPopover({
  clip,
  x,
  y,
  edge,
  isStart,
  cutCount,
  edit,
  onClose,
}: {
  clip: Extract<Clip, { kind: "video" | "image" }>;
  x: number;
  y: number;
  /** "in" = incoming ramp (interior cut / first-clip fade-in); "out" = fade to black. */
  edge: "in" | "out";
  /** The "in" edge on the FIRST clip is a fade-in-from-black, not a cut. */
  isStart: boolean;
  /** Number of cut boundaries on the main track(s) — gates "Apply to all cuts". */
  cutCount: number;
  edit: TimelineEdit;
  onClose: () => void;
}) {
  const isOut = edge === "out";
  const current = isOut ? clip.transitionOutSec : clip.transitionInSec;
  const on = current > 0;
  // Seed the duration slider from the current transition, else a sensible 0.6s.
  const [dur, setDur] = useState(on ? Math.max(0.1, Math.min(2, current)) : 0.6);
  // The last type picked/hovered — drives "Apply to all cuts" + the active swatch.
  const [pickedType, setPickedType] = useState<TransitionType>(clip.transitionType ?? "crossfade");
  // Live filter across all 55 transitions (label + engine type), case-insensitive.
  const [query, setQuery] = useState("");
  // Which swatch is being hovered/focused (drives the animated mini-preview card).
  const [hovered, setHovered] = useState<{ type: TransitionType; label: string; x: number; y: number } | null>(null);
  // A swatch is mid-drag onto a cut — drop the click-catcher's hit-testing so the
  // drag reaches the timeline clips beneath it.
  const [dragging, setDragging] = useState(false);
  const filteredGallery = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TRANSITION_GALLERY;
    return TRANSITION_GALLERY.map((section) => ({
      group: section.group,
      items: section.items.filter(
        (t) => t.label.toLowerCase().includes(q) || t.type.toLowerCase().includes(q),
      ),
    })).filter((section) => section.items.length > 0);
  }, [query]);

  // The chip sits near the BOTTOM of the screen (the timeline), so a popover
  // anchored below it would overflow off-screen with its controls unclickable.
  // Measure the panel and flip it ABOVE the chip when there isn't room below.
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: Math.max(8, typeof window !== "undefined" ? Math.min(x - 124, window.innerWidth - 260) : x - 124),
    top: y + 6,
  });
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || typeof window === "undefined") return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const left = Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8));
    // y is the chip's BOTTOM; below by default, flipped above (past the ~22px
    // chip) when the panel would spill past the viewport bottom.
    const top =
      y + 6 + h > window.innerHeight - 8 ? Math.max(8, y - 22 - h) : y + 6;
    setPos({ left, top });
    // `query` is a dep so the panel re-anchors when the filtered list changes its
    // height (the scrollable body caps growth, but an empty result shrinks it).
  }, [x, y, isOut, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const heading = isOut ? "Fade out to black" : isStart ? "Fade in from black" : "Transition";
  const clearLabel = isOut ? "No fade out" : isStart ? "No fade in" : "Hard cut";
  const clearFn = isOut ? () => edit.onClearFadeOut(clip.id) : () => edit.onClearTransition(clip.id);
  // The "out" edge is always an opacity fade against black — no style gallery.
  const setDurFn = (v: number) => {
    if (isOut) edit.onSetFadeOut(clip.id, v);
    else edit.onSetTransition(clip.id, clip.transitionType, v);
  };

  return (
    <>
      {/* click-catcher — disabled mid-drag so a dragged swatch reaches the cuts. */}
      <div
        className={["fixed inset-0 z-40", dragging ? "pointer-events-none" : ""].join(" ")}
        onPointerDown={onClose}
        aria-hidden
      />
      {/* Animated hover mini-preview of the hovered transition (A→B loop). */}
      {hovered && !dragging && (
        <div
          className="pointer-events-none fixed z-[60] rounded-lg border border-line bg-elevated p-1.5 shadow-2xl"
          style={{
            left: Math.min(hovered.x + 8, (typeof window !== "undefined" ? window.innerWidth : 9999) - 156),
            top: Math.max(8, hovered.y - 24),
          }}
        >
          <TransitionMiniPreview type={hovered.type} />
          <p className="mt-1 max-w-[132px] truncate text-center text-[10px] text-muted">{hovered.label}</p>
        </div>
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-label={isOut ? "Fade out to black" : "Cut transition"}
        className="fixed z-50 rounded-xl border border-line bg-elevated p-3 text-xs shadow-2xl"
        style={{ left: pos.left, top: pos.top, width: 248 }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium text-text">{heading}</span>
          <button
            type="button"
            onClick={() => {
              clearFn();
              onClose();
            }}
            className={[
              "rounded-md border px-2 py-0.5 text-[11px] transition",
              on ? "border-line bg-panel text-muted hover:text-text" : "border-amber/40 bg-amber/10 text-amber",
            ].join(" ")}
          >
            {clearLabel}
          </button>
        </div>
        {isOut ? (
          <p className="mb-1 text-[11px] leading-snug text-faint">
            Fade the final frame out to black over the chosen time.
          </p>
        ) : (
          <>
            {/* Search across all 55 transitions (by name or type). */}
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search transitions…"
              aria-label="Search transitions"
              className="mb-2 w-full rounded-md border border-line bg-panel px-2 py-1.5 text-[11px] text-text placeholder:text-faint outline-none transition focus:border-amber/50"
            />
            {/* Grouped, scrollable gallery — capped height so all 55 fit on-screen. */}
            <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-0.5">
              {filteredGallery.length === 0 ? (
                <p className="px-1 py-2 text-[11px] text-faint">No transitions match “{query.trim()}”.</p>
              ) : (
                filteredGallery.map((section) => (
                  <div key={section.group}>
                    <p className="mb-1 px-0.5 text-[10px] font-medium uppercase tracking-wider text-faint">
                      {section.group}
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {section.items.map(({ type, label }) => {
                        const active = on && clip.transitionType === type;
                        const showHover = (e: { currentTarget: HTMLElement }) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setHovered({ type, label, x: r.right, y: r.top });
                        };
                        return (
                          <button
                            key={type}
                            type="button"
                            draggable
                            onClick={() => {
                              setPickedType(type);
                              edit.onSetTransition(clip.id, type, dur);
                            }}
                            onDragStart={(e) => {
                              setPickedType(type);
                              setDragging(true);
                              setHovered(null);
                              e.dataTransfer.effectAllowed = "copy";
                              e.dataTransfer.setData(TRANSITION_DND_ID, `${type}|${dur}`);
                              e.dataTransfer.setData("text/plain", label);
                            }}
                            onDragEnd={() => setDragging(false)}
                            onMouseEnter={showHover}
                            onFocus={showHover}
                            onMouseLeave={() => setHovered((h) => (h?.type === type ? null : h))}
                            onBlur={() => setHovered((h) => (h?.type === type ? null : h))}
                            aria-pressed={active}
                            title={`${label} — click to apply, or drag onto a cut`}
                            className={[
                              "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition cursor-grab active:cursor-grabbing",
                              active
                                ? "border-amber bg-amber/10 text-amber"
                                : "border-line bg-panel text-muted hover:border-amber/40 hover:text-text",
                            ].join(" ")}
                          >
                            <span
                              aria-hidden
                              className={["h-2.5 w-2.5 shrink-0 rounded-[2px]", active ? "bg-amber" : "bg-teal/50"].join(" ")}
                            />
                            <span className="truncate text-[11px]">{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
        <label className="mt-3 flex items-center gap-2">
          <span className="shrink-0 text-faint">Duration</span>
          <input
            type="range"
            min={0.1}
            max={2}
            step={0.1}
            value={dur}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDur(v);
              // Live-update only when the fade/transition is already set (keeps the type).
              if (on) setDurFn(v);
            }}
            aria-label={`${isOut ? "Fade out" : "Transition"} duration: ${dur.toFixed(1)}s`}
            style={{ accentColor: "var(--color-amber)" }}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-line"
          />
          <span className="w-8 shrink-0 text-right tabular-nums text-muted">{dur.toFixed(1)}s</span>
        </label>
        {isOut && !on && (
          <button
            type="button"
            onClick={() => edit.onSetFadeOut(clip.id, dur)}
            className="mt-3 w-full rounded-md border border-amber/40 bg-amber/10 px-2 py-1.5 text-[11px] font-medium text-amber transition hover:bg-amber/20"
          >
            Add fade out
          </button>
        )}
        {/* Bulk actions — apply the picked style + duration to every cut, or
            hard-cut the whole timeline. Both are single undo steps. */}
        {!isOut && (
          <div className="mt-3 flex items-center gap-1.5 border-t border-line-soft pt-2.5">
            <button
              type="button"
              onClick={() => {
                edit.onApplyTransitionToAll(pickedType, dur);
                onClose();
              }}
              disabled={cutCount < 1}
              title={`Apply ${TRANSITION_GROUPS[pickedType].label} (${dur.toFixed(1)}s) to all ${cutCount} cut${cutCount === 1 ? "" : "s"}`}
              className="flex-1 rounded-md border border-amber/40 bg-amber/10 px-2 py-1.5 text-[11px] font-medium text-amber transition hover:bg-amber/20 disabled:opacity-40 disabled:hover:bg-amber/10"
            >
              Apply to all cuts
            </button>
            <button
              type="button"
              onClick={() => {
                edit.onRemoveAllTransitions();
                onClose();
              }}
              title="Remove every transition — hard-cut the whole timeline"
              className="rounded-md border border-line bg-panel px-2 py-1.5 text-[11px] text-muted transition hover:text-text"
            >
              Remove all
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ---- track header ----------------------------------------------------------

function TrackHeader({
  track,
  editing,
  draftName,
  dimmed,
  registerRef,
  onHandleDown,
  onBeginRename,
  onDraftChange,
  onCommitRename,
  onCancelRename,
  onToggleFlag,
  onRemove,
  canRemove,
}: {
  track: Track;
  editing: boolean;
  draftName: string;
  dimmed: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  onHandleDown: (e: React.PointerEvent) => void;
  onBeginRename: () => void;
  onDraftChange: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onToggleFlag: (flag: TrackFlag) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const isAudio = track.kind === "audio";
  return (
    <div
      ref={registerRef}
      className={["group flex h-9 items-center gap-1 rounded-lg border border-line bg-elevated/70 pl-1 pr-1 transition", dimmed ? "opacity-60" : ""].join(" ")}
    >
      {/* reorder drag-handle */}
      <button
        type="button"
        onPointerDown={onHandleDown}
        aria-label={`Drag to reorder the ${trackLabel(track)} track`}
        title="Drag to change layer order"
        className="grid h-6 w-3 shrink-0 cursor-grab place-items-center text-faint transition hover:text-text active:cursor-grabbing"
      >
        <Icon path={ICONS.handle} filled />
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        {/* name + kind badge */}
        <div className="flex min-w-0 items-center gap-1">
          <span className={["shrink-0 rounded px-1 py-px text-[8px] uppercase leading-none", isAudio ? "bg-panel text-faint" : "bg-teal/20 text-teal"].join(" ")}>
            {isAudio ? "aud" : "vis"}
          </span>
          {editing ? (
            <input
              type="text"
              value={draftName}
              autoFocus
              onChange={(e) => onDraftChange(e.target.value)}
              onBlur={onCommitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); onCommitRename(); }
                else if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
              }}
              aria-label="Track name"
              className="min-w-0 flex-1 rounded border border-amber/50 bg-panel px-1 py-px text-[11px] text-text outline-none"
            />
          ) : (
            <span
              onDoubleClick={onBeginRename}
              title="Double-click to rename"
              className="min-w-0 flex-1 cursor-text truncate text-[11px] text-text"
            >
              {trackLabel(track)}
            </span>
          )}
        </div>

        {/* flag toggles */}
        <div className="flex items-center gap-0.5">
          {isAudio ? (
            <>
              <FlagButton active={track.muted} onClick={() => onToggleFlag("muted")} label={`${track.muted ? "Unmute" : "Mute"} ${trackLabel(track)}`} icon={track.muted ? ICONS.mute : ICONS.sound} />
              <FlagButton active={track.solo} onClick={() => onToggleFlag("solo")} label={`${track.solo ? "Unsolo" : "Solo"} ${trackLabel(track)}`} letter="S" />
            </>
          ) : (
            <FlagButton active={track.hidden} onClick={() => onToggleFlag("hidden")} label={`${track.hidden ? "Show" : "Hide"} ${trackLabel(track)}`} icon={track.hidden ? ICONS.eyeOff : ICONS.eye} />
          )}
          <FlagButton active={track.locked} onClick={() => onToggleFlag("locked")} label={`${track.locked ? "Unlock" : "Lock"} ${trackLabel(track)}`} icon={track.locked ? ICONS.lock : ICONS.unlock} />
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label={`Remove ${trackLabel(track)} track`}
            title={canRemove ? "Remove track" : "The base video track can't be removed"}
            className="ml-auto grid h-4 w-4 place-items-center rounded text-faint transition hover:bg-danger/15 hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-faint"
          >
            <Icon path={ICONS.close} />
          </button>
        </div>
      </div>
    </div>
  );
}

function FlagButton({
  active,
  onClick,
  label,
  icon,
  letter,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: string;
  letter?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={[
        "grid h-4 w-4 place-items-center rounded text-[9px] font-semibold leading-none transition",
        active ? "bg-amber/20 text-amber" : "text-faint hover:text-text",
      ].join(" ")}
    >
      {letter ? letter : icon ? <Icon path={icon} /> : null}
    </button>
  );
}

/** The amber insertion line shown while dragging a header to reorder layers. */
function TrackInsertLine({ displayTracks, drop }: { displayTracks: Track[]; drop: { kind: TrackKind; index: number } }) {
  // Count display rows (36px h-9 + 6px gap-1.5 = 42px pitch) above the slot,
  // including the visual group's height when inserting into the audio group.
  const group = displayTracks.filter((t) => t.kind === drop.kind);
  const rowsAbove = (drop.kind === "audio" ? displayTracks.filter((t) => t.kind === "visual").length : 0) + Math.min(drop.index, group.length);
  const top = rowsAbove * 42 - 3;
  return <span className="pointer-events-none absolute left-0 right-0 z-10 h-0.5 rounded bg-amber" style={{ top }} aria-hidden />;
}

// ---- inspector -------------------------------------------------------------

/**
 * A compact labelled −/+ stepper for a roll / slip / slide nudge (Wave E). Each
 * press moves the edit by ±0.1s via the matching pure op; presses coalesce into
 * one undo step. Disabled (with an explanatory title) when the op can't apply.
 */
function TrimNudge({
  label,
  title,
  disabled,
  onNudge,
}: {
  label: string;
  title: string;
  disabled: boolean;
  onNudge: (deltaSec: number) => void;
}) {
  const reason =
    label === "Roll"
      ? "No next clip to roll the cut into"
      : label === "Slip"
        ? "Only video clips have source to slip"
        : "Needs a clip on both sides to slide";
  return (
    <span
      role="group"
      aria-label={`${label} the clip`}
      title={disabled ? `${label} — ${reason}` : title}
      className={["flex items-center gap-1", disabled ? "opacity-40" : ""].join(" ")}
    >
      <span className="text-faint">{label}</span>
      <button
        type="button"
        onClick={() => onNudge(-0.1)}
        disabled={disabled}
        aria-label={`${label} 0.1 seconds earlier`}
        className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-muted transition hover:text-text disabled:cursor-not-allowed"
      >
        −0.1s
      </button>
      <button
        type="button"
        onClick={() => onNudge(0.1)}
        disabled={disabled}
        aria-label={`${label} 0.1 seconds later`}
        className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-muted transition hover:text-text disabled:cursor-not-allowed"
      >
        +0.1s
      </button>
    </span>
  );
}

function ClipInspector({
  doc,
  found,
  timeSec,
  edit,
  kfOpen,
  onToggleKf,
  speedOpen,
  onToggleSpeed,
}: {
  doc: EditDoc;
  found: NonNullable<ReturnType<typeof findClip>>;
  timeSec: number;
  edit: TimelineEdit;
  kfOpen: boolean;
  onToggleKf: () => void;
  speedOpen: boolean;
  onToggleSpeed: () => void;
}) {
  const { clip, track } = found;
  const canKeyframe = animatableProps(clip).length > 0;
  const kfCount = "keyframes" in clip && clip.keyframes ? clip.keyframes.length : 0;
  // Speed ramp is video-only and retimes the MAIN footage (the engine skips
  // overlay lanes), so offer it only for a video clip on a main sequential track.
  const canSpeedRamp = clip.kind === "video" && isMainSequentialTrack(track);
  const hasRamp = clip.kind === "video" && !!clip.speedRamp && clip.speedRamp.length >= 2;
  const constSpeed = clip.kind === "video" ? clip.speed ?? 1 : 1;
  const hasVolume = clip.kind === "video" || clip.kind === "audio";
  const volume = hasVolume ? clip.volume : 1;
  const muted = hasVolume && clip.volume === 0;
  const canReorder = isMainSequentialTrack(track) && (track.kind === "audio" ? clip.kind === "audio" : clip.kind === "video" || clip.kind === "image");
  const trim = trimEligibility(track, clip); // roll / slip / slide applicability (Wave E)
  const maxDur = maxTimelineDuration(doc, clip);
  const canSplit = timeSec > clip.start + MIN_CLIP_SEC && timeSec < clip.start + clip.duration - MIN_CLIP_SEC;

  // Remember pre-mute volume so unmute restores it (mute has no schema field).
  const premute = useRef(hasVolume && clip.volume > 0 ? clip.volume : 1);
  if (hasVolume && clip.volume > 0) premute.current = clip.volume;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/60 px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] uppercase text-faint">{clip.kind}</span>
        <span className="text-muted">on</span>
        <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] text-faint">{trackLabel(track)}</span>
      </span>

      {/* Duration via right-edge trim, shown read-only + steppers */}
      <label className="flex items-center gap-1.5">
        <span className="text-faint">Duration</span>
        <span className="tabular-nums text-muted">{fmtTime(clip.duration)}</span>
      </label>
      <span className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => edit.onTrim(clip.id, "right", clip.start + Math.max(MIN_CLIP_SEC, clip.duration - 0.1), `trim-${clip.id}`)}
          className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-muted transition hover:text-text"
          aria-label="Shorten by 0.1s"
        >
          −0.1s
        </button>
        <button
          type="button"
          onClick={() => edit.onTrim(clip.id, "right", clip.start + Math.min(maxDur, clip.duration + 0.1), `trim-${clip.id}`)}
          disabled={clip.duration + 0.1 > maxDur + 1e-6}
          className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-muted transition hover:text-text disabled:opacity-40"
          aria-label="Lengthen by 0.1s"
        >
          +0.1s
        </button>
      </span>

      {hasVolume && (
        <>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
          <label className="flex items-center gap-1.5">
            <span className="text-faint">Vol</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => edit.onSetClipVolume(clip.id, Number(e.target.value), `clipvol-${clip.id}`)}
              aria-label={`Clip volume: ${Math.round(volume * 100)}%`}
              style={{ accentColor: "var(--color-teal)" }}
              className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-line"
            />
            <span className="w-8 tabular-nums text-muted">{Math.round(volume * 100)}%</span>
          </label>
          <button
            type="button"
            onClick={() => edit.onSetClipVolume(clip.id, muted ? premute.current : 0, `clipmute-${clip.id}`)}
            aria-pressed={muted}
            className={[
              "rounded-md border px-2 py-1 transition",
              muted ? "border-amber/40 bg-amber/10 text-amber" : "border-line bg-panel text-muted hover:text-text",
            ].join(" ")}
          >
            {muted ? "Muted" : "Mute"}
          </button>
        </>
      )}

      <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
      {canReorder && (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => edit.onMove(clip.id, "earlier")}
            className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-muted transition hover:text-text"
            aria-label="Move clip earlier"
            title="Move earlier"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => edit.onMove(clip.id, "later")}
            className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-muted transition hover:text-text"
            aria-label="Move clip later"
            title="Move later"
          >
            →
          </button>
        </span>
      )}
      {canKeyframe && (
        <button
          type="button"
          onClick={onToggleKf}
          aria-pressed={kfOpen}
          aria-label={kfOpen ? "Hide keyframes" : "Show keyframes"}
          title="Keyframe the clip's motion / opacity / volume"
          className={[
            "rounded-md border px-2 py-1 transition",
            kfOpen ? "border-amber/40 bg-amber/10 text-amber" : "border-line bg-panel text-muted hover:text-text",
          ].join(" ")}
        >
          ⬦ Keyframes{kfCount > 0 ? ` (${kfCount})` : ""}
        </button>
      )}
      {canSpeedRamp && (
        <button
          type="button"
          onClick={onToggleSpeed}
          aria-pressed={speedOpen}
          aria-label={speedOpen ? "Hide speed ramp" : "Show speed ramp"}
          title="Speed ramp (time remap): a fast → slow → fast speed curve"
          className={[
            "rounded-md border px-2 py-1 transition",
            speedOpen ? "border-amber/40 bg-amber/10 text-amber" : "border-line bg-panel text-muted hover:text-text",
          ].join(" ")}
        >
          ⏩ Speed{hasRamp ? " · curve" : ` · ${constSpeed}×`}
        </button>
      )}

      {/* Advanced trims (Wave E) — discoverable ±0.1s nudges so users don't have
          to find the drag modes. Disabled when the op can't apply to this clip. */}
      {trim.main && (
        <>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
          <TrimNudge
            label="Roll"
            title="Roll: move the cut with the next clip by 0.1s (both outer edges stay put)"
            disabled={!trim.roll}
            onNudge={(d) => edit.onRoll(clip.id, d, `roll-step-${clip.id}`)}
          />
          <TrimNudge
            label="Slip"
            title="Slip: shift what's shown by 0.1s without moving the clip"
            disabled={!trim.slip}
            onNudge={(d) => edit.onSlip(clip.id, d, `slip-step-${clip.id}`)}
          />
          <TrimNudge
            label="Slide"
            title="Slide: move the clip 0.1s; the neighbours adjust to fit"
            disabled={!trim.slide}
            onNudge={(d) => edit.onSlide(clip.id, d, `slide-step-${clip.id}`)}
          />
        </>
      )}
      <button
        type="button"
        onClick={() => edit.onSplitAt(clip.id, timeSec)}
        disabled={!canSplit}
        title="Split at the playhead (S)"
        className="rounded-md border border-line bg-panel px-2 py-1 text-muted transition hover:text-text disabled:opacity-40"
      >
        Split
      </button>
      <button
        type="button"
        onClick={() => edit.onDuplicate(clip.id)}
        className="rounded-md border border-line bg-panel px-2 py-1 text-muted transition hover:text-text"
      >
        Duplicate
      </button>
      <button
        type="button"
        onClick={() => edit.onRippleDelete(clip.id)}
        title="Delete and close the gap (Del)"
        className="rounded-md border border-line bg-panel px-2 py-1 text-danger transition hover:bg-danger/15"
      >
        Ripple delete
      </button>
      <button
        type="button"
        onClick={() => edit.onDelete(clip.id)}
        title="Delete and leave a gap"
        className="rounded-md border border-line bg-panel px-2 py-1 text-muted transition hover:text-text"
      >
        Delete
      </button>
    </div>
  );
}

// ---- speed-ramp (time remap / CapCut "Curve") editor -----------------------

/** A clamped video clip type (the only kind that carries a `speedRamp`). */
type SpeedClip = Extract<Clip, { kind: "video" }>;

/** Speed axis of the curve editor: 0.1×–4× on a LOG scale (so 0.5× / 2× sit
 *  symmetrically around 1×, matching how the multiplier actually reads). */
const SPEED_MIN = 0.1;
const SPEED_MAX = 4;
const SPEED_LOG_MIN = Math.log(SPEED_MIN);
const SPEED_LOG_SPAN = Math.log(SPEED_MAX) - SPEED_LOG_MIN;

const clampN = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const clamp01N = (n: number): number => clampN(n, 0, 1);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** speed multiplier → 0..1 fraction up the (log) Y axis. */
const speedToFrac = (m: number): number =>
  (Math.log(clampN(m, SPEED_MIN, SPEED_MAX)) - SPEED_LOG_MIN) / SPEED_LOG_SPAN;
/** 0..1 fraction up the Y axis → speed multiplier. */
const fracToSpeed = (f: number): number => Math.exp(SPEED_LOG_MIN + clamp01N(f) * SPEED_LOG_SPAN);

/** Nice labels for the engine's speed-ramp presets, in a sensible display order. */
const SPEED_RAMP_PRESET_META: { key: SpeedRampPreset; label: string }[] = [
  { key: "ease-in-out", label: "Ease in-out" },
  { key: "ramp-up", label: "Ramp up" },
  { key: "ramp-down", label: "Ramp down" },
  { key: "hero", label: "Hero" },
  { key: "bullet-time", label: "Bullet time" },
];

/** Stable signature of a set of ramp points, for preset-active detection + sync. */
const rampSig = (pts?: readonly (readonly [number, number])[] | null): string =>
  pts && pts.length ? pts.map(([p, m]) => `${r3(p)},${r3(m)}`).join(" ") : "";

/** Plain-language sketch of a ramp's shape, e.g. "fast → slow → fast". */
function describeRamp(pts: readonly (readonly [number, number])[]): string {
  const word = (m: number): string => (m < 0.85 ? "slow" : m > 1.2 ? "fast" : "normal");
  const words: string[] = [];
  for (const [, m] of pts) {
    const w = word(m);
    if (words[words.length - 1] !== w) words.push(w);
  }
  return words.length ? words.join(" → ") : "constant";
}

/**
 * A compact, draggable speed-curve editor for the selected VIDEO clip (CapCut's
 * "Curve" / time remap). X = clip progress 0→1, Y = speed multiplier 0.1×–4× on a
 * log scale. Preset buttons seed a whole curve; dragging a point (or adding one by
 * clicking the plot, removing one by right-click / Delete) edits the control
 * points — every change routes through `edit.onSetSpeedRamp`, coalesced into one
 * undo step per gesture. "Constant speed" clears the ramp back to a scalar speed.
 *
 * Handles are HTML buttons positioned by percentage over an SVG that draws the
 * curve, so they stay crisp and keyboard-focusable at any width (the tone-curve
 * editor's interaction pattern, generalized to draggable X + add/remove).
 */
function SpeedRampEditor({ clip, edit }: { clip: SpeedClip; edit: TimelineEdit }) {
  const constSpeed = clip.speed ?? 1;
  const ramp = clip.speedRamp;
  const hasRamp = !!ramp && ramp.length >= 2;
  // The doc's current control points, or a flat line at the constant speed when
  // there's no ramp yet (so the first drag turns a constant into a curve).
  const docSig = rampSig(ramp) + `|${constSpeed}`;
  const plotRef = useRef<HTMLDivElement>(null);
  const [pts, setPts] = useState<[number, number][]>(() =>
    hasRamp ? ramp!.map(([p, m]) => [p, m] as [number, number]) : [[0, constSpeed], [1, constSpeed]],
  );
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [selIdx, setSelIdx] = useState<number | null>(null);

  // Re-sync from the doc when it changes (preset applied, undo/redo, cleared) and
  // we're not mid-drag — mirrors the tone-curve editor's sig-driven resync.
  useEffect(() => {
    if (dragIdx !== null) return;
    const cur = clip.speedRamp;
    setPts(
      cur && cur.length >= 2
        ? cur.map(([p, m]) => [p, m] as [number, number])
        : [[0, clip.speed ?? 1], [1, clip.speed ?? 1]],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docSig, dragIdx]);

  const emit = useCallback(
    (next: [number, number][]) => {
      const sorted = [...next].sort((a, b) => a[0] - b[0]);
      edit.onSetSpeedRamp(clip.id, { points: sorted }, `speed-${clip.id}`);
    },
    [edit, clip.id],
  );

  // Live point drag: endpoints keep their X (0 / 1); interior points move freely
  // in X within their neighbours. Attached while an index is being dragged.
  useEffect(() => {
    if (dragIdx === null) return;
    const move = (e: PointerEvent) => {
      const rect = plotRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = clamp01N((e.clientX - rect.left) / rect.width);
      const py = clamp01N(1 - (e.clientY - rect.top) / rect.height);
      const m = fracToSpeed(py);
      setPts((prev) => {
        const next = prev.map((pt) => [...pt] as [number, number]);
        const isFirst = dragIdx === 0;
        const isLast = dragIdx === next.length - 1;
        let p = px;
        if (isFirst) p = 0;
        else if (isLast) p = 1;
        else p = clampN(px, next[dragIdx - 1]![0] + 0.001, next[dragIdx + 1]![0] - 0.001);
        next[dragIdx] = [r3(p), r3(m)];
        emit(next);
        return next;
      });
    };
    const up = () => setDragIdx(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // Attach once per drag; `emit`/geometry are stable for the gesture's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragIdx]);

  // Add a point where the plot background is clicked (unless it lands on top of
  // an existing point's X). Interior points are fully draggable afterwards.
  const addPointAt = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = clamp01N((e.clientX - rect.left) / rect.width);
    const m = fracToSpeed(clamp01N(1 - (e.clientY - rect.top) / rect.height));
    setPts((prev) => {
      if (prev.some((pt) => Math.abs(pt[0] - p) < 0.02)) return prev;
      const next = [...prev.map((pt) => [...pt] as [number, number]), [r3(p), r3(m)] as [number, number]].sort(
        (a, b) => a[0] - b[0],
      );
      emit(next);
      setSelIdx(next.findIndex((pt) => pt[0] === r3(p)));
      return next;
    });
  };

  // Remove an INTERIOR point (right-click / Delete). Endpoints are kept so the
  // curve always spans the whole clip; a curve with only its two endpoints left
  // is effectively a constant.
  const removePoint = (idx: number) => {
    setPts((prev) => {
      if (idx === 0 || idx === prev.length - 1 || prev.length <= 2) return prev;
      const next = prev.filter((_, i) => i !== idx);
      emit(next);
      return next;
    });
    setSelIdx(null);
  };

  const nudge = (idx: number, dP: number, dSpeedFrac: number) => {
    setPts((prev) => {
      const next = prev.map((pt) => [...pt] as [number, number]);
      const isFirst = idx === 0;
      const isLast = idx === next.length - 1;
      let p = next[idx]![0];
      if (!isFirst && !isLast && dP !== 0) {
        p = clampN(p + dP, next[idx - 1]![0] + 0.001, next[idx + 1]![0] - 0.001);
      }
      const m = dSpeedFrac !== 0 ? fracToSpeed(clamp01N(speedToFrac(next[idx]![1]) + dSpeedFrac)) : next[idx]![1];
      next[idx] = [r3(p), r3(m)];
      emit(next);
      return next;
    });
  };

  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  const activePreset = SPEED_RAMP_PRESET_META.find(
    ({ key }) => rampSig(SPEED_RAMP_PRESETS[key]) === rampSig(hasRamp ? ramp : null),
  );
  // Source consumed by the ramp = timeline duration × mean multiplier (the
  // integral of the curve). Honest readout: the clip's on-screen length is fixed.
  const sourceUsed = hasRamp ? clip.duration * speedRampIntegral(sorted, 1) : clip.duration * constSpeed;

  // Curve geometry in a 0..1000 viewBox (SVG scales to the plot; handles are HTML).
  const VB = 1000;
  const toVX = (p: number) => p * VB;
  const toVY = (m: number) => (1 - speedToFrac(m)) * VB;
  const curvePath = sorted
    .map((pt, i) => `${i === 0 ? "M" : "L"}${toVX(pt[0]).toFixed(1)},${toVY(pt[1]).toFixed(1)}`)
    .join(" ");
  const oneY = toVY(1);

  return (
    <div className="mt-2 rounded-xl border border-line bg-elevated/40 px-3 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="uppercase tracking-wider text-faint">Speed ramp</span>
        <span className="text-line">·</span>
        <span className="text-muted">
          time remap — {hasRamp ? describeRamp(sorted) : "constant"}
          {" · "}applies on preview + export
        </span>
      </div>

      {/* Preset buttons + constant-speed clear */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {SPEED_RAMP_PRESET_META.map(({ key, label }) => {
          const on = activePreset?.key === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => edit.onSetSpeedRamp(clip.id, { preset: key })}
              aria-pressed={on}
              title={`${label} speed ramp — ${describeRamp(SPEED_RAMP_PRESETS[key])}`}
              className={[
                "rounded-md border px-2 py-1 text-[11px] transition",
                on ? "border-amber bg-amber/10 text-amber" : "border-line bg-panel text-muted hover:border-amber/40 hover:text-text",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
        <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
        <button
          type="button"
          onClick={() => edit.onClearSpeedRamp(clip.id)}
          disabled={!hasRamp}
          aria-pressed={!hasRamp}
          title="Remove the speed curve and play at a single constant speed"
          className={[
            "rounded-md border px-2 py-1 text-[11px] transition",
            !hasRamp ? "border-amber/40 bg-amber/10 text-amber" : "border-line bg-panel text-muted hover:text-text",
          ].join(" ")}
        >
          Constant speed
        </button>
      </div>

      <div className="flex flex-wrap items-stretch gap-3">
        {/* The draggable curve. Y labels sit to the left. */}
        <div className="flex items-stretch gap-1.5">
          <div className="flex w-8 shrink-0 flex-col justify-between py-0.5 text-right text-[9px] tabular-nums text-faint">
            <span>{SPEED_MAX}×</span>
            <span>1×</span>
            <span>{SPEED_MIN}×</span>
          </div>
          <div
            ref={plotRef}
            role="group"
            aria-label="Speed curve — click to add a point, drag points to shape, right-click a point to remove"
            className="relative h-32 w-64 max-w-full shrink-0 cursor-copy touch-none rounded-lg border border-line bg-panel"
            onPointerDown={addPointAt}
          >
            <svg
              viewBox={`0 0 ${VB} ${VB}`}
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-hidden
              focusable="false"
            >
              {/* 1× reference + vertical thirds */}
              <line x1={0} y1={oneY} x2={VB} y2={oneY} stroke="var(--color-line)" strokeWidth={2} strokeDasharray="10 10" />
              <line x1={VB / 3} y1={0} x2={VB / 3} y2={VB} stroke="var(--color-line)" strokeWidth={1} strokeDasharray="6 10" opacity={0.5} />
              <line x1={(2 * VB) / 3} y1={0} x2={(2 * VB) / 3} y2={VB} stroke="var(--color-line)" strokeWidth={1} strokeDasharray="6 10" opacity={0.5} />
              <path d={curvePath} fill="none" stroke="var(--color-amber)" strokeWidth={6} vectorEffect="non-scaling-stroke" />
            </svg>
            {sorted.map((pt, i) => {
              const isEnd = i === 0 || i === sorted.length - 1;
              const isSel = selIdx === i;
              return (
                <button
                  key={`${i}-${pt[0]}`}
                  type="button"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                    setSelIdx(i);
                    setDragIdx(i);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    removePoint(i);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelIdx(i);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Delete" || e.key === "Backspace") {
                      e.preventDefault();
                      removePoint(i);
                    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      nudge(i, 0, e.key === "ArrowUp" ? 0.05 : -0.05);
                    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !isEnd) {
                      e.preventDefault();
                      nudge(i, e.key === "ArrowRight" ? 0.02 : -0.02, 0);
                    }
                  }}
                  aria-label={`Speed point at ${Math.round(pt[0] * 100)}% of the clip, ${pt[1]}×${isEnd ? " (edge — speed only)" : ""}`}
                  title={`${pt[1]}× @ ${Math.round(pt[0] * 100)}% · drag to shape${isEnd ? "" : " · right-click to remove"}`}
                  className="absolute z-10 grid h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab place-items-center rounded-full border-2 border-panel bg-amber outline-none transition active:cursor-grabbing"
                  style={{
                    left: `${pt[0] * 100}%`,
                    top: `${(1 - speedToFrac(pt[1])) * 100}%`,
                    boxShadow: isSel ? "0 0 0 2px var(--color-amber)" : undefined,
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* Right column: X-axis label, readout, and a constant-speed slider. */}
        <div className="flex min-w-[180px] flex-1 flex-col justify-between gap-2 text-[11px]">
          <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-faint">
            <span>start</span>
            <span>clip progress</span>
            <span>end</span>
          </div>
          <p className="text-muted">
            {hasRamp ? (
              <>
                Curve: <span className="text-text">{describeRamp(sorted)}</span>. The clip stays{" "}
                <span className="tabular-nums">{fmtTime(clip.duration)}</span> long; it plays{" "}
                <span className="tabular-nums">{fmtTime(sourceUsed)}</span> of source.
              </>
            ) : (
              <>Add a point or pick a preset to build a speed curve. The clip keeps its {fmtTime(clip.duration)} length.</>
            )}
          </p>
          <label className="flex items-center gap-2">
            <span className="shrink-0 text-faint">Constant</span>
            <input
              type="range"
              min={0.25}
              max={4}
              step={0.05}
              value={hasRamp ? 1 : constSpeed}
              onChange={(e) => edit.onSetConstantSpeed(clip.id, Number(e.target.value), `cspeed-${clip.id}`)}
              aria-label={`Constant speed: ${hasRamp ? "1" : constSpeed}×`}
              title="Set a single constant speed (clears the curve)"
              style={{ accentColor: "var(--color-amber)" }}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-line"
            />
            <span className="w-9 shrink-0 text-right tabular-nums text-muted">
              {hasRamp ? "—" : `${constSpeed}×`}
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}

// ---- on-timeline keyframe editor -------------------------------------------

const KF_EPS = 1e-3;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Format a keyframe value for the compact display (per-prop precision). */
function fmtKfValue(prop: KeyframeProp, v: number): string {
  if (prop === "scale" || prop === "opacity" || prop === "volume") return v.toFixed(2);
  return String(Math.round(v));
}

/**
 * The expandable per-prop keyframe editor for the selected clip. One thin sub-lane
 * per animatable prop (t = 0 at the clip's head → 1 at its tail); each keyframe is
 * a draggable diamond at `t · laneWidth`. Add at the playhead, edit the selected
 * diamond's value/easing, drag to retime, right-click / Del to remove. Every edit
 * routes through the timeline callbacks → the editor's undoable commit.
 */
function KeyframeEditor({
  clip,
  timeSec,
  edit,
}: {
  clip: Clip;
  timeSec: number;
  edit: TimelineEdit;
}) {
  const props = animatableProps(clip);
  const [sel, setSel] = useState<{ prop: KeyframeProp; t: number } | null>(null);
  const laneRefs = useRef<Map<KeyframeProp, HTMLDivElement>>(new Map());
  const drag = useRef<{ prop: KeyframeProp; origT: number; fromT: number; startX: number; width: number } | null>(null);
  const progress = clipProgress(clip, timeSec);
  const kfs = "keyframes" in clip ? clip.keyframes : undefined;
  // Every clip KeyframeEditor renders for (video/image/text/solid/audio) carries a
  // `keyframes` field; narrow past the cursor/callout union members for clipKeyframes.
  const kfClip = clip as Parameters<typeof clipKeyframes>[0];

  // Drop the selection if its diamond no longer exists (removed / undone).
  useEffect(() => {
    if (sel && !clipKeyframes(kfClip, sel.prop).some((k) => Math.abs(k.t - sel.t) < KF_EPS)) setSel(null);
  }, [kfClip, sel]);

  const startDiamondDrag = (e: React.PointerEvent, prop: KeyframeProp, t: number) => {
    e.stopPropagation();
    const lane = laneRefs.current.get(prop);
    const width = lane?.getBoundingClientRect().width ?? 1;
    drag.current = { prop, origT: t, fromT: t, startX: e.clientX, width };
    setSel({ prop, t });
    let moved = false;
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const newT = round3(Math.max(0, Math.min(1, d.origT + dx / Math.max(1, d.width))));
      if (Math.abs(newT - d.fromT) >= KF_EPS) {
        edit.onMoveKeyframe(clip.id, d.prop, d.fromT, newT);
        d.fromT = newT;
        setSel({ prop: d.prop, t: newT });
      }
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const addAtPlayhead = (prop: KeyframeProp) => {
    const value = valueAt(kfs, prop, progress, baseValue(clip, prop));
    const t = round3(progress);
    edit.onSetKeyframe(clip.id, { prop, t, value });
    setSel({ prop, t });
  };

  const selectedKf =
    sel ? clipKeyframes(kfClip, sel.prop).find((k) => Math.abs(k.t - sel.t) < KF_EPS) ?? null : null;

  return (
    <div className="mt-2 rounded-xl border border-line bg-elevated/40 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <span className="uppercase tracking-wider text-faint">Keyframes</span>
        <span className="text-line">·</span>
        <span className="text-muted">click a lane&apos;s ⬦ to add at the playhead · drag diamonds to retime · right-click to remove</span>
      </div>
      <div className="flex flex-col gap-1">
        {props.map((prop) => {
          const rowKfs = clipKeyframes(kfClip, prop);
          const meta = PROP_META[prop];
          return (
            <div key={prop} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[10px] uppercase text-faint">{meta.label}</span>
              <button
                type="button"
                onClick={() => addAtPlayhead(prop)}
                aria-label={`Add a ${meta.label} keyframe at the playhead`}
                title={`Add a ${meta.label} keyframe at the playhead`}
                className="grid h-5 w-5 shrink-0 place-items-center rounded-md border border-line bg-panel text-amber outline-none transition hover:border-amber/40"
              >
                ⬦
              </button>
              <div
                ref={(el) => {
                  if (el) laneRefs.current.set(prop, el);
                  else laneRefs.current.delete(prop);
                }}
                className="relative h-5 flex-1 rounded-md bg-line-soft/40"
              >
                {/* clip-progress playhead marker */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 z-0 w-px bg-amber/70"
                  style={{ left: `${progress * 100}%` }}
                />
                {rowKfs.map((k) => {
                  const isSel = sel?.prop === prop && Math.abs(sel.t - k.t) < KF_EPS;
                  return (
                    <button
                      key={`${prop}-${k.t}`}
                      type="button"
                      onPointerDown={(e) => startDiamondDrag(e, prop, k.t)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel({ prop, t: k.t });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        edit.onRemoveKeyframe(clip.id, prop, k.t);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault();
                          edit.onRemoveKeyframe(clip.id, prop, k.t);
                        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                          e.preventDefault();
                          const nt = round3(Math.max(0, Math.min(1, k.t + (e.key === "ArrowRight" ? 0.02 : -0.02))));
                          edit.onMoveKeyframe(clip.id, prop, k.t, nt);
                          setSel({ prop, t: nt });
                        }
                      }}
                      aria-label={`${meta.label} keyframe at ${Math.round(k.t * 100)}%, value ${fmtKfValue(prop, k.value)}${isSel ? ", selected" : ""}`}
                      title={`${meta.label} ${fmtKfValue(prop, k.value)} @ ${Math.round(k.t * 100)}% · drag to retime · right-click to remove`}
                      className="absolute top-1/2 z-10 grid h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center outline-none"
                      style={{ left: `${k.t * 100}%` }}
                    >
                      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden focusable="false">
                        <path
                          d="M6 1 11 6 6 11 1 6Z"
                          fill={isSel ? "var(--color-amber)" : "var(--color-teal)"}
                          stroke={isSel ? "var(--color-amber)" : "var(--color-teal)"}
                          strokeWidth={1}
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Selected-diamond controls: value + easing + remove */}
      {sel && selectedKf && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line-soft pt-2 text-xs">
          <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] uppercase text-faint">
            {PROP_META[sel.prop].label} @ {Math.round(sel.t * 100)}%
          </span>
          <label className="flex items-center gap-1.5">
            <span className="text-faint">Value</span>
            <input
              type="number"
              step={PROP_META[sel.prop].step}
              value={selectedKf.value}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) edit.onSetKeyframe(clip.id, { prop: sel.prop, t: sel.t, value: v, easing: selectedKf.easing });
              }}
              aria-label={`${PROP_META[sel.prop].label} value`}
              className="w-20 rounded-md border border-line bg-panel px-1.5 py-0.5 text-text outline-none"
            />
            {PROP_META[sel.prop].unit && <span className="text-faint">{PROP_META[sel.prop].unit}</span>}
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-faint">Easing</span>
            <select
              value={selectedKf.easing}
              onChange={(e) =>
                edit.onSetKeyframe(clip.id, { prop: sel.prop, t: sel.t, value: selectedKf.value, easing: e.target.value as KeyframeEasing })
              }
              aria-label="Keyframe easing"
              className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-muted outline-none"
            >
              {EASINGS.map((es) => (
                <option key={es} value={es}>
                  {es}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => edit.onRemoveKeyframe(clip.id, sel.prop, sel.t)}
            className="rounded-md border border-line bg-panel px-2 py-0.5 text-danger transition hover:bg-danger/15"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
