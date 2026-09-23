/**
 * Client-only, dependency-free BEAT DETECTION for the timeline.
 *
 * Reuses the same Web Audio decode path as the waveform strip (`decodeAudio`),
 * then runs a simple energy-based onset detector focused on the LOW band (kick /
 * bass, which carries the pulse in most music):
 *
 *   1. down-mix to mono;
 *   2. one-pole low-pass (~200 Hz) to emphasize the low band;
 *   3. short-time energy in ~10 ms frames;
 *   4. an onset "novelty" envelope = half-wave-rectified difference of the
 *      log-energy (log domain so a loud chorus doesn't drown a quiet verse);
 *   5. adaptive peak-picking (local mean + k·std threshold) with a minimum
 *      inter-onset interval so a single hit isn't counted twice.
 *
 * A rough BPM is estimated from the median inter-onset interval (folded into a
 * musical 70–180 range) purely for an honest read-out.
 *
 * This is an ESTIMATE — it finds transients, not a perfect musical grid. The UI
 * says so, and the detected beats land as ordinary, editable timeline markers.
 */
import type { EditDoc } from "@cadence/core";
import { generatedMusicOf, musicBeatTimes } from "@cadence/director";
import { decodeAudio } from "./waveform";

const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface BeatResult {
  /** Detected beat times in seconds, ascending. */
  times: number[];
  /** Rough tempo estimate (BPM), or `null` when too few beats to estimate. */
  bpm: number | null;
}

/** Decoded results cached per media id, so we analyze a source once. */
const cache = new Map<string, BeatResult>();

/** Never drop more than this many markers onto the timeline from one detection. */
const MAX_BEATS = 500;

/**
 * Detect beats in a media source (File or object/blob URL). `limitSec` clamps
 * results to the timeline length. Returns `null` when the source has no
 * decodable audio or decoding is unavailable. Never throws.
 */
export async function detectBeats(
  mediaId: string,
  source: File | string,
  limitSec?: number,
): Promise<BeatResult | null> {
  const cached = cache.get(mediaId);
  if (cached) return clampResult(cached, limitSec);
  const buffer = await decodeAudio(source);
  if (!buffer) return null;
  const result = analyze(buffer);
  cache.set(mediaId, result);
  return clampResult(result, limitSec);
}

/**
 * EXACT beats for GENERATED music: the bed was composed on a known tempo grid, so
 * there's nothing to estimate — return that grid (timeline seconds) + the true
 * BPM. `null` when the doc's music isn't generated (fall back to `detectBeats`).
 */
export function generatedBeats(doc: EditDoc, limitSec?: number): BeatResult | null {
  const g = generatedMusicOf(doc);
  if (!g) return null;
  const times = musicBeatTimes(doc);
  if (times.length === 0) return null;
  return clampResult({ times, bpm: Math.round(g.arrangement.bpm) }, limitSec);
}

/** Clear the cached beats for a media id (e.g. when its source is replaced). */
export function clearBeats(mediaId: string): void {
  cache.delete(mediaId);
}

function clampResult(result: BeatResult, limitSec?: number): BeatResult {
  let times = result.times;
  if (limitSec != null) times = times.filter((t) => t <= limitSec + 1e-3);
  if (times.length > MAX_BEATS) times = times.slice(0, MAX_BEATS);
  return { times, bpm: result.bpm };
}

function analyze(buffer: AudioBuffer): BeatResult {
  const sr = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const len = buffer.length;
  if (sr <= 0 || channels === 0 || len === 0) return { times: [], bpm: null };

  // 1. down-mix to mono.
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += data[c]![i]!;
    mono[i] = s / channels;
  }

  // 2. one-pole low-pass (~200 Hz) to emphasize the low (kick/bass) band.
  const fc = 200;
  const rc = 1 / (2 * Math.PI * fc);
  const dt = 1 / sr;
  const a = dt / (rc + dt);
  let lp = 0;
  const low = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    lp = lp + a * (mono[i]! - lp);
    low[i] = lp;
  }

  // 3. short-time energy in ~10 ms frames (window = 2 hops).
  const hop = Math.max(1, Math.floor(sr * 0.01));
  const win = hop * 2;
  const nFrames = Math.floor((len - win) / hop) + 1;
  if (nFrames <= 4) return { times: [], bpm: null };
  const energy = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    let e = 0;
    const end = Math.min(len, start + win);
    for (let i = start; i < end; i++) {
      const v = low[i]!;
      e += v * v;
    }
    energy[f] = e;
  }

  // 4. onset novelty = half-wave-rectified difference of the log-energy.
  const onset = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    const d = Math.log1p(energy[f]!) - Math.log1p(energy[f - 1]!);
    onset[f] = d > 0 ? d : 0;
  }

  // 5. adaptive peak-picking.
  const frameSec = hop / sr;
  const minGap = Math.max(1, Math.round(0.18 / frameSec)); // ≥ ~330 BPM guard
  const w = Math.max(3, Math.round(0.3 / frameSec)); // ~300 ms local window
  const times: number[] = [];
  let lastPeak = -Infinity;
  for (let f = 1; f < nFrames - 1; f++) {
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    const lo = Math.max(0, f - w);
    const hi = Math.min(nFrames - 1, f + w);
    for (let j = lo; j <= hi; j++) {
      const v = onset[j]!;
      sum += v;
      sum2 += v * v;
      n++;
    }
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const thresh = mean + 1.3 * std + 1e-6;
    const v = onset[f]!;
    if (v > thresh && v >= onset[f - 1]! && v >= onset[f + 1]! && f - lastPeak >= minGap) {
      times.push(round(f * frameSec));
      lastPeak = f;
    }
  }

  return { times, bpm: estimateBpm(times) };
}

/** Fold the median inter-onset interval into a musical 70–180 BPM read-out. */
function estimateBpm(times: number[]): number | null {
  if (times.length < 4) return null;
  const iois: number[] = [];
  for (let i = 1; i < times.length; i++) iois.push(times[i]! - times[i - 1]!);
  iois.sort((x, y) => x - y);
  const med = iois[Math.floor(iois.length / 2)]!;
  if (!(med > 0)) return null;
  let bpm = 60 / med;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}
