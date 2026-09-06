"use client";

import { useRef } from "react";
import type { AudioClip, ColorGrade, EditDoc, MediaAsset, QualityPreset } from "@cadence/core";
import { adjustColor, currentGrade, NEUTRAL_GRADE } from "@cadence/director";
import { fmtTime } from "@/lib/format";
import { LOOKS, describeDoc } from "@/lib/status";
import { VoiceOverRecorder } from "./VoiceOverRecorder";
import type { RoomKey } from "./RoomsRail";

interface RoomPanelProps {
  room: Exclude<RoomKey, "edit">;
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  /** Same handler QuickActions/DirectorRail use — a director request. */
  onAction: (prompt: string) => void;
  /**
   * Apply a fully-formed edit-doc directly (client-side, no server round-trip).
   * Wired to the editor's setDoc so the Color sliders give instant feedback —
   * `@cadence/director` is pure, so `adjustColor(doc, …)` runs in the browser.
   */
  onApplyDoc: (doc: EditDoc) => void;
  /** Same handler DirectorRail uses — add files (video/photos/audio). */
  onFiles: (files: File[]) => void;
  onExport: () => void;
  canExport: boolean;
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

const QUALITY_PRESETS: { key: QualityPreset; label: string; prompt: string }[] = [
  { key: "standard", label: "Standard", prompt: "set standard quality (1080p)" },
  { key: "high", label: "High", prompt: "make it high quality" },
  { key: "ultra", label: "Ultra", prompt: "make it 4K" },
];

export function RoomPanel(props: RoomPanelProps) {
  const {
    room,
    doc,
    mediaList,
    busy,
    onAction,
    onApplyDoc,
    onFiles,
    onExport,
    canExport,
    muted,
    onToggleMute,
    onReorderMedia,
    onRemoveMedia,
    onRecordVoiceover,
    onSetTrackVolume,
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
    );
  }

  if (room === "color") {
    return (
      <ColorRoom
        doc={doc}
        mediaList={mediaList}
        busy={busy}
        onAction={onAction}
        onApplyDoc={onApplyDoc}
        status={status}
      />
    );
  }

  if (room === "vfx") {
    return (
      <Shell label="vfx">
        <Pill onClick={() => onAction("add b-roll as picture-in-picture")} disabled={busy || mediaList.length === 0}>
          + B-roll
        </Pill>
        <Pill onClick={() => onAction("punch in for emphasis at 2s")} disabled={busy || mediaList.length === 0}>
          Punch-in
        </Pill>
        <Pill onClick={() => onAction('add an animated title that says "Cadence"')} disabled={busy || mediaList.length === 0}>
          Kinetic title
        </Pill>
        <Pill onClick={() => onAction("add a fade in and out")} disabled={busy || mediaList.length === 0}>
          Fade in/out
        </Pill>
      </Shell>
    );
  }

  if (room === "audio") {
    const hasAudioMedia = mediaList.some((m) => m.kind === "audio");
    const musicClip = doc.tracks.find((t) => t.id === "music")?.clips.find((c): c is AudioClip => c.kind === "audio");
    const voiceClip = doc.tracks.find((t) => t.id === "voiceover")?.clips.find((c): c is AudioClip => c.kind === "audio");
    return (
      <Shell label="audio">
        <Pill onClick={openPicker} disabled={busy}>
          + Add music / audio
        </Pill>
        <VoiceOverRecorder disabled={busy} onRecorded={onRecordVoiceover} />
        <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />
        <Pill onClick={() => onAction("add background music")} disabled={busy || !hasAudioMedia}>
          Use as music
        </Pill>
        <Pill onClick={() => onAction("auto-mix the audio")} disabled={busy || mediaList.length === 0}>
          Duck under speech
        </Pill>
        {musicClip && (
          <VolumeSlider
            label="Music"
            value={musicClip.volume}
            disabled={busy}
            onChange={(v) => onSetTrackVolume("music", v)}
          />
        )}
        {voiceClip && (
          <VolumeSlider
            label="Voice"
            value={voiceClip.volume}
            disabled={busy}
            onChange={(v) => onSetTrackVolume("voiceover", v)}
          />
        )}
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
        <span className="shrink-0 text-[11px] text-faint">Music, voice-over &amp; mix render on export.</span>
        {hiddenInput}
      </Shell>
    );
  }

