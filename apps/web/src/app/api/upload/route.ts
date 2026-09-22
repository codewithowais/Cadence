import { type NextRequest } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  UPLOAD_DIR,
  blobEnabled,
  BLOB_OWNER_COOKIE,
  isValidOwnerToken,
  newOwnerToken,
  blobOwnerTag,
  blobObjectPath,
} from "@/lib/uploads";

export const runtime = "nodejs";

/**
 * Save an uploaded media file (multipart/form-data, field "file") so the ffmpeg
 * export can read it later. Returns { id, path } where `path` is:
 *  - a PUBLIC Vercel Blob URL when a Blob store is configured (serverless deploys:
 *    upload and export run on different instances, so media must live in shared
 *    storage — a local temp path would be gone by export time), or
 *  - a local server path otherwise (local dev / Docker with a persistent disk).
 * The export route accepts either shape via `resolveMediaToLocalPath`.
 *
 * NOTE: server-side Blob upload streams the file through this function, so on
 * Vercel it is bounded by the ~4.5 MB request-body limit — fine for photos. Larger
 * videos need client-direct Blob upload (a `handleUpload` token route) as a follow-up.
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

    if (blobEnabled()) {
      // Per-client owner token (httpOnly cookie) so only the uploader can later
      // delete these blobs. We store under a HASH of the token, never the token.
      const existing = req.cookies.get(BLOB_OWNER_COOKIE)?.value;
      const owner = isValidOwnerToken(existing) ? existing : newOwnerToken();
      const tag = blobOwnerTag(owner);

      // Shared storage for serverless. Import lazily so local/Docker (no token,
      // package may be absent from the runtime) never touches @vercel/blob.
      const { put } = await import("@vercel/blob");
      const blob = await put(blobObjectPath(tag, `${id}${ext}`), file, {
        access: "public",
        contentType: file.type || undefined,
        addRandomSuffix: false,
      });

      const res = Response.json({ id, path: blob.url });
      if (owner !== existing) {
        // First upload from this client → persist the owner token (httpOnly so it
        // can't be read from JS or a shared doc; Secure since Blob deploys are https).
        res.headers.append(
          "set-cookie",
          `${BLOB_OWNER_COOKIE}=${owner}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
        );
      }
      return res;
    }

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
