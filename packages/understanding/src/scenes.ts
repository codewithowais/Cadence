/**
 * SCENE / SHOT SPLITTING — pure, dependency-free, environment-agnostic.
 *
 * "Already-built video → divided into clips": given a finished video, find where
 * it should be cut so each part becomes its own editable clip. This module holds
 * ONLY pure math (no DOM, no node, no ffmpeg), so the SAME scoring runs in the
 * browser (frames sampled from <video> → canvas), in Node tests and in evals:
 *
 *   frameSignature()      downscaled RGBA → colour histogram + coarse luma grid
 *   signatureDistance()   0..1 dissimilarity between two signatures
 *   detectCutsFromScores() adaptive threshold + peak NMS + min shot length
 *   refineCut()           sub-sample the exact boundary inside one sample gap
 *
 * plus the non-visual split strategies (transcript sentences, silence gaps,
 * beats, fixed interval) and `planSourceSplit`, the one entry point the Director
 * tool and the web UI share. Every function returns SOURCE-media seconds.
 *
 * Honest limits: this finds HARD cuts and fast changes. Slow dissolves/fades and
 * scenes that differ only by motion are under-detected — raise sensitivity, or
 * use the sentence/interval strategies.
 */
import type { Transcript } from "./transcript";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export type SplitMethod = "scenes" | "sentences" | "silence" | "beats" | "interval";
export const SPLIT_METHODS: readonly SplitMethod[] = ["scenes", "sentences", "silence", "beats", "interval"];

/** One resulting piece of the source, in source seconds. */
export interface Shot {
  index: number;
  start: number;
  end: number;
  label: string;
}

// ---- frame signatures -------------------------------------------------------

/** Histogram bins per channel. */
export const HIST_BINS = 16;
/** Luma grid is GRID × GRID cells. */
export const GRID = 6;

export interface FrameSignature {
  /** 3 × HIST_BINS normalised (sum 1 per channel) R,G,B histograms. */
  hist: Float32Array;
  /** GRID × GRID mean luma, 0..1 (coarse spatial layout). */
  grid: Float32Array;
}

/**
 * Signature of one (already downscaled) RGBA frame. The caller downsizes — a
 * 64×36 canvas is plenty; this cost is O(pixels).
 */
export function frameSignature(rgba: ArrayLike<number>, width: number, height: number): FrameSignature {
  const hist = new Float32Array(3 * HIST_BINS);
  const gridSum = new Float32Array(GRID * GRID);
  const gridN = new Float32Array(GRID * GRID);
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const px = w * h;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(GRID - 1, Math.floor((y / h) * GRID));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      hist[Math.min(HIST_BINS - 1, (r * HIST_BINS) >> 8)]!++;
      hist[HIST_BINS + Math.min(HIST_BINS - 1, (g * HIST_BINS) >> 8)]!++;
      hist[2 * HIST_BINS + Math.min(HIST_BINS - 1, (b * HIST_BINS) >> 8)]!++;
      const gx = Math.min(GRID - 1, Math.floor((x / w) * GRID));
      const cell = gy * GRID + gx;
      gridSum[cell]! += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      gridN[cell]!++;
    }
  }
  for (let i = 0; i < hist.length; i++) hist[i]! /= px;
  const grid = new Float32Array(GRID * GRID);
  for (let i = 0; i < grid.length; i++) grid[i] = gridN[i]! > 0 ? gridSum[i]! / gridN[i]! : 0;
  return { hist, grid };
}

/**
 * 0..1 dissimilarity of two signatures: the larger of the colour-histogram
 * distance (half-L1 per channel, averaged — 1 means disjoint palettes) and the
 * luma-layout distance (mean |Δ| over the grid, boosted ×1.5 since real cuts
 * rarely flip every cell). Identical frames → 0; unrelated frames → near 1.
 */
export function signatureDistance(a: FrameSignature, b: FrameSignature): number {
  let h = 0;
  for (let i = 0; i < a.hist.length; i++) h += Math.abs(a.hist[i]! - b.hist[i]!);
  h = h / 2 / 3; // 3 channels, each half-L1 in 0..1
  let g = 0;
  for (let i = 0; i < a.grid.length; i++) g += Math.abs(a.grid[i]! - b.grid[i]!);
  g = (g / a.grid.length) * 1.5;
  return clamp(Math.max(h, g), 0, 1);
}

