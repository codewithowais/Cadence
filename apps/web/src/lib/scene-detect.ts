/**
 * Client-side SCENE DETECTION for a finished video — free, nothing to install.
 *
 * A hidden <video> is seeked through ~4 samples per second (never more than
 * `maxSamples`, so a 2-hour file just samples more sparsely), each frame is
 * drawn into a tiny canvas and reduced to a colour-histogram + luma-grid
 * signature by the PURE scorer in `@cadence/understanding/scenes` (unit-tested in
 * tests/scene-split.test.ts). The expensive part (the scan) is done ONCE per
 * media and cached; moving the sensitivity / min-shot sliders only re-runs the
 * cheap threshold step, so previews update instantly.
 *
 * It never blocks the UI: every sample awaits a `seeked` event (a macrotask), the
 * scan is cancellable, and progress is reported per sample.
 *
 * Boundaries are then REFINED: around each coarse cut we sample densely inside
 * the sample gap (a few rounds of 8 frames) to land within ~0.1s of the true cut.
 */
import {
  detectCutsFromScores,
  frameSignature,
  refineCut,
  samplePlan,
  scoreSeries,
  type CutPoint,
  type FrameSignature,
} from "@cadence/understanding/scenes";

/** Width × height of the analysis canvas — tiny on purpose (histograms don't need pixels). */
const AW = 64;
const AH = 36;

export interface SceneScan {
  mediaId: string;
  durationSec: number;
  /** Sample times (source seconds), ascending. */
  times: number[];
  /** `scores[i]` = distance of sample i from sample i-1 (0..1). */
  scores: number[];
}

export interface ScanOptions {
  fps?: number;
  maxSamples?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Signatures kept alongside each scan so refinement can reuse the open video. */
const scanCache = new Map<string, SceneScan>();
const refineCache = new Map<string, number>();

export function getCachedScan(mediaId: string): SceneScan | undefined {
  return scanCache.get(mediaId);
}

export function clearSceneScan(mediaId: string): void {
  scanCache.delete(mediaId);
  for (const k of [...refineCache.keys()]) if (k.startsWith(`${mediaId}:`)) refineCache.delete(k);
}

/** A hidden, muted <video> ready to be seeked (resolves once a frame is decodable). */
async function openVideo(url: string): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  v.src = url;
  await new Promise<void>((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(new Error("This video couldn't be decoded in the browser for scene detection."));
    };
    const cleanup = () => {
      v.removeEventListener("loadeddata", ok);
      v.removeEventListener("error", bad);
    };
    if (v.readyState >= 2) return ok();
    v.addEventListener("loadeddata", ok);
    v.addEventListener("error", bad);
    v.load();
  });
  return v;
}

/** Seek and wait for the frame (with a safety timeout so one bad seek can't hang the scan). */
function seek(v: HTMLVideoElement, t: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2) return resolve();
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      v.removeEventListener("seeked", fin);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(fin, timeoutMs);
    v.addEventListener("seeked", fin);
    v.currentTime = t;
  });
}

function makeAnalysisCanvas(): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = AW;
  c.height = AH;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas isn't available for scene detection.");
  return ctx;
}

function sample(ctx: CanvasRenderingContext2D, v: HTMLVideoElement): FrameSignature {
  ctx.drawImage(v, 0, 0, AW, AH);
  const px = ctx.getImageData(0, 0, AW, AH).data;
  return frameSignature(px, AW, AH);
}

const aborted = () => new DOMException("Scene detection cancelled", "AbortError");

/**
 * Scan a video (object/blob URL) and cache the score series under `mediaId`.
 * Resolves with the scan; rejects with an AbortError if cancelled.
 */
export async function scanVideoScenes(
  mediaId: string,
  url: string,
  durationSec: number,
  opts: ScanOptions = {},
): Promise<SceneScan> {
  const cached = scanCache.get(mediaId);
  if (cached) return cached;
  const times = samplePlan(durationSec, { fps: opts.fps ?? 4, maxSamples: opts.maxSamples ?? 900 });
  if (times.length < 2) throw new Error("That video is too short to divide into scenes.");
  const video = await openVideo(url);
  const ctx = makeAnalysisCanvas();
  const sigs: FrameSignature[] = [];
  try {
    for (let i = 0; i < times.length; i++) {
      if (opts.signal?.aborted) throw aborted();
      await seek(video, times[i]!);
      sigs.push(sample(ctx, video));
      opts.onProgress?.(i + 1, times.length);
    }
  } finally {
    video.removeAttribute("src");
    video.load();
  }
  const scan: SceneScan = { mediaId, durationSec, times, scores: scoreSeries(sigs) };
  scanCache.set(mediaId, scan);
  return scan;
}

