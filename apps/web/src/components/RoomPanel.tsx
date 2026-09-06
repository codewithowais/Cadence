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
import { cssFilter } from "@cadence/core";
import {
  addMask,
  adjustColor,
  adjustCurves,
  adjustHsl,
  audioFade,
  chromaKey,
  currentGrade,
  normalizeLoudness,
  regionBlur,
  setBlend,
  setPan,
  NEUTRAL_GRADE,
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
import { LOOKS, describeDoc } from "@/lib/status";
import { captionsToSrt, hasCaptions } from "@/lib/srt";
import { renderFrameBlob } from "@/lib/api";
import { VoiceOverRecorder } from "./VoiceOverRecorder";
import { TranscriptRoom } from "./TranscriptRoom";
import { DemoRoom } from "./DemoRoom";
import type { Transcript } from "@cadence/understanding";
import type { RoomKey } from "./RoomsRail";
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
}

/** Shared wrapper so every room reads as the same contextual strip. */
function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-faint">{label}</span>
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
      <Shell label="media">
        {mediaList.length === 0 && <span className="shrink-0 text-xs text-faint">No media yet.</span>}
        {mediaList.map((m, i) => {
          const detail =
            m.kind === "audio" || m.kind === "video"
              ? m.durationSec != null
                ? fmtTime(m.durationSec)
                : ""
              : m.width && m.height
                ? `${m.width}×${m.height}`
                : "";
          return (
            <span
              key={m.id}
              title={m.label ?? m.src}
              className="flex max-w-[260px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated py-1 pl-2 pr-1 text-xs text-muted"
            >
              <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] uppercase text-faint">{m.kind}</span>
              <span className="truncate">{m.label ?? m.src}</span>
              {detail && <span className="shrink-0 tabular-nums text-faint">{detail}</span>}
              <span className="ml-0.5 flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={() => onReorderMedia(m.id, "up")}
                  disabled={busy || i === 0}
                  aria-label={`Move ${m.label ?? m.src} earlier`}
                  title="Move earlier"
                  className="grid h-6 w-6 place-items-center rounded-md text-faint transition hover:bg-line hover:text-text disabled:opacity-30"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <button
                  type="button"
                  onClick={() => onReorderMedia(m.id, "down")}
                  disabled={busy || i === mediaList.length - 1}
                  aria-label={`Move ${m.label ?? m.src} later`}
                  title="Move later"
                  className="grid h-6 w-6 place-items-center rounded-md text-faint transition hover:bg-line hover:text-text disabled:opacity-30"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveMedia(m.id)}
                  disabled={busy}
                  aria-label={`Remove ${m.label ?? m.src}`}
                  title="Remove"
                  className="grid h-6 w-6 place-items-center rounded-md text-faint transition hover:bg-red-500/15 hover:text-red-300 disabled:opacity-30"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </span>
            </span>
          );
        })}
        <Pill onClick={openPicker} disabled={busy}>
          + Add media
        </Pill>
        {mediaList.length > 1 && (
          <span className="shrink-0 text-[11px] text-faint">Reorder to change clip order · remove to drop a clip.</span>
        )}
        {hiddenInput}
      </Shell>
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

  if (room === "color") {
    return (
      <ColorRoom
        doc={doc}
        mediaList={mediaList}
        urls={urls}
        busy={busy}
        timeSec={timeSec}
        onAction={onAction}
        onApplyDoc={onApplyDoc}
        status={status}
      />
    );
  }

  if (room === "vfx") {
    return (
      <VfxRoom
        doc={doc}
        mediaList={mediaList}
        busy={busy}
        timeSec={timeSec}
        onAction={onAction}
        onApplyDoc={onApplyDoc}
        onBeginPlacement={onBeginPlacement}
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
      {err && <span className="self-center text-[11px] text-red-300">Couldn&apos;t read the frame for scopes.</span>}
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

function ColorRoom({
  doc,
  mediaList,
  urls,
  busy,
  timeSec,
  onAction,
  onApplyDoc,
  status,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  urls: Record<string, string>;
  busy: boolean;
  timeSec: number;
  onAction: (prompt: string) => void;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  status: ReturnType<typeof describeDoc>;
}) {
  const hasVisual = mediaList.some((m) => m.kind === "video" || m.kind === "image");
  // The sliders are read straight from the doc — the single source of truth — so
  // they always reflect whatever grade is applied (a preset, an NL tweak, reset).
  const grade = currentGrade(doc);
  const disabled = busy || !hasVisual;
  const [showScopes, setShowScopes] = useState(false);

  // Merge one field onto the live doc and apply instantly (pure, client-side).
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

  // The media whose frame the scopes sample: the first loaded visual clip.
  const scopeMedia = mediaList.find((m) => (m.kind === "video" || m.kind === "image") && urls[m.id]);

  return (
    <div aria-label="Color" className="flex max-h-[42vh] flex-col gap-2 overflow-y-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      {/* Look presets + core grade sliders */}
      <div className="flex flex-wrap items-center gap-2">
        {LOOKS.map((l) => {
          const active = l.key === "none" ? status.look === null : status.look?.toLowerCase() === l.label.toLowerCase();
          return (
            <Pill
              key={l.key}
              onClick={() => onAction(l.key === "none" ? "remove the color grade" : `give it a ${l.key} look`)}
              disabled={busy || mediaList.length === 0}
              active={active}
            >
              {l.label}
            </Pill>
          );
        })}
        <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />
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

      {/* Tone curve: presets + a draggable master curve (→ adjustCurves) */}
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

      {/* Scopes (client-only): histogram + RGB parade from the preview frame */}
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
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-faint">deliver</span>

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
        className="shrink-0 rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
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
          <span className="text-red-300">Couldn&apos;t render a thumbnail — try again once media is loaded. </span>
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
 * VFX room — real, direct controls that apply the PURE compositing/region fns from
 * `@cadence/director` through the editor's undoable commit path (instant preview),
 * plus the existing NL-driven overlays. Chroma / blend / mask composite over the
 * b-roll overlay when present (else the main clip); blur/pixelate hide a region of
 * the MAIN clip — the room states which, so it's never a surprise.
 */
function VfxRoom({
  doc,
  mediaList,
  busy,
  timeSec,
  onAction,
  onApplyDoc,
  onBeginPlacement,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  timeSec: number;
  onAction: (prompt: string) => void;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onBeginPlacement?: BeginPlacement;
}) {
  const hasVisual = mediaList.some((m) => m.kind === "video" || m.kind === "image");
  const noMedia = busy || mediaList.length === 0;
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
    <div aria-label="VFX" className="flex max-h-[42vh] flex-col gap-2 overflow-y-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      {/* Existing NL-driven overlays (kept) */}
      <Row label="effects">
        <Pill onClick={() => onAction("add b-roll as picture-in-picture")} disabled={noMedia}>+ B-roll</Pill>
        <Pill onClick={() => onAction("punch in for emphasis at 2s")} disabled={noMedia}>Punch-in</Pill>
        <Pill onClick={() => onAction('add an animated title that says "Cadence"')} disabled={noMedia}>Kinetic title</Pill>
        <Pill onClick={() => onAction("add a fade in and out")} disabled={noMedia}>Fade in/out</Pill>
        <Pill onClick={() => onAction("add a vignette")} disabled={noMedia}>Vignette</Pill>
        <Pill onClick={() => onAction("add film grain")} disabled={noMedia}>Grain</Pill>
        <Pill onClick={() => onAction("add a light leak")} disabled={noMedia}>Light leak</Pill>
      </Row>

      {/* Stickers + one-click text presets (→ insertSticker / TEXT_PRESETS) */}
      <StickersTextSection
        doc={doc}
        disabled={disabled}
        timeSec={timeSec}
        onApplyDoc={onApplyDoc}
        onBeginPlacement={onBeginPlacement}
      />

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

// ---- Stickers + text presets -----------------------------------------------

/**
 * A discoverable picker for emoji STICKERS and one-click styled TEXT PRESETS.
 * Every insert reuses the engine's text/title fns (via `@/lib/text-presets`) and
 * applies through the undoable `onApplyDoc` (commit) path. Inserts land centered
 * at the playhead by default; with "Place on preview" armed, the next pick drops
 * where the user clicks on the Stage (reuses `onBeginPlacement`).
 */
function StickersTextSection({
  doc,
  disabled,
  timeSec,
  onApplyDoc,
  onBeginPlacement,
}: {
  doc: EditDoc;
  disabled?: boolean;
  timeSec: number;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onBeginPlacement?: BeginPlacement;
}) {
  const [draft, setDraft] = useState("");
  const [placeMode, setPlaceMode] = useState(false);
  const startSec = round2(Math.max(0, timeSec));
  const canPlace = !!onBeginPlacement;

  // Resolve placement (if armed), then apply the caller-provided builder. The
  // builder receives timing + optional placed fractions and returns the new doc.
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
    <>
      <Row label="stickers">
        {EMOJI_STICKERS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => void drop((o) => insertSticker(doc, emoji, o))}
            disabled={disabled}
            aria-label={`Add ${emoji} sticker`}
            title="Preview is exact. Emoji fidelity in the exported .mp4 depends on the render machine's fonts."
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-elevated text-lg leading-none transition hover:border-amber/40 disabled:opacity-40"
          >
            {emoji}
          </button>
        ))}
      </Row>

      <Row label="text">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Your text (optional)"
          disabled={disabled}
          aria-label="Text for the preset overlay"
          className="w-[160px] shrink-0 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-text placeholder:text-faint disabled:opacity-40"
        />
        {TEXT_PRESETS.map((preset) => (
          <Pill
            key={preset.key}
            onClick={() => void drop((o) => preset.build(doc, o), draft)}
            disabled={disabled}
          >
            {preset.label}
          </Pill>
        ))}
        {canPlace && (
          <Pill onClick={() => setPlaceMode((p) => !p)} active={placeMode} disabled={disabled}>
            {placeMode ? "Placing on preview" : "Place on preview"}
          </Pill>
        )}
        <span className="text-[11px] text-faint">
          {placeMode
            ? "Pick a sticker or preset, then click the preview to drop it."
            : "Adds centered at the playhead — drag it anywhere on the timeline."}
        </span>
      </Row>
    </>
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
    <div aria-label="Audio" className="flex max-h-[42vh] flex-col gap-2 overflow-y-auto border-b border-line-soft bg-panel/30 px-4 py-2">
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
        <span className="shrink-0 text-[11px] uppercase tracking-wider text-faint">tracks</span>
        <span className="text-xs text-faint">No tracks yet — add media to build your timeline.</span>
      </div>
    );
  }

  return (
    <div
      aria-label="Tracks"
      className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-panel/20 px-4 py-1.5"
    >
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-faint">tracks</span>
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
                  muted ? "text-red-300 hover:bg-red-500/15" : "text-faint hover:bg-line hover:text-text",
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
