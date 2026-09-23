/**
 * PURE helpers for ffmpeg's machine-readable progress output (`-progress <url>`).
 *
 * Format (verified against the bundled ffmpeg 6.0 by running
 * `ffmpeg -progress pipe:1 … `): ffmpeg writes blocks of `key=value` lines, each
 * block terminated by a `progress=continue` line, the final one by `progress=end`:
 *
 *   frame=90
 *   fps=0.00
 *   out_time_us=2900000
 *   out_time_ms=2900000        ← (sic) also microseconds, a long-standing ffmpeg quirk
 *   out_time=00:00:02.900000
 *   speed=68.9x
 *   progress=end
 *
 * Before the first frame is muxed, `out_time_us` is a large NEGATIVE sentinel
 * (-9223372036854775807) and `speed=N/A` — both must be treated as "no data yet".
 *
 * No I/O here: the impure driver (export.ts) feeds stdout chunks in and receives
 * parsed blocks out, so this stays unit-testable.
 */

/** One parsed progress block (the key=value lines up to a `progress=` line). */
export type FfmpegProgressBlock = Record<string, string>;

/**
 * Incremental line parser. `push(chunk)` accepts arbitrary stdout chunks (lines may
 * be split across chunks) and returns every block completed by that chunk.
 */
export class FfmpegProgressParser {
  private buf = "";
  private block: FfmpegProgressBlock = {};

  push(chunk: string): FfmpegProgressBlock[] {
    this.buf += chunk;
    const out: FfmpegProgressBlock[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "").trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      this.block[key] = value;
      if (key === "progress") {
        out.push(this.block);
        this.block = {};
      }
    }
    // Guard against an unbounded partial line (never expected from ffmpeg).
    if (this.buf.length > 8192) this.buf = this.buf.slice(-8192);
    return out;
  }
}

/** Parse "HH:MM:SS.micro" (ffmpeg's `out_time`) → seconds, or null. */
export function parseClockTime(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(-)?(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s.trim());
  if (!m || m[1]) return null;
  const sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return Number.isFinite(sec) ? sec : null;
}

/**
 * Encoded output time (seconds) reported by a block, or null when the block carries
 * no usable time yet (negative sentinel / N/A). Prefers `out_time_us`, then
 * `out_time_ms` (also µs), then the `out_time` clock string.
 */
export function blockOutTimeSec(block: FfmpegProgressBlock): number | null {
  for (const key of ["out_time_us", "out_time_ms"] as const) {
    const raw = block[key];
    if (raw === undefined || raw === "N/A") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n / 1_000_000;
  }
  return parseClockTime(block.out_time);
}

/**
 * Fraction complete (0..1) for a block given the expected output duration and fps.
 * Uses the encoded time; falls back to `frame / (total * fps)` when time is missing.
 * `progress=end` always reads as 1. Clamped to [0, 1]; null when nothing is known.
 */
export function blockFraction(block: FfmpegProgressBlock, totalSec: number, fps?: number): number | null {
  if (block.progress === "end") return 1;
  if (!(totalSec > 0)) return null;
  const t = blockOutTimeSec(block);
  if (t !== null) return clamp01(t / totalSec);
  const frame = Number(block.frame);
  if (fps && fps > 0 && Number.isFinite(frame) && frame > 0) return clamp01(frame / (totalSec * fps));
  return null;
}

/**
 * Seconds remaining, extrapolated from wall-clock elapsed time and the fraction
 * done (`elapsed · (1 − f) / f`). Null until there is enough signal (f < 2 % or
 * under half a second elapsed) — an early ETA is noise, not information.
 */
export function etaSeconds(fraction: number, elapsedSec: number): number | null {
  if (!(fraction >= 0.02) || !(elapsedSec >= 0.5)) return null;
  if (fraction >= 1) return 0;
  const eta = (elapsedSec * (1 - fraction)) / fraction;
  return Number.isFinite(eta) ? Math.max(0, eta) : null;
}

/**
 * Monotonic progress tracker: ffmpeg's reported time can momentarily step back
 * (B-frame reordering, filter latency); the UI bar must never move backwards.
 * `update(f)` returns the value to show, or null when it wouldn't change the bar
 * by at least `minStep` (throttles chatty updates). `finish()` forces 1.
 */
export class MonotonicProgress {
  private shown = -1;
  constructor(private readonly minStep = 0.005) {}
  update(fraction: number | null): number | null {
    if (fraction === null || !Number.isFinite(fraction)) return null;
    const f = clamp01(fraction);
    if (f <= this.shown) return null;
    if (f < 1 && this.shown >= 0 && f - this.shown < this.minStep) return null;
    this.shown = f;
    return f;
  }
  finish(): number | null {
    if (this.shown >= 1) return null;
    this.shown = 1;
    return 1;
  }
  get value(): number {
    return Math.max(0, this.shown);
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
