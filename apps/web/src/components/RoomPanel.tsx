"use client";

import { useEffect, useRef, useState } from "react";
import type {
  AudioClip,
  BlendMode,
  ColorGrade,
  CurvePoint,
  EditDoc,
  MediaAsset,
} from "@cadence/core";
import { cssFilter, docDurationSec } from "@cadence/core";
import {
  addAdjustment,
  addMask,
  adjustColor,
  adjustCurves,
  adjustHsl,
  applyLut,
  audioFade,
  chromaKey,
  currentGrade,
  normalizeLoudness,
  regionBlur,
  setBlend,
  setPan,
  LOOK_KEYS,
  LOOK_PRESETS,
  NEUTRAL_GRADE,
  type LookKey,
} from "@cadence/director";
import {
  clearChroma,
  clearMask,
  clearRegionFx,
  compositeScope,
  currentBlend,
  currentChroma,
  currentMask,
  currentRegionFx,
  trackFade,
  trackPan,
} from "@/lib/fx";
import { EMOJI_STICKERS, TEXT_PRESETS, insertSticker, type PlaceOpts } from "@/lib/text-presets";
import { fmtTime, download, downloadBlob } from "@/lib/format";
import { describeDoc } from "@/lib/status";
import {
  LOOK_FAMILIES,
  ALL_LOOKS,
  BG_SWATCHES,
  applyLookPreset,
  clearLook,
  looksActive,
  isNeutralGrade,
  setBackground,
  backgroundActive,
  type LookPreset,
} from "@/lib/design-presets";
import { captionsToSrt, hasCaptions } from "@/lib/srt";
import { renderFrameBlob, uploadMedia } from "@/lib/api";
import { VoiceOverRecorder } from "./VoiceOverRecorder";
import { TranscriptRoom } from "./TranscriptRoom";
import { DemoRoom } from "./DemoRoom";
import type { Transcript } from "@cadence/understanding";
import type { RoomKey } from "./RoomsRail";
import { MEDIA_DND_ID, MEDIA_DND_AUDIO, MEDIA_DND_VISUAL } from "./CutsStrip";
import type { BeginPlacement } from "@/lib/placement";

interface RoomPanelProps {
  room: Exclude<RoomKey, "edit">;
  doc: EditDoc;
  mediaList: MediaAsset[];
  /** Object URLs for loaded media (by id) — the Color room's scopes sample these. */
  urls: Record<string, string>;
  busy: boolean;
  /** Same handler QuickActions/DirectorRail use — a director request. */
  onAction: (prompt: string) => void;
  /**
   * Apply a fully-formed edit-doc directly (client-side, no server round-trip).
   * Wired to the editor's commit path so every room control is instant AND
   * undoable — `@cadence/director` is pure, so `adjustColor(doc, …)` /
   * `chromaKey(doc, …)` / `audioFade(doc, …)` all run in the browser. Pass a
   * `coalesceKey` for a continuous control (a slider drag) so the whole drag
   * collapses into ONE undo step; omit it for a discrete toggle (its own step).
   */
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  /** Same handler DirectorRail uses — add files (video/photos/audio). */
  onFiles: (files: File[]) => void;
  onExport: () => void;
  canExport: boolean;
  /** Current playhead time (seconds) — the frame the Deliver room's thumbnail grabs. */
  timeSec: number;
  /** Preview mute state (lifted to the editor; also toggled in the transport). */
  muted: boolean;
  onToggleMute: () => void;
  /** Media room: move a media's clip earlier/later on the timeline (undoable). */
  onReorderMedia: (mediaId: string, dir: "up" | "down") => void;
  /** Media room: remove a media and its clips from the project (undoable). */
  onRemoveMedia: (mediaId: string) => void;
  /** Media room: append a media to the timeline (the keyboard/click parity for DnD). */
  onAddMediaToTimeline?: (mediaId: string) => void;
  /** Audio room: register a recorded voice-over (blob + measured duration). */
  onRecordVoiceover: (file: File, durationSec: number) => void;
  /** Audio room: set the volume of every audio clip on a track (music/voiceover). */
  onSetTrackVolume: (trackId: string, volume: number) => void;
  /** Words room: cached transcripts by media id (fetched server-side). */
  transcripts: Record<string, Transcript>;
  /** Words room: transcripts came from the offline stub (no Whisper installed). */
  transcriptApproximate: boolean;
  /** Words room: media ids currently being transcribed on demand. */
  transcribing: Record<string, boolean>;
  /** Words room: fetch + cache a transcript for a media (server-side). */
  onEnsureTranscript: (media: MediaAsset) => void;
  /** Words room: generate an AI (TTS) voice-over; resolves to a message to surface. */
  onGenerateVoiceover: (text: string) => Promise<string>;
  /** Demo/VFX rooms: arm an on-preview placement gesture (click/drag → composition fractions). */
  onBeginPlacement?: BeginPlacement;
  /** Audio room: detect beats in the music/audio and drop them as markers. */
  onDetectBeats?: () => void | Promise<void>;
  /** Audio room: split the clips under every timeline marker (beat-snapped cutting). */
  onSplitAtBeats?: () => void;
  /** Audio room: whether a decodable audio source exists for beat detection. */
  canDetectBeats?: boolean;
  /** Audio room: number of markers currently on the timeline. */
  markerCount?: number;
  /** Words room: the clip selected on the timeline (enables "this caption only"). */
  selectedClipId?: string | null;
}

/** Shared wrapper so every room reads as the same contextual strip. */
function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      {children}
    </div>
  );
}

