import type { EditDoc } from "@cadence/core";
import { fmtTime } from "@/lib/format";

interface CutsStripProps {
  doc: EditDoc;
  timeSec: number;
  durationSec: number;
  onSeek: (t: number) => void;
}

const TRACK_COLORS: Record<string, string> = {
  video: "bg-teal/25 border-teal/50 text-teal",
  image: "bg-teal/25 border-teal/50 text-teal",
  text: "bg-amber/20 border-amber/50 text-amber",
  audio: "bg-elevated border-line text-muted",
};

export function CutsStrip({ doc, timeSec, durationSec, onSeek }: CutsStripProps) {
  const total = durationSec || 1;
  const playheadPct = Math.min(100, (timeSec / total) * 100);

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
        {/* playhead */}
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
        </div>
      </div>
    </section>
  );
}
