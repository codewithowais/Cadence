"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EditDoc } from "@cadence/core";
import { computePreview } from "@/lib/preview";
import { fmtTime } from "@/lib/format";

interface StageProps {
  mediaUrl: string | null;
  doc: EditDoc;
  timeSec: number;
  durationSec: number;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onNudge: (delta: number) => void;
  canNudge: boolean;
}

export function Stage(props: StageProps) {
  const { mediaUrl, doc, timeSec, durationSec, playing } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameH, setFrameH] = useState(0);

  const preview = useMemo(() => computePreview(doc, timeSec), [doc, timeSec]);
  const scale = frameH > 0 ? frameH / doc.meta.height : 0;

  // Track the visible frame height so we can scale composition-space overlays.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setFrameH(e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reseek at cut boundaries (and start/stop) — lets each cut play smoothly.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || preview.sourceTime == null) return;
    v.currentTime = preview.sourceTime;
    if (playing) void v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.videoClipId, playing]);

  // Scrubbing while paused: seek to the exact frame.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || playing || preview.sourceTime == null) return;
    v.currentTime = preview.sourceTime;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSec]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Stage */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
        <div
          ref={frameRef}
          className="relative flex max-h-full items-center justify-center overflow-hidden rounded-2xl border border-line bg-black shadow-[0_20px_80px_-20px_rgba(0,0,0,0.8)]"
          style={{ aspectRatio: `${doc.meta.width} / ${doc.meta.height}`, maxWidth: "100%", height: "100%" }}
        >
          {mediaUrl ? (
            <>
              <video
                ref={videoRef}
                src={mediaUrl}
                muted
                playsInline
                preload="auto"
                className="h-full w-full object-cover"
              />
              {/* Text overlays in composition space, scaled to the frame */}
              {scale > 0 &&
                preview.texts.map((t) => (
                  <div
                    key={t.id}
                    className="voice pointer-events-none absolute whitespace-pre font-semibold"
                    style={{
                      left: `${(t.transform.x / doc.meta.width) * 100}%`,
                      top: `${(t.transform.y / doc.meta.height) * 100}%`,
                      transform: `translate(${t.align === "center" ? "-50%" : t.align === "right" ? "-100%" : "0"}, -50%) rotate(${t.transform.rotation}deg)`,
                      fontSize: `${t.fontSize * scale}px`,
                      color: t.color,
                      opacity: t.transform.opacity,
                      fontFamily: "var(--font-chrome)",
                      textShadow: "0 2px 20px rgba(0,0,0,0.55)",
                    }}
                  >
                    {t.text}
                  </div>
                ))}
            </>
          ) : (
            <div className="grid h-full w-full place-items-center text-faint">
              <span className="text-sm">Preview will appear here</span>
            </div>
          )}
        </div>
      </div>

      {/* Transport */}
      <div className="flex items-center gap-3 px-4 pb-1 sm:px-6">
        <button
          type="button"
          onClick={props.onTogglePlay}
          disabled={!mediaUrl}
          aria-label={playing ? "Pause" : "Play"}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber text-ink transition hover:bg-amber-bright disabled:opacity-40"
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>

        <span className="w-24 shrink-0 tabular-nums text-xs text-muted">
          {fmtTime(timeSec)} <span className="text-faint">/ {fmtTime(durationSec)}</span>
        </span>

        <input
          type="range"
          className="scrubber flex-1"
          min={0}
          max={Math.max(0.001, durationSec)}
          step={0.01}
          value={Math.min(timeSec, durationSec)}
          onChange={(e) => props.onSeek(Number(e.target.value))}
          disabled={!mediaUrl}
          aria-label="Scrubber"
        />

        {/* Nudge — manual control for the last frames */}
        <div className="hidden shrink-0 items-center gap-1 sm:flex" title="Nudge the ending">
          <span className="mr-1 text-[11px] text-faint">nudge end</span>
          <button
            type="button"
            onClick={() => props.onNudge(-0.1)}
            disabled={!props.canNudge}
            className="rounded-md border border-line bg-elevated px-2 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40"
          >
            −0.1s
          </button>
          <button
            type="button"
            onClick={() => props.onNudge(0.1)}
            disabled={!props.canNudge}
            className="rounded-md border border-line bg-elevated px-2 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40"
          >
            +0.1s
          </button>
        </div>
      </div>
    </div>
  );
}
