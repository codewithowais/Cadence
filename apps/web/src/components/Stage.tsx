"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeClipsAt,
  cssFilter,
  imageMotion,
  transitionOpacity,
  type EditDoc,
} from "@cadence/core";
import { computePreview } from "@/lib/preview";
import { fmtTime } from "@/lib/format";

interface StageProps {
  urls: Record<string, string>;
  hasMedia: boolean;
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
  const { urls, hasMedia, doc, timeSec, durationSec, playing } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameH, setFrameH] = useState(0);

  const preview = useMemo(() => computePreview(doc, timeSec), [doc, timeSec]);
  const active = useMemo(() => activeClipsAt(doc, timeSec).map((c) => c.clip), [doc, timeSec]);
  const scale = frameH > 0 ? frameH / doc.meta.height : 0;

  const videoMediaId = useMemo(() => {
    for (const track of doc.tracks) for (const c of track.clips) if (c.kind === "video") return c.mediaId;
    return null;
  }, [doc]);
  const activeVideo = active.find((c) => c.kind === "video");
  const activeImages = active.filter((c) => c.kind === "image");
  const activeTexts = active.filter((c) => c.kind === "text");

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setFrameH(e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reseek at cut boundaries (and start/stop).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || preview.sourceTime == null) return;
    v.currentTime = preview.sourceTime;
    if (playing) void v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.videoClipId, playing]);

  // Scrub while paused.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || playing || preview.sourceTime == null) return;
    v.currentTime = preview.sourceTime;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSec]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
        <div
          ref={frameRef}
          className="relative flex max-h-full items-center justify-center overflow-hidden rounded-2xl border border-line bg-black shadow-[0_20px_80px_-20px_rgba(0,0,0,0.8)]"
          style={{ aspectRatio: `${doc.meta.width} / ${doc.meta.height}`, maxWidth: "100%", height: "100%" }}
        >
          {!hasMedia && (
            <div className="grid h-full w-full place-items-center text-faint">
              <span className="text-sm">Preview will appear here</span>
            </div>
          )}

          {/* Video layer (single source in edit mode) */}
          {hasMedia && videoMediaId && urls[videoMediaId] && (
            <video
              ref={videoRef}
              src={urls[videoMediaId]}
              muted
              playsInline
              preload="auto"
              className="absolute inset-0 h-full w-full object-cover"
              style={{
                opacity: activeVideo ? transitionOpacity(activeVideo, timeSec) : 0,
                filter: activeVideo ? cssFilter(activeVideo.look) : "none",
              }}
            />
          )}

          {/* Image layers (slideshow: crossfade + Ken Burns) */}
          {hasMedia &&
            activeImages.map((clip) => {
              const m = imageMotion(clip, timeSec);
              const url = urls[clip.mediaId];
              if (!url) return null;
              return (
                <img
                  key={clip.id}
                  src={url}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover will-change-transform"
                  style={{
                    opacity: transitionOpacity(clip, timeSec),
                    filter: cssFilter(clip.look),
                    transform: `translate(${m.panXFrac * 100}%, ${m.panYFrac * 100}%) scale(${clip.transform.scale * m.scale})`,
                  }}
                />
              );
            })}

          {/* Text / caption overlays */}
          {scale > 0 &&
            activeTexts.map((t) => {
              const anchor =
                t.align === "center" ? "translate(-50%, -50%)" : t.align === "right" ? "translate(-100%, -50%)" : "translate(0, -50%)";
              return (
                <div
                  key={t.id}
                  className="pointer-events-none absolute font-semibold"
                  style={{
                    left: `${(t.transform.x / doc.meta.width) * 100}%`,
                    top: `${(t.transform.y / doc.meta.height) * 100}%`,
                    transform: `${anchor} rotate(${t.transform.rotation}deg)`,
                    opacity: transitionOpacity(t, timeSec),
                    maxWidth: "92%",
                  }}
                >
                  <span
                    className={t.background ? "" : "voice"}
                    style={{
                      display: "inline-block",
                      whiteSpace: "nowrap",
                      fontSize: `${t.fontSize * scale}px`,
                      lineHeight: 1.1,
                      color: t.color,
                      background: t.background ?? "transparent",
                      padding: t.background ? `${t.fontSize * scale * 0.28}px ${t.fontSize * scale * 0.5}px` : 0,
                      borderRadius: t.background ? `${t.fontSize * scale * 0.4}px` : 0,
                      fontFamily: "var(--font-chrome)",
                      textShadow: t.background ? "none" : "0 2px 20px rgba(0,0,0,0.55)",
                    }}
                  >
                    {t.text}
                  </span>
                </div>
              );
            })}
        </div>
      </div>

      {/* Transport */}
      <div className="flex items-center gap-3 px-4 pb-1 sm:px-6">
        <button
          type="button"
          onClick={props.onTogglePlay}
          disabled={!hasMedia}
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
          disabled={!hasMedia}
          aria-label="Scrubber"
        />

        <div className="hidden shrink-0 items-center gap-1 sm:flex" title="Nudge the ending">
          <span className="mr-1 text-[11px] text-faint">nudge end</span>
          <button type="button" onClick={() => props.onNudge(-0.1)} disabled={!props.canNudge} className="rounded-md border border-line bg-elevated px-2 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40">−0.1s</button>
          <button type="button" onClick={() => props.onNudge(0.1)} disabled={!props.canNudge} className="rounded-md border border-line bg-elevated px-2 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40">+0.1s</button>
        </div>
      </div>
    </div>
  );
}
