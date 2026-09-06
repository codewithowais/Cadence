"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  activeClipsAt,
  cssFilter,
  emphasisScale,
  imageMotion,
  textKinetic,
  transitionOpacity,
  type EditDoc,
  type ImageClip,
  type TextClip,
  type VideoClip,
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
  /** Whether the preview <video> is muted (source audio). */
  muted: boolean;
  onToggleMute: () => void;
}

/** A b-roll PiP <video> that seeks to its source time (own ref, like the main one). */
function BrollVideo(props: {
  src: string;
  clip: VideoClip;
  timeSec: number;
  playing: boolean;
  style: CSSProperties;
}) {
  const { src, clip, timeSec, playing, style } = props;
  const ref = useRef<HTMLVideoElement>(null);
  const sourceTime = clip.sourceIn + (timeSec - clip.start);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = Math.max(0, sourceTime);
    if (playing) void v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, clip.id]);
  useEffect(() => {
    const v = ref.current;
    if (!v || playing) return;
    v.currentTime = Math.max(0, sourceTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSec]);
  return <video ref={ref} src={src} muted playsInline preload="auto" style={style} />;
}

export function Stage(props: StageProps) {
  const { urls, hasMedia, doc, timeSec, durationSec, playing, muted } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameH, setFrameH] = useState(0);

  const preview = useMemo(() => computePreview(doc, timeSec), [doc, timeSec]);
  const activeOnTracks = useMemo(() => activeClipsAt(doc, timeSec), [doc, timeSec]);
  const scale = frameH > 0 ? frameH / doc.meta.height : 0;

  // The first video clip on a non-b-roll track — the fallback source shown before
  // playback and between cuts.
  const firstVideoMediaId = useMemo(() => {
    for (const track of doc.tracks) {
      if (track.id === "broll") continue;
      for (const c of track.clips) if (c.kind === "video") return c.mediaId;
    }
    return null;
  }, [doc]);
  // Base (full-frame) clips vs. b-roll overlays (picture-in-picture).
  const activeVideo = activeOnTracks.find((c) => c.track.id !== "broll" && c.clip.kind === "video")?.clip as
    | VideoClip
    | undefined;
  // With several videos combined on one timeline, the preview <video> must play
  // whichever clip is active — not a single fixed source. Falls back to the first
  // clip's media between cuts. For a single-video project this equals the base.
  const videoMediaId = activeVideo?.mediaId ?? firstVideoMediaId;
  const activeImages = activeOnTracks
    .filter((c) => c.track.id !== "broll")
    .map((c) => c.clip)
    .filter((c): c is ImageClip => c.kind === "image");
  const activeTexts = activeOnTracks.map((c) => c.clip).filter((c): c is TextClip => c.kind === "text");
  const activeBroll = activeOnTracks
    .filter((c) => c.track.id === "broll")
    .map((c) => c.clip)
    .filter((c): c is VideoClip | ImageClip => c.kind === "image" || c.kind === "video");

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
              muted={muted}
              playsInline
              preload="auto"
              className="absolute inset-0 h-full w-full object-cover will-change-transform"
              style={{
                opacity: activeVideo ? transitionOpacity(activeVideo, timeSec) : 0,
                filter: activeVideo ? cssFilter(activeVideo.look) : "none",
                // Punch-in emphasis — same core helper as the canvas/export.
                transform: activeVideo ? `scale(${emphasisScale(activeVideo, timeSec)})` : undefined,
                transformOrigin: "center",
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

          {/* B-roll / picture-in-picture overlays (top track, scaled + positioned) */}
          {hasMedia &&
            activeBroll.map((clip) => {
              const url = urls[clip.mediaId];
              if (!url) return null;
              const sizePct = clip.transform.scale * 100;
              const left = (clip.transform.x / doc.meta.width) * 100;
              const top = (clip.transform.y / doc.meta.height) * 100;
              const style: CSSProperties = {
                position: "absolute",
                width: `${sizePct}%`,
                height: `${sizePct}%`,
                left: `${left}%`,
                top: `${top}%`,
                transform: "translate(-50%, -50%)",
                opacity: transitionOpacity(clip, timeSec),
                filter: cssFilter(clip.look),
                objectFit: "cover",
                borderRadius: `${Math.max(4, scale * doc.meta.height * 0.02)}px`,
                boxShadow: "0 8px 30px -8px rgba(0,0,0,0.7)",
                outline: "2px solid rgba(255,255,255,0.14)",
              };
              return clip.kind === "video" ? (
                <BrollVideo key={clip.id} src={url} clip={clip} timeSec={timeSec} playing={playing} style={style} />
              ) : (
                <img key={clip.id} src={url} alt="" className="will-change-transform" style={style} />
              );
            })}

          {/* Text / caption overlays */}
          {scale > 0 &&
            activeTexts.map((t) => {
              const anchor =
                t.align === "center" ? "translate(-50%, -50%)" : t.align === "right" ? "translate(-100%, -50%)" : "translate(0, -50%)";
              // Kinetic intro (slide + scale in) — same core helper as canvas/export.
              const kin = textKinetic(t, timeSec);
              return (
                <div
                  key={t.id}
                  className="pointer-events-none absolute font-semibold will-change-transform"
                  style={{
                    left: `${(t.transform.x / doc.meta.width) * 100}%`,
                    top: `${(t.transform.y / doc.meta.height) * 100}%`,
                    transform: `${anchor} translate(${kin.dx * scale}px, ${kin.dy * scale}px) scale(${kin.scaleMul}) rotate(${t.transform.rotation}deg)`,
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

        <button
          type="button"
          onClick={props.onToggleMute}
          disabled={!hasMedia}
          aria-pressed={!muted}
          aria-label={muted ? "Unmute preview" : "Mute preview"}
          title={muted ? "Unmute preview audio" : "Mute preview audio"}
          className={[
            "grid h-9 w-9 shrink-0 place-items-center rounded-full border transition disabled:opacity-40",
            muted
              ? "border-line bg-elevated text-faint hover:text-muted"
              : "border-amber/40 bg-amber/10 text-amber",
          ].join(" ")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
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
        </button>

        <div className="hidden shrink-0 items-center gap-1 sm:flex" title="Nudge the ending">
          <span className="mr-1 text-[11px] text-faint">nudge end</span>
          <button type="button" onClick={() => props.onNudge(-0.1)} disabled={!props.canNudge} className="rounded-md border border-line bg-elevated px-2 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40">−0.1s</button>
          <button type="button" onClick={() => props.onNudge(0.1)} disabled={!props.canNudge} className="rounded-md border border-line bg-elevated px-2 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40">+0.1s</button>
        </div>
      </div>
    </div>
  );
}
