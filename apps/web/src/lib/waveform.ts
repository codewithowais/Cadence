/**
 * Client-only audio waveform extraction for the timeline.
 *
 * Given an uploaded File or an object URL, we decode the audio track with the
 * Web Audio API and reduce it to a small array of normalized peak amplitudes
 * (one per "bucket"), suitable for drawing a thin waveform strip under the cuts.
 *
 * Pure browser code: no ffmpeg, no upload round-trip. Results are cached per
 * media id so we decode once per source, not once per render. Files with no
 * decodable audio (silent clips, images, unsupported codecs) resolve to `null`
 * so the caller can simply render nothing.
 */

/** Default number of amplitude buckets across the whole timeline width. */
const DEFAULT_BUCKETS = 600;

/** Decoded peaks per media id (`null` = decoded but no usable audio). */
const cache = new Map<string, number[] | null>();
/** In-flight decodes per media id, so concurrent callers share one decode. */
const inflight = new Map<string, Promise<number[] | null>>();

type AudioContextCtor = typeof AudioContext;

/** Resolve the (possibly prefixed) AudioContext constructor, or null on the server / unsupported. */
function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Read the raw bytes of a File or object/blob URL as an ArrayBuffer. */
async function readBytes(source: File | string): Promise<ArrayBuffer> {
  if (typeof source !== "string") return source.arrayBuffer();
  const res = await fetch(source);
  return res.arrayBuffer();
}

/**
 * Reduce a decoded AudioBuffer to `buckets` normalized peak amplitudes (0..1).
 * Uses the max absolute sample per bucket across all channels, then normalizes
 * by the global peak so quiet clips are still legible.
 */
function bucketPeaks(buffer: AudioBuffer, buckets: number): number[] {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  if (channels === 0 || length === 0) return [];

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  const peaks = new Array<number>(buckets).fill(0);
  const step = length / buckets;
  let globalMax = 0;

  for (let b = 0; b < buckets; b++) {
    const startIdx = Math.floor(b * step);
    const endIdx = Math.min(length, Math.floor((b + 1) * step));
    let max = 0;
    for (let i = startIdx; i < endIdx; i++) {
      for (let c = 0; c < channels; c++) {
        const v = Math.abs(data[c]![i]!);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
    if (max > globalMax) globalMax = max;
  }

  if (globalMax <= 0) return []; // pure silence → treat as "no audio"
  for (let b = 0; b < buckets; b++) peaks[b] = peaks[b]! / globalMax;
  return peaks;
}

/**
 * Compute (or return cached) normalized peaks for a media source.
 * Returns `null` when the source has no decodable audio, or when decoding is
 * unavailable (SSR / unsupported browser) — never throws.
 */
export async function computeWaveform(
  mediaId: string,
  source: File | string,
  buckets: number = DEFAULT_BUCKETS,
): Promise<number[] | null> {
  if (cache.has(mediaId)) return cache.get(mediaId) ?? null;
  const pending = inflight.get(mediaId);
  if (pending) return pending;

  const job = (async (): Promise<number[] | null> => {
    const Ctor = getAudioContextCtor();
    if (!Ctor) return null;
    let ctx: AudioContext | null = null;
    try {
      const bytes = await readBytes(source);
      ctx = new Ctor();
      // Some browsers only support the promise form; others the callback form.
      const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
        const p = ctx!.decodeAudioData(bytes, resolve, reject);
        if (p && typeof p.then === "function") p.then(resolve, reject);
      });
      const peaks = bucketPeaks(buffer, buckets);
      return peaks.length > 0 ? peaks : null;
    } catch {
      return null; // no audio track / unsupported codec → degrade gracefully
    } finally {
      try {
        await ctx?.close();
      } catch {
        /* already closed */
      }
    }
  })();

  inflight.set(mediaId, job);
  const result = await job;
  inflight.delete(mediaId);
  cache.set(mediaId, result);
  return result;
}

/** Clear the cached waveform for a media id (e.g. when its source is replaced). */
export function clearWaveform(mediaId: string): void {
  cache.delete(mediaId);
  inflight.delete(mediaId);
}
