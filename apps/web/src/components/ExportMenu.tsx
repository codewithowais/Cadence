"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EditDoc } from "@cadence/core";
import {
  FPS_OPTIONS,
  QUALITY_OPTIONS,
  currentExportSettings,
  targetResolution,
  type ExportContainer,
  type ExportSettings,
} from "@/lib/export-presets";
import { preflightExport, type PreflightInput } from "@/lib/export-preflight";
import { formatEta } from "@/lib/export-stream";

/**
 * What an in-flight export is doing, for the top-bar progress pill. `fraction`
 * is the determinate progress of the CURRENT phase (null → indeterminate).
 */
export interface ExportUiProgress {
  phase: "uploading" | "queued" | "preparing" | "encoding" | "finishing" | "downloading";
  fraction: number | null;
  etaSec: number | null;
  /** Extra context, e.g. "2 of 3" while uploading several files. */
  detail?: string;
}

interface ExportMenuProps {
  doc: EditDoc;
  canExport: boolean;
  busy?: boolean;
  /** Apply the chosen settings to the doc, then run the real export. */
  onExport: (settings: ExportSettings) => void;
  /** Present while an export runs → the button becomes a progress pill. */
  progress?: ExportUiProgress | null;
  /** Cancel the running export (kills the server-side encode too). */
  onCancel?: () => void;
  /** Which media files are loaded (drives the pre-flight checks). */
  preflight?: Omit<PreflightInput, "output">;
}

const CONTAINERS: { key: ExportContainer; label: string }[] = [
  { key: "mp4", label: "MP4" },
  { key: "webm", label: "WebM" },
];

const PHASE_LABEL: Record<ExportUiProgress["phase"], string> = {
  uploading: "Uploading media",
  queued: "Waiting for a render slot",
  preparing: "Preparing",
  encoding: "Rendering",
  finishing: "Enhancing",
  downloading: "Downloading",
};

