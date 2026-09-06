"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Clip, EditDoc, Track, TrackKind } from "@cadence/core";
import { fmtTime } from "@/lib/format";
import { computeWaveform } from "@/lib/waveform";
import { findClip, isMainSequentialTrack, maxTimelineDuration, MIN_CLIP_SEC, type TrimEdge } from "@/lib/edit-ops";

/** The media whose audio the waveform should visualize (prefers the base video). */
export interface WaveformSource {
  mediaId: string;
  file?: File;
  url?: string;
}

/** Track-flag toggles surfaced on the header (subset of the schema's booleans). */
export type TrackFlag = "hidden" | "locked" | "muted" | "solo";

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
};

const ZOOM_MIN = 1;
const ZOOM_MAX = 24;
/** Pixels within which a drag snaps to a neighbor edge / playhead / marker. */
const SNAP_PX = 8;
/** Width of the sticky track-header gutter (px). */
const GUTTER_PX = 152;

function clipLabel(clip: Clip): string {
  if (clip.kind === "text") return `“${clip.text.slice(0, 18)}”`;
  if (clip.kind === "audio") return "audio";
  if (clip.kind === "solid") return "solid";
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

type DragKind = "trim-left" | "trim-right" | "move" | "seek" | null;

interface DragState {
  kind: DragKind;
  clipId: string;
  trackId: string;
  pointerId: number;
  startX: number;
  /** Geometry captured at drag start so edge math is independent of live commits. */
  origStart: number;
  origEnd: number;
  moved: boolean;
  /** A within-main-track reorder resolves to a sequential index. */
  dropIndex: number | null;
  /** A cross-track / free move resolves to a destination track + snapped start. */
  dropTrackId: string | null;
  dropStart: number | null;
}

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
  // Track-reorder insertion line: the kind group + top-first slot the header will land in.
  const [trackDrop, setTrackDrop] = useState<{ kind: TrackKind; index: number } | null>(null);
  // Inline rename editor state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

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
    drag.current = {
      kind: edge ?? "move",
      clipId: clip.id,
      trackId: track.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      origStart: clip.start,
      origEnd: clip.start + clip.duration,
      moved: false,
      dropIndex: null,
      dropTrackId: null,
      dropStart: null,
    };
  };

  const laneRectX = useCallback(() => {
    return lanesRef.current?.getBoundingClientRect().left ?? 0;
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
          {selected ? "trim edges · drag to reorder or onto another track" : "click a cut to select · drag the ruler to scan"}
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
          <div ref={lanesRef} className="relative select-none" style={{ width: contentWidth || "100%" }}>
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
                          title={`${clip.kind} · ${fmtTime(clip.duration)}${track.locked ? " · locked" : " · double-click to zoom to it"}`}
                          className={[
                            "group absolute inset-y-0 overflow-hidden rounded-md border px-2 text-left text-[11px] leading-9 outline-none transition",
                            color,
                            track.locked ? "pointer-events-none cursor-default" : draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                            isSelected
                              ? "z-10 ring-2 ring-amber shadow-[0_0_0_1px_var(--color-amber)]"
                              : active
                                ? "ring-2 ring-amber/70"
                                : "hover:brightness-125",
                          ].join(" ")}
                          style={{ left, width }}
                        >
                          <span className="pointer-events-none block truncate">{clipLabel(clip)}</span>
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
                        </div>
                      );
                    })}
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

      {/* Inspector for the selected clip */}
      {selected && <ClipInspector doc={doc} found={selected} timeSec={timeSec} edit={edit} />}
    </section>
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
            className="ml-auto grid h-4 w-4 place-items-center rounded text-faint transition hover:bg-red-500/15 hover:text-red-300 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-faint"
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

function ClipInspector({
  doc,
  found,
  timeSec,
  edit,
}: {
  doc: EditDoc;
  found: NonNullable<ReturnType<typeof findClip>>;
  timeSec: number;
  edit: TimelineEdit;
}) {
  const { clip, track } = found;
  const hasVolume = clip.kind === "video" || clip.kind === "audio";
  const volume = hasVolume ? clip.volume : 1;
  const muted = hasVolume && clip.volume === 0;
  const canReorder = isMainSequentialTrack(track) && (track.kind === "audio" ? clip.kind === "audio" : clip.kind === "video" || clip.kind === "image");
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
        className="rounded-md border border-line bg-panel px-2 py-1 text-red-300 transition hover:bg-red-500/15"
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
