import { type NextRequest } from "next/server";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEditDoc } from "@cadence/core";
import { detectFfmpeg, runExport, FFMPEG_MISSING_MESSAGE, FfmpegNotFoundError } from "@cadence/render-ffmpeg";

export const runtime = "nodejs";
// Real encoding can take a while; give it room.
export const maxDuration = 300;

const EXPORT_DIR = join(tmpdir(), "cadence-exports");

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
  try {
    const body = await req.json();
    const doc = parseEditDoc(body?.doc);

    // media.src already holds concrete server paths (from /api/upload).
    const byId = new Map(doc.media.map((m) => [m.id, m.src] as const));
    const resolveMediaPath = (mediaId: string): string => {
      const p = byId.get(mediaId);
      if (!p) throw new Error(`no media path for "${mediaId}" — upload it first`);
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
    return Response.json(
      { error: err instanceof Error ? err.message : "export failed" },
      { status: 500 },
    );
  } finally {
    if (outFile) void unlink(outFile).catch(() => {});
  }
}
