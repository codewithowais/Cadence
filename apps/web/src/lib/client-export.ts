/**
 * In-browser .mp4 export via ffmpeg.wasm — the free, no-server-limits render path.
 *
 * WHY: on serverless (Vercel) the upload and export requests run on different
 * instances with separate disks, and real encoding also hits the ~4.5 MB body and
 * ~60 s function limits. Rendering in the browser sidesteps ALL of that: the media
 * never leaves the machine, there's no upload, no Blob storage, no timeout, and no
 * server compute cost. It reuses the SAME pure `buildExportPlan` the server uses, so
 * the ffmpeg filtergraph (cuts, xfade, Ken Burns, looks, fades) is identical.
 *
 * SCOPE (phase 1): photo slideshows (+ optional music). Text/title overlays are
 * skipped for now — `buildExportPlan` simply doesn't draw a text clip with no
 * pre-rasterized PNG, so nothing crashes; browser-side text rasterization is a
 * follow-up. Video clips may work but are unverified.
 */
import type { EditDoc } from "@cadence/core";
import { buildExportPlan } from "@cadence/render-ffmpeg/plan";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

/** Pinned single-threaded core (no SharedArrayBuffer / cross-origin-isolation needed). */
const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

let ffmpegSingleton: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

/** Load ffmpeg.wasm once (the ~30 MB core is fetched lazily on first export). */
async function loadFfmpeg(onLog?: (line: string) => void): Promise<FFmpeg> {
  if (ffmpegSingleton) return ffmpegSingleton;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const ff = new FFmpeg();
    if (onLog) ff.on("log", ({ message }) => onLog(message));
    await ff.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegSingleton = ff;
    return ff;
  })();
  return loadPromise;
}

/** A lowercase dot-extension from a filename, or "". */
function extFromName(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? `.${m[1]!.toLowerCase()}` : "";
}

/** A dot-extension guessed from a MIME type (fallback when the name has none). */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
  };
  return map[mime] ?? "";
}

export interface ClientExportInput {
  doc: EditDoc;
  /** mediaId → the original File the user added (Editor keeps these in memory). */
  files: Record<string, File>;
  onLog?: (line: string) => void;
  /** Encode progress in [0,1], when ffmpeg reports it. */
  onProgress?: (ratio: number) => void;
}

/** True when a doc can render fully client-side today (all media Files present). */
export function canClientExport(doc: EditDoc, files: Record<string, File>): boolean {
  return doc.media.length > 0 && doc.media.every((m) => !!files[m.id]);
}

/**
 * Render `doc` to an .mp4 Blob entirely in the browser. Throws on any missing file
 * or ffmpeg failure so the caller can fall back to the server path.
 */
export async function clientExport({ doc, files, onLog, onProgress }: ClientExportInput): Promise<Blob> {
  const ff = await loadFfmpeg(onLog);
  const onProg = onProgress ? ({ progress }: { progress: number }) => onProgress(progress) : null;
  if (onProg) ff.on("progress", onProg);

  const written: string[] = [];
  const OUT = "out.mp4";
  try {
    // Write each media File into the wasm virtual FS and map id → its FS name.
    const nameById = new Map<string, string>();
    for (let i = 0; i < doc.media.length; i++) {
      const m = doc.media[i]!;
      const file = files[m.id];
      if (!file) throw new Error(`Missing the media file for ${m.label ?? m.id}.`);
      const ext = extFromName(file.name) || extFromMime(file.type) || ".bin";
      const name = `m${i}${ext}`;
      await ff.writeFile(name, await fetchFile(file));
      written.push(name);
      nameById.set(m.id, name);
    }

    const resolveMediaPath = (idOrPath: string): string => {
      const n = nameById.get(idOrPath);
      if (!n) throw new Error(`no media for "${idOrPath}" — add it first`);
      return n;
    };

    // Images carry no audio stream; tell the plan so it substitutes silence instead
    // of referencing a non-existent [idx:a] pad (the same fix the server's ffprobe
    // pass provides). Audio/video are assumed to have a track.
    const mediaHasAudio = new Map<string, boolean>();
    for (const m of doc.media) mediaHasAudio.set(m.id, m.kind !== "image");

    // Same pure planner the server uses. No text overlays in phase 1 (a text clip
    // with no rasterized PNG is simply not drawn — no crash).
    const plan = buildExportPlan(doc, resolveMediaPath, OUT, undefined, mediaHasAudio);

    await ff.exec(plan.args);

    const data = await ff.readFile(OUT);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    return new Blob([bytes], { type: "video/mp4" });
  } finally {
    if (onProg) ff.off("progress", onProg);
    for (const n of written) await ff.deleteFile(n).catch(() => {});
    await ff.deleteFile(OUT).catch(() => {});
  }
}
