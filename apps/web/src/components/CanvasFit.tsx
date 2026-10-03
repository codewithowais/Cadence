"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { SAFE_ZONES, blurRadiusFor, type CanvasSettings, type SafeZoneId } from "@cadence/core";
import { getSafeZoneMode, subscribeSafeZone } from "@/lib/canvas-prefs";

/**
 * Stage helpers for the custom canvas: the blurred-background copy behind a "Fit"
 * picture, and the safe-zone guide overlay. Both are additive layers inside the Stage
 * frame — the Stage owns the interaction layer, this file owns nothing but pixels.
 */

/** Subscribe to the safe-zone guide mode (SSR-safe: "off" on the server). */
export function useSafeZoneMode(): SafeZoneId {
  return useSyncExternalStore(subscribeSafeZone, getSafeZoneMode, () => "off" as SafeZoneId);
}

/**
 * The enlarged, blurred copy of the picture that fills the bars in Fit/blur mode. Mirrors
 * the export (cover-scale → boxblur) so preview == export. A second muted <video> keeps
 * itself in sync with the main one (resyncing if it drifts); images just repeat the URL.
 */
export function FitBackdrop(props: {
  kind: "video" | "image";
  src: string;
  /** Source time (s) the picture should show; null = leave alone. */
  sourceTime: number | null;
  playing: boolean;
  rate?: number;
  canvas: CanvasSettings | undefined;
  /** Frame size in CSS px and the composition size (to scale the blur radius). */
  frameW: number;
  compW: number;
  compH: number;
}) {
  const { kind, src, sourceTime, playing, canvas, frameW, compW, compH } = props;
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v || sourceTime == null) return;
    const drift = Math.abs(v.currentTime - sourceTime);
    if (!playing || drift > 0.3) {
      try {
        v.currentTime = sourceTime;
      } catch {
        /* metadata not ready yet */
      }
    }
    v.playbackRate = Math.max(0.25, Math.min(4, props.rate ?? 1));
    if (playing) void v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceTime, playing, src]);

  // The export blurs a (compW×compH) frame by `radius` px; scale it to the on-screen frame.
  const radius = blurRadiusFor(canvas, compW, compH);
  const px = Math.max(2, Math.round(radius * (frameW / Math.max(1, compW)) * 1.4));
  const common = {
    className: "pointer-events-none absolute inset-0 h-full w-full object-cover",
    style: { filter: `blur(${px}px) brightness(0.92)`, transform: "scale(1.12)" },
    "aria-hidden": true as const,
    "data-fit-backdrop": "blur",
  };
  return kind === "video" ? (
    <video ref={ref} src={src} muted playsInline preload="auto" {...common} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" {...common} />
  );
}

/** Guide lines for the platform UI-safe area / title-safe (a Stage overlay, never exported). */
export function SafeZoneOverlay({ mode }: { mode: SafeZoneId }) {
  if (mode === "off") return null;
  const g = SAFE_ZONES.find((z) => z.id === mode);
  if (!g) return null;
  const { top, bottom, left, right } = g.insets;
  return (
    <div className="pointer-events-none absolute inset-0 z-20" aria-hidden="true" data-testid="safe-zone-overlay" data-safe-zone={mode}>
      {/* Dim the unsafe margins, outline the safe area. */}
      <div className="absolute inset-x-0 top-0 bg-black/35" style={{ height: `${top * 100}%` }} />
      <div className="absolute inset-x-0 bottom-0 bg-black/35" style={{ height: `${bottom * 100}%` }} />
      <div className="absolute left-0 bg-black/35" style={{ top: `${top * 100}%`, bottom: `${bottom * 100}%`, width: `${left * 100}%` }} />
      <div className="absolute right-0 bg-black/35" style={{ top: `${top * 100}%`, bottom: `${bottom * 100}%`, width: `${right * 100}%` }} />
      <div
        className="absolute rounded-sm border border-dashed border-white/80"
        style={{ left: `${left * 100}%`, right: `${right * 100}%`, top: `${top * 100}%`, bottom: `${bottom * 100}%` }}
      />
      <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{g.label}</span>
    </div>
  );
}
