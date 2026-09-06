/**
 * ffmpeg availability + version probe. Free/local only — we shell out to the
 * SYSTEM ffmpeg (no npm ffmpeg dependency). Used so the app can degrade
 * gracefully (HTTP 501 + install hint) when ffmpeg isn't present.
 */
import { spawn } from "node:child_process";

export interface FfmpegInfo {
  available: boolean;
  /** Parsed version string, e.g. "7.1" (undefined when unavailable). */
  version?: string;
  /** The binary that was probed. */
  bin: string;
}

/**
 * The message shown wherever ffmpeg is required but missing. Homebrew has dropped
 * Intel-macOS support, so we point at the portable options instead of only brew.
 */
export const FFMPEG_MISSING_MESSAGE =
  "ffmpeg not found. Options: run the app via Docker (`docker compose up`, ffmpeg is baked in), " +
  "set FFMPEG_PATH to an ffmpeg binary, or install ffmpeg (macOS: `brew install ffmpeg`, " +
  "or on Intel Macs MacPorts `sudo port install ffmpeg`).";

/**
 * Probe `ffmpeg -version`. Resolves (never rejects) with availability + version.
 * `bin` defaults to $FFMPEG_PATH or "ffmpeg".
 */
export function detectFfmpeg(bin = process.env.FFMPEG_PATH || "ffmpeg"): Promise<FfmpegInfo> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (info: FfmpegInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    let child;
    try {
      child = spawn(bin, ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done({ available: false, bin });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => done({ available: false, bin }));
    child.on("close", (code) => {
      if (code !== 0) {
        done({ available: false, bin });
        return;
      }
      const m = out.match(/ffmpeg version (\S+)/i);
      done({ available: true, version: m?.[1], bin });
    });
  });
}
