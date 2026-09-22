import { type NextRequest } from "next/server";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEditDoc, type EditDoc } from "@cadence/core";
import { detectFfmpeg, runExport, FFMPEG_MISSING_MESSAGE, FfmpegNotFoundError } from "@cadence/render-ffmpeg";
import {
  resolveMediaToLocalPath,
  MediaNotOnServerError,
  BLOB_OWNER_COOKIE,
  isValidOwnerToken,
  blobOwnerTag,
  blobBelongsToOwner,
} from "@/lib/uploads";

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

/**
 * Real .mp4 export: accepts { doc } (media.src already server paths from
 * /api/upload) → renders via the free/local ffmpeg path → streams the mp4.
 * If ffmpeg is missing, returns HTTP 501 with the install message JSON so the UI
 * can fall back to the JSON edit-doc export.
 */
export async function POST(req: NextRequest) {
  // Fail fast + honestly when ffmpeg isn't installed.
  const info = await detectFfmpeg();
  if (!info.available) {
    return Response.json({ error: FFMPEG_MISSING_MESSAGE, code: "FFMPEG_NOT_FOUND" }, { status: 501 });
  }

  let outFile: string | null = null;
  // Local files we downloaded from Blob for this export; deleted in `finally`.
  const scratch: string[] = [];
  // Source Vercel Blob URLs to delete after export so storage doesn't accumulate.
  const blobUrls: string[] = [];
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

    await runExport(doc, { resolveMediaPath, outFile, skipDetect: true });

    const bytes = await readFile(outFile);
    const safeTitle = (doc.meta.title || "cadence").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "cadence";
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${safeTitle}.mp4"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof FfmpegNotFoundError) {
      return Response.json({ error: err.message, code: "FFMPEG_NOT_FOUND" }, { status: 501 });
    }
    if (err instanceof MediaNotOnServerError) {
      // Media isn't on the server's disk (cleared temp / different invocation).
      // 422 so the UI shows the actionable "re-add & export" message, not a crash.
      return Response.json({ error: err.message, code: err.code }, { status: 422 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "export failed" },
      { status: 500 },
    );
  } finally {
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
  }
}
