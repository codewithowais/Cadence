"use client";

/**
 * SpeedRamp — a compact preset strip for the Edit room that appears when a VIDEO
 * clip is selected: CapCut-style speed-curve presets (montage, hero time, bullet
 * time, flash-in, ease, ramps) each drawn as its own mini speed curve, plus a
 * "Constant" reset. Every preset routes through the same pure `setSpeedRamp` engine
 * op the Director's `set_speed_ramp` tool uses (so the AI and the buttons agree),
 * and preview + export integrate the same curve (`speedRampIntegral`).
 *
 * The draggable per-point curve editor lives in the timeline inspector (CutsStrip);
 * this strip is the fast, glanceable way to pick a look. Purely additive.
 */
import { useMemo } from "react";
import { type EditDoc, type VideoClip } from "@cadence/core";
import { SPEED_RAMP_PRESETS, type SpeedRampPreset } from "@cadence/director";

const PRESET_ORDER: { key: SpeedRampPreset; label: string; hint: string }[] = [
  { key: "montage", label: "Montage", hint: "Three fast→slow pulses — beat-montage energy" },
  { key: "hero-time", label: "Hero time", hint: "Real time → long slow-motion hold → real time" },
  { key: "bullet-time", label: "Bullet time", hint: "Fast → near-freeze → fast" },
  { key: "flash-in", label: "Flash in", hint: "Whip in fast, then settle to real time" },
  { key: "hero", label: "Hero", hint: "Normal → dramatic slow build → snap up" },
  { key: "ease-in-out", label: "Ease", hint: "Slow, swell to fast, ease back" },
  { key: "ramp-up", label: "Ramp up", hint: "Accelerate across the clip" },
  { key: "ramp-down", label: "Ramp down", hint: "Decelerate across the clip" },
];

const SPEED_MIN = 0.1;
const SPEED_MAX = 4;
const LOG_MIN = Math.log(SPEED_MIN);
const LOG_SPAN = Math.log(SPEED_MAX) - LOG_MIN;

/** A ramp's points as an SVG polyline in a 0..100 × 0..40 box (log speed axis). */
export function rampSparkline(points: readonly (readonly [number, number])[], w = 100, h = 40): string {
  return points
    .map(([p, m], i) => {
      const f = (Math.log(Math.min(SPEED_MAX, Math.max(SPEED_MIN, m))) - LOG_MIN) / LOG_SPAN;
      return `${i === 0 ? "M" : "L"}${(p * w).toFixed(1)},${((1 - f) * h).toFixed(1)}`;
    })
    .join(" ");
}

const sig = (pts?: readonly (readonly [number, number])[] | null): string =>
  pts && pts.length ? pts.map(([p, m]) => `${Math.round(p * 1000) / 1000},${Math.round(m * 1000) / 1000}`).join(" ") : "";

export function SpeedRamp({
  doc,
  selectedClipId,
  busy,
  onApply,
  onClear,
}: {
  doc: EditDoc;
  selectedClipId?: string | null;
  busy?: boolean;
  onApply: (clipId: string, arg: { preset: SpeedRampPreset }) => void;
  onClear: (clipId: string) => void;
}) {
  const clip = useMemo<VideoClip | null>(() => {
    if (!selectedClipId) return null;
    for (const t of doc.tracks) for (const c of t.clips) if (c.id === selectedClipId && c.kind === "video") return c;
    return null;
  }, [doc, selectedClipId]);
  if (!clip) return null;

  const hasRamp = !!clip.speedRamp && clip.speedRamp.length >= 2;
  const current = hasRamp ? sig(clip.speedRamp) : "";

  return (
    <div
      role="group"
      aria-label="Speed ramp presets"
      data-testid="speed-ramp"
      className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-panel/30 px-4 py-2"
    >
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">speed ramp</span>
      {PRESET_ORDER.map(({ key, label, hint }) => {
        const on = current !== "" && current === sig(SPEED_RAMP_PRESETS[key]);
        return (
          <button
            key={key}
            type="button"
            disabled={busy}
            aria-pressed={on}
            onClick={() => onApply(clip.id, { preset: key })}
            title={`${label} — ${hint}`}
            className={[
              "flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition disabled:opacity-50",
              on ? "border-amber bg-amber/10 text-amber" : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
            ].join(" ")}
          >
            <svg width="30" height="14" viewBox="0 0 100 40" fill="none" aria-hidden="true">
              <path d={rampSparkline(SPEED_RAMP_PRESETS[key])} stroke="currentColor" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
            {label}
          </button>
        );
      })}
      <button
        type="button"
        disabled={busy || !hasRamp}
        onClick={() => onClear(clip.id)}
        title="Remove the speed curve and play at a single constant speed"
        className="shrink-0 rounded-lg border border-line bg-elevated px-2 py-1 text-[11px] text-muted transition hover:text-text disabled:opacity-40"
      >
        Constant
      </button>
    </div>
  );
}
