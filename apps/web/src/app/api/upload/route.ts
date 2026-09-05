import { type NextRequest } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

const UPLOAD_DIR = join(tmpdir(), "cadence-uploads");

/**
 * Save an uploaded media file (multipart/form-data, field "file") to a temp dir
 * so the ffmpeg export can read it by a real server path. Returns { id, path }.
 * Free/local only — nothing leaves the machine.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "expected a 'file' field" }, { status: 400 });
    }

    // Keep the original extension (sanitized) so ffmpeg can sniff the container.
    const ext = safeExt(file.name);
    const id = randomUUID();
    await mkdir(UPLOAD_DIR, { recursive: true });
    const path = join(UPLOAD_DIR, `${id}${ext}`);

    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(path, bytes);

    return Response.json({ id, path });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "upload failed" },
      { status: 400 },
    );
  }
}

/** A lowercase, dot-prefixed extension with no path separators, or "". */
function safeExt(name: string): string {
  const e = extname(basename(name)).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(e) ? e : "";
}
