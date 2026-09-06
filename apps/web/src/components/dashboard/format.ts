/**
 * Pure formatting helpers for the dashboard (no React, safe on client + server).
 */

/** The project shape the dashboard hub renders (all fields serializable). */
export interface DashProject {
  readonly id: string;
  readonly name: string;
  /** ISO timestamps so they cross the server→client boundary cleanly. */
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Aspect ratio label derived from the latest doc's meta (e.g. "16:9"), if known. */
  readonly aspect?: string;
  /** Resolution label derived from the latest doc's meta (e.g. "1080p"), if known. */
  readonly resolution?: string;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** A simplified aspect-ratio label like "16:9" / "9:16" / "1:1" from pixel dims. */
export function aspectLabel(width: number, height: number): string | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const d = gcd(Math.round(width), Math.round(height));
  const w = Math.round(width) / d;
  const h = Math.round(height) / d;
  // Collapse near-standard ratios that don't reduce cleanly (e.g. 1366×768).
  if (w > 40 || h > 40) {
    const r = width / height;
    const known: Array<[number, string]> = [
      [16 / 9, "16:9"],
      [9 / 16, "9:16"],
      [4 / 3, "4:3"],
      [1, "1:1"],
      [4 / 5, "4:5"],
      [21 / 9, "21:9"],
    ];
    let best: string | undefined;
    let bestErr = Infinity;
    for (const [ratio, label] of known) {
      const err = Math.abs(r - ratio) / ratio;
      if (err < bestErr) {
        bestErr = err;
        best = label;
      }
    }
    return bestErr < 0.06 ? best : `${Math.round(r * 100) / 100}:1`;
  }
  return `${w}:${h}`;
}

/** A resolution tag from the output height (e.g. "1080p", "4K"), if recognizable. */
export function resolutionLabel(height: number): string | undefined {
  if (!Number.isFinite(height) || height <= 0) return undefined;
  const h = Math.round(height);
  if (h >= 2160) return "4K";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  return `${h}p`;
}

/** Compact relative time like "just now" / "5m ago" / "3d ago", falling back to a date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, now - then);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < 45_000) return "just now";
  if (diff < hour) return `${Math.max(1, Math.round(diff / min))}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}
