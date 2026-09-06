"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Clip, EditDoc } from "@cadence/core";
import { fmtTime } from "@/lib/format";
import { computeWaveform } from "@/lib/waveform";
import { findClip, isMainSequentialTrack, maxTimelineDuration, MIN_CLIP_SEC, type TrimEdge } from "@/lib/edit-ops";

/** The media whose audio the waveform should visualize (prefers the base video). */
export interface WaveformSource {
  mediaId: string;
  file?: File;
  url?: string;
}

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

function clipLabel(clip: Clip): string {
  if (clip.kind === "text") return `“${clip.text.slice(0, 18)}”`;
  if (clip.kind === "audio") return "audio";
  if (clip.kind === "solid") return "solid";
  return fmtTime(clip.duration);
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
  /** For a reorder drag: current target sequential index (rendered as a marker). */
  dropIndex: number | null;
}

export function CutsStrip({ doc, timeSec, durationSec, onSeek, waveform, edit }: CutsStripProps) {
  const total = durationSec || 1;
  const peaks = useWaveformPeaks(waveform);
  const { selectedClipId } = edit;

  // Zoom multiplier: at 1 the whole timeline fits the lane width (matching the
  // previous %-based look); >1 makes it wider and horizontally scrollable.
  const [zoom, setZoom] = useState(1);
  const [laneWidth, setLaneWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);

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
  const zoomTo = useCallback((next: number) => {
    centerOnPlayhead.current = true;
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next * 10) / 10)));
  }, []);
  useLayoutEffect(() => {
    if (!centerOnPlayhead.current) return;
    centerOnPlayhead.current = false;
    const el = scrollRef.current;
    if (el && pxPerSec > 0) el.scrollLeft = Math.max(0, timeSec * pxPerSec - el.clientWidth / 2);
  }, [zoom, pxPerSec, timeSec]);

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
  const rafRef = useRef<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ trackId: string; x: number } | null>(null);

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

  // ---- pointer handlers ----------------------------------------------------

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, trackId: string, edge: DragKind) => {
    // edge is "trim-left"/"trim-right" from a handle, otherwise a body press.
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = {
      kind: edge ?? "move",
      clipId: clip.id,
      trackId,
      pointerId: e.pointerId,
      startX: e.clientX,
      origStart: clip.start,
      origEnd: clip.start + clip.duration,
      moved: false,
      dropIndex: null,
    };
  };

  const laneRectX = useCallback(() => {
    return lanesRef.current?.getBoundingClientRect().left ?? 0;
  }, []);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
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
        const { track } = found;
        const deltaSec = pxToSec(e.clientX - cur.startX);

        if (cur.kind === "trim-right") {
          const edgeTime = snap(cur.origEnd + deltaSec, cur.clipId);
          edit.onTrim(cur.clipId, "right", edgeTime, `trim-${cur.clipId}`);
        } else if (cur.kind === "trim-left") {
          const edgeTime = snap(cur.origStart + deltaSec, cur.clipId);
          edit.onTrim(cur.clipId, "left", edgeTime, `trim-${cur.clipId}`);
        } else if (cur.kind === "move" && isMainSequentialTrack(track)) {
          // Reorder: find the sequential drop index from the cursor x.
          const xInLane = e.clientX - laneRectX() + (scrollRef.current?.scrollLeft ?? 0);
          const seq = track.clips.filter((c) => (track.kind === "audio" ? c.kind === "audio" : c.kind === "video" || c.kind === "image"));
          let idx = seq.length - 1;
          for (let i = 0; i < seq.length; i++) {
            const c = seq[i]!;
            const mid = secToPx(c.start + c.duration / 2);
            if (xInLane < mid) { idx = i; break; }
          }
          cur.dropIndex = idx;
          const target = seq[idx];
          setDropIndicator({ trackId: track.id, x: target ? secToPx(target.start) : contentWidth });
        }
      });
    },
    [doc, pxToSec, secToPx, snap, edit, laneRectX, contentWidth],
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
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
      }
      void e;
    },
    [doc, edit, onSeek],
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

  return (
    <section aria-label="Timeline" className="border-t border-line-soft bg-panel/40 px-4 pb-4 pt-3">
      {/* Toolbar */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="uppercase tracking-wider text-faint">Timeline</span>
        <span className="text-line">·</span>
        <span className="text-muted">
          {selected ? "click edges to trim · drag to reorder" : "click a cut to select · drag the ruler to scan"}
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

      {/* Scrollable timeline */}
      <div ref={scrollRef} className="relative overflow-x-auto overflow-y-hidden">
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
            {doc.tracks.map((track) => (
              <div
                key={track.id}
                className="relative h-9 rounded-lg bg-line-soft/40"
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) seekFromPointer(e);
                }}
              >
                {dropIndicator && dropIndicator.trackId === track.id && (
                  <span className="pointer-events-none absolute inset-y-0 z-30 w-0.5 bg-amber" style={{ left: dropIndicator.x }} />
                )}
                {track.clips.map((clip) => {
                  const left = secToPx(clip.start);
                  const width = Math.max(4, secToPx(clip.duration) - 2);
                  const active = timeSec >= clip.start && timeSec < clip.start + clip.duration;
                  const isSelected = clip.id === selectedClipId;
                  const color = TRACK_COLORS[clip.kind] ?? TRACK_COLORS.audio;
                  const canReorder = isMainSequentialTrack(track) && (track.kind === "audio" ? clip.kind === "audio" : clip.kind === "video" || clip.kind === "image");
                  return (
                    <div
                      key={clip.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`${clip.kind} clip, ${fmtTime(clip.duration)}${isSelected ? ", selected" : ""}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          edit.onSelectClip(clip.id);
                          onSeek(clip.start + 0.001);
                        }
                      }}
                      onPointerDown={(e) => onClipPointerDown(e, clip, track.id, "move")}
                      title={`${clip.kind} · ${fmtTime(clip.duration)}`}
                      className={[
                        "group absolute inset-y-0 overflow-hidden rounded-md border px-2 text-left text-[11px] leading-9 outline-none transition",
                        color,
                        canReorder ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
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
                      <span
                        onPointerDown={(e) => onClipPointerDown(e, clip, track.id, "trim-left")}
                        className={[
                          "absolute inset-y-0 left-0 w-2 cursor-col-resize",
                          isSelected ? "bg-amber/80" : "opacity-0 group-hover:bg-amber/40 group-hover:opacity-100",
                        ].join(" ")}
                        aria-hidden
                      />
                      <span
                        onPointerDown={(e) => onClipPointerDown(e, clip, track.id, "trim-right")}
                        className={[
                          "absolute inset-y-0 right-0 w-2 cursor-col-resize",
                          isSelected ? "bg-amber/80" : "opacity-0 group-hover:bg-amber/40 group-hover:opacity-100",
                        ].join(" ")}
                        aria-hidden
                      />
                    </div>
                  );
                })}
              </div>
            ))}

            {peaks && peaks.length > 0 && (
              <div className="relative h-7 overflow-hidden rounded-lg bg-line-soft/25" aria-label="Audio waveform">
                <WaveformStrip peaks={peaks} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Inspector for the selected clip */}
      {selected && <ClipInspector doc={doc} found={selected} timeSec={timeSec} edit={edit} />}
    </section>
  );
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
        <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] text-faint">{track.id}</span>
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
