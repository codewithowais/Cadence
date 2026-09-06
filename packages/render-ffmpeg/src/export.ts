/**
 * runExport — the impure driver: build the pure plan, spawn system ffmpeg, and
 * resolve to the finished .mp4.
 *
 * MONEY GATE: the default path is FREE/local ffmpeg (Lanczos upscale + unsharp +
 * hqdn3d — all in the filtergraph from plan.ts). No paid service is ever enabled
 * here. FAITHFULNESS: when `doc.quality.aiUpscale` is on, we select a provider
 * from @cadence/enhance (configFromEnv/selectProvider); every such provider is
 * identity-preserving by contract (Real-ESRGAN-style detail work only — NEVER a
 * generative face/content redraw). If no faithful AI provider is available, we
 * fall back to the free path silently.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, selectProvider, type EnhanceResult } from "@cadence/enhance";
import type { EditDoc } from "@cadence/core";
import { buildExportPlan, type KaraokeOverlayMap, type ResolveMediaPath, type TextOverlayMap } from "./plan";
import {
  renderTextOverlays,
  renderKaraokeOverlays,
  docNeedsTextOverlays,
  docNeedsKaraokeOverlays,
} from "./text-overlays";
import { detectFfmpeg, resolveFfmpegBin, FFMPEG_MISSING_MESSAGE, type FfmpegInfo } from "./detect";

export interface RunExportOptions {
  resolveMediaPath: ResolveMediaPath;
  outFile: string;
  /** Override the ffmpeg binary (default $FFMPEG_PATH or "ffmpeg"). */
  bin?: string;
  /** Called with ffmpeg's stderr chunks (progress lines) if provided. */
  onLog?: (line: string) => void;
  /** Skip the availability probe (used by callers that already probed). */
  skipDetect?: boolean;
}

export interface ExportOutcome {
  outFile: string;
  args: string[];
  ffmpeg: FfmpegInfo;
  /** Set when an @cadence/enhance faithful pass ran (aiUpscale). */
  enhance?: EnhanceResult;
}

/** Thrown when ffmpeg isn't installed; `.code` lets callers map it to HTTP 501. */
export class FfmpegNotFoundError extends Error {
  readonly code = "FFMPEG_NOT_FOUND";
  constructor(message = FFMPEG_MISSING_MESSAGE) {
    super(message);
    this.name = "FfmpegNotFoundError";
  }
}

/**
 * Render `doc` to a real .mp4 at `outFile`. Throws {@link FfmpegNotFoundError}
 * with a clear install hint if ffmpeg is missing.
 */