/** Small segmented control used for each option row. */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  render,
}: {
  options: readonly { key: T; label: string }[] | readonly T[];
  value: T;
  onChange: (v: T) => void;
  render?: (o: { key: T; label: string }) => React.ReactNode;
}) {
  const norm = options.map((o) =>
    typeof o === "object" ? (o as { key: T; label: string }) : { key: o as T, label: String(o) },
  );
  return (
    <div className="flex gap-1 rounded-lg border border-line bg-elevated p-1">
      {norm.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={String(o.key)}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={active}
            className={[
              "flex-1 rounded-md px-2 py-1 text-xs font-medium transition",
              active ? "bg-teal/15 text-teal" : "text-muted hover:text-text",
            ].join(" ")}
          >
            {render ? render(o) : o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The determinate (or indeterminate) export progress pill with Cancel. */
function ExportProgressPill({ progress, onCancel }: { progress: ExportUiProgress; onCancel?: () => void }) {
  const pct = progress.fraction === null ? null : Math.round(Math.max(0, Math.min(1, progress.fraction)) * 100);
  const label = PHASE_LABEL[progress.phase];
  const eta = progress.phase === "encoding" || progress.phase === "downloading" ? formatEta(progress.etaSec) : "";
  const sub = [progress.detail, eta].filter(Boolean).join(" · ");
  return (
    <div
      role="group"
      aria-label="Export in progress"
      className="flex items-center gap-2 rounded-lg border border-amber/35 bg-elevated py-1 pl-3 pr-1 shadow-[0_6px_18px_-10px_rgba(13,122,107,0.45)]"
    >
      <div className="flex w-40 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
          {/* Phase changes are announced; percent ticks are not (too chatty). */}
          <span aria-live="polite" className="truncate font-semibold text-text">
            {label}
          </span>
          <span className="tabular-nums text-muted" data-testid="export-percent">
            {pct === null ? "…" : `${pct}%`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={`${label} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-valuetext={pct === null ? `${label}…` : `${label} ${pct}%${eta ? `, ${eta}` : ""}`}
          className="relative h-1.5 w-full overflow-hidden rounded-full bg-line-soft"
        >
          {pct === null ? (
            <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-amber/70 motion-safe:animate-pulse" />
          ) : (
            <div
              className="h-full rounded-full bg-amber transition-[width] duration-300 ease-out motion-reduce:transition-none"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
        <span className="h-3 truncate text-[10px] leading-3 text-faint">{sub}</span>
      </div>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel export"
          title="Cancel export"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-danger/10 hover:text-danger"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  );
}

export function ExportMenu({ doc, canExport, busy, onExport, progress, onCancel, preflight }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ExportSettings>(() => currentExportSettings(doc));
  const rootRef = useRef<HTMLDivElement>(null);

  // Seed the popover from the live doc each time it opens.
  useEffect(() => {
    if (open) setSettings(currentExportSettings(doc));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // An export starting (from anywhere) closes the popover.
  useEffect(() => {
    if (progress) setOpen(false);
  }, [progress]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const res =
    settings.preset === "standard"
      ? { width: doc.meta.width, height: doc.meta.height }
      : targetResolution(doc, settings.preset);

  // Pre-flight only while the popover is open (it's cheap, but no need per frame).
  const check = useMemo(
    () => (open && preflight ? preflightExport(doc, { ...preflight, output: res }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, doc, preflight, res.width, res.height],
  );
  const blocked = check ? !check.ok : false;

  if (progress) return <ExportProgressPill progress={progress} onCancel={onCancel} />;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!canExport}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg bg-amber px-3 py-1.5 font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
      >
        Export
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Export options"
          className="absolute right-0 top-full z-40 mt-2 w-64 rounded-2xl border border-line bg-panel p-4 text-left shadow-[0_16px_44px_-16px_rgba(24,34,38,0.22)]"
        >
          <div className="space-y-3">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
                <span>Format</span>
                {settings.container === "webm" && <span className="text-amber-bright">renders MP4</span>}
              </div>
              <Segmented
                options={CONTAINERS}
                value={settings.container}
                onChange={(container) => setSettings((s) => ({ ...s, container }))}
              />
            </div>

            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-faint">Quality</div>
              <Segmented
                options={QUALITY_OPTIONS}
                value={settings.preset}
                onChange={(preset) => setSettings((s) => ({ ...s, preset }))}
                render={(o) => (
                  <span className="flex flex-col leading-tight">
                    <span>{o.label}</span>
                    <span className="text-[9px] text-faint">
                      {QUALITY_OPTIONS.find((q) => q.key === o.key)?.note}
                    </span>
                  </span>
                )}
              />
            </div>

            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-faint">Frame rate</div>
              <Segmented
                options={FPS_OPTIONS}
                value={settings.fps}
                onChange={(fps) => setSettings((s) => ({ ...s, fps }))}
                render={(o) => <span>{o.label} fps</span>}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-[11px] text-muted">
              <span className="text-faint">Output</span>
              <span className="tabular-nums">
                {res.width}×{res.height} · {settings.fps}fps
              </span>
            </div>

            {check && check.issues.length > 0 && (
              <ul aria-label="Export checks" className="space-y-1.5">
                {check.issues.map((issue) => (
                  <li
                    key={issue.code}
                    data-level={issue.level}
                    className={[
                      "flex gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug",
                      issue.level === "error"
                        ? "border-danger/30 bg-danger/5 text-danger"
                        : "border-amber/30 bg-amber/5 text-amber-deep",
                    ].join(" ")}
                  >
                    <span aria-hidden="true" className="mt-px font-bold">{issue.level === "error" ? "!" : "i"}</span>
                    <span>
                      <span className="sr-only">{issue.level === "error" ? "Blocking: " : "Heads up: "}</span>
                      {issue.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              disabled={!canExport || busy || blocked}
              onClick={() => {
                setOpen(false);
                onExport(settings);
              }}
              className="w-full rounded-lg bg-amber px-3 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              Export .mp4
            </button>
            <p className="text-[10px] leading-snug text-faint">
              Real .mp4 renders via ffmpeg with live progress — cancel any time. Without ffmpeg you get the edit-doc JSON.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