/** Cheap: apply sensitivity + min shot to a cached scan (coarse cut times, source seconds). */
export function cutsFromScan(scan: SceneScan, sensitivity: number, minShotSec: number): CutPoint[] {
  return detectCutsFromScores(scan.times, scan.scores, scan.durationSec, { sensitivity, minShotSec });
}

/**
 * Pin each coarse cut to the true boundary: densely sample inside the gap before
 * it (3 rounds of 8 sub-steps) and take the largest jump. Cached per cut.
 */
export async function refineCuts(
  scan: SceneScan,
  url: string,
  cuts: readonly CutPoint[],
  signal?: AbortSignal,
): Promise<number[]> {
  const out: number[] = [];
  const todo = cuts.filter((c) => !refineCache.has(`${scan.mediaId}:${c.t}`));
  if (todo.length > 0) {
    const video = await openVideo(url);
    const ctx = makeAnalysisCanvas();
    try {
      for (const c of todo) {
        if (signal?.aborted) throw aborted();
        const idx = scan.times.indexOf(c.t);
        let lo = idx > 0 ? scan.times[idx - 1]! : Math.max(0, c.t - 0.5);
        let hi = c.t;
        let best = c.t;
        for (let round = 0; round < 3 && hi - lo > 0.04; round++) {
          const ts = Array.from({ length: 9 }, (_, k) => lo + ((hi - lo) * k) / 8);
          const sigs: FrameSignature[] = [];
          for (const t of ts) {
            await seek(video, t);
            sigs.push(sample(ctx, video));
          }
          best = refineCut(ts, sigs, hi);
          const at = ts.indexOf(best);
          if (at <= 0) break;
          lo = ts[at - 1]!;
          hi = ts[at]!;
        }
        refineCache.set(`${scan.mediaId}:${c.t}`, Math.round(best * 1000) / 1000);
      }
    } finally {
      video.removeAttribute("src");
      video.load();
    }
  }
  for (const c of cuts) out.push(refineCache.get(`${scan.mediaId}:${c.t}`) ?? c.t);
  return out;
}

/**
 * Small JPEG thumbnails (data URLs) for a list of source times — one decode pass.
 * Best-effort: resolves "" for any frame that can't be drawn.
 */
export async function captureThumbs(url: string, times: readonly number[], signal?: AbortSignal): Promise<string[]> {
  if (times.length === 0) return [];
  const video = await openVideo(url);
  const c = document.createElement("canvas");
  c.width = 120;
  c.height = 68;
  const ctx = c.getContext("2d");
  const out: string[] = [];
  try {
    for (const t of times) {
      if (signal?.aborted) throw aborted();
      try {
        await seek(video, t);
        ctx?.drawImage(video, 0, 0, c.width, c.height);
        out.push(c.toDataURL("image/jpeg", 0.6));
      } catch {
        out.push("");
      }
    }
  } finally {
    video.removeAttribute("src");
    video.load();
  }
  return out;
}

// ---- server (ffmpeg) upgrade path ------------------------------------------------

/** Is server-side ffmpeg scene detection available? Never throws. */
export async function serverSceneSupport(): Promise<boolean> {
  try {
    const res = await fetch("/api/scenes", { cache: "no-store" });
    if (!res.ok) return false;
    const j = (await res.json()) as { ffmpeg?: boolean };
    return j.ffmpeg === true;
  } catch {
    return false;
  }
}

/** Run ffmpeg scene detection on an already-uploaded server path. `null` when unavailable. */
export async function detectScenesServer(path: string, sensitivity: number): Promise<number[] | null> {
  try {
    const res = await fetch("/api/scenes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ src: path, sensitivity }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { cuts?: number[] };
    return Array.isArray(j.cuts) ? j.cuts : null;
  } catch {
    return null;
  }
}