function Pill({
  onClick,
  disabled,
  active,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={[
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-50",
        active
          ? "border-teal/40 bg-teal/10 text-teal"
          : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/** Compact 0..1 volume slider for an audio track (music / voice-over). */
function VolumeSlider({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const pct = Math.round(value * 100);
  return (
    <label className="flex w-[132px] shrink-0 flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
        <span>{label} vol</span>
        <span className="tabular-nums text-muted">{pct}%</span>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${label} volume: ${pct}%`}
        style={{ accentColor: "var(--color-teal)" }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

export function RoomPanel(props: RoomPanelProps) {
  const {
    room,
    doc,
    mediaList,
    urls,
    busy,
    onAction,
    onApplyDoc,
    onFiles,
    onExport,
    canExport,
    timeSec,
    muted,
    onToggleMute,
    onReorderMedia,
    onRemoveMedia,
    onAddMediaToTimeline,
    onRecordVoiceover,
    onSetTrackVolume,
    transcripts,
    transcriptApproximate,
    transcribing,
    onEnsureTranscript,
    onGenerateVoiceover,
    onBeginPlacement,
    onDetectBeats,
    onSplitAtBeats,
    canDetectBeats,
    markerCount,
    selectedClipId,
  } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const openPicker = () => fileRef.current?.click();

  const status = describeDoc(doc);

  const hiddenInput = (
    <input
      ref={fileRef}
      type="file"
      accept="video/*,image/*,audio/*"
      multiple
      className="hidden"
      onChange={(e) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        if (files.length) onFiles(files);
        e.target.value = "";
      }}
    />
  );

  if (room === "media") {
    return (
      <>
        <MediaGrid
          mediaList={mediaList}
          urls={urls}
          busy={busy}
          onOpenPicker={openPicker}
          onFiles={onFiles}
          onReorderMedia={onReorderMedia}
          onRemoveMedia={onRemoveMedia}
          onAddToTimeline={onAddMediaToTimeline}
        />
        {hiddenInput}
        <TrackPanel doc={doc} busy={busy} onSetTrackVolume={onSetTrackVolume} />
      </>
    );
  }

  if (room === "words") {
    return (
      <TranscriptRoom
        doc={doc}
        mediaList={mediaList}
        busy={busy}
        transcripts={transcripts}
        approximate={transcriptApproximate}
        transcribing={transcribing}
        onEnsureTranscript={onEnsureTranscript}
        onApplyDoc={onApplyDoc}
        onGenerateVoiceover={onGenerateVoiceover}
        onRecordVoiceover={onRecordVoiceover}
        onBeginPlacement={onBeginPlacement}
        selectedClipId={selectedClipId}
      />
    );
  }

  if (room === "demo") {
    return (
      <DemoRoom
        doc={doc}
        mediaList={mediaList}
        busy={busy}
        timeSec={timeSec}
        onApplyDoc={onApplyDoc}
        onFiles={onFiles}
        onReorderMedia={onReorderMedia}
        onBeginPlacement={onBeginPlacement}
      />
    );
  }

  if (room === "design") {
    return (
      <DesignRoom
        doc={doc}
        mediaList={mediaList}
        urls={urls}
        busy={busy}
        timeSec={timeSec}
        onAction={onAction}
        onApplyDoc={onApplyDoc}
        onBeginPlacement={onBeginPlacement}
        status={status}
      />
    );
  }

  if (room === "audio") {
    return (
      <AudioRoom
        doc={doc}
        mediaList={mediaList}
        busy={busy}
        muted={muted}
        onAction={onAction}
        onApplyDoc={onApplyDoc}
        onToggleMute={onToggleMute}
        onSetTrackVolume={onSetTrackVolume}
        onRecordVoiceover={onRecordVoiceover}
        openPicker={openPicker}
        hiddenInput={hiddenInput}
        onDetectBeats={onDetectBeats}
        onSplitAtBeats={onSplitAtBeats}
        canDetectBeats={canDetectBeats}
        markerCount={markerCount}
      />
    );
  }

  // deliver
  return (
    <DeliverRoom
      doc={doc}
      mediaList={mediaList}
      busy={busy}
      timeSec={timeSec}
      onAction={onAction}
      onExport={onExport}
      canExport={canExport}
      status={status}
    />
  );
}

// ---- Shared room controls --------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const clampN = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** A wrapping strip label + controls row (never hides controls in a horizontal scroll). */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-[92px] shrink-0 text-[10px] uppercase tracking-wider text-faint">{label}</span>
      {children}
    </div>
  );
}

/**
 * A generic labelled range slider with a unit-aware read-out. `format` renders the
 * value shown (and spoken via aria-valuetext), so a screen reader hears
 * "Hue, 60°", not "0.60" — the roadmap's a11y ask.
 */
function FxSlider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
  format,
  width = "120px",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  width?: string;
}) {
  const shown = format ? format(value) : value.toFixed(2);
  return (
    <label className="flex shrink-0 flex-col gap-1" style={{ width }}>
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
        <span>{label}</span>
        <span className="tabular-nums text-muted">{shown}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={`${label}, ${shown}`}
        style={{ accentColor: "var(--color-teal)" }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

/** A compact number field with −/＋ nudge buttons (e.g. a mask/blur rect in %). */
function NudgeField({
  label,
  value,
  step,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const set = (v: number) => onChange(Math.round(clampN(v, min, max)));
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <button
        type="button"
        onClick={() => set(value - step)}
        disabled={disabled || value <= min}
        aria-label={`Decrease ${label}`}
        className="grid h-6 w-6 place-items-center rounded-md border border-line bg-panel text-muted transition hover:text-text disabled:opacity-30"
      >
        −
      </button>
      <span className="w-9 text-center tabular-nums text-xs text-muted">{Math.round(value)}%</span>
      <button
        type="button"
        onClick={() => set(value + step)}
        disabled={disabled || value >= max}
        aria-label={`Increase ${label}`}
        className="grid h-6 w-6 place-items-center rounded-md border border-line bg-panel text-muted transition hover:text-text disabled:opacity-30"
      >
        +
      </button>
    </span>
  );
}

// ---- Color room ------------------------------------------------------------

const gradeKey = (g: ColorGrade): string => `${g.brightness}|${g.contrast}|${g.saturation}|${g.warmth}`;

function GradeSlider({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex w-[120px] shrink-0 flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
        <span>{label}</span>
        <span className="tabular-nums text-muted">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={`${label}, ${value.toFixed(2)}`}
        style={{ accentColor: "var(--color-teal)" }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

// Curve presets, expressed as master control points [x, y] in 0..1.
const CURVE_PRESETS: { key: string; label: string; points: CurvePoint[] | null }[] = [
  { key: "linear", label: "Linear", points: null },
  { key: "scurve", label: "S-curve", points: [[0, 0], [0.25, 0.16], [0.75, 0.84], [1, 1]] },
  { key: "soft", label: "Soft", points: [[0, 0.06], [0.5, 0.5], [1, 0.94]] },
  { key: "lift", label: "Lift blacks", points: [[0, 0.12], [0.5, 0.56], [1, 1]] },
  { key: "crush", label: "Crush", points: [[0, 0], [0.2, 0.04], [0.6, 0.58], [1, 1]] },
];

const curveSig = (pts?: CurvePoint[] | null): string =>
  pts && pts.length ? pts.map(([x, y]) => `${round2(x)},${round2(y)}`).join(" ") : "";

/** Linear-interpolate a curve's y at a given x (endpoints clamp). */
function sampleCurve(points: CurvePoint[], x: number): number {
  if (!points.length) return x;
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (x <= pts[0]![0]) return pts[0]![1];
  if (x >= pts[pts.length - 1]![0]) return pts[pts.length - 1]![1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    if (x >= x0 && x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return x;
}

// The draggable master curve uses fixed x nodes; only y is dragged. Node ys are
// sampled from the doc's current master curve, so the editor reflects presets too.
const CURVE_NODES = [0, 0.25, 0.5, 0.75, 1];

/**
 * A small draggable master-curve editor (bonus). Reads the current master curve
 * off the doc (sampled at the fixed nodes) and, on drag, emits new [x,y] points
 * through `adjustCurves` — so it's pure, undoable, and in sync with the doc.
 */
function CurveEditor({
  master,
  disabled,
  onChange,
}: {
  master: CurvePoint[] | undefined;
  disabled?: boolean;
  onChange: (points: CurvePoint[]) => void;
}) {
  const SIZE = 120;
  const PAD = 8;
  const inner = SIZE - PAD * 2;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const sig = curveSig(master);
  const derived = CURVE_NODES.map((x) => clamp01(sampleCurve(master ?? [], x)));
  const [ys, setYs] = useState<number[]>(derived);

  // Re-sync from the doc whenever it changes and we're not mid-drag.
  useEffect(() => {
    if (drag === null) setYs(CURVE_NODES.map((x) => clamp01(sampleCurve(master ?? [], x))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, drag]);

  const toX = (x: number) => PAD + x * inner;
  const toY = (y: number) => PAD + (1 - y) * inner;

  const emit = (next: number[]) =>
    onChange(CURVE_NODES.map((x, i) => [round2(x), round2(clamp01(next[i]!))] as CurvePoint));

  useEffect(() => {
    if (drag === null) return;
    const move = (e: PointerEvent) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const yFrac = clamp01(1 - (e.clientY - rect.top - PAD) / inner);
      setYs((prev) => {
        const next = [...prev];
        next[drag] = yFrac;
        emit(next);
        return next;
      });
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  const path = CURVE_NODES.map((x, i) => `${i === 0 ? "M" : "L"}${toX(x).toFixed(1)},${toY(ys[i]!).toFixed(1)}`).join(" ");

  return (
    <svg
      ref={svgRef}
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="group"
      aria-label="Master tone curve — drag the points"
      className={["shrink-0 touch-none rounded-lg border border-line bg-panel", disabled ? "pointer-events-none opacity-40" : ""].join(" ")}
    >
      {/* diagonal reference + grid */}
      <line x1={toX(0)} y1={toY(0)} x2={toX(1)} y2={toY(1)} stroke="var(--color-line)" strokeWidth="1" strokeDasharray="3 3" />
      <path d={path} fill="none" stroke="var(--color-teal)" strokeWidth="2" />
      {CURVE_NODES.map((x, i) => (
        <circle
          key={x}
          cx={toX(x)}
          cy={toY(ys[i]!)}
          r={5}
          fill="var(--color-amber)"
          className="cursor-ns-resize"
          onPointerDown={(e) => {
            if (disabled) return;
            e.preventDefault();
            (e.currentTarget as SVGElement).setPointerCapture?.(e.pointerId);
            setDrag(i);
          }}
        />
      ))}
    </svg>
  );
}

/**
 * Client-only SCOPES (bonus): a luma+RGB histogram and an RGB parade computed from
 * the current preview frame. We draw the first visual media into an offscreen
 * canvas WITH the active grade's `cssFilter` applied — so the scopes reflect the
 * grade — then read back pixels. Blob object-URLs are same-origin, so the canvas
 * isn't tainted and `getImageData` works. No schema, no server, no library.
 */
function Scopes({
  url,
  kind,
  timeSec,
  grade,
}: {
  url: string | undefined;
  kind: "video" | "image";
  timeSec: number;
  grade: ColorGrade;
}) {
  const histRef = useRef<HTMLCanvasElement>(null);
  const paradeRef = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState(false);
  const filter = cssFilter(grade);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const off = document.createElement("canvas");
    const SW = 220;

    const paint = (media: CanvasImageSource, mw: number, mh: number) => {
      if (cancelled) return;
      try {
        const ar = mw > 0 && mh > 0 ? mh / mw : 9 / 16;
        const sw = SW;
        const sh = Math.max(1, Math.round(SW * ar));
        off.width = sw;
        off.height = sh;
        const ctx = off.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.filter = filter; // scopes reflect the applied grade
        ctx.drawImage(media, 0, 0, sw, sh);
        const { data } = ctx.getImageData(0, 0, sw, sh);

        // Histogram (256 bins per channel + luma).
        const rH = new Float32Array(256), gH = new Float32Array(256), bH = new Float32Array(256), lH = new Float32Array(256);
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
          rH[r]!++; gH[g]!++; bH[b]!++;
          lH[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]!++;
        }
        drawHistogram(histRef.current, [lH, rH, gH, bH]);
        drawParade(paradeRef.current, data, sw, sh);
        setErr(false);
      } catch {
        setErr(true);
      }
    };

    if (kind === "image") {
      const img = new Image();
      img.onload = () => paint(img, img.naturalWidth, img.naturalHeight);
      img.onerror = () => !cancelled && setErr(true);
      img.src = url;
    } else {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.onloadeddata = () => {
        try {
          v.currentTime = Math.max(0, Math.min(timeSec, v.duration || 0));
        } catch {
          paint(v, v.videoWidth, v.videoHeight);
        }
      };
      v.onseeked = () => paint(v, v.videoWidth, v.videoHeight);
      v.onerror = () => !cancelled && setErr(true);
      v.src = url;
    }
    return () => {
      cancelled = true;
    };
  }, [url, kind, timeSec, filter]);

  return (
    <div className="flex flex-wrap items-start gap-3">
      <figure className="flex flex-col gap-1">
        <canvas ref={histRef} width={220} height={80} className="rounded-lg border border-line bg-panel" />
        <figcaption className="text-[10px] uppercase tracking-wider text-faint">Histogram · luma + RGB</figcaption>
      </figure>
      <figure className="flex flex-col gap-1">
        <canvas ref={paradeRef} width={220} height={80} className="rounded-lg border border-line bg-panel" />
        <figcaption className="text-[10px] uppercase tracking-wider text-faint">RGB parade</figcaption>
      </figure>
      {err && <span className="self-center text-[11px] text-danger">Couldn&apos;t read the frame for scopes.</span>}
    </div>
  );
}

/** Paint luma+RGB histograms onto a canvas (luma grey under coloured channels). */
function drawHistogram(cv: HTMLCanvasElement | null, channels: Float32Array[]) {
  if (!cv) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  let max = 1;
  for (const ch of channels) for (const v of ch) if (v > max) max = v;
  const styles = ["rgba(150,160,175,0.55)", "rgba(255,90,90,0.75)", "rgba(90,220,120,0.75)", "rgba(90,150,255,0.75)"];
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c]!;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x < 256; x++) {
      const px = (x / 255) * W;
      const py = H - (Math.log1p(ch[x]!) / Math.log1p(max)) * H;
      ctx.lineTo(px, py);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = styles[c]!;
    ctx.fill();
  }
}

/** Paint an RGB parade (three side-by-side scatter panels: R, G, B by column). */
function drawParade(cv: HTMLCanvasElement | null, data: Uint8ClampedArray, sw: number, sh: number) {
  if (!cv) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const panel = W / 3;
  const img = ctx.createImageData(W, H);
  const buf = img.data;
  const plot = (panelIdx: number, colX: number, val: number, rgb: [number, number, number]) => {
    const x = Math.round(panelIdx * panel + (colX / (sw - 1 || 1)) * (panel - 1));
    const y = Math.round((1 - val / 255) * (H - 1));
    const o = (y * W + x) * 4;
    // additive accumulation for a soft scatter
    buf[o] = Math.min(255, buf[o]! + rgb[0]);
    buf[o + 1] = Math.min(255, buf[o + 1]! + rgb[1]);
    buf[o + 2] = Math.min(255, buf[o + 2]! + rgb[2]);
    buf[o + 3] = 255;
  };
  const stepY = Math.max(1, Math.floor(sh / 90));
  const stepX = Math.max(1, Math.floor(sw / 160));
  for (let y = 0; y < sh; y += stepY) {
    for (let x = 0; x < sw; x += stepX) {
      const i = (y * sw + x) * 4;
      plot(0, x, data[i]!, [40, 8, 8]);
      plot(1, x, data[i + 1]!, [8, 40, 8]);
      plot(2, x, data[i + 2]!, [8, 12, 40]);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---- Design room (unified Looks · Color · Backgrounds · Text · Overlays) ----

type DesignCategory = "looks" | "grade" | "backgrounds" | "text" | "overlays" | "advanced";

const DESIGN_CATEGORIES: { key: DesignCategory; label: string; hint: string }[] = [
  { key: "looks", label: "Looks", hint: "One-tap filters" },
  { key: "grade", label: "Color grade", hint: "Fine-tune sliders" },
  { key: "backgrounds", label: "Backgrounds", hint: "Fill behind the frame" },
  { key: "text", label: "Text styles", hint: "Titles & captions" },
  { key: "overlays", label: "Overlays / FX", hint: "B-roll, titles, grain" },
  { key: "advanced", label: "Advanced", hint: "Chroma, blend, mask" },
];

const DESIGN_CAT_KEY = "cadence:designCat";

/**
 * The unified DESIGN room — one browsable surface that replaces the old separate
 * Color and VFX rooms. A left category list switches the right pane between a
 * thumbnail LOOKS gallery, the full color-grade controls, a background palette,
 * a text-style gallery, the overlay/FX presets, and the advanced compositing
 * controls. Every capability from the old rooms is preserved, just reorganized.
 */
function DesignRoom({
  doc,
  mediaList,
  urls,
  busy,
  timeSec,
  onAction,
  onApplyDoc,
  onBeginPlacement,
  status,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  urls: Record<string, string>;
  busy: boolean;
  timeSec: number;
  onAction: (prompt: string) => void;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onBeginPlacement?: BeginPlacement;
  status: ReturnType<typeof describeDoc>;
}) {
  void status;
  const [cat, setCat] = useState<DesignCategory>("looks");

  // Restore the last-open category (client-only).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DESIGN_CAT_KEY) as DesignCategory | null;
      if (saved && DESIGN_CATEGORIES.some((c) => c.key === saved)) setCat(saved);
    } catch {
      /* storage may be unavailable */
    }
  }, []);
  const choose = (next: DesignCategory) => {
    setCat(next);
    try {
      localStorage.setItem(DESIGN_CAT_KEY, next);
    } catch {
      /* ignore */
    }
  };

  // The frame the look/grade thumbnails and scopes sample: the first loaded visual.
  const frameMedia = mediaList.find((m) => (m.kind === "video" || m.kind === "image") && urls[m.id]);
  const frameUrl = frameMedia ? urls[frameMedia.id] : undefined;
  const frameKind = (frameMedia?.kind as "video" | "image") ?? "image";

  return (
    <div
      aria-label="Design"
      className="flex max-h-full gap-0 overflow-hidden border-b border-line-soft bg-panel/30"
    >
      {/* Category list (the "one place" navigation). */}
      <nav
        aria-label="Design categories"
        className="flex w-[132px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line-soft bg-panel/40 p-2"
      >
        {DESIGN_CATEGORIES.map((c) => {
          const active = c.key === cat;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => choose(c.key)}
              aria-current={active ? "true" : undefined}
              title={c.hint}
              className={[
                "flex flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition",
                active ? "bg-amber/10 text-amber" : "text-muted hover:bg-elevated hover:text-text",
              ].join(" ")}
            >
              <span className="text-xs font-medium">{c.label}</span>
              <span className="text-[10px] leading-tight text-faint">{c.hint}</span>
            </button>
          );
        })}
      </nav>

      {/* Active category content. */}
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
        {cat === "looks" && (
          <LooksGallery
            doc={doc}
            mediaList={mediaList}
            busy={busy}
            frameUrl={frameUrl}
            frameKind={frameKind}
            timeSec={timeSec}
            onApplyDoc={onApplyDoc}
          />
        )}
        {cat === "grade" && (
          <div className="flex flex-col gap-4">
            <GradeControls
              doc={doc}
              mediaList={mediaList}
              urls={urls}
              busy={busy}
              timeSec={timeSec}
              onApplyDoc={onApplyDoc}
            />
            <div className="h-px w-full bg-line-soft" aria-hidden />
            <LutControls doc={doc} mediaList={mediaList} busy={busy} onApplyDoc={onApplyDoc} />
            <div className="h-px w-full bg-line-soft" aria-hidden />
            <AdjustmentControls
              doc={doc}
              mediaList={mediaList}
              busy={busy}
              timeSec={timeSec}
              onApplyDoc={onApplyDoc}
            />
          </div>
        )}
        {cat === "backgrounds" && <BackgroundsGallery doc={doc} busy={busy} onApplyDoc={onApplyDoc} />}
        {cat === "text" && (
          <TextStylesGallery
            doc={doc}
            mediaList={mediaList}
            busy={busy}
            timeSec={timeSec}
            onApplyDoc={onApplyDoc}
            onBeginPlacement={onBeginPlacement}
          />
        )}
        {cat === "overlays" && <OverlaysSection mediaList={mediaList} busy={busy} onAction={onAction} />}
        {cat === "advanced" && (
          <AdvancedFx doc={doc} mediaList={mediaList} busy={busy} onApplyDoc={onApplyDoc} />
        )}
      </div>
    </div>
  );
}

/** A small 16:9 preview of the user's frame with a look's CSS filter applied. */
function LookThumb({
  url,
  kind,
  filter,
}: {
  url?: string;
  kind: "video" | "image";
  filter: string;
}) {
  if (url && kind === "video") {
    return (
      <video
        src={url}
        muted
        playsInline
        preload="metadata"
        aria-hidden
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          try {
            v.currentTime = Math.min(1, (v.duration || 2) / 2);
          } catch {
            /* first frame is fine */
          }
        }}
        style={{ filter }}
        className="h-full w-full object-cover"
      />
    );
  }
  if (url) {
    return <img src={url} alt="" style={{ filter }} className="h-full w-full object-cover" />;
  }
  // No footage yet — preview the filter over a representative gradient so the
  // card still communicates the look.
  return (
    <div
      style={{ filter, background: "linear-gradient(135deg,#3a4a63 0%,#c98a4a 55%,#e8d9b0 100%)" }}
      className="h-full w-full"
    />
  );
}

/**
 * The LOOKS gallery — a CapCut-style grid of named filters, grouped by family,
 * each rendering the user's OWN current frame with that look's grade applied via
 * the pure `cssFilter`. Clicking a card applies the look INSTANTLY through the
 * undoable commit path (no Director round-trip) — the latency fix (A8).
 */
function LooksGallery({
  doc,
  mediaList,
  busy,
  frameUrl,
  frameKind,
  timeSec,
  onApplyDoc,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  frameUrl?: string;
  frameKind: "video" | "image";
  timeSec: number;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
}) {
  void timeSec;
  const hasVisual = mediaList.some((m) => m.kind === "video" || m.kind === "image");
  const disabled = busy || !hasVisual;
  const grade = currentGrade(doc);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const apply = (look: LookPreset) => {
    if (disabled) return;
    onApplyDoc(applyLookPreset(doc, look));
  };
  const neutral = isNeutralGrade(grade);

  const families = LOOK_FAMILIES.map((f) => ({
    ...f,
    looks: q ? f.looks.filter((l) => l.label.toLowerCase().includes(q)) : f.looks,
  })).filter((f) => f.looks.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-faint">
          Tap a filter to apply it to your footage — instant &amp; undoable. Each tile previews the look on your frame.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search looks…"
            aria-label="Search looks"
            className="w-[130px] rounded-full border border-line bg-elevated px-3 py-1 text-xs text-text placeholder:text-faint"
          />
          <button
            type="button"
            onClick={() => !disabled && onApplyDoc(clearLook(doc))}
            disabled={disabled || neutral}
            className="shrink-0 rounded-full border border-line bg-elevated px-3 py-1 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-40"
          >
            Original
          </button>
        </div>
      </div>

      {!hasVisual && (
        <p className="rounded-lg border border-line bg-elevated/40 px-3 py-2 text-xs text-faint">
          Add a video or photo first — then every filter previews on your own frame.
        </p>
      )}

      {families.map((fam) => (
        <section key={fam.key} className="flex flex-col gap-1.5">
          <h3 className="text-[10px] uppercase tracking-wider text-faint">{fam.label}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
            {fam.looks.map((look) => {
              const active = looksActive(look, grade);
              return (
                <button
                  key={look.key}
                  type="button"
                  onClick={() => apply(look)}
                  disabled={disabled}
                  aria-label={look.label}
                  aria-pressed={active}
                  className={[
                    "group flex flex-col overflow-hidden rounded-lg border text-left transition disabled:opacity-50",
                    active ? "border-teal/60 ring-1 ring-teal/40" : "border-line hover:border-amber/50",
                  ].join(" ")}
                >
                  <span className="relative block aspect-video w-full overflow-hidden bg-panel">
                    <LookThumb url={frameUrl} kind={frameKind} filter={cssFilter(look.grade)} />
                    {active && (
                      <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-teal text-[10px] font-bold text-onaccent">
                        ✓
                      </span>
                    )}
                  </span>
                  <span className="truncate px-1.5 py-1 text-[11px] text-muted group-hover:text-text">
                    {look.label}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {families.length === 0 && <p className="text-xs text-faint">No looks match “{query}”.</p>}
    </div>
  );
}

/**
 * The full color-grade controls — brightness/contrast/saturation/warmth/hue
 * sliders, tone-curve presets + draggable master curve, and the client-only
 * scopes. Moved verbatim from the old Color room; every control still applies
 * instantly + undoably through the pure grade fns.
 */
function GradeControls({
  doc,
  mediaList,
  urls,
  busy,
  timeSec,
  onApplyDoc,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  urls: Record<string, string>;
  busy: boolean;
  timeSec: number;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
}) {
  const hasVisual = mediaList.some((m) => m.kind === "video" || m.kind === "image");
  const grade = currentGrade(doc);
  const disabled = busy || !hasVisual;
  const [showScopes, setShowScopes] = useState(false);

  const set = (partial: Partial<ColorGrade>) => {
    if (!hasVisual) return;
    onApplyDoc(adjustColor(doc, partial), "color");
  };
  const setHue = (hueShift: number) => {
    if (!hasVisual) return;
    onApplyDoc(adjustHsl(doc, { hueShift }), "hue");
  };
  const applyCurve = (points: CurvePoint[] | null, coalesce?: string) => {
    if (!hasVisual) return;
    onApplyDoc(adjustCurves(doc, points ? { master: points } : {}), coalesce);
  };
  const isNeutral = gradeKey(grade) === gradeKey(NEUTRAL_GRADE);
  const hue = grade.hueShift ?? 0;
  const master = grade.curves?.master;
  const masterSig = curveSig(master);
  const scopeMedia = mediaList.find((m) => (m.kind === "video" || m.kind === "image") && urls[m.id]);

  return (
    <div className="flex flex-col gap-3">
      {!hasVisual && (
        <p className="rounded-lg border border-line bg-elevated/40 px-3 py-2 text-xs text-faint">
          Add a video or photo to grade it.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <GradeSlider label="Brightness" value={grade.brightness} min={0.5} max={1.5} disabled={disabled} onChange={(v) => set({ brightness: v })} />
        <GradeSlider label="Contrast" value={grade.contrast} min={0.5} max={1.5} disabled={disabled} onChange={(v) => set({ contrast: v })} />
        <GradeSlider label="Saturation" value={grade.saturation} min={0} max={2} disabled={disabled} onChange={(v) => set({ saturation: v })} />
        <GradeSlider label="Warmth" value={grade.warmth} min={0} max={1} disabled={disabled} onChange={(v) => set({ warmth: v })} />
        <FxSlider
          label="Hue"
          value={hue}
          min={0}
          max={360}
          step={1}
          disabled={disabled}
          onChange={(v) => setHue(v)}
          format={(v) => `${Math.round(v)}°`}
        />
        <button
          type="button"
          onClick={() => {
            set({ ...NEUTRAL_GRADE });
            applyCurve(null);
          }}
          disabled={disabled || (isNeutral && hue === 0 && !master)}
          className="shrink-0 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-40"
        >
          Reset
        </button>
      </div>

      <Row label="curve">
        {CURVE_PRESETS.map((p) => (
          <Pill
            key={p.key}
            onClick={() => applyCurve(p.points)}
            disabled={disabled}
            active={curveSig(p.points) === masterSig}
          >
            {p.label}
          </Pill>
        ))}
        <CurveEditor master={master} disabled={disabled} onChange={(pts) => applyCurve(pts, "curve")} />
        <span className="max-w-[220px] text-[11px] text-faint">
          Curves render exactly on export (ffmpeg); the live preview approximates the rest of the grade.
        </span>
      </Row>

      <Row label="scopes">
        <Pill onClick={() => setShowScopes((s) => !s)} disabled={!scopeMedia} active={showScopes}>
          {showScopes ? "Hide scopes" : "Show scopes"}
        </Pill>
        {showScopes && scopeMedia && (
          <Scopes url={urls[scopeMedia.id]} kind={scopeMedia.kind as "video" | "image"} timeSec={timeSec} grade={grade} />
        )}
        {showScopes && !scopeMedia && <span className="text-[11px] text-faint">Load a video or photo to see levels.</span>}
      </Row>
    </div>
  );
}

/** The basename of a stored upload path (uuid.cube), for a fallback LUT label. */
function pathBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * LUT import (.cube). Picks a `.cube` file, uploads it via the existing
 * `/api/upload` flow so the server has a real path at EXPORT time, then sets it as
 * the creative look on every main visual clip through the pure `applyLut` (routed
 * to the undoable commit). The LUT is applied on export only (ffmpeg `lut3d`); the
 * canvas preview approximates the rest of the grade but not the LUT — stated
 * honestly, mirroring how curves are handled.
 */
function LutControls({
  doc,
  mediaList,
  busy,
  onApplyDoc,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
}) {
  const hasVisual = mediaList.some((m) => m.kind === "video" || m.kind === "image");
  const disabled = busy || !hasVisual;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remember the ORIGINAL filename for each uploaded path (the stored path is a
  // uuid, so this gives a friendly label; falls back to the basename otherwise).
  const namesRef = useRef<Record<string, string>>({});

  const activeLut = currentGrade(doc).lut;
  const activeLabel = activeLut ? namesRef.current[activeLut] ?? pathBasename(activeLut) : null;

  const pick = () => fileRef.current?.click();

  const onFile = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const { path } = await uploadMedia(file);
      namesRef.current[path] = file.name;
      onApplyDoc(applyLut(doc, { lut: path }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't import that LUT.");
    } finally {
      setUploading(false);
    }
  };

  const remove = () => {
    if (disabled) return;
    onApplyDoc(applyLut(doc, { lut: "" }));
  };

  return (
    <section className="flex flex-col gap-2" aria-label="LUT import">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] uppercase tracking-wider text-faint">LUT (.cube)</h3>
      </div>
      <p className="text-[11px] text-faint">
        Import a 3D LUT to grade your footage. LUTs are applied on <strong className="text-muted">export</strong>{" "}
        (ffmpeg) — the live preview approximates with the grade sliders above.
      </p>
      {!hasVisual && (
        <p className="rounded-lg border border-line bg-elevated/40 px-3 py-2 text-xs text-faint">
          Add a video or photo first — a LUT needs a visual clip.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".cube"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={pick}
          disabled={disabled || uploading}
          className="shrink-0 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-40"
        >
          {uploading ? "Importing…" : activeLut ? "Replace LUT (.cube)" : "Import LUT (.cube)"}
        </button>
        {activeLut && (
          <>
            <span
              className="inline-flex max-w-[220px] items-center gap-1.5 truncate rounded-full border border-teal/40 bg-teal/10 px-3 py-1 text-xs text-teal"
              title={activeLut}
            >
              <span aria-hidden>●</span>
              <span className="truncate">{activeLabel}</span>
            </span>
            <button
              type="button"
              onClick={remove}
              disabled={disabled}
              className="shrink-0 rounded-full border border-line bg-elevated px-3 py-1 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-40"
            >
              Remove LUT
            </button>
          </>
        )}
      </div>
      {error && <p className="text-[11px] text-amber-bright">{error}</p>}
    </section>
  );
}

/**
 * Adjustment layers. Adds an `adjustment` clip on the topmost "adjustments" track
 * that grades EVERYTHING beneath it for its span — one grade across many clips.
 * The layer is seeded from a chosen look preset and placed at the playhead with a
 * sensible default length (min 4s / the remaining timeline). It shows up as its own
 * lane on the timeline, where its edges can be dragged to set the range. Pure +
 * undoable via `addAdjustment`.
 */
function AdjustmentControls({
  doc,
  mediaList,
  busy,
  timeSec,
  onApplyDoc,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  timeSec: number;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
}) {
  const hasVisual = mediaList.some((m) => m.kind === "video" || m.kind === "image");
  const disabled = busy || !hasVisual;
  const [look, setLook] = useState<LookKey>("cinematic");

  const count = doc.tracks.find((t) => t.id === "adjustments")?.clips.length ?? 0;

  const add = () => {
    if (disabled) return;
    const remaining = docDurationSec(doc) - timeSec;
    const durationSec = remaining > 0.2 ? Math.min(4, remaining) : 4;
    onApplyDoc(addAdjustment(doc, { atSec: Math.max(0, timeSec), durationSec, look }));
  };

  return (
    <section className="flex flex-col gap-2" aria-label="Adjustment layers">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] uppercase tracking-wider text-faint">Adjustment layers</h3>
        {count > 0 && (
          <span className="text-[10px] text-faint">
            {count} layer{count === 1 ? "" : "s"} on the timeline
          </span>
        )}
      </div>
      <p className="text-[11px] text-faint">
        Grades everything below it for its span — drag its edges on the timeline to set the range.
      </p>
      {!hasVisual && (
        <p className="rounded-lg border border-line bg-elevated/40 px-3 py-2 text-xs text-faint">
          Add a video or photo first — an adjustment layer grades the clips beneath it.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          className="shrink-0 rounded-full bg-amber px-3 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Adjustment layer
        </button>
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-faint">Look</span>
          <select
            value={look}
            disabled={disabled}
            onChange={(e) => setLook(e.target.value as LookKey)}
            aria-label="Adjustment layer look preset"
            className="rounded-lg border border-line bg-elevated px-2 py-1 text-xs text-text disabled:opacity-40"
          >
            {LOOK_KEYS.map((k) => (
              <option key={k} value={k}>
                {LOOK_PRESETS[k].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[10px] text-faint">
        Seeds from a look preset. Fine-tuning a selected layer&apos;s own grade with these sliders is a later wave;
        for now delete it on the timeline and re-add to change the look.
      </p>
    </section>
  );
}

/**
 * The background palette — a curated swatch grid. Picking a swatch sets
 * `meta.background`, the colour shown behind fit-to-frame content and in any
 * letterbox bars (e.g. after a 2.39:1 reframe). Solid only (no schema change);
 * gradients are noted as out of scope.
 */
function BackgroundsGallery({
  doc,
  busy,
  onApplyDoc,
}: {
  doc: EditDoc;
  busy: boolean;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-faint">
        Sets the colour behind your frame — it shows in letterbox bars and behind photos that don&apos;t fill the aspect.
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
        {BG_SWATCHES.map((sw) => {
          const active = backgroundActive(sw, doc);
          return (
            <button
              key={sw.key}
              type="button"
              onClick={() => !busy && onApplyDoc(setBackground(doc, sw.color))}
              disabled={busy}
              aria-label={`Background ${sw.label}`}
              aria-pressed={active}
              className={[
                "group flex flex-col overflow-hidden rounded-lg border text-left transition disabled:opacity-50",
                active ? "border-teal/60 ring-1 ring-teal/40" : "border-line hover:border-amber/50",
              ].join(" ")}
            >
              <span className="relative block aspect-video w-full" style={{ backgroundColor: sw.color }}>
                {active && (
                  <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-teal text-[10px] font-bold text-onaccent">
                    ✓
                  </span>
                )}
              </span>
              <span className="truncate px-1.5 py-1 text-[11px] text-muted group-hover:text-text">{sw.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Deliver room ----------------------------------------------------------

/**
 * Social-platform delivery presets. Each maps to the aspect the platform expects
 * and fires the SAME natural-language reframe the Director already understands
 * (via `onAction`/`handleSend`) — no new tool, no schema change. Several presets
 * share an aspect (Shorts / TikTok / Reels are all 9:16), so more than one can
 * read as active when the current aspect matches.
 */
const PLATFORM_PRESETS: { key: string; label: string; aspect: string; prompt: string }[] = [
  { key: "youtube", label: "YouTube", aspect: "16:9", prompt: "make it 16:9 widescreen for YouTube" },
  { key: "shorts", label: "YT Shorts", aspect: "9:16", prompt: "make it vertical 9:16 for YouTube Shorts" },
  { key: "tiktok", label: "TikTok", aspect: "9:16", prompt: "make it vertical 9:16 for TikTok" },
  { key: "reels", label: "Reels", aspect: "9:16", prompt: "make it vertical 9:16 for Instagram Reels" },
  { key: "ig-feed", label: "IG Feed", aspect: "1:1", prompt: "make it square 1:1 for Instagram feed" },
  { key: "ig-portrait", label: "IG Portrait", aspect: "4:5", prompt: "make it 4:5 portrait for Instagram" },
];

function DeliverRoom({
  doc,
  mediaList,
  busy,
  timeSec,
  onAction,
  onExport,
  canExport,
  status,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  timeSec: number;
  onAction: (prompt: string) => void;
  onExport: () => void;
  canExport: boolean;
  status: ReturnType<typeof describeDoc>;
}) {
  const noMedia = busy || mediaList.length === 0;
  const outW = doc.quality.targetWidth ?? doc.meta.width;
  const outH = doc.quality.targetHeight ?? doc.meta.height;
  const upscaled = outW !== doc.meta.width || outH !== doc.meta.height;
  const fps = doc.quality.fps ?? doc.meta.fps;
  const qualityLabel =
    doc.quality.preset === "ultra" ? "4K" : doc.quality.preset === "high" ? "High" : "Standard";

  const [thumbState, setThumbState] = useState<"idle" | "working" | "error">("idle");
  const captionsReady = hasCaptions(doc);

  const filename = (ext: string) => `${(doc.meta.title || "cadence").replace(/\s+/g, "-")}.${ext}`;

  async function downloadThumbnail() {
    if (!canExport) return;
    setThumbState("working");
    try {
      // POST the live doc + current playhead time to the canvas render route and
      // save the PNG it returns as a poster/thumbnail (free, no ffmpeg).
      const blob = await renderFrameBlob(doc, timeSec);
      downloadBlob(filename("png"), blob);
      setThumbState("idle");
    } catch {
      setThumbState("error");
    }
  }

  function downloadCaptions() {
    if (!captionsReady) return;
    // Reuse the pure lib/srt helper — do NOT recreate SRT generation here.
    download(filename("srt"), captionsToSrt(doc), "application/x-subrip");
  }

  return (
    <div
      aria-label="Deliver"
      className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-panel/30 px-4 py-2"
    >
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">deliver</span>

      {/* Platform presets — each reframes via the existing reframe tool. */}
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-faint">Platform</span>
      {PLATFORM_PRESETS.map((p) => (
        <Pill
          key={p.key}
          onClick={() => onAction(p.prompt)}
          disabled={noMedia}
          active={status.aspect === p.aspect}
        >
          {p.label}
          <span className="text-faint">{p.aspect}</span>
        </Pill>
      ))}

      <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />

      {/* Quality / format summary from doc.quality + meta. */}
      <span
        className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-elevated px-3 py-1 text-[11px] text-muted"
        title={upscaled ? `Upscales ${doc.meta.width}×${doc.meta.height} → ${outW}×${outH} on export` : "Output specification"}
      >
        <span className="tabular-nums text-text">{outW}×{outH}</span>
        <span className="text-faint">·</span>
        <span className="tabular-nums">{fps}fps</span>
        <span className="text-faint">·</span>
        <span>MP4</span>
        <span className="text-faint">·</span>
        <span className={doc.quality.preset === "standard" ? "" : "text-amber-bright"}>{qualityLabel}</span>
      </span>

      <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />

      {/* Export (hero) + free sidecar downloads. */}
      <button
        type="button"
        onClick={onExport}
        disabled={!canExport || busy}
        className="shrink-0 rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Exporting…" : "Export .mp4"}
      </button>
      <button
        type="button"
        onClick={downloadThumbnail}
        disabled={!canExport || busy || thumbState === "working"}
        title="Save the current frame as a PNG poster"
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
        {thumbState === "working" ? "Rendering…" : "Thumbnail"}
      </button>
      <button
        type="button"
        onClick={downloadCaptions}
        disabled={!captionsReady}
        title={captionsReady ? "Download the captions as an .srt sidecar" : "Add captions first to download an .srt"}
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 15h4M15 15h2M7 11h2M13 11h4" /></svg>
        Captions .srt
      </button>

      {/* Honest one-liner: the real render needs ffmpeg. */}
      <span className="shrink-0 basis-full text-[11px] text-faint">
        {thumbState === "error" ? (
          <span className="text-danger">Couldn&apos;t render a thumbnail — try again once media is loaded. </span>
        ) : null}
        A real .mp4 renders via ffmpeg (<code>docker compose up</code>); without it you get the edit-doc JSON. Thumbnail &amp; .srt download instantly, no ffmpeg.
      </span>
    </div>
  );
}

// ---- VFX room --------------------------------------------------------------

const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "screen", label: "Screen" },
  { value: "multiply", label: "Multiply" },
  { value: "overlay", label: "Overlay" },
  { value: "add", label: "Add" },
  { value: "soft-light", label: "Soft light" },
];

const KEY_COLORS: { value: string; label: string }[] = [
  { value: "#00d000", label: "Green" },
  { value: "#0047ff", label: "Blue" },
];

/**
 * Overlays / FX — the one-click, NL-driven overlay presets (b-roll PiP, punch-in,
 * kinetic title, fades, vignette, grain, light leak). These are structural edits
 * the Director composes, so they route through `onAction`; the click still feels
 * responsive because the Director applies them and commits.
 */
function OverlaysSection({
  mediaList,
  busy,
  onAction,
}: {
  mediaList: MediaAsset[];
  busy: boolean;
  onAction: (prompt: string) => void;
}) {
  const noMedia = busy || mediaList.length === 0;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-faint">One-tap overlays &amp; effects. Titles &amp; b-roll are placed by the Director; everything else previews live.</p>
      <Row label="effects">
        <Pill onClick={() => onAction("add b-roll as picture-in-picture")} disabled={noMedia}>+ B-roll</Pill>
        <Pill onClick={() => onAction("punch in for emphasis at 2s")} disabled={noMedia}>Punch-in</Pill>
        <Pill onClick={() => onAction('add an animated title that says "Cadence"')} disabled={noMedia}>Kinetic title</Pill>
        <Pill onClick={() => onAction("add a fade in and out")} disabled={noMedia}>Fade in/out</Pill>
        <Pill onClick={() => onAction("add a vignette")} disabled={noMedia}>Vignette</Pill>
        <Pill onClick={() => onAction("add film grain")} disabled={noMedia}>Grain</Pill>
        <Pill onClick={() => onAction("add a light leak")} disabled={noMedia}>Light leak</Pill>
      </Row>
    </div>
  );
}

/**
 * Advanced compositing — the pro controls (chroma key, blend mode, blur/pixelate
 * region, mask) that apply the PURE compositing/region fns from `@cadence/director`
 * through the editor's undoable commit path (instant preview). Chroma / blend /
 * mask composite over the b-roll overlay when present (else the main clip);
 * blur/pixelate hide a region of the MAIN clip — the room states which.
 */
function AdvancedFx({
  doc,
  mediaList,
  busy,
  onApplyDoc,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
}) {
  const hasVisual = mediaList.some((m) => m.kind === "video" || m.kind === "image");
  const disabled = busy || !hasVisual;

  const W = doc.meta.width;
  const H = doc.meta.height;
  const scope = compositeScope(doc);
  const scopeNote =
    scope === "broll"
      ? "composites over your b-roll overlay"
      : scope === "main"
        ? "composites over the main clip (add b-roll to layer it instead)"
        : "add a clip to composite over";

  // Current effect state, read straight from the doc (single source of truth).
  const chroma = currentChroma(doc);
  const blend = currentBlend(doc);
  const mask = currentMask(doc);
  const region = currentRegionFx(doc);

  // % helpers (schema stores px; UI shows composition %).
  const pxToPctX = (px: number) => (px / W) * 100;
  const pxToPctY = (px: number) => (px / H) * 100;
  const pctToPxX = (pct: number) => round2((pct / 100) * W);
  const pctToPxY = (pct: number) => round2((pct / 100) * H);

  // Chroma key -------------------------------------------------------------
  const toggleChroma = () => {
    if (chroma) onApplyDoc(clearChroma(doc));
    else onApplyDoc(chromaKey(doc, { color: "#00d000" }));
  };
  const setChroma = (patch: { color?: string; similarity?: number; spill?: number }, coalesce?: string) => {
    onApplyDoc(
      chromaKey(doc, {
        color: patch.color ?? chroma?.color ?? "#00d000",
        similarity: patch.similarity ?? chroma?.similarity ?? 0.3,
        blend: chroma?.blend ?? 0.1,
        spill: patch.spill ?? chroma?.spill ?? 0,
      }),
      coalesce,
    );
  };

  // Region blur / pixelate -------------------------------------------------
  const DEFAULT_REGION = { x: pctToPxX(30), y: pctToPxY(30), w: pctToPxX(40), h: pctToPxY(40) };
  const addRegion = (type: "blur" | "pixelate") =>
    onApplyDoc(regionBlur(doc, { type, ...DEFAULT_REGION, amount: region?.amount ?? 0.5 }));
  const setRegion = (patch: Partial<{ type: "blur" | "pixelate"; x: number; y: number; w: number; h: number; amount: number }>, coalesce?: string) => {
    if (!region) return;
    onApplyDoc(
      regionBlur(doc, {
        type: patch.type ?? region.type,
        x: patch.x ?? region.x,
        y: patch.y ?? region.y,
        w: patch.w ?? region.w,
        h: patch.h ?? region.h,
        amount: patch.amount ?? region.amount,
      }),
      coalesce,
    );
  };

  // Mask -------------------------------------------------------------------
  const DEFAULT_MASK = { x: pctToPxX(25), y: pctToPxY(25), w: pctToPxX(50), h: pctToPxY(50) };
  const addMaskShape = (shape: "rect" | "ellipse") =>
    onApplyDoc(addMask(doc, { shape, ...DEFAULT_MASK, feather: mask?.feather ?? 0, invert: mask?.invert ?? false }));
  const setMask = (patch: Partial<{ shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number; feather: number; invert: boolean }>, coalesce?: string) => {
    if (!mask) return;
    onApplyDoc(
      addMask(doc, {
        shape: patch.shape ?? mask.shape,
        x: patch.x ?? mask.x,
        y: patch.y ?? mask.y,
        w: patch.w ?? mask.w,
        h: patch.h ?? mask.h,
        feather: patch.feather ?? mask.feather,
        invert: patch.invert ?? mask.invert,
      }),
      coalesce,
    );
  };

  return (
    <div aria-label="Advanced FX" className="flex flex-col gap-2">
      {!hasVisual && (
        <p className="rounded-lg border border-line bg-elevated/40 px-3 py-2 text-xs text-faint">
          Add a video or photo to use chroma key, blend, blur and masks.
        </p>
      )}
      {/* Chroma key (→ chromaKey / clearChroma) */}
      <Row label="chroma key">
        <Pill onClick={toggleChroma} disabled={disabled} active={!!chroma}>
          {chroma ? "Keying on" : "Green screen"}
        </Pill>
        {chroma && (
          <>
            {KEY_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setChroma({ color: c.value })}
                aria-label={`Key out ${c.label}`}
                aria-pressed={chroma.color.toLowerCase() === c.value.toLowerCase()}
                title={`${c.label} screen`}
                className={[
                  "h-7 w-7 shrink-0 rounded-full border-2 transition",
                  chroma.color.toLowerCase() === c.value.toLowerCase() ? "border-teal" : "border-line hover:border-amber/50",
                ].join(" ")}
                style={{ backgroundColor: c.value }}
              />
            ))}
            <FxSlider
              label="Similarity"
              value={chroma.similarity}
              min={0.01}
              max={1}
              step={0.01}
              disabled={disabled}
              onChange={(v) => setChroma({ similarity: v }, "chroma-sim")}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <FxSlider
              label="Spill"
              value={chroma.spill}
              min={0}
              max={1}
              step={0.01}
              disabled={disabled}
              onChange={(v) => setChroma({ spill: v }, "chroma-spill")}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </>
        )}
        <span className="text-[11px] text-faint">{scopeNote}</span>
      </Row>

      {/* Blend mode (→ setBlend) */}
      <Row label="blend">
        <label className="flex shrink-0 items-center gap-1.5">
          <span className="sr-only">Blend mode</span>
          <select
            value={blend}
            disabled={disabled}
            onChange={(e) => onApplyDoc(setBlend(doc, e.target.value as BlendMode))}
            aria-label="Blend mode"
            className="rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-text disabled:opacity-40"
          >
            {BLEND_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-faint">{scope === "broll" ? "blends the b-roll overlay over the base" : "blends the main clip (best over b-roll)"}</span>
      </Row>

      {/* Blur / pixelate region (→ regionBlur) — always the MAIN clip */}
      <Row label="blur / pixelate">
        {!region ? (
          <>
            <Pill onClick={() => addRegion("blur")} disabled={disabled}>Blur region</Pill>
            <Pill onClick={() => addRegion("pixelate")} disabled={disabled}>Pixelate region</Pill>
            <span className="text-[11px] text-faint">hides a face / plate / logo on the main clip</span>
          </>
        ) : (
          <>
            <Pill onClick={() => setRegion({ type: "blur" })} disabled={disabled} active={region.type === "blur"}>Blur</Pill>
            <Pill onClick={() => setRegion({ type: "pixelate" })} disabled={disabled} active={region.type === "pixelate"}>Pixelate</Pill>
            <NudgeField label="X" value={pxToPctX(region.x)} step={2} min={0} max={100} disabled={disabled} onChange={(p) => setRegion({ x: pctToPxX(p) }, "region-x")} />
            <NudgeField label="Y" value={pxToPctY(region.y)} step={2} min={0} max={100} disabled={disabled} onChange={(p) => setRegion({ y: pctToPxY(p) }, "region-y")} />
            <NudgeField label="W" value={pxToPctX(region.w)} step={2} min={1} max={100} disabled={disabled} onChange={(p) => setRegion({ w: pctToPxX(p) }, "region-w")} />
            <NudgeField label="H" value={pxToPctY(region.h)} step={2} min={1} max={100} disabled={disabled} onChange={(p) => setRegion({ h: pctToPxY(p) }, "region-h")} />
            <FxSlider label="Amount" value={region.amount} min={0} max={1} step={0.01} disabled={disabled} onChange={(v) => setRegion({ amount: v }, "region-amt")} format={(v) => `${Math.round(v * 100)}%`} />
            <Pill onClick={() => onApplyDoc(clearRegionFx(doc))} disabled={disabled}>Remove</Pill>
          </>
        )}
      </Row>

      {/* Mask (→ addMask / clearMask) */}
      <Row label="mask">
        {!mask ? (
          <>
            <Pill onClick={() => addMaskShape("rect")} disabled={disabled}>Rect mask</Pill>
            <Pill onClick={() => addMaskShape("ellipse")} disabled={disabled}>Ellipse mask</Pill>
            <span className="text-[11px] text-faint">reveals a shape · {scopeNote}</span>
          </>
        ) : (
          <>
            <Pill onClick={() => setMask({ shape: "rect" })} disabled={disabled} active={mask.shape === "rect"}>Rect</Pill>
            <Pill onClick={() => setMask({ shape: "ellipse" })} disabled={disabled} active={mask.shape === "ellipse"}>Ellipse</Pill>
            <NudgeField label="X" value={pxToPctX(mask.x)} step={2} min={0} max={100} disabled={disabled} onChange={(p) => setMask({ x: pctToPxX(p) }, "mask-x")} />
            <NudgeField label="Y" value={pxToPctY(mask.y)} step={2} min={0} max={100} disabled={disabled} onChange={(p) => setMask({ y: pctToPxY(p) }, "mask-y")} />
            <NudgeField label="W" value={pxToPctX(mask.w)} step={2} min={1} max={100} disabled={disabled} onChange={(p) => setMask({ w: pctToPxX(p) }, "mask-w")} />
            <NudgeField label="H" value={pxToPctY(mask.h)} step={2} min={1} max={100} disabled={disabled} onChange={(p) => setMask({ h: pctToPxY(p) }, "mask-h")} />
            <FxSlider label="Feather" value={mask.feather} min={0} max={Math.round(H * 0.25)} step={1} disabled={disabled} onChange={(v) => setMask({ feather: v }, "mask-feather")} format={(v) => `${Math.round(v)}px`} />
            <Pill onClick={() => setMask({ invert: !mask.invert })} disabled={disabled} active={mask.invert}>Invert</Pill>
            <Pill onClick={() => onApplyDoc(clearMask(doc))} disabled={disabled}>Remove</Pill>
          </>
        )}
      </Row>
    </div>
  );
}

// ---- Text styles + stickers gallery ----------------------------------------

/**
 * The TEXT-styles gallery — a browsable grid of one-click styled TEXT PRESETS
 * (each rendering a live "Aa" preview in its own style) plus the emoji STICKER
 * picker. Every insert reuses the engine's text/title fns (via `@/lib/text-presets`)
 * and applies through the undoable `onApplyDoc` (commit) path. Inserts land
 * centered at the playhead by default; with "Place on preview" armed, the next
 * pick drops where the user clicks on the Stage (reuses `onBeginPlacement`).
 */
function TextStylesGallery({
  doc,
  mediaList,
  busy,
  timeSec,
  onApplyDoc,
  onBeginPlacement,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  timeSec: number;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onBeginPlacement?: BeginPlacement;
}) {
  const disabled = busy || mediaList.length === 0;
  const [draft, setDraft] = useState("");
  const [placeMode, setPlaceMode] = useState(false);
  const startSec = round2(Math.max(0, timeSec));
  const canPlace = !!onBeginPlacement;

  const drop = async (build: (opts: PlaceOpts) => EditDoc, text?: string) => {
    if (disabled) return;
    const base: PlaceOpts = { text, startSec };
    if (placeMode && onBeginPlacement) {
      const res = await onBeginPlacement("point", "Click where it should go on the preview");
      if (!res || res.points.length === 0) return;
      const p = res.points[0]!;
      onApplyDoc(build({ ...base, xFrac: p.xFrac, yFrac: p.yFrac }));
    } else {
      onApplyDoc(build(base));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Your text (optional)"
          disabled={disabled}
          aria-label="Text for the preset overlay"
          className="w-[180px] shrink-0 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-text placeholder:text-faint disabled:opacity-40"
        />
        {canPlace && (
          <Pill onClick={() => setPlaceMode((p) => !p)} active={placeMode} disabled={disabled}>
            {placeMode ? "Placing on preview" : "Place on preview"}
          </Pill>
        )}
        <span className="text-[11px] text-faint">
          {placeMode
            ? "Pick a style, then click the preview to drop it."
            : "Tap a style — it lands at the playhead. Drag it anywhere on the timeline."}
        </span>
      </div>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-[10px] uppercase tracking-wider text-faint">Text styles</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
          {TEXT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => void drop((o) => preset.build(doc, o), draft)}
              disabled={disabled}
              aria-label={preset.label}
              className="group flex flex-col overflow-hidden rounded-lg border border-line text-left transition hover:border-amber/50 disabled:opacity-50"
            >
              <span className="grid h-12 w-full place-items-center overflow-hidden bg-[#141821] px-2">
                <span
                  className="max-w-full truncate text-lg leading-none"
                  style={preset.previewStyle}
                >
                  {(draft.trim() || preset.sample).slice(0, 14)}
                </span>
              </span>
              <span className="truncate px-1.5 py-1 text-[11px] text-muted group-hover:text-text">{preset.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-[10px] uppercase tracking-wider text-faint">Stickers</h3>
        <div className="flex flex-wrap gap-1.5">
          {EMOJI_STICKERS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => void drop((o) => insertSticker(doc, emoji, o))}
              disabled={disabled}
              aria-label={`Add ${emoji} sticker`}
              title="Preview is exact. Emoji fidelity in the exported .mp4 depends on the render machine's fonts."
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line bg-elevated text-lg leading-none transition hover:border-amber/40 disabled:opacity-40"
            >
              {emoji}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---- Audio room ------------------------------------------------------------

/**
 * Audio room — keeps the music/voice volume, duck and preview-mute controls, and
 * adds per-track FADE in/out and PAN (→ audioFade / setPan) plus a doc-level
 * loudness NORMALIZE toggle (→ normalizeLoudness). Every new control applies a
 * pure fn through the undoable commit path and reads its value back off the doc.
 */
function AudioRoom({
  doc,
  mediaList,
  busy,
  muted,
  onAction,
  onApplyDoc,
  onToggleMute,
  onSetTrackVolume,
  onRecordVoiceover,
  openPicker,
  hiddenInput,
  onDetectBeats,
  onSplitAtBeats,
  canDetectBeats,
  markerCount,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  muted: boolean;
  onAction: (prompt: string) => void;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onToggleMute: () => void;
  onSetTrackVolume: (trackId: string, volume: number) => void;
  onRecordVoiceover: (file: File, durationSec: number) => void;
  openPicker: () => void;
  hiddenInput: React.ReactNode;
  onDetectBeats?: () => void | Promise<void>;
  onSplitAtBeats?: () => void;
  canDetectBeats?: boolean;
  markerCount?: number;
}) {
  const hasAudioMedia = mediaList.some((m) => m.kind === "audio");
  const musicClip = doc.tracks.find((t) => t.id === "music")?.clips.find((c): c is AudioClip => c.kind === "audio");
  const voiceClip = doc.tracks.find((t) => t.id === "voiceover")?.clips.find((c): c is AudioClip => c.kind === "audio");
  const loudnorm = doc.loudnorm === true;

  const renderTrack = (trackId: "music" | "voiceover", label: string, clip: AudioClip) => {
    const fade = trackFade(doc, trackId) ?? { fadeInSec: 0, fadeOutSec: 0 };
    const pan = trackPan(doc, trackId) ?? 0;
    const maxFade = Math.max(0.5, Math.min(10, clip.duration / 2));
    const panLabel = pan === 0 ? "Center" : pan < 0 ? `${Math.round(-pan * 100)}% L` : `${Math.round(pan * 100)}% R`;
    return (
      <Row label={label} key={trackId}>
        <VolumeSlider label={label} value={clip.volume} disabled={busy} onChange={(v) => onSetTrackVolume(trackId, v)} />
        <FxSlider
          label="Fade in"
          value={fade.fadeInSec}
          min={0}
          max={maxFade}
          step={0.1}
          disabled={busy}
          onChange={(v) => onApplyDoc(audioFade(doc, { fadeInSec: v, track: trackId }), `fadein-${trackId}`)}
          format={(v) => `${v.toFixed(1)}s`}
        />
        <FxSlider
          label="Fade out"
          value={fade.fadeOutSec}
          min={0}
          max={maxFade}
          step={0.1}
          disabled={busy}
          onChange={(v) => onApplyDoc(audioFade(doc, { fadeOutSec: v, track: trackId }), `fadeout-${trackId}`)}
          format={(v) => `${v.toFixed(1)}s`}
        />
        <FxSlider
          label="Pan L↔R"
          value={pan}
          min={-1}
          max={1}
          step={0.05}
          disabled={busy}
          onChange={(v) => onApplyDoc(setPan(doc, v, { track: trackId }), `pan-${trackId}`)}
          format={() => panLabel}
        />
      </Row>
    );
  };

  return (
    <div aria-label="Audio" className="flex max-h-full flex-col gap-2 overflow-y-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      {/* Sources + mix + preview (kept) */}
      <div className="flex flex-wrap items-center gap-2">
        <Pill onClick={openPicker} disabled={busy}>+ Add music / audio</Pill>
        <VoiceOverRecorder disabled={busy} onRecorded={onRecordVoiceover} />
        <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />
        <Pill onClick={() => onAction("add background music")} disabled={busy || !hasAudioMedia}>Use as music</Pill>
        <Pill onClick={() => onAction("auto-mix the audio")} disabled={busy || mediaList.length === 0}>Duck under speech</Pill>
        <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />
        <Pill onClick={onToggleMute} active={!muted}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            {muted ? (
              <>
                <path d="M11 5 6 9H2v6h4l5 4z" />
                <path d="M23 9l-6 6M17 9l6 6" />
              </>
            ) : (
              <>
                <path d="M11 5 6 9H2v6h4l5 4z" />
                <path d="M15.5 8.5a5 5 0 010 7M19 5a9 9 0 010 14" />
              </>
            )}
          </svg>
          {muted ? "Preview muted" : "Preview sound on"}
        </Pill>
      </div>

      {/* Beat sync (→ detectBeats / splitAtTimes) — beats land as markers, cuts snap. */}
      <Row label="beat sync">
        <Pill onClick={() => void onDetectBeats?.()} disabled={busy || !canDetectBeats}>
          Detect beats
        </Pill>
        <Pill onClick={() => onSplitAtBeats?.()} disabled={busy || (markerCount ?? 0) === 0}>
          Split at beats
        </Pill>
        <span className="text-[11px] text-faint">
          {(markerCount ?? 0) > 0
            ? `${markerCount} marker${markerCount === 1 ? "" : "s"} on the timeline · `
            : ""}
          {canDetectBeats
            ? "Estimated from the audio — cuts snap to markers. Nudge or right-click any that are off."
            : "Add music or a video with audio to detect beats."}
        </span>
      </Row>

      {/* Per-track fades + pan (→ audioFade / setPan) */}
      {musicClip && renderTrack("music", "Music", musicClip)}
      {voiceClip && renderTrack("voiceover", "Voice", voiceClip)}

      {/* Doc-level loudness normalization (→ normalizeLoudness) */}
      <Row label="loudness">
        <Pill onClick={() => onApplyDoc(normalizeLoudness(doc, !loudnorm))} disabled={busy} active={loudnorm}>
          {loudnorm ? "Normalize: on" : "Normalize loudness"}
        </Pill>
        <span className="text-[11px] text-faint">
          {loudnorm ? "Final mix normalized to −14 LUFS on export (EBU R128)." : "Even out the overall level to a −14 LUFS target on export."}
        </span>
      </Row>

      <span className="text-[11px] text-faint">Music, voice-over, fades, pan &amp; the normalized mix render on export.</span>
      {hiddenInput}
    </div>
  );
}

// ---- Track panel -----------------------------------------------------------

/** Friendly names for the doc's known track ids (falls back to the raw id). */
const TRACK_LABELS: Record<string, string> = {
  video: "Video / Photos",
  captions: "Captions",
  titles: "Titles",
  broll: "B-roll",
  fades: "Fades",
  music: "Music",
  voiceover: "Voice-over",
};

const trackLabel = (id: string): string =>
  TRACK_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/**
 * A read-only map of the doc's tracks — each with a friendly label, kind badge,
 * and clip count — so the timeline's layers are legible at a glance. Audio tracks
 * get a mute toggle that routes through the same commit path as the volume
 * sliders (undoable); visual tracks stay read-only.
 */
// ---- Media room: browsable thumbnail grid (B3) ------------------------------

/** A video poster: the <video> seeked to a representative early frame. */
function VideoPoster({ url }: { url: string }) {
  return (
    <video
      src={url}
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        try {
          v.currentTime = Math.min(1, (v.duration || 2) / 2);
        } catch {
          /* seeking not ready — the first frame is fine */
        }
      }}
      className="h-full w-full object-cover"
    />
  );
}

/** The 16:9 poster for a media tile: image → <img>, video → seeked frame,
 *  audio (or a missing binary) → a kind glyph. */
function MediaPoster({ media, url }: { media: MediaAsset; url?: string }) {
  if (url && media.kind === "image") {
    return <img src={url} alt="" className="h-full w-full object-cover" />;
  }
  if (url && media.kind === "video") {
    return <VideoPoster url={url} />;
  }
  const path =
    media.kind === "audio"
      ? "M9 18V5l12-2v13 M9 18a3 3 0 11-6 0 3 3 0 016 0z M21 16a3 3 0 11-6 0 3 3 0 016 0z"
      : media.kind === "image"
        ? "M4 5h16v14H4z M8 11l2 2 3-4 5 6H5z"
        : "M4 5h16v14H4z M10 9l5 3-5 3z";
  return (
    <div className="grid h-full w-full place-items-center text-faint">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </div>
  );
}

function MediaTile({
  media,
  url,
  index,
  count,
  busy,
  selected,
  onSelect,
  onReorder,
  onRemove,
  onAddToTimeline,
}: {
  media: MediaAsset;
  url?: string;
  index: number;
  count: number;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onReorder: (mediaId: string, dir: "up" | "down") => void;
  onRemove: (mediaId: string) => void;
  onAddToTimeline?: (mediaId: string) => void;
}) {
  const label = media.label ?? media.src;
  const family = media.kind === "audio" ? MEDIA_DND_AUDIO : MEDIA_DND_VISUAL;
  const detail =
    media.kind === "audio" || media.kind === "video"
      ? media.durationSec != null
        ? fmtTime(media.durationSec)
        : ""
      : media.width && media.height
        ? `${media.width}×${media.height}`
        : "";
  return (
    <div
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DND_ID, media.id);
        e.dataTransfer.setData(family, media.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onSelect}
      aria-label={`${label} — drag onto a timeline lane to add it`}
      title={`${label} — drag onto a timeline lane`}
      className={[
        "group relative flex flex-col overflow-hidden rounded-xl border bg-elevated text-left transition",
        selected ? "border-teal/50 ring-1 ring-teal/40" : "border-line hover:border-amber/40",
        busy ? "" : "cursor-grab active:cursor-grabbing",
      ].join(" ")}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-panel">
        <MediaPoster media={media} url={url} />
        <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/85">
          {media.kind}
        </span>
        {detail && (
          <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white/85">
            {detail}
          </span>
        )}
        {/* Hover / focus action cluster (keeps reorder + remove + add accessible). */}
        <div className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onReorder(media.id, "up"); }}
            disabled={busy || index === 0}
            aria-label={`Move ${label} earlier`}
            title="Move earlier"
            className="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-white/80 transition hover:bg-black/80 disabled:opacity-30"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onReorder(media.id, "down"); }}
            disabled={busy || index === count - 1}
            aria-label={`Move ${label} later`}
            title="Move later"
            className="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-white/80 transition hover:bg-black/80 disabled:opacity-30"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(media.id); }}
            disabled={busy}
            aria-label={`Remove ${label}`}
            title="Remove"
            className="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-white/80 transition hover:bg-danger/70 disabled:opacity-30"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="truncate text-xs text-muted" title={label}>{label}</span>
        {onAddToTimeline && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAddToTimeline(media.id); }}
            disabled={busy}
            aria-label={`Add ${label} to timeline`}
            title="Add to timeline"
            className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-faint transition hover:bg-line hover:text-text disabled:opacity-30"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}

function MediaGrid({
  mediaList,
  urls,
  busy,
  onOpenPicker,
  onFiles,
  onReorderMedia,
  onRemoveMedia,
  onAddToTimeline,
}: {
  mediaList: MediaAsset[];
  urls: Record<string, string>;
  busy: boolean;
  onOpenPicker: () => void;
  onFiles: (files: File[]) => void;
  onReorderMedia: (mediaId: string, dir: "up" | "down") => void;
  onRemoveMedia: (mediaId: string) => void;
  onAddToTimeline?: (mediaId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dropHot, setDropHot] = useState(false);

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const onDropFiles = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropHot(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) onFiles(files);
  };

  if (mediaList.length === 0) {
    return (
      <div className="border-b border-line-soft bg-panel/30 px-4 py-3">
        <div
          onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setDropHot(true); } }}
          onDragLeave={() => setDropHot(false)}
          onDrop={onDropFiles}
          className={[
            "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-7 text-center transition",
            dropHot ? "border-amber/60 bg-amber/10" : "border-line bg-elevated/30",
          ].join(" ")}
        >
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-amber/10 text-amber">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M8 8l4-4 4 4M4 20h16" /></svg>
          </div>
          <p className="text-sm text-text">Drop video, photos or audio here</p>
          <button
            type="button"
            onClick={onOpenPicker}
            disabled={busy}
            className="mt-1 rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright disabled:opacity-50"
          >
            + Add media
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="border-b border-line-soft bg-panel/30 px-4 py-2.5"
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setDropHot(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropHot(false); }}
      onDrop={onDropFiles}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">media</span>
        <span className="flex items-center gap-2">
          {mediaList.length > 1 && (
            <span className="hidden text-[11px] text-faint sm:inline">Drag a tile onto a lane · reorder or remove on hover</span>
          )}
          <button
            type="button"
            onClick={onOpenPicker}
            disabled={busy}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-50"
          >
            + Add media
          </button>
        </span>
      </div>
      <div
        className={[
          "grid max-h-full grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2 overflow-y-auto rounded-lg pr-0.5 transition",
          dropHot ? "outline-dashed outline-2 outline-offset-2 outline-amber/50" : "",
        ].join(" ")}
      >
        {mediaList.map((m, i) => (
          <MediaTile
            key={m.id}
            media={m}
            url={urls[m.id]}
            index={i}
            count={mediaList.length}
            busy={busy}
            selected={selectedId === m.id}
            onSelect={() => setSelectedId(m.id)}
            onReorder={onReorderMedia}
            onRemove={onRemoveMedia}
            onAddToTimeline={onAddToTimeline}
          />
        ))}
      </div>
    </div>
  );
}

function TrackPanel({
  doc,
  busy,
  onSetTrackVolume,
}: {
  doc: EditDoc;
  busy: boolean;
  onSetTrackVolume: (trackId: string, volume: number) => void;
}) {
  // Remember the pre-mute volume per track so unmute restores it (session-local).
  const [lastVol, setLastVol] = useState<Record<string, number>>({});

  if (doc.tracks.length === 0) {
    return (
      <div className="flex items-center gap-2 border-b border-line-soft bg-panel/20 px-4 py-1.5">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">tracks</span>
        <span className="text-xs text-faint">No tracks yet — add media to build your timeline.</span>
      </div>
    );
  }

  return (
    <div
      aria-label="Tracks"
      className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-panel/20 px-4 py-1.5"
    >
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">tracks</span>
      {doc.tracks.map((track) => {
        const count = track.clips.length;
        const audioClips = track.clips.filter((c): c is AudioClip => c.kind === "audio");
        const isAudio = track.kind === "audio" && audioClips.length > 0;
        const muted = isAudio && audioClips.every((c) => c.volume === 0);
        const toggleMute = () => {
          if (muted) {
            onSetTrackVolume(track.id, lastVol[track.id] ?? (track.id === "music" ? 0.28 : 1));
          } else {
            const cur = audioClips.find((c) => c.volume > 0)?.volume ?? 1;
            setLastVol((m) => ({ ...m, [track.id]: cur }));
            onSetTrackVolume(track.id, 0);
          }
        };
        return (
          <span
            key={track.id}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated py-1 pl-2 pr-2.5 text-xs text-muted"
          >
            <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] uppercase text-faint">{track.kind}</span>
            <span className="text-text">{trackLabel(track.id)}</span>
            <span className="tabular-nums text-faint">
              {count} clip{count === 1 ? "" : "s"}
            </span>
            {isAudio && (
              <button
                type="button"
                onClick={toggleMute}
                disabled={busy}
                aria-pressed={muted}
                aria-label={`${muted ? "Unmute" : "Mute"} ${trackLabel(track.id)} track`}
                title={muted ? "Unmute track" : "Mute track"}
                className={[
                  "ml-0.5 grid h-6 w-6 place-items-center rounded-md transition disabled:opacity-30",
                  muted ? "text-danger hover:bg-danger/15" : "text-faint hover:bg-line hover:text-text",
                ].join(" ")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  {muted ? (
                    <>
                      <path d="M11 5 6 9H2v6h4l5 4z" />
                      <path d="M23 9l-6 6M17 9l6 6" />
                    </>
                  ) : (
                    <>
                      <path d="M11 5 6 9H2v6h4l5 4z" />
                      <path d="M15.5 8.5a5 5 0 010 7M19 5a9 9 0 010 14" />
                    </>
                  )}
                </svg>
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
