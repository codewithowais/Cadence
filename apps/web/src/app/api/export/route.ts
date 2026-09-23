import { type NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEditDoc, type EditDoc } from "@cadence/core";
import {
  detectFfmpeg,
  runExport,
  FFMPEG_MISSING_MESSAGE,
  FfmpegNotFoundError,
  ExportCancelledError,
} from "@cadence/render-ffmpeg";
import {
  resolveMediaToLocalPath,
  MediaNotOnServerError,
  BLOB_OWNER_COOKIE,
  isValidOwnerToken,
  blobOwnerTag,
  blobBelongsToOwner,
} from "@/lib/uploads";
import {
  EXPORT_PROGRESS_HEADER,
  EXPORT_STREAM_HEADER,
  encodeExportEvent,
  type ExportStreamEvent,
} from "@/lib/export-stream";
import { acquireExportSlot, exportSlotsBusy } from "@/lib/export-slots";

export const runtime = "nodejs";
// Real encoding can take a while; give it room.
export const maxDuration = 300;

const EXPORT_DIR = join(tmpdir(), "cadence-exports");

/**
 * Every distinct `.cube` LUT path referenced by the doc — per-clip creative looks
 * (`look.lut` on video/image clips) and adjustment layers (`grade.lut`). These are
 * validated against the uploads dir exactly like media paths before ffmpeg sees them.
 */
function collectLutPaths(doc: EditDoc): string[] {
  const out = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if ((clip.kind === "video" || clip.kind === "image") && clip.look.lut) out.add(clip.look.lut);
      if (clip.kind === "adjustment" && clip.grade.lut) out.add(clip.grade.lut);
    }
  }
  return [...out];
}

/** Map a failure to the stable error codes the client understands. */
function describeError(err: unknown): { error: string; code?: string; status: number } {
  if (err instanceof FfmpegNotFoundError) return { error: err.message, code: "FFMPEG_NOT_FOUND", status: 501 };
  if (err instanceof MediaNotOnServerError) return { error: err.message, code: err.code, status: 422 };
  if (err instanceof ExportCancelledError) return { error: err.message, code: err.code, status: 499 };
  return { error: err instanceof Error ? err.message : "export failed", status: 500 };
}

/**
 * Real .mp4 export: accepts { doc } (media.src already server paths from
 * /api/upload) → renders via the free/local ffmpeg path → returns the mp4.
 * If ffmpeg is missing, returns HTTP 501 with the install message JSON so the UI
 * can fall back to the JSON edit-doc export.
 *
 * PROGRESS: a client that sends `x-cadence-progress: 1` gets a streamed response
 * instead (see lib/export-stream.ts): `phase`/`progress` JSON lines while ffmpeg
 * encodes, then a `file` header line followed by the raw mp4 bytes. Disconnecting
 * (fetch abort → `req.signal`, or the body stream being cancelled) kills ffmpeg.
 * Requests without the header get the unchanged binary response.
 */
export async function POST(req: NextRequest) {
  // Fail fast + honestly when ffmpeg isn't installed.
  const info = await detectFfmpeg();
  if (!info.available) {
    return Response.json({ error: FFMPEG_MISSING_MESSAGE, code: "FFMPEG_NOT_FOUND" }, { status: 501 });
  }

  let outFile: string | null = null;
  // Local files we downloaded from Blob for this export; deleted in `cleanup`.
  const scratch: string[] = [];
  // Source Vercel Blob URLs to delete after export so storage doesn't accumulate.
  const blobUrls: string[] = [];
  // Once the streamed response owns the export, cleanup moves into the stream.
  let streaming = false;

  const cleanup = async (): Promise<void> => {
    if (outFile) void unlink(outFile).catch(() => {});
    for (const f of scratch) void unlink(f).catch(() => {});
    // Free the source blobs so Vercel Blob storage doesn't accumulate: the client
    // re-uploads every media file on each export, so these are single-use. Awaited
    // (not fire-and-forget) because a serverless instance may freeze right after the
    // response, which would skip the deletion and leak storage against the free quota.
    //
    // AUTHORIZATION: only delete blobs owned by THIS caller. We derive the owner tag
    // from the caller's own httpOnly cookie token and delete only URLs whose path
    // carries that tag — so a crafted doc referencing another client's blob URLs can
    // never drive their deletion (IDOR). Client-supplied URLs are never trusted blindly.
    if (blobUrls.length) {
      const token = req.cookies.get(BLOB_OWNER_COOKIE)?.value;
      const owned = isValidOwnerToken(token)
        ? blobUrls.filter((u) => blobBelongsToOwner(u, blobOwnerTag(token)))
        : [];
      if (owned.length) {
        try {
          const { del } = await import("@vercel/blob");
          await del(owned);
        } catch {
          // Best-effort — a failed cleanup must never fail the export.
        }
      }
    }
  };

  try {
    const body = await req.json();
    const doc = parseEditDoc(body?.doc);

    // SECURITY: media.src is client-supplied. Every path is resolved to a real
    // LOCAL file before ffmpeg sees it — either validated INSIDE the uploads dir
    // or downloaded from an allow-listed Vercel Blob URL — so a crafted src
    // ("/etc/passwd", "http://…") can't become arbitrary-file-read / SSRF.
    const byId = new Map<string, string>();
    for (const m of doc.media) {
      const r = await resolveMediaToLocalPath(m.src, m.label ?? m.id);
      byId.set(m.id, r.path);
      if (r.downloaded) { scratch.push(r.path); blobUrls.push(m.src); }
    }

    // LUT (.cube) paths are also client-supplied and reach ffmpeg via the SAME
    // resolver (the engine passes `look.lut` / adjustment `grade.lut` through
    // resolveMediaPath → `lut3d=file=…`). Resolve every LUT value the same way
    // (local path or Blob); the sync resolver then serves both media ids and LUT
    // paths (and a LUT with no valid file fails safe).
    const byLut = new Map<string, string>();
    for (const lut of collectLutPaths(doc)) {
      const r = await resolveMediaToLocalPath(lut);
      byLut.set(lut, r.path);
      if (r.downloaded) { scratch.push(r.path); blobUrls.push(lut); }
    }

    const resolveMediaPath = (idOrPath: string): string => {
      const p = byId.get(idOrPath) ?? byLut.get(idOrPath);
      if (!p) throw new Error(`no media path for "${idOrPath}" — upload it first`);
      return p;
    };

    await mkdir(EXPORT_DIR, { recursive: true });
    outFile = join(EXPORT_DIR, `${randomUUID()}.mp4`);
    const safeTitle = (doc.meta.title || "cadence").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "cadence";

    if (req.headers.get(EXPORT_PROGRESS_HEADER) === "1") {
      streaming = true;
      return streamExport({ doc, resolveMediaPath, outFile, filename: `${safeTitle}.mp4`, reqSignal: req.signal, cleanup });
    }

    // ---- Legacy (non-streaming) path: unchanged response shape ----------------
    const release = await acquireExportSlot(req.signal);
    try {
      await runExport(doc, { resolveMediaPath, outFile, skipDetect: true, signal: req.signal });
    } finally {
      release();
    }

    const bytes = await readFile(outFile);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${safeTitle}.mp4"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const d = describeError(err);
    return Response.json({ error: d.error, ...(d.code ? { code: d.code } : {}) }, { status: d.status });
  } finally {
    if (!streaming) await cleanup();
  }
}