/** Distances between consecutive signatures: out[0] = 0, out[i] = d(sig[i-1], sig[i]). */
export function scoreSeries(sigs: readonly FrameSignature[]): number[] {
  const out = new Array<number>(sigs.length).fill(0);
  for (let i = 1; i < sigs.length; i++) out[i] = signatureDistance(sigs[i - 1]!, sigs[i]!);
  return out;
}

// ---- adaptive cut detection --------------------------------------------------

export interface DetectOptions {
  /** 0..1 — higher finds MORE cuts (default 0.5). */
  sensitivity?: number;
  /** Shortest allowed shot, seconds (default 1). */
  minShotSec?: number;
}

export interface CutPoint {
  /** Source seconds of the first frame of the NEW shot. */
  t: number;
  /** The distance score that produced it (0..1). */
  score: number;
}

/** Sensitivity → { absolute floor, MAD multiplier }. Monotonic: more sensitive ⇒ lower both. */
export function sensitivityParams(sensitivity: number): { absMin: number; k: number } {
  const s = clamp(Number.isFinite(sensitivity) ? sensitivity : 0.5, 0, 1);
  return { absMin: 0.1 + (1 - s) * 0.28, k: 7 - 4.5 * s };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/**
 * Pick the cut points out of a score series sampled at `times` (ascending,
 * `scores[i]` is the change INTO sample i).
 *
 * A sample is a candidate when its score beats BOTH an absolute floor and a
 * LOCAL adaptive threshold (median + k·robust-spread of the surrounding window),
 * so a busy handheld scene doesn't fire constantly while a calm one still
 * registers a real cut. Candidates are then non-max-suppressed by `minShotSec`
 * (the strongest wins, so two hits on one flash collapse to one cut) and kept
 * clear of the start/end of the media. Deterministic. Ascending output.
 */
export function detectCutsFromScores(
  times: readonly number[],
  scores: readonly number[],
  durationSec: number,
  opts: DetectOptions = {},
): CutPoint[] {
  const n = Math.min(times.length, scores.length);
  if (n < 2) return [];
  const minShot = Math.max(0.1, opts.minShotSec ?? 1);
  const { absMin, k } = sensitivityParams(opts.sensitivity ?? 0.5);
  const W = 12;
  const candidates: CutPoint[] = [];
  for (let i = 1; i < n; i++) {
    const s = scores[i]!;
    if (s < absMin) continue;
    const lo = Math.max(1, i - W);
    const hi = Math.min(n - 1, i + W);
    const win: number[] = [];
    for (let j = lo; j <= hi; j++) if (j !== i) win.push(scores[j]!);
    const med = median(win);
    const mad = Math.max(0.02, 1.4826 * median(win.map((v) => Math.abs(v - med))));
    if (s < med + k * mad) continue;
    // Must be a local maximum against its direct neighbours (a cut is one spike).
    if (s < (scores[i - 1] ?? 0) || s < (scores[i + 1] ?? 0)) continue;
    candidates.push({ t: round(times[i]!), score: round(s) });
  }
  return suppressCuts(candidates, durationSec, minShot);
}

/** Strongest-first non-max suppression by `minShotSec`, clear of both media ends. */
function suppressCuts(cands: CutPoint[], durationSec: number, minShot: number): CutPoint[] {
  const ranked = [...cands].sort((a, b) => b.score - a.score || a.t - b.t);
  const kept: CutPoint[] = [];
  for (const c of ranked) {
    if (c.t < minShot - 1e-6) continue;
    if (durationSec > 0 && durationSec - c.t < minShot - 1e-6) continue;
    if (kept.some((k) => Math.abs(k.t - c.t) < minShot - 1e-6)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.t - b.t);
}

/**
 * Locate the exact boundary inside one sample gap. `fine` is signatures sampled
 * densely over [t0, t1] (inclusive of both ends, ascending `times`); returns the
 * time of the adjacent pair with the largest distance. Falls back to `t1`.
 */
export function refineCut(times: readonly number[], sigs: readonly FrameSignature[], fallback: number): number {
  let best = -1;
  let at = fallback;
  for (let i = 1; i < Math.min(times.length, sigs.length); i++) {
    const d = signatureDistance(sigs[i - 1]!, sigs[i]!);
    if (d > best) {
      best = d;
      at = times[i]!;
    }
  }
  return round(at);
}

// ---- cut lists → shots -------------------------------------------------------

/** Sort, round, de-duplicate and drop cuts closer than `minShotSec` to each other or the ends. */
export function normalizeCuts(cuts: readonly number[], durationSec: number, minShotSec = 0.5): number[] {
  const min = Math.max(0.05, minShotSec);
  const sorted = [...new Set(cuts.filter((c) => Number.isFinite(c)).map(round))].sort((a, b) => a - b);
  const out: number[] = [];
  let prev = 0;
  for (const c of sorted) {
    if (c - prev < min - 1e-6) continue;
    if (durationSec > 0 && durationSec - c < min - 1e-6) continue;
    out.push(c);
    prev = c;
  }
  return out;
}

/** The pieces a cut list divides [0, durationSec] into, with labels (`labels[i]` for piece i). */
export function cutsToShots(
  cuts: readonly number[],
  durationSec: number,
  opts: { labels?: readonly string[]; labelPrefix?: string } = {},
): Shot[] {
  const bounds = [0, ...cuts, durationSec];
  const prefix = opts.labelPrefix ?? "Scene";
  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    shots.push({
      index: i,
      start: round(bounds[i]!),
      end: round(bounds[i + 1]!),
      label: opts.labels?.[i] ?? `${prefix} ${i + 1}`,
    });
  }
  return shots;
}

// ---- other strategies --------------------------------------------------------

const words = (text: string, n: number): string => {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const head = parts.slice(0, n).join(" ");
  return parts.length > n ? `${head}…` : head;
};

/**
 * Cut at every transcript segment (sentence) boundary. The cut sits just before
 * the next sentence's first word (never clipping it), and each piece is labelled
 * with its opening words. Sentences shorter than `minShotSec` are merged forward.
 */
export function sentenceCuts(
  transcript: Transcript,
  durationSec: number,
  opts: { minShotSec?: number } = {},
): { cuts: number[]; labels: string[] } {
  const min = Math.max(0.1, opts.minShotSec ?? 1);
  const segs = [...transcript.segments].sort((a, b) => a.start - b.start);
  const cuts: number[] = [];
  const labels: string[] = [];
  let pieceStart = 0;
  let pieceText = segs[0]?.text ?? "";
  let first = true;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (first) {
      pieceText = seg.text;
      first = false;
      continue;
    }
    const prev = segs[i - 1]!;
    const gap = Math.max(0, seg.start - prev.end);
    const cut = round(seg.start - Math.min(gap / 2, 0.15));
    if (cut - pieceStart < min - 1e-6 || (durationSec > 0 && durationSec - cut < min - 1e-6)) {
      pieceText = `${pieceText} ${seg.text}`; // too short: merge into the running piece
      continue;
    }
    labels.push(words(pieceText, 5));
    cuts.push(cut);
    pieceStart = cut;
    pieceText = seg.text;
  }
  if (segs.length > 0) labels.push(words(pieceText, 5));
  return { cuts, labels };
}

