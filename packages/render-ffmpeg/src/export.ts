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
import type { Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, selectProvider, type EnhanceResult } from "@cadence/enhance";
import { docDurationSec, sourceSpanSec, type EditDoc } from "@cadence/core";
import {
  buildExportPlan,
  docIsCanvasRenderable,
  type AnimatedOverlayMap,
  type KaraokeOverlayMap,
  type ResolveMediaPath,
  type TextOverlayMap,
} from "./plan";
import {
  renderAnimatedOverlays,
  docNeedsAnimatedOverlays,
  renderTextOverlays,
  renderKaraokeOverlays,
  renderShapeOverlays,
  docNeedsTextOverlays,
  docNeedsKaraokeOverlays,
  docNeedsShapeOverlays,
} from "./text-overlays";
import { detectFfmpeg, resolveFfmpegBin, FFMPEG_MISSING_MESSAGE, type FfmpegInfo } from "./detect";
import { FfmpegProgressParser, MonotonicProgress, blockFraction, etaSeconds } from "./progress";

/**
 * Coarse stage of an export, reported via {@link RunExportOptions.onPhase}:
 * `preparing` (rasterizing overlays, stabilization pre-pass, audio probes),
 * `encoding` (the main ffmpeg pass — the part `onProgress` measures), and
 * `finishing` (the optional faithful AI enhancement pass).
 */
export type ExportPhase = "preparing" | "encoding" | "finishing";

