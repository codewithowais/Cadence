"use client";

import { useEffect, useMemo, useState } from "react";
import type { EditDoc } from "@cadence/core";
import { fmtTime } from "@/lib/format";
import { computeWaveform } from "@/lib/waveform";

/** The media whose audio the waveform should visualize (prefers the base video). */
export interface WaveformSource {
  mediaId: string;
  file?: File;
  url?: string;
}

interface CutsStripProps {
  doc: EditDoc;
  timeSec: number;
  durationSec: number;
  onSeek: (t: number) => void;
  /**
   * Main media for the audio waveform. We deliberately prefer the base video's
   * own audio (not a separate music track) so the peaks line up with the cuts
   * the user actually sees. `null`/absent → no waveform is drawn.
   */
  waveform?: WaveformSource | null;
}

const TRACK_COLORS: Record<string, string> = {
  video: "bg-teal/25 border-teal/50 text-teal",
  image: "bg-teal/25 border-teal/50 text-teal",
  text: "bg-amber/20 border-amber/50 text-amber",
  audio: "bg-elevated border-line text-muted",
};

/**
 * Decode the source's audio into normalized peaks. Runs once per media id
 * (cached in waveform.ts), off the render path, and is abortable: if the
 * source changes mid-decode we ignore the stale result.
 */
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
    setPeaks(null); // clear while decoding so we show nothing, not stale peaks
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

/** A filled, vertically-mirrored waveform envelope drawn as a single SVG path. */
function WaveformStrip({ peaks }: { peaks: number[] }) {
  const H = 100; // viewBox height; center line at H/2
  const W = 1000; // viewBox width; stretched to fill via preserveAspectRatio="none"
  const d = useMemo(() => {
    const n = peaks.length;
    if (n === 0) return "";
    const cx = W / n;
    const cy = H / 2;
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = i * cx;
      const a = Math.max(0.015, peaks[i]!); // floor so silence still reads as a hairline
      top.push(`${x.toFixed(2)},${(cy - a * cy).toFixed(2)}`);
      bottom.push(`${x.toFixed(2)},${(cy + a * cy).toFixed(2)}`);
    }
    return `M${top.join("L")}L${bottom.reverse().join("L")}Z`;
  }, [peaks]);

  return (
    <svg
      aria-hidden="true"
      className="h-full w-full"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      focusable="false"
    >
      <path d={d} className="fill-teal/25" />
    </svg>
  );
}

export function CutsStrip({ doc, timeSec, durationSec, onSeek, waveform }: CutsStripProps) {
  const total = durationSec || 1;
  const playheadPct = Math.min(100, (timeSec / total) * 100);
  const peaks = useWaveformPeaks(waveform);

  return (
    <section aria-label="Timeline" className="border-t border-line-soft bg-panel/40 px-4 pb-4 pt-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint">
        <span>Timeline</span>
        <span className="text-line">·</span>
        <span className="normal-case tracking-normal text-muted">
          click a cut to jump · drag the scrubber to scan
        </span>
      </div>

      <div className="relative select-none">
        {/* playhead — spans the tracks and the waveform strip below them */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-amber"
          style={{ left: `${playheadPct}%` }}
        >
          <span className="absolute -top-1 -left-[3px] h-1.5 w-1.5 rounded-full bg-amber" />
        </div>

        <div className="flex flex-col gap-1.5">
          {doc.tracks.map((track) => (
            <div key={track.id} className="relative h-9 rounded-lg bg-line-soft/40">
              {track.clips.map((clip) => {
                const left = (clip.start / total) * 100;
                const width = (clip.duration / total) * 100;
                const active = timeSec >= clip.start && timeSec < clip.start + clip.duration;
                const color = TRACK_COLORS[clip.kind] ?? TRACK_COLORS.audio;
                const label =
                  clip.kind === "text"
                    ? `“${clip.text.slice(0, 18)}”`
                    : clip.kind === "video" || clip.kind === "image"
                      ? `${fmtTime(clip.duration)}`
                      : "audio";
                return (
                  <button
                    key={clip.id}
                    type="button"
                    onClick={() => onSeek(clip.start + 0.001)}
                    title={`${clip.kind} · ${fmtTime(clip.duration)}`}
                    className={[
                      "absolute inset-y-0 overflow-hidden rounded-md border px-2 text-left text-[11px] leading-9 transition",
                      color,
                      active ? "ring-2 ring-amber/70" : "hover:brightness-125",
                    ].join(" ")}
                    style={{ left: `${left}%`, width: `calc(${width}% - 2px)` }}
                  >
                    <span className="block truncate">{label}</span>
                  </button>
                );
              })}
            </div>
          ))}

          {/* Audio waveform — a thin strip under the cuts, spanning the full
              timeline width. Renders nothing while decoding or when the media
              has no audio, so it never regresses the layout. */}
          {peaks && peaks.length > 0 && (
            <div
              className="relative h-7 overflow-hidden rounded-lg bg-line-soft/25"
              aria-label="Audio waveform"
            >
              <WaveformStrip peaks={peaks} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