  // deliver
  return (
    <DeliverRoom
      doc={doc}
      mediaList={mediaList}
      busy={busy}
      onAction={onAction}
      onExport={onExport}
      canExport={canExport}
      status={status}
    />
  );
}

// ---- Color room ------------------------------------------------------------

const ASPECT_CHIPS: { label: string; prompt: string }[] = [
  { label: "9:16", prompt: "make it vertical 9:16" },
  { label: "1:1", prompt: "make it square 1:1" },
  { label: "4:5", prompt: "make it 4:5 portrait" },
  { label: "16:9", prompt: "make it 16:9 widescreen" },
];

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
        aria-label={`${label}: ${value.toFixed(2)}`}
        style={{ accentColor: "var(--color-teal)" }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

function ColorRoom({
  doc,
  mediaList,
  busy,
  onAction,
  onApplyDoc,
  status,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  onAction: (prompt: string) => void;
  onApplyDoc: (doc: EditDoc) => void;
  status: ReturnType<typeof describeDoc>;
}) {
  const hasVisual = mediaList.some((m) => m.kind === "video" || m.kind === "image");
  // The sliders are read straight from the doc — the single source of truth — so
  // they always reflect whatever grade is applied (a preset, an NL tweak, reset).
  const grade = currentGrade(doc);
  const disabled = busy || !hasVisual;

  // Merge one field onto the live doc and apply instantly (pure, client-side).
  const set = (partial: Partial<ColorGrade>) => {
    if (!hasVisual) return;
    onApplyDoc(adjustColor(doc, partial));
  };
  const isNeutral = gradeKey(grade) === gradeKey(NEUTRAL_GRADE);

  return (
    <Shell label="color">
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
      <button
        type="button"
        onClick={() => set({ ...NEUTRAL_GRADE })}
        disabled={disabled || isNeutral}
        className="shrink-0 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-40"
      >
        Reset
      </button>
    </Shell>
  );
}

// ---- Deliver room ----------------------------------------------------------

function DeliverRoom({
  doc,
  mediaList,
  busy,
  onAction,
  onExport,
  canExport,
  status,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  onAction: (prompt: string) => void;
  onExport: () => void;
  canExport: boolean;
  status: ReturnType<typeof describeDoc>;
}) {
  const noMedia = busy || mediaList.length === 0;
  const outW = doc.quality.targetWidth ?? doc.meta.width;
  const outH = doc.quality.targetHeight ?? doc.meta.height;
  const upscaled = outW !== doc.meta.width || outH !== doc.meta.height;

  return (
    <Shell label="deliver">
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-faint">Aspect</span>
      {ASPECT_CHIPS.map((a) => (
        <Pill key={a.label} onClick={() => onAction(a.prompt)} disabled={noMedia} active={status.aspect === a.label}>
          {a.label}
        </Pill>
      ))}
      <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-faint">Quality</span>
      {QUALITY_PRESETS.map((q) => (
        <Pill key={q.key} onClick={() => onAction(q.prompt)} disabled={noMedia} active={doc.quality.preset === q.key}>
          {q.label}
          {q.key === "ultra" ? " · 4K" : ""}
        </Pill>
      ))}
      <span
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-2.5 py-1 text-[11px] text-muted"
        title={upscaled ? `Upscales ${doc.meta.width}×${doc.meta.height} → ${outW}×${outH} on export` : "Output resolution"}
      >
        <span className="text-faint">Output</span>
        <span className="tabular-nums">
          {outW}×{outH}
        </span>
      </span>
      <button
        type="button"
        onClick={onExport}
        disabled={!canExport || busy}
        className="shrink-0 rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
      >
        Export .mp4
      </button>
      <span className="shrink-0 text-[11px] text-faint">
        Real .mp4 export renders via ffmpeg (runs with <code>docker compose up</code>); otherwise you get the edit-doc JSON.
      </span>
    </Shell>
  );
}
