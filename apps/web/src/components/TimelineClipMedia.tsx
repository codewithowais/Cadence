"use client";

/**
 * What a timeline clip shows INSIDE its box: a filmstrip of real frames for
 * video / image clips and a per-clip waveform for audio clips. Both are lazy —
 * only the part of the clip inside the scroll viewport is rendered, thumbnails
 * are generated once per (media, time) and cached, and every failure (no
 * decodable audio, a cross-origin canvas, an unsupported codec) just renders
 * nothing so the plain coloured clip underneath still works.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { quantizeThumbTime, requestThumb, thumbStepFor, cachedThumb } from "@/lib/filmstrip";
import { computeWaveform } from "@/lib/waveform";

/** One thumbnail tile at source time `t` (video) or the still itself (image). */
function Tile({ mediaId, url, t, left, width, still }: { mediaId: string; url: string; t: number; left: number; width: number; still: boolean }) {
  const [src, setSrc] = useState<string | null>(() => (still ? url : cachedThumb(mediaId, t) ?? null));
  useEffect(() => {
    if (still) {
      setSrc(url);
      return;
    }
    const hit = cachedThumb(mediaId, t);
    if (hit !== undefined) {
      setSrc(hit);
      return;
    }
    let alive = true;
    void requestThumb(mediaId, url, t).then((r) => {
      if (alive) setSrc(r);
    });
    return () => {
      alive = false;
    };
  }, [mediaId, url, t, still]);
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      draggable={false}
      className="pointer-events-none absolute top-0 h-full select-none object-cover opacity-80"
      style={{ left, width }}
    />
  );
}

export interface FilmstripProps {
  mediaId: string;
  url: string;
  /** The clip's on-screen width (px) and height (px). */
  widthPx: number;
  heightPx: number;
  pxPerSec: number;
  sourceIn: number;
  speed: number;
  /** Image clips repeat the still instead of seeking. */
  still: boolean;
  /** Visible slice of the clip, in px from the clip's left edge. */
  viewFrom: number;
  viewTo: number;
  /** A freeze-frame clip shows one frame everywhere. */
  freezeAtSec?: number;
}

/** Filmstrip tiles for the visible part of a video / image clip. */
export const Filmstrip = memo(function Filmstrip(p: FilmstripProps) {
  const tileW = Math.max(36, Math.round((p.heightPx * 16) / 9));
  const step = thumbStepFor(p.pxPerSec);
  const tiles = useMemo(() => {
    if (p.widthPx < 24) return [];
    const first = Math.max(0, Math.floor(p.viewFrom / tileW));
    const last = Math.min(Math.ceil(p.widthPx / tileW) - 1, Math.floor(p.viewTo / tileW));
    const out: { i: number; t: number }[] = [];
    for (let i = first; i <= last && out.length < 60; i++) {
      const local = ((i + 0.5) * tileW) / Math.max(1e-6, p.pxPerSec);
      const t = p.freezeAtSec != null ? p.freezeAtSec : p.sourceIn + local * p.speed;
      out.push({ i, t: quantizeThumbTime(t, step) });
    }
    return out;
  }, [p.widthPx, p.viewFrom, p.viewTo, tileW, p.pxPerSec, p.sourceIn, p.speed, p.freezeAtSec, step]);
  return (
    <span aria-hidden data-testid="filmstrip" className="pointer-events-none absolute inset-0 overflow-hidden">
      {tiles.map(({ i, t }) => (
        <Tile key={i} mediaId={p.mediaId} url={p.url} t={t} left={i * tileW} width={tileW} still={p.still} />
      ))}
    </span>
  );
});

/** Decoded peaks for a media (shared cache with the base waveform), or null. */
function usePeaks(mediaId: string, url: string | undefined): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (!url) {
      setPeaks(null);
      return;
    }
    let alive = true;
    void computeWaveform(mediaId, url)
      .then((r) => alive && setPeaks(r))
      .catch(() => alive && setPeaks(null));
    return () => {
      alive = false;
    };
  }, [mediaId, url]);
  return peaks;
}

export interface ClipWaveformProps {
  mediaId: string;
  url?: string;
  /** Source window the clip shows. */
  sourceIn: number;
  sourceSpan: number;
  /** Total length of the media (s); peaks cover [0, mediaDur]. */
  mediaDur?: number;
}

/** A waveform for ONE audio clip: just the slice of the media's peaks it plays. */
export const ClipWaveform = memo(function ClipWaveform({ mediaId, url, sourceIn, sourceSpan, mediaDur }: ClipWaveformProps) {
  const peaks = usePeaks(mediaId, url);
  const d = useMemo(() => {
    if (!peaks || peaks.length === 0) return "";
    const dur = mediaDur && mediaDur > 0 ? mediaDur : sourceIn + sourceSpan;
    const n = peaks.length;
    const a = Math.max(0, Math.min(n - 1, Math.floor((sourceIn / dur) * n)));
    const b = Math.max(a + 1, Math.min(n, Math.ceil(((sourceIn + sourceSpan) / dur) * n)));
    const slice = peaks.slice(a, b);
    const W = 1000;
    const H = 100;
    const cx = W / slice.length;
    const cy = H / 2;
    const top: string[] = [];
    const bottom: string[] = [];
    slice.forEach((v, i) => {
      const amp = Math.max(0.03, v);
      top.push(`${(i * cx).toFixed(1)},${(cy - amp * cy).toFixed(1)}`);
      bottom.push(`${(i * cx).toFixed(1)},${(cy + amp * cy).toFixed(1)}`);
    });
    return `M${top.join("L")}L${bottom.reverse().join("L")}Z`;
  }, [peaks, sourceIn, sourceSpan, mediaDur]);
  if (!d) return null;
  return (
    <svg aria-hidden data-testid="clip-waveform" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 100" preserveAspectRatio="none" focusable="false">
      <path d={d} className="fill-current opacity-60" />
    </svg>
  );
});
