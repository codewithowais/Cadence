/**
 * ffmpeg availability + version probe. Free/local only — we shell out to the
 * SYSTEM ffmpeg (no npm ffmpeg dependency). Used so the app can degrade
 * gracefully (HTTP 501 + install hint) when ffmpeg isn't present.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/**
 * Resolve the bundled `ffmpeg-static` binary path, or null if unavailable
 * (package not installed / unsupported platform). Lazy + guarded so the module
 * stays safe to import in environments without it. Cached after first lookup.
 */
let staticBinCache: string | null | undefined;
function ffmpegStaticBin(): string | null {
  if (staticBinCache !== undefined) return staticBinCache;
  try {
    const require = createRequire(import.meta.url);
    const p = require("ffmpeg-static") as unknown;
    staticBinCache = typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    staticBinCache = null;
  }
  return staticBinCache;
}

/**
 * The ffmpeg binary to use, in priority order:
 *   1. `FFMPEG_PATH` env (operator override / Docker),
 *   2. the bundled `ffmpeg-static` binary (free, no system install needed),
 *   3. `ffmpeg` on PATH.
 * This makes export work out of the box locally without Docker or a system install.
 */
export function resolveFfmpegBin(): string {
  const env = process.env.FFMPEG_PATH?.trim();
  if (env) return env;
  return ffmpegStaticBin() ?? "ffmpeg";
}

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
export function detectFfmpeg(bin = resolveFfmpegBin()): Promise<FfmpegInfo> {
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
