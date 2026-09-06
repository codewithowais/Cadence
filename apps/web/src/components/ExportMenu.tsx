"use client";

import { useEffect, useRef, useState } from "react";
import type { EditDoc } from "@cadence/core";
import {
  FPS_OPTIONS,
  QUALITY_OPTIONS,
  currentExportSettings,
  targetResolution,
  type ExportContainer,
  type ExportSettings,
} from "@/lib/export-presets";

interface ExportMenuProps {
  doc: EditDoc;
  canExport: boolean;
  busy?: boolean;
  /** Apply the chosen settings to the doc, then run the real export. */
  onExport: (settings: ExportSettings) => void;
}

const CONTAINERS: { key: ExportContainer; label: string }[] = [
  { key: "mp4", label: "MP4" },
  { key: "webm", label: "WebM" },
];

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

export function ExportMenu({ doc, canExport, busy, onExport }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ExportSettings>(() => currentExportSettings(doc));
  const rootRef = useRef<HTMLDivElement>(null);

  // Seed the popover from the live doc each time it opens.
  useEffect(() => {
    if (open) setSettings(currentExportSettings(doc));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

            <button
              type="button"
              disabled={!canExport || busy}
              onClick={() => {
                setOpen(false);
                onExport(settings);
              }}
              className="w-full rounded-lg bg-amber px-3 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              Export .mp4
            </button>
            <p className="text-[10px] leading-snug text-faint">
              Real .mp4 renders via ffmpeg; otherwise you get the edit-doc JSON.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