/**
 * Cut in the middle of every silence of at least `minGapSec` between spoken
 * words (falls back to segment gaps when the transcript has no word timings).
 */
export function silenceCuts(
  transcript: Transcript,
  durationSec: number,
  opts: { minGapSec?: number; minShotSec?: number } = {},
): number[] {
  const minGap = Math.max(0.1, opts.minGapSec ?? 0.7);
  const items =
    transcript.words.length > 1
      ? transcript.words
      : transcript.segments.map((s) => ({ start: s.start, end: s.end }));
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const cuts: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.start - sorted[i - 1]!.end;
    if (gap >= minGap) cuts.push((sorted[i]!.start + sorted[i - 1]!.end) / 2);
  }
  return normalizeCuts(cuts, durationSec, opts.minShotSec ?? 1);
}

/** Cut on every `every`-th beat (1 = every beat, 4 = every bar of 4/4). */
export function beatCuts(
  beats: readonly number[],
  durationSec: number,
  opts: { every?: number; minShotSec?: number } = {},
): number[] {
  const every = Math.max(1, Math.round(opts.every ?? 1));
  const sorted = [...beats].sort((a, b) => a - b);
  const picked = sorted.filter((_, i) => i % every === every - 1 || every === 1);
  return normalizeCuts(picked, durationSec, opts.minShotSec ?? 0.5);
}

