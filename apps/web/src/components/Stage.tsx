"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  activeClipsAt,
  cssFilter,
  emphasisScale,
  imageMotion,
  transitionOpacity,
  transitionStyle,
  type AudioClip,
  type EditDoc,
  type ImageClip,
  type VideoClip,
} from "@cadence/core";
import { SyntheticLayer } from "./SyntheticLayer";
import { computePreview } from "@/lib/preview";
import { clipGainAt } from "@/lib/audio-mix";
import { fmtTime } from "@/lib/format";
import type { PlacementRequest, PlacementResult } from "@/lib/placement";

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
  /**
   * When set, an on-preview placement gesture is armed (Walkthrough room): the
   * Stage renders a capture overlay that reports composition fractions. Kept OFF
   * (null) at all other times so it never interferes with the normal preview.
   */
  placement?: PlacementRequest | null;
  /** Resolve the armed placement with a result, or `null` to cancel. */
  onFinishPlacement?: (result: PlacementResult | null) => void;
  /** Empty-state actions: start a text video / open the media picker. */
  onStartWithText?: () => void;
  onAddMedia?: () => void;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

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

/**
 * A hidden <audio> element for one timeline audio clip (music / voice-over), kept
 * in sync with the transport so music & voice-over are HEARD in the browser
 * preview — not only on export (the review's P0-3). It plays only while the
 * playhead is inside the clip's [start, start+duration) window, seeks to
 * `sourceIn + (timeSec - start)`, honors the clip `volume`, and follows the
 * preview `muted` toggle. One instance per audio clip, so several tracks
 * (background music + a voice-over) mix together, exactly like the export.
 */
function AudioClipPlayer(props: {
  src: string;
  clip: AudioClip;
  timeSec: number;
  playing: boolean;
  muted: boolean;
  /** The clip's level right now (keyframed duck, fades, track mute/solo) — as exported. */
  gain?: number;
}) {
  const { src, clip, timeSec, playing, muted } = props;
  const gain = props.gain ?? clip.volume;
  const ref = useRef<HTMLAudioElement>(null);
  const active = timeSec >= clip.start && timeSec < clip.start + clip.duration;
  const sourceTime = clip.sourceIn + (timeSec - clip.start);

  // Volume + preview mute — applied immediately whenever they change.
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = Math.max(0, Math.min(1, gain));
    a.muted = muted;
  }, [gain, muted]);

  // Start/stop with the transport (and when the playhead enters/leaves the clip).
  // Correct any drift at the boundary so playback stays in step with the clock.
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (playing && active) {
      const target = Math.max(0, sourceTime);
      if (Math.abs(a.currentTime - target) > 0.25) a.currentTime = target;
      void a.play().catch(() => {});
    } else {
      a.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, active, clip.id]);

  // Scrub while paused: track the playhead so the preview is "live" when stopped.
  useEffect(() => {
    const a = ref.current;
    if (!a || playing) return;
    if (active) a.currentTime = Math.max(0, sourceTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSec]);

  return <audio ref={ref} src={src} preload="auto" data-clip={clip.id} />;
}

