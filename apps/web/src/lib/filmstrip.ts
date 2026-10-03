/**
 * Client-only filmstrip thumbnails for timeline video clips.
 *
 * One hidden, muted <video> per media is seeked (serially) to the requested
 * source times and each frame is drawn to a small canvas → JPEG data URL, cached
 * per (media, quantized time). Pure browser code: no ffmpeg, no upload. Anything
 * that can't be decoded resolves to `null` and the clip simply shows no thumbs.
 */

const THUMB_H = 54;
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const videos = new Map<string, Promise<HTMLVideoElement | null>>();
const chains = new Map<string, Promise<unknown>>();

/** Quantize a source time so neighbouring zoom levels share thumbnails. */
export function quantizeThumbTime(t: number, step: number): number {
  return Math.max(0, Math.round(t / step) * step);
}

/** The step (seconds) to quantize at for a zoom level. */
export function thumbStepFor(pxPerSec: number): number {
  return pxPerSec >= 120 ? 0.1 : pxPerSec >= 40 ? 0.25 : 0.5;
}

function loadVideo(url: string): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.crossOrigin = "anonymous";
    const timer = window.setTimeout(() => resolve(null), 8000);
    v.onloadeddata = () => {
      window.clearTimeout(timer);
      resolve(v);
    };
    v.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    v.src = url;
  });
}

function seekAndGrab(video: HTMLVideoElement, t: number): Promise<string | null> {
  return new Promise((resolve) => {
    const dur = Number.isFinite(video.duration) ? video.duration : t;
    const target = Math.max(0, Math.min(t, Math.max(0, dur - 0.05)));
    const timer = window.setTimeout(() => resolve(null), 4000);
    const grab = () => {
      window.clearTimeout(timer);
      try {
        const aspect = (video.videoWidth || 16) / (video.videoHeight || 9);
        const c = document.createElement("canvas");
        c.height = THUMB_H;
        c.width = Math.max(1, Math.round(THUMB_H * aspect));
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(video, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.6));
      } catch {
        resolve(null);
      }
    };
    if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= 2) return grab();
    video.onseeked = grab;
    video.currentTime = target;
  });
}

/** A cached thumbnail for `(mediaId, quantizedTime)` if one has already been made. */
export function cachedThumb(mediaId: string, t: number): string | null | undefined {
  return cache.get(`${mediaId}@${t.toFixed(3)}`);
}

/**
 * Request one thumbnail (source seconds `t`, already quantized). Concurrent calls
 * share work; seeks for one media run strictly one at a time.
 */
export function requestThumb(mediaId: string, url: string, t: number): Promise<string | null> {
  const key = `${mediaId}@${t.toFixed(3)}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const pending = inflight.get(key);
  if (pending) return pending;
  let vp = videos.get(mediaId);
  if (!vp) {
    vp = loadVideo(url);
    videos.set(mediaId, vp);
  }
  const prev = chains.get(mediaId) ?? Promise.resolve();
  const job = prev
    .catch(() => undefined)
    .then(async () => {
      const v = await vp!;
      if (!v) return null;
      return seekAndGrab(v, t);
    })
    .then((res) => {
      cache.set(key, res);
      inflight.delete(key);
      return res;
    });
  inflight.set(key, job);
  chains.set(mediaId, job);
  return job;
}

/** Forget a media's decoder + thumbs (its source was replaced / removed). */
export function clearFilmstrip(mediaId: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${mediaId}@`)) cache.delete(k);
  videos.delete(mediaId);
  chains.delete(mediaId);
}
