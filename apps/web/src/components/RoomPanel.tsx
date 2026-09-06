"use client";

import { useRef } from "react";
import type { EditDoc, MediaAsset, QualityPreset } from "@cadence/core";
import { fmtTime } from "@/lib/format";
import { LOOKS, describeDoc } from "@/lib/status";
import type { RoomKey } from "./RoomsRail";

interface RoomPanelProps {
  room: Exclude<RoomKey, "edit">;
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  /** Same handler QuickActions/DirectorRail use — a director request. */
  onAction: (prompt: string) => void;
  /** Same handler DirectorRail uses — add files (video/photos/audio). */
  onFiles: (files: File[]) => void;
  onExport: () => void;
  canExport: boolean;
  /** Preview mute state (lifted to the editor; also toggled in the transport). */
  muted: boolean;
  onToggleMute: () => void;
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

const QUALITY_PRESETS: { key: QualityPreset; label: string; prompt: string }[] = [
  { key: "standard", label: "Standard", prompt: "set standard quality (1080p)" },
  { key: "high", label: "High", prompt: "make it high quality" },
  { key: "ultra", label: "Ultra", prompt: "make it 4K" },
];

export function RoomPanel(props: RoomPanelProps) {
  const { room, doc, mediaList, busy, onAction, onFiles, onExport, canExport, muted, onToggleMute } = props;
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
        {mediaList.map((m) => {
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
              className="flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted"
            >
              <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] uppercase text-faint">{m.kind}</span>
              <span className="truncate">{m.label ?? m.src}</span>
              {detail && <span className="shrink-0 tabular-nums text-faint">{detail}</span>}
            </span>
          );
        })}
        <Pill onClick={openPicker} disabled={busy}>
          + Add media
        </Pill>
        {hiddenInput}
      </Shell>
    );
  }

  if (room === "color") {
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
      </Shell>
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
    return (
      <Shell label="audio">
        <Pill onClick={openPicker} disabled={busy}>
          + Add music
        </Pill>
        <Pill onClick={() => onAction("add background music")} disabled={busy || mediaList.length === 0}>
          Use as music
        </Pill>
        <Pill onClick={() => onAction("auto-mix the audio")} disabled={busy || mediaList.length === 0}>
          Auto-mix
        </Pill>
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
        <span className="shrink-0 text-[11px] text-faint">Music &amp; mix render on export.</span>
        {hiddenInput}
      </Shell>
    );
  }

  // deliver
  return (
    <Shell label="deliver">
      {QUALITY_PRESETS.map((q) => (
        <Pill
          key={q.key}
          onClick={() => onAction(q.prompt)}
          disabled={busy || mediaList.length === 0}
          active={doc.quality.preset === q.key}
        >
          {q.label}
          {q.key === "ultra" ? " · 4K" : ""}
        </Pill>
      ))}
      <button
        type="button"
        onClick={onExport}
        disabled={!canExport || busy}
        className="shrink-0 rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
      >
        Export
      </button>
      <span className="shrink-0 text-[11px] text-faint">Real .mp4 export needs ffmpeg (runs via <code>docker compose up</code>).</span>
    </Shell>
  );
}