export function Stage(props: StageProps) {
  const { urls, hasMedia, doc, timeSec, durationSec, playing, muted } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameH, setFrameH] = useState(0);
  const [frameW, setFrameW] = useState(0);
  // Anything to show/play? Text videos have no media but plenty of content.
  const hasContent = durationSec > 0;

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
  // Every audio clip in the doc (music + voice-over across all tracks). Rendered
  // as always-present hidden <audio> elements so the playhead crossing into a
  // clip can start it — each one plays only while it's active.
  const audioClips = useMemo(() => {
    const out: { clip: AudioClip; track: EditDoc["tracks"][number] }[] = [];
    for (const track of doc.tracks) for (const c of track.clips) if (c.kind === "audio") out.push({ clip: c, track });
    return out;
  }, [doc]);
  const activeBroll = activeOnTracks
    .filter((c) => c.track.id === "broll")
    .map((c) => c.clip)
    .filter((c): c is VideoClip | ImageClip => c.kind === "image" || c.kind === "video");

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setFrameH(e.contentRect.height);
        setFrameW(e.contentRect.width);
      }
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

  // Speed + freeze parity (editing craft): play the active clip at its own
  // constant speed, and hold the picture on a freeze-frame — the export holds
  // that one source frame too (`computePreview` maps time via `sourceTimeAt`).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = Math.max(0.25, Math.min(4, preview.rate));
    if (preview.frozen) {
      v.pause();
      if (preview.sourceTime != null) v.currentTime = preview.sourceTime;
    } else if (playing) void v.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.videoClipId, preview.rate, preview.frozen, playing]);

  return (
    <div className="flex min-h-[180px] min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6" style={{ containerType: "size" }}>
        <div
          ref={frameRef}
          className="relative flex items-center justify-center overflow-hidden rounded-2xl border border-line bg-[#12181a] shadow-[0_18px_50px_-20px_rgba(24,34,38,0.30)]"
          // Exact composition aspect at the largest size that fits the stage
          // (container-query units), so canvas layers and media line up.
          style={{
            aspectRatio: `${doc.meta.width} / ${doc.meta.height}`,
            width: `min(100cqw, calc(100cqh * ${doc.meta.width / doc.meta.height}))`,
          }}
        >
          {/* Backgrounds + synthetic clips BENEATH the footage (shared canvas drawing). */}
          {frameW > 0 && <SyntheticLayer doc={doc} timeSec={timeSec} layer="under" width={frameW} height={frameH} />}

          {!hasContent && (
            <div className="absolute inset-0 z-10 grid place-items-center px-6 text-center">
              <div className="flex max-w-sm flex-col items-center gap-3 text-white/60">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7V5h16v2M9 19h6M12 5v14" /></svg>
                <span className="text-sm font-medium text-white/85">Start with words or footage</span>
                <span className="text-xs text-white/50">Type a script and get an animated text video — no upload needed. Or add a video or photos to edit.</span>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                  {props.onStartWithText && (
                    <button
                      type="button"
                      onClick={props.onStartWithText}
                      className="rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright"
                    >
                      Start with text
                    </button>
                  )}
                  {props.onAddMedia && (
                    <button
                      type="button"
                      onClick={props.onAddMedia}
                      className="rounded-full border border-white/25 px-4 py-1.5 text-xs font-medium text-white/85 transition hover:border-white/50"
                    >
                      Add media
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Video layer (single source in edit mode). The transition TYPE is
              honored via the shared pure `transitionStyle` helper (slide / wipe /
              zoom / fade), so changing it in the UI visibly changes the preview. */}
          {hasMedia && videoMediaId && urls[videoMediaId] && (() => {
            const ts = activeVideo
              ? transitionStyle(activeVideo, timeSec, doc.meta.width, doc.meta.height)
              : null;
            return (
              <video
                ref={videoRef}
                src={urls[videoMediaId]}
                muted={muted}
                playsInline
                preload="auto"
                data-transition={ts?.type}
                data-transition-active={ts?.active ? "true" : "false"}
                className="absolute inset-0 h-full w-full object-cover will-change-transform"
                style={{
                  opacity: ts ? ts.opacity : 0,
                  filter: activeVideo ? cssFilter(activeVideo.look) : "none",
                  // Slide offset + zoom reveal + punch-in emphasis — all shared core helpers.
                  transform: ts
                    ? `translate(${ts.translateXPct}%, ${ts.translateYPct}%) scale(${emphasisScale(activeVideo!, timeSec) * ts.scaleMul})`
                    : undefined,
                  clipPath: ts && ts.clipPath !== "none" ? ts.clipPath : undefined,
                  transformOrigin: "center",
                }}
              />
            );
          })()}

          {/* Image layers (slideshow: Ken Burns + the chosen transition type). */}
          {hasMedia &&
            activeImages.map((clip) => {
              const m = imageMotion(clip, timeSec);
              const ts = transitionStyle(clip, timeSec, doc.meta.width, doc.meta.height);
              const url = urls[clip.mediaId];
              if (!url) return null;
              return (
                <img
                  key={clip.id}
                  src={url}
                  alt=""
                  data-transition={ts.type}
                  data-transition-active={ts.active ? "true" : "false"}
                  className="absolute inset-0 h-full w-full object-cover will-change-transform"
                  style={{
                    opacity: ts.opacity,
                    filter: cssFilter(clip.look),
                    transform: `translate(${m.panXFrac * 100 + ts.translateXPct}%, ${m.panYFrac * 100 + ts.translateYPct}%) scale(${clip.transform.scale * m.scale * ts.scaleMul})`,
                    clipPath: ts.clipPath !== "none" ? ts.clipPath : undefined,
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

          {/* Text, shapes, callouts, cursors (and backgrounds above footage) — drawn by
              the SAME shared canvas code as the export, so the preview is exact. */}
          {frameW > 0 && <SyntheticLayer doc={doc} timeSec={timeSec} layer="over" width={frameW} height={frameH} />}

          {/* Audio layer — hidden <audio> per music/voice-over clip, synced to the
              transport so they're heard in the preview (not just on export). */}
          {hasMedia &&
            audioClips.map(({ clip, track }) => {
              const url = urls[clip.mediaId];
              if (!url) return null;
              return (
                <AudioClipPlayer
                  key={clip.id}
                  src={url}
                  clip={clip}
                  timeSec={timeSec}
                  playing={playing}
                  muted={muted}
                  gain={clipGainAt(doc, track, clip, timeSec)}
                />
              );
            })}

          {/* On-preview placement overlay (Walkthrough room). Only mounted while a
              gesture is armed, so it never intercepts normal preview interaction. */}
          {props.placement && props.onFinishPlacement && (
            <PlacementLayer request={props.placement} onFinish={props.onFinishPlacement} />
          )}
        </div>
      </div>

      {/* Transport */}
      <div className="flex items-center gap-3 px-4 pb-1 sm:px-6">
        <button
          type="button"
          onClick={props.onTogglePlay}
          disabled={!hasContent}
          aria-label={playing ? "Pause" : "Play"}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber text-onaccent transition hover:bg-amber-bright disabled:opacity-40"
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
          disabled={!hasContent}
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

/**
 * The placement capture overlay. It fills the composition frame exactly (the frame
 * element's box IS the rendered composition rect), so a pointer position maps to a
 * fraction as `(clientX - rect.left) / rect.width` — clamped to 0..1. Emits:
 *  - "point": one click → a single fractional point.
 *  - "path":  each click drops a waypoint (last = the click); Finish / Enter emits
 *             the ordered list, Esc / empty cancels.
 *  - "rect":  press-drag-release → a normalized rectangle (drag too small = cancel).
 */
function PlacementLayer({
  request,
  onFinish,
}: {
  request: PlacementRequest;
  onFinish: (result: PlacementResult | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [points, setPoints] = useState<{ xFrac: number; yFrac: number }[]>([]);
  const [rectDrag, setRectDrag] = useState<{ ax: number; ay: number; bx: number; by: number } | null>(null);

  const toFrac = (cx: number, cy: number): { xFrac: number; yFrac: number } => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { xFrac: 0, yFrac: 0 };
    return { xFrac: clamp01((cx - r.left) / r.width), yFrac: clamp01((cy - r.top) / r.height) };
  };

  const finishPath = () => {
    if (points.length === 0) onFinish(null);
    else onFinish({ mode: "path", points });
  };

  // Keyboard: Esc cancels any gesture; Enter finishes a path. The effect re-binds
  // every render so the closure always sees the latest `points`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onFinish(null);
      } else if (e.key === "Enter" && request.mode === "path") {
        e.preventDefault();
        finishPath();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const f = toFrac(e.clientX, e.clientY);
    if (request.mode === "point") {
      onFinish({ mode: "point", points: [f] });
    } else if (request.mode === "path") {
      setPoints((p) => [...p, f]);
    } else {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      setRectDrag({ ax: f.xFrac, ay: f.yFrac, bx: f.xFrac, by: f.yFrac });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const f = toFrac(e.clientX, e.clientY);
    setHover({ x: f.xFrac, y: f.yFrac });
    if (request.mode === "rect" && rectDrag) {
      setRectDrag((d) => (d ? { ...d, bx: f.xFrac, by: f.yFrac } : d));
    }
  };

  const onPointerUp = () => {
    if (request.mode === "rect" && rectDrag) {
      const xFrac = Math.min(rectDrag.ax, rectDrag.bx);
      const yFrac = Math.min(rectDrag.ay, rectDrag.by);
      const wFrac = Math.abs(rectDrag.bx - rectDrag.ax);
      const hFrac = Math.abs(rectDrag.by - rectDrag.ay);
      setRectDrag(null);
      if (wFrac < 0.01 || hFrac < 0.01) onFinish(null); // a stray click, not a box
      else onFinish({ mode: "rect", points: [{ xFrac, yFrac }], rect: { xFrac, yFrac, wFrac, hFrac } });
    }
  };

  const pct = (n: number): string => `${n * 100}%`;
  const liveRect =
    rectDrag && {
      left: pct(Math.min(rectDrag.ax, rectDrag.bx)),
      top: pct(Math.min(rectDrag.ay, rectDrag.by)),
      width: pct(Math.abs(rectDrag.bx - rectDrag.ax)),
      height: pct(Math.abs(rectDrag.by - rectDrag.ay)),
    };

  return (
    <div
      ref={ref}
      role="application"
      aria-label={request.hint}
      className="absolute inset-0 z-40 cursor-crosshair touch-none"
      style={{ background: "rgba(10,13,18,0.28)" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
    >
      {/* Crosshair follows the pointer (point / path modes). */}
      {hover && request.mode !== "rect" && (
        <>
          <span className="pointer-events-none absolute inset-y-0 w-px bg-amber/50" style={{ left: pct(hover.x) }} />
          <span className="pointer-events-none absolute inset-x-0 h-px bg-amber/50" style={{ top: pct(hover.y) }} />
        </>
      )}

      {/* Path waypoints + connecting line. */}
      {request.mode === "path" && points.length > 0 && (
        <>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <polyline
              points={points.map((p) => `${p.xFrac * 100},${p.yFrac * 100}`).join(" ")}
              fill="none"
              stroke="var(--color-amber)"
              strokeWidth={0.4}
              strokeDasharray="1.2 1.2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {points.map((p, i) => {
            const isClick = i === points.length - 1;
            return (
              <span
                key={i}
                className={[
                  "pointer-events-none absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[9px] font-bold text-onaccent",
                  isClick ? "h-5 w-5 bg-amber ring-2 ring-amber/40" : "h-4 w-4 bg-teal",
                ].join(" ")}
                style={{ left: pct(p.xFrac), top: pct(p.yFrac) }}
              >
                {isClick ? "◉" : i + 1}
              </span>
            );
          })}
        </>
      )}

      {/* Live rectangle (rect mode). */}
      {liveRect && (
        <span
          className="pointer-events-none absolute rounded-md border-2 border-amber bg-amber/15"
          style={liveRect}
        />
      )}

      {/* Hint + controls bar. Stops pointer events so the buttons don't add points. */}
      <div
        className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber/40 bg-panel/95 px-3 py-1.5 text-[11px] text-text shadow-lg"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <span className="text-amber">●</span>
        <span>{request.hint}</span>
        {request.mode === "path" && <span className="tabular-nums text-faint">{points.length} pt</span>}
        {request.mode === "path" && (
          <button
            type="button"
            onClick={finishPath}
            disabled={points.length === 0}
            className="rounded-full bg-amber px-2.5 py-0.5 text-[11px] font-semibold text-onaccent transition hover:bg-amber-bright disabled:opacity-40"
          >
            Finish
          </button>
        )}
        <button
          type="button"
          onClick={() => onFinish(null)}
          className="rounded-full border border-line bg-elevated px-2.5 py-0.5 text-[11px] text-muted transition hover:text-text"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