/** Cut every `everySec` seconds ("chop every 5 seconds"). */
export function intervalCuts(durationSec: number, everySec: number, opts: { minShotSec?: number } = {}): number[] {
  const step = Math.max(0.1, everySec);
  const cuts: number[] = [];
  for (let t = step; t < durationSec - 1e-6; t += step) cuts.push(round(t));
  return normalizeCuts(cuts, durationSec, Math.min(opts.minShotSec ?? 0.5, step));
}

// ---- the shared planner -------------------------------------------------------

export interface SplitPlanInput {
  method: SplitMethod;
  durationSec: number;
  /** 0..1; scenes: detection sensitivity · silence: shorter gaps count when higher. */
  sensitivity?: number;
  minShotSec?: number;
  /** interval: seconds between cuts · beats: cut on every N-th beat. */
  every?: number;
  /** scenes: cut points already detected (browser frames / ffmpeg). */
  sceneCuts?: readonly number[];
  transcript?: Transcript;
  beats?: readonly number[];
}

export interface SplitPlan {
  method: SplitMethod;
  /** Source seconds, ascending, clear of both ends. */
  cuts: number[];
  shots: Shot[];
}

/** Thrown when a method lacks the analysis it needs (message is user-facing). */
export class SplitPlanError extends Error {}

const PREFIX: Record<SplitMethod, string> = {
  scenes: "Scene",
  sentences: "Sentence",
  silence: "Part",
  beats: "Beat",
  interval: "Part",
};

/** Turn a method + its analysis into cut points and labelled shots. Pure. */
export function planSourceSplit(input: SplitPlanInput): SplitPlan {
  const { method, durationSec } = input;
  const minShot = Math.max(0.1, input.minShotSec ?? (method === "interval" || method === "beats" ? 0.5 : 1));
  let cuts: number[] = [];
  let labels: string[] | undefined;
  switch (method) {
    case "scenes": {
      if (!input.sceneCuts) {
        throw new SplitPlanError(
          "I need to look at the frames first — open the Media room, tap “Divide into scenes”, then ask again.",
        );
      }
      cuts = normalizeCuts(input.sceneCuts, durationSec, minShot);
      break;
    }
    case "sentences": {
      if (!input.transcript) throw new SplitPlanError("There's no transcript yet to split by sentence.");
      const r = sentenceCuts(input.transcript, durationSec, { minShotSec: minShot });
      cuts = r.cuts;
      labels = r.labels;
      break;
    }
    case "silence": {
      if (!input.transcript) throw new SplitPlanError("There's no transcript yet to find the silences.");
      const s = clamp(input.sensitivity ?? 0.5, 0, 1);
      cuts = silenceCuts(input.transcript, durationSec, { minGapSec: 1.4 - s * 1.1, minShotSec: minShot });
      break;
    }
    case "beats": {
      if (!input.beats || input.beats.length === 0) throw new SplitPlanError("No beats found — detect beats first.");
      cuts = beatCuts(input.beats, durationSec, { every: input.every, minShotSec: minShot });
      break;
    }
    case "interval": {
      if (!(input.every && input.every > 0)) throw new SplitPlanError("Tell me how often to cut, e.g. “every 5 seconds”.");
      cuts = intervalCuts(durationSec, input.every, { minShotSec: minShot });
      break;
    }
  }
  return { method, cuts, shots: cutsToShots(cuts, durationSec, { labels, labelPrefix: PREFIX[method] }) };
}

// ---- fixed sample plan --------------------------------------------------------

/**
 * Sample times for scanning a video: ~`fps` samples per second, but never more
 * than `maxSamples` so a 2-hour file stays bounded (the rate drops instead).
 */
export function samplePlan(durationSec: number, opts: { fps?: number; maxSamples?: number } = {}): number[] {
  const fps = opts.fps ?? 4;
  const max = opts.maxSamples ?? 900;
  if (!(durationSec > 0)) return [];
  const count = Math.max(2, Math.min(max, Math.ceil(durationSec * fps)));
  const step = durationSec / count;
  return Array.from({ length: count }, (_, i) => round(Math.min(durationSec - 0.001, i * step + step / 2)));
}