/**
 * The streamed export: an async generator bridged to a pull-based ReadableStream
 * (the Web-API pattern from the Next.js route-handler docs). Progress callbacks
 * feed a small queue the generator drains; after a successful encode the mp4 is
 * read from disk in 256 KB chunks, so a slow client applies backpressure instead
 * of the whole file being buffered in memory.
 */
function streamExport(args: {
  doc: EditDoc;
  resolveMediaPath: (id: string) => string;
  outFile: string;
  filename: string;
  reqSignal: AbortSignal;
  cleanup: () => Promise<void>;
}): Response {
  const { doc, resolveMediaPath, outFile, filename, reqSignal, cleanup } = args;
  const ac = new AbortController();
  // Client went away (fetch aborted / tab closed) → kill the encode.
  const onReqAbort = (): void => ac.abort();
  if (reqSignal.aborted) ac.abort();
  else reqSignal.addEventListener("abort", onReqAbort, { once: true });

  async function* events(): AsyncGenerator<Uint8Array> {
    const queue: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;
    const push = (e: ExportStreamEvent): void => {
      queue.push(encodeExportEvent(e));
      wake?.();
      wake = null;
    };
    let release: (() => void) | null = null;
    try {
      if (exportSlotsBusy()) push({ type: "phase", phase: "queued" });
      const job = (async () => {
        release = await acquireExportSlot(ac.signal);
        await runExport(doc, {
          resolveMediaPath,
          outFile,
          skipDetect: true,
          signal: ac.signal,
          onPhase: (phase) => push({ type: "phase", phase }),
          onProgress: (fraction, etaSec) =>
            push({ type: "progress", fraction: Math.round(fraction * 10_000) / 10_000, etaSec: etaSec === null ? null : Math.round(etaSec * 10) / 10 }),
        });
      })().then(
        () => { finished = true; wake?.(); },
        (err: unknown) => { failure = err; finished = true; wake?.(); },
      );
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (finished) break;
        await new Promise<void>((r) => { wake = r; });
      }
      await job;
      (release as (() => void) | null)?.();
      release = null;
      while (queue.length) yield queue.shift()!;
      if (failure) {
        const d = ac.signal.aborted ? describeError(new ExportCancelledError()) : describeError(failure);
        yield encodeExportEvent({ type: "error", error: d.error, ...(d.code ? { code: d.code } : {}) });
        return;
      }
      const { size } = await stat(outFile);
      yield encodeExportEvent({ type: "file", size, filename, contentType: "video/mp4" });
      for await (const chunk of createReadStream(outFile, { highWaterMark: 256 * 1024 })) {
        if (ac.signal.aborted) return;
        yield new Uint8Array(chunk as Buffer);
      }
    } finally {
      (release as (() => void) | null)?.();
      reqSignal.removeEventListener("abort", onReqAbort);
      await cleanup();
    }
  }

  const it = events();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      // The response was abandoned (Next cancels the body when the socket closes).
      ac.abort();
      await it.return(undefined).catch(() => {});
    },
  });

  return new Response(body, {
    headers: {
      // Binary-safe type: text types may be compressed/buffered by proxies, which
      // would hold progress lines back until the very end.
      "content-type": "application/octet-stream",
      [EXPORT_STREAM_HEADER]: "1",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