export interface RunExportOptions {
  resolveMediaPath: ResolveMediaPath;
  outFile: string;
  /** Override the ffmpeg binary (default $FFMPEG_PATH or "ffmpeg"). */
  bin?: string;
  /** Called with ffmpeg's stderr chunks (progress lines) if provided. */
  onLog?: (line: string) => void;
  /** Skip the availability probe (used by callers that already probed). */
  skipDetect?: boolean;
  /**
   * Encode progress: `fraction` 0..1 (monotonic, reaches exactly 1 on success) and
   * a wall-clock ETA in seconds (null until there is enough signal). Parsed from
   * ffmpeg's `-progress pipe:1` output; only requested from ffmpeg when set.
   */
  onProgress?: (fraction: number, etaSec: number | null) => void;
  /** Stage changes (preparing → encoding → finishing). */
  onPhase?: (phase: ExportPhase) => void;
  /**
   * Abort the export: kills ffmpeg (and the canvas frame feeder) immediately and
   * rejects with {@link ExportCancelledError}. Temp files are still cleaned up.
   */
  signal?: AbortSignal;
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

/** Thrown when an export is aborted via `RunExportOptions.signal`. */
export class ExportCancelledError extends Error {
  readonly code = "EXPORT_CANCELLED";
  constructor(message = "Export cancelled.") {
    super(message);
    this.name = "ExportCancelledError";
  }
}

/**
 * Render `doc` to a real .mp4 at `outFile`. Throws {@link FfmpegNotFoundError}
 * with a clear install hint if ffmpeg is missing.
 */
export async function runExport(doc: EditDoc, opts: RunExportOptions): Promise<ExportOutcome> {
  const bin = opts.bin || resolveFfmpegBin();
  const { signal } = opts;
  const checkAborted = (): void => {
    if (signal?.aborted) throw new ExportCancelledError();
  };
  checkAborted();

  const ffmpeg = opts.skipDetect ? { available: true, bin } : await detectFfmpeg(bin);
  if (!ffmpeg.available) throw new FfmpegNotFoundError();
  opts.onPhase?.("preparing");

  // Rasterize any text-bearing clips (captions/titles/kinetic titles + callout
  // labels) to transparent PNGs with the canvas engine, then hand the paths to the
  // pure plan builder, which OVERLAYS them instead of emitting drawtext (the bundled
  // ffmpeg has no libfreetype). No-text docs skip this entirely (fast path). The
  // temp dir holding the PNGs is cleaned up once ffmpeg has consumed them.
  let overlayDir: string | null = null;
  try {
    let overlays: TextOverlayMap | undefined;
    let karaokeOverlays: KaraokeOverlayMap | undefined;
    let shapeOverlays: TextOverlayMap | undefined;
    let stabilizeTransforms: Map<string, string> | undefined;
    let animatedOverlays: AnimatedOverlayMap | undefined;
    // Media-less docs (text videos, title cards) render EVERY frame through the
    // shared canvas and pipe raw RGBA into ffmpeg — no per-clip overlays needed.
    const canvasBase = docIsCanvasRenderable(doc);
    const needsKaraoke = !canvasBase && docNeedsKaraokeOverlays(doc);
    const needsShapes = !canvasBase && docNeedsShapeOverlays(doc);
    const needsStabilize = docNeedsStabilize(doc);
    const needsAnimated = !canvasBase && docNeedsAnimatedOverlays(doc);
    if ((!canvasBase && docNeedsTextOverlays(doc)) || needsKaraoke || needsShapes || needsStabilize || needsAnimated) {
      overlayDir = await mkdtemp(join(tmpdir(), "cadence-text-"));
      overlays = await renderTextOverlays(doc, overlayDir);
      if (needsKaraoke) karaokeOverlays = await renderKaraokeOverlays(doc, overlayDir);
      if (needsShapes) shapeOverlays = await renderShapeOverlays(doc, overlayDir);
      if (needsAnimated) animatedOverlays = await renderAnimatedOverlays(doc, overlayDir);
      // vidstab PRE-PASS: detect a smoothing sidecar for each stabilized clip on the
      // SAME source window the main pass reads, so the transforms align frame-for-frame.
      if (needsStabilize) stabilizeTransforms = await detectStabilize(bin, doc, opts.resolveMediaPath, overlayDir, opts.onLog, signal);
    }
    checkAborted();
    // Detect which sources actually carry an audio stream (no ffprobe exists in
    // ffmpeg-static) so the pure plan substitutes silence for audioless inputs
    // instead of referencing a non-existent [idx:a] pad — the audioless-export fix.
    const mediaHasAudio = await detectMediaAudio(bin, doc, opts.resolveMediaPath);
    const plan = buildExportPlan(doc, opts.resolveMediaPath, opts.outFile, overlays, mediaHasAudio, karaokeOverlays, shapeOverlays, stabilizeTransforms, {
      animatedOverlays,
      canvasBase,
    });
    let feed: ((stdin: Writable) => Promise<void>) | undefined;
    if (plan.stdinFrames) {
      const { count, fps } = plan.stdinFrames;
      const { createRgbaFrameRenderer } = await import("@cadence/render-node");
      const renderer = createRgbaFrameRenderer(doc);
      feed = async (stdin) => {
        for (let i = 0; i < count; i++) {
          // Stop painting the moment the export is cancelled or ffmpeg went away.
          if (signal?.aborted || stdin.destroyed || stdin.writableEnded) return;
          const ok = stdin.write(renderer.render(i / fps));
          if (!ok) await waitForDrain(stdin);
        }
        if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
      };
    }
    checkAborted();
    opts.onPhase?.("encoding");
    // Machine-readable progress: `-progress pipe:1` is a GLOBAL option, so it is
    // prepended to the pure plan's argv (the plan itself stays untouched). Only
    // requested when a caller listens, so legacy callers spawn the exact same argv.
    const progress = opts.onProgress
      ? { totalSec: docDurationSec(doc), fps: plan.stdinFrames?.fps ?? doc.meta.fps, onProgress: opts.onProgress }
      : undefined;
    // `-stats_period 0.25` (a global option in the bundled ffmpeg 6.0 — see
    // `ffmpeg -h full`) halves the default 0.5 s cadence so short exports still
    // move the bar smoothly.
    const args = progress ? ["-progress", "pipe:1", "-stats_period", "0.25", ...plan.args] : plan.args;
    await spawnFfmpeg(bin, args, opts.onLog, feed, { progress, signal });

    // Optional faithful AI enhancement pass (off by default; money/setup gated).
    let enhance: EnhanceResult | undefined;
    if (doc.quality.aiUpscale) {
      checkAborted();
      opts.onPhase?.("finishing");
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

    return { outFile: opts.outFile, args, ffmpeg, enhance };
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

/** True when any (non-freeze) video clip in the doc requests stabilization. */
export function docNeedsStabilize(doc: EditDoc): boolean {
  return doc.tracks.some((t) =>
    t.clips.some((c) => c.kind === "video" && c.stabilize && c.freezeAtSec === undefined),
  );
}

/**
 * Run a `vidstabdetect` PRE-PASS for every stabilized video clip and return
 * clipId → transforms sidecar (.trf) path. Each detect reads the SAME source window
 * the main export pass reads (`-ss sourceIn -t sourceSpan`) so the transforms align
 * frame-for-frame with `vidstabtransform`. GRACEFUL: a clip whose detect fails (no
 * vidstab, unreadable source) is simply omitted from the map — the main pass then
 * encodes it un-stabilized instead of failing the whole export. Never rejects.
 */
export async function detectStabilize(
  bin: string,
  doc: EditDoc,
  resolveMediaPath: ResolveMediaPath,
  dir: string,
  onLog?: (line: string) => void,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const clips: { id: string; mediaId: string; ss: number; span: number }[] = [];
  for (const track of doc.tracks) {
    for (const c of track.clips) {
      if (c.kind === "video" && c.stabilize && c.freezeAtSec === undefined) {
        clips.push({ id: c.id, mediaId: c.mediaId, ss: c.sourceIn, span: sourceSpanSec(c) });
      }
    }
  }
  await Promise.all(
    clips.map(
      (c) =>
        new Promise<void>((resolve) => {
          const trf = join(dir, `stab-${c.id.replace(/[^A-Za-z0-9_-]/g, "_")}.trf`);
          const args = [
            "-hide_banner", "-y",
            "-ss", String(Math.max(0, c.ss)),
            "-t", String(Math.max(0.1, c.span)),
            "-i", resolveMediaPath(c.mediaId),
            "-vf", `vidstabdetect=result=${trf}:shakiness=6:accuracy=15`,
            "-f", "null", "-",
          ];
          if (signal?.aborted) {
            resolve();
            return;
          }
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
          } catch {
            resolve();
            return;
          }
          const onAbort = (): void => {
            child.kill("SIGKILL");
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          child.stderr?.on("data", (d: Buffer) => onLog?.(d.toString()));
          child.on("error", () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          });
          child.on("close", (code) => {
            signal?.removeEventListener("abort", onAbort);
            if (code === 0) map.set(c.id, trf);
            resolve();
          });
        }),
    ),
  );
  return map;
}

/** Resolve once `stdin` drains — or closes/errors, so a dead ffmpeg can't hang the feeder. */
function waitForDrain(stdin: Writable): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      stdin.off("drain", done);
      stdin.off("close", done);
      stdin.off("error", done);
      resolve();
    };
    stdin.on("drain", done);
    stdin.on("close", done);
    stdin.on("error", done);
  });
}

