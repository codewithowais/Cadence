/**
 * Server-side SCENE DETECTION upgrade path (ffmpeg `select='gt(scene,X)'`).
 *
 * The browser detector (see `scenes.ts` + apps/web/src/lib/scene-detect.ts) needs
 * nothing installed. When ffmpeg IS present the server can do it faster and more
 * precisely on the real decoded stream. Everything here degrades gracefully:
 * `detectSceneFfmpeg()` never throws, it reports `{available:false}` and the UI
 * stays on the browser detector.
 *
 * Node builtins are LAZY-imported (same trick as whisper-transcriber) so a client
 * bundle that touches the `@cadence/understanding` barrel never pulls them in.
 * PySceneDetect is intentionally NOT wired (no CLI here to verify its output
 * format against) — documented in docs/agents/scene-split-cycle-j.md.
 */
import { assertLocalMediaPath } from "./whisper-transcriber";

const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Sensitivity (0..1, higher = more cuts) → ffmpeg scene-score threshold. ffmpeg's
 * `scene` score is 0..1; ~0.3–0.4 is the usual "clear cut"; ~0.1 also catches soft, low-contrast ones.
 */
export function ffmpegSceneThreshold(sensitivity: number): number {
  const s = Math.max(0, Math.min(1, Number.isFinite(sensitivity) ? sensitivity : 0.5));
  return round(0.4 - s * 0.34); // 0 → 0.40, 0.5 → 0.23, 1 → 0.06
}

/** Pure: pull the `pts_time:` of every selected frame out of `showinfo` stderr. Ascending, de-duplicated. */
export function parseShowinfoCuts(stderr: string): number[] {
  const out: number[] = [];
  const re = /pts_time:\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0) out.push(round(t));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The ffmpeg argv for a scene scan of `input` (exported so tests pin the exact filter). */
export function sceneScanArgs(input: string, threshold: number): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    input,
    "-an",
    "-vf",
    `select='gt(scene,${threshold})',showinfo`,
    "-f",
    "null",
    "-",
  ];
}

export type FfmpegSceneResult =
  | { available: true; cuts: number[]; threshold: number }
  | { available: false; reason: string };

/** Probe `ffmpeg -version`; never throws. */
export async function ffmpegPresent(bin = process.env.FFMPEG_PATH || "ffmpeg"): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    try {
      const p = spawn(/* turbopackIgnore: true */ bin, ["-version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Detect scene cuts in a LOCAL media file with ffmpeg. The path is validated by
 * the same SSRF/flag-smuggling guard as transcription. Resolves
 * `{available:false}` when ffmpeg is missing or fails — never throws on absence.
 */
export async function detectSceneFfmpeg(
  src: string,
  opts: { sensitivity?: number; timeoutMs?: number } = {},
): Promise<FfmpegSceneResult> {
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  if (!(await ffmpegPresent(bin))) return { available: false, reason: "ffmpeg is not installed on the server." };
  const safe = await assertLocalMediaPath(src);
  const threshold = ffmpegSceneThreshold(opts.sensitivity ?? 0.5);
  const { spawn } = await import("node:child_process");
  return new Promise<FfmpegSceneResult>((resolve) => {
    let stderr = "";
    let done = false;
    const finish = (r: FfmpegSceneResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const p = spawn(/* turbopackIgnore: true */ bin, sceneScanArgs(safe, threshold), { stdio: ["ignore", "ignore", "pipe"] });
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        finish({ available: false, reason: "ffmpeg scene scan timed out." });
      }, opts.timeoutMs ?? 5 * 60_000);
      p.stderr.on("data", (d: Buffer) => {
        // showinfo is chatty: keep only the lines we parse so memory stays flat.
        for (const line of d.toString().split("\n")) if (line.includes("pts_time:")) stderr += `${line}\n`;
      });
      p.on("error", () => finish({ available: false, reason: "ffmpeg could not be started." }));
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) finish({ available: true, cuts: parseShowinfoCuts(stderr), threshold });
        else finish({ available: false, reason: `ffmpeg exited with code ${code}.` });
      });
    } catch {
      finish({ available: false, reason: "ffmpeg could not be started." });
    }
  });
}