export async function runExport(doc: EditDoc, opts: RunExportOptions): Promise<ExportOutcome> {
  const bin = opts.bin || resolveFfmpegBin();

  const ffmpeg = opts.skipDetect ? { available: true, bin } : await detectFfmpeg(bin);
  if (!ffmpeg.available) throw new FfmpegNotFoundError();

  // Rasterize any text-bearing clips (captions/titles/kinetic titles + callout
  // labels) to transparent PNGs with the canvas engine, then hand the paths to the
  // pure plan builder, which OVERLAYS them instead of emitting drawtext (the bundled
  // ffmpeg has no libfreetype). No-text docs skip this entirely (fast path). The
  // temp dir holding the PNGs is cleaned up once ffmpeg has consumed them.
  let overlayDir: string | null = null;
  try {
    let overlays: TextOverlayMap | undefined;
    let karaokeOverlays: KaraokeOverlayMap | undefined;
    const needsKaraoke = docNeedsKaraokeOverlays(doc);
    if (docNeedsTextOverlays(doc) || needsKaraoke) {
      overlayDir = await mkdtemp(join(tmpdir(), "cadence-text-"));
      overlays = await renderTextOverlays(doc, overlayDir);
      if (needsKaraoke) karaokeOverlays = await renderKaraokeOverlays(doc, overlayDir);
    }
    // Detect which sources actually carry an audio stream (no ffprobe exists in
    // ffmpeg-static) so the pure plan substitutes silence for audioless inputs
    // instead of referencing a non-existent [idx:a] pad — the audioless-export fix.
    const mediaHasAudio = await detectMediaAudio(bin, doc, opts.resolveMediaPath);
    const plan = buildExportPlan(doc, opts.resolveMediaPath, opts.outFile, overlays, mediaHasAudio, karaokeOverlays);
    await spawnFfmpeg(bin, plan.args, opts.onLog);

    // Optional faithful AI enhancement pass (off by default; money/setup gated).
    let enhance: EnhanceResult | undefined;
    if (doc.quality.aiUpscale) {
      const provider = selectProvider(configFromEnv());
      // The free provider is a no-op marker (its work already happened in the
      // filtergraph). Only run a real pass for an available, faithful AI provider.
      if (provider.usesAI && (await provider.isAvailable())) {
        const scale = deriveScale(doc);
        enhance = await provider.enhance({
          inputPath: opts.outFile,
          outputPath: opts.outFile,
          scale,
          sharpen: doc.quality.sharpen,
          denoise: doc.quality.denoise,
          kind: "video",
        });
      } else {
        enhance = {
          outputPath: opts.outFile,
          provider: provider.id,
          usedAI: false,
          note: "aiUpscale requested but no faithful AI provider available — used the free Lanczos+unsharp path",
        };
      }
    }

    return { outFile: opts.outFile, args: plan.args, ffmpeg, enhance };
  } finally {
    if (overlayDir) await rm(overlayDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Upscale factor implied by quality targets (2..4), else 2. */
function deriveScale(doc: EditDoc): number {
  const tw = doc.quality.targetWidth;
  if (tw && doc.meta.width > 0) return Math.max(2, Math.min(4, Math.round(tw / doc.meta.width)));
  return 2;
}

/**
 * Whether a media file carries an audio stream — detected WITHOUT ffprobe, because
 * `ffmpeg-static` bundles only the `ffmpeg` binary (no `ffprobe`). We run
 * `ffmpeg -hide_banner -i <path>` with NO output file: ffmpeg prints the input's
 * stream table to stderr and then exits NONZERO ("At least one output file must be
 * specified") — that nonzero exit is expected and irrelevant; we only parse stderr
 * for a `Stream #… Audio:` line. Resolves `false` on any spawn/error (a probe
 * failure degrades to silence-substitution, which still yields a valid, playable
 * mp4, rather than crashing the export). Never rejects.
 */
export function probeHasAudio(bin: string, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawn(bin, ["-hide_banner", "-i", path], { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      resolve(false);
      return;
    }
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(/Stream #[^\n]*Audio:/i.test(stderr)));
  });
}

/**
 * Build `mediaId → hasAudio` for every asset a doc references, honoring an explicit
 * `MediaAsset.hasAudio` (skips the probe when the caller already knows), treating
 * image assets as always audioless, and otherwise probing the file with
 * {@link probeHasAudio}. Threaded into the pure {@link buildExportPlan} so an
 * audioless video/audio input contributes synthesized silence instead of a
 * non-existent `[idx:a]` pad. Probes run in parallel; a probe failure yields `false`.
 */
export async function detectMediaAudio(
  bin: string,
  doc: EditDoc,
  resolveMediaPath: ResolveMediaPath,
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  await Promise.all(
    doc.media.map(async (asset) => {
      if (asset.hasAudio !== undefined) {
        map.set(asset.id, asset.hasAudio);
        return;
      }
      if (asset.kind === "image") {
        map.set(asset.id, false);
        return;
      }
      map.set(asset.id, await probeHasAudio(bin, resolveMediaPath(asset.id)));
    }),
  );
  return map;
}

function spawnFfmpeg(bin: string, args: string[], onLog?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
      onLog?.(s);
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") reject(new FfmpegNotFoundError());
      else reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}