interface SpawnProgress {
  totalSec: number;
  fps: number;
  onProgress: (fraction: number, etaSec: number | null) => void;
}

function spawnFfmpeg(
  bin: string,
  args: string[],
  onLog?: (line: string) => void,
  feed?: (stdin: Writable) => Promise<void>,
  extra: { progress?: SpawnProgress; signal?: AbortSignal } = {},
): Promise<void> {
  const { progress, signal } = extra;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExportCancelledError());
      return;
    }
    let settled = false;
    const settle = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const child = spawn(bin, args, { stdio: [feed ? "pipe" : "ignore", progress ? "pipe" : "ignore", "pipe"] });
    // Cancel = kill ffmpeg NOW (SIGKILL: no graceful flush of a file we'll delete).
    function onAbort(): void {
      child.kill("SIGKILL");
      settle(new ExportCancelledError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (feed && child.stdin) {
      // A broken pipe (ffmpeg died early) surfaces via the close code below.
      child.stdin.on("error", () => {});
      feed(child.stdin).catch((err) => {
        child.kill("SIGKILL");
        settle(err);
      });
    }
    if (progress && child.stdout) {
      const parser = new FfmpegProgressParser();
      const mono = new MonotonicProgress();
      const started = Date.now();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        for (const block of parser.push(chunk)) {
          // `progress=end` is reported by the close handler (after exit 0) instead,
          // so a caller never sees 100 % for an encode that then fails.
          if (block.progress === "end") continue;
          const shown = mono.update(blockFraction(block, progress.totalSec, progress.fps));
          if (shown !== null && shown < 1) {
            try {
              progress.onProgress(shown, etaSeconds(shown, (Date.now() - started) / 1000));
            } catch {
              /* a throwing listener must never break the encode */
            }
          }
        }
      });
    }
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
      onLog?.(s);
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") settle(new FfmpegNotFoundError());
      else settle(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        if (progress && !settled) {
          try {
            progress.onProgress(1, 0);
          } catch {
            /* ignore listener errors */
          }
        }
        settle();
      } else settle(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}
