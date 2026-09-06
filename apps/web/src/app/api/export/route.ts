import { type NextRequest } from "next/server";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEditDoc, type EditDoc } from "@cadence/core";
import { detectFfmpeg, runExport, FFMPEG_MISSING_MESSAGE, FfmpegNotFoundError } from "@cadence/render-ffmpeg";
import { resolveUploadPath } from "@/lib/uploads";

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
  try {
    const body = await req.json();
    const doc = parseEditDoc(body?.doc);

    // SECURITY: media.src is client-supplied. Validate every path resolves INSIDE
    // the uploads dir before handing any of it to ffmpeg — otherwise a crafted
    // src ("/etc/passwd", "http://…") would be arbitrary-file-read / SSRF.
    const byId = new Map<string, string>();
    for (const m of doc.media) {
      byId.set(m.id, await resolveUploadPath(m.src));
    }

    // LUT (.cube) paths are also client-supplied and reach ffmpeg via the SAME
    // resolver (the engine passes `look.lut` / adjustment `grade.lut` through
    // resolveMediaPath → `lut3d=file=…`). Pre-resolve every LUT value the same
    // way so it's provably inside the uploads dir; the sync resolver then serves
    // both media ids and LUT paths (and a LUT with no valid file fails safe).
    const byLut = new Map<string, string>();
    for (const lut of collectLutPaths(doc)) {
      byLut.set(lut, await resolveUploadPath(lut));
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
    return Response.json(
      { error: err instanceof Error ? err.message : "export failed" },
      { status: 500 },
    );
  } finally {
    if (outFile) void unlink(outFile).catch(() => {});
  }
}
