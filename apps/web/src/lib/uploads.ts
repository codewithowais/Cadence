import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";

/**
 * Resolve the directory /api/upload writes media to and /api/export reads it back
 * from. It MUST survive between those two independent HTTP requests and across app
 * restarts — otherwise a just-uploaded file is gone by export time and the user hits
 * {@link MediaNotOnServerError}.
 *
 * We deliberately do NOT use `os.tmpdir()`: on macOS `/var/folders/.../T` is auto-
 * reaped (files unused for ~3 days are deleted), so uploads silently vanish between
 * sessions and mid-session if a restart intervenes. A stable per-user dir under the
 * home directory is never reaped and persists across dev-server restarts.
 *
 * Resolution order:
 *   1. `CADENCE_MEDIA_DIR` — operator override (Docker: point at a mounted volume so
 *      uploads also survive container recreation). Shared with the transcriber's
 *      trust root — see `mediaBaseDir()` in @cadence/understanding.
 *   2. Serverless (`VERCEL` / AWS Lambda): only `os.tmpdir()` is writable. On these
 *      platforms upload and export run on DIFFERENT instances that don't share a
 *      disk, so this local dir is only a scratch space — durable media lives in
 *      Vercel Blob (see {@link resolveMediaToLocalPath}). Downloaded blobs and, on a
 *      warm instance, direct disk uploads land here transiently.
 *   3. Otherwise (local + Docker): a persistent `~/.cadence/uploads`.
 *
 * KEEP IN SYNC with `mediaBaseDir()` in
 * packages/understanding/src/whisper-transcriber.ts — both are the media trust root.
 */
function resolveUploadDir(): string {
  const configured = process.env.CADENCE_MEDIA_DIR?.trim();
  if (configured) return configured;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return join(tmpdir(), "cadence-uploads");
  }
  return join(homedir(), ".cadence", "uploads");
}

/** Where /api/upload stores media. The ONLY directory export is allowed to read. */
export const UPLOAD_DIR = resolveUploadDir();

/** Raised when a media file the doc references isn't on the server's disk. */
export class MediaNotOnServerError extends Error {
  readonly code = "MEDIA_NOT_ON_SERVER";
  constructor(label?: string) {
    super(
      `The media file for “${label ?? "this clip"}” isn't on the server anymore. ` +
        `Re-add the media in the editor and export again.`,
    );
    this.name = "MediaNotOnServerError";
  }
}

/**
 * Resolve a client-supplied media path to a real path that is provably INSIDE
 * the uploads dir — or throw. The export route hands media paths to ffmpeg, so
 * without this a crafted `media.src` ("/etc/passwd", "http://…") would be an
 * arbitrary-file-read / SSRF. realpath() also collapses symlinks and "..".
 *
 * ROBUSTNESS: the uploads dir is a transient temp dir. It can be absent at export
 * time — a cleared /tmp, or (on serverless) an export invocation that never saw
 * the upload invocation's disk. We `mkdir` the base first so resolving it never
 * throws a cryptic `ENOENT realpath '/tmp/cadence-uploads'`; a genuinely-missing
 * media FILE then surfaces as a clear {@link MediaNotOnServerError} the UI can act
 * on, instead of an opaque fs error. `label` (the media's name) makes it friendly.
 */
export async function resolveUploadPath(clientPath: string, label?: string): Promise<string> {
  // Ensure the trust root exists so realpath(base) can't ENOENT. A freshly-created
  // empty dir just means no valid uploads live here yet — the per-file check below
  // then fails with the clear MediaNotOnServerError rather than a raw fs error.
  await mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});
  const base = await realpath(UPLOAD_DIR);

  let real: string;
  try {
    real = await realpath(clientPath);
  } catch {
    // File isn't on disk (cleared temp, wrong invocation, never uploaded).
    throw new MediaNotOnServerError(label);
  }
  if (real !== base && !real.startsWith(base + sep)) {
    // Resolves outside the uploads dir → treat as an injection attempt.
    throw new Error("invalid media path");
  }
  return real;
}

// ---------------------------------------------------------------------------
// Vercel Blob (shared storage for serverless deploys)
//
// On Vercel, /api/upload and /api/export run on separate instances with separate
// /tmp, so a locally-written upload is gone by export time ("media not on server").
// When a Blob store is configured we upload to Blob (global) and, at export time,
// download each blob into THIS invocation's disk so ffmpeg can read a real file.
// Locally / in Docker no token is set, so everything stays on the disk path above.
// ---------------------------------------------------------------------------

/** Safety cap for a single downloaded media file. */
const MAX_BLOB_BYTES = 300 * 1024 * 1024; // 300 MB

/** True when Vercel Blob is configured — i.e. the deploy has shared storage. */
export function blobEnabled(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/** Top-level namespace for every blob this app stores. */
export const BLOB_PREFIX = "cadence-uploads";

/** Name of the httpOnly cookie holding a client's opaque blob-owner token. */
export const BLOB_OWNER_COOKIE = "cadence_bid";

/** A valid owner token is a UUID we minted — never trust an arbitrary cookie value. */
export function isValidOwnerToken(token: string | undefined | null): token is string {
  return typeof token === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token);
}

/** Mint a fresh owner token (for a client that has none yet). */
export function newOwnerToken(): string {
  return randomUUID();
}

/**
 * The path tag that marks blob ownership. It is a HASH of the secret owner token,
 * so the token itself never appears in a (public) blob URL — a shared doc leaks only
 * the tag, and deletion requires re-presenting the token that hashes to it.
 */
export function blobOwnerTag(ownerToken: string): string {
  return createHash("sha256").update(ownerToken).digest("hex").slice(0, 32);
}

/** Pathname for a blob owned by `ownerTag`: `cadence-uploads/<tag>/<name>`. */
export function blobObjectPath(ownerTag: string, name: string): string {
  return `${BLOB_PREFIX}/${ownerTag}/${name}`;
}

/**
 * Authorization gate for deletion: true iff `blobUrl` is one WE stored under this
 * exact owner tag. The export route computes the tag from the CALLER's own cookie
 * token, so a doc carrying another client's blob URLs can never drive their deletion
 * (IDOR) — the tags won't match.
 */
export function blobBelongsToOwner(blobUrl: string, ownerTag: string): boolean {
  if (!ownerTag) return false;
  try {
    return new URL(blobUrl).pathname.startsWith(`/${BLOB_PREFIX}/${ownerTag}/`);
  } catch {
    return false;
  }
}

/**
 * A PUBLIC Vercel Blob URL, e.g.
 * `https://<store-id>.public.blob.vercel-storage.com/<path>`. Only this exact host
 * shape is ever fetched server-side — anything else stays subject to the local
 * realpath/containment guard, so a crafted `media.src` can't turn into SSRF.
 */
function isVercelBlobUrl(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === "https:" && u.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

/** A lowercase, dot-prefixed extension from a blob URL's path, or "". */
function safeUrlExt(u: URL): string {
  const e = extname(u.pathname).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(e) ? e : "";
}

/**
 * Resolve a doc's `media.src` to a real LOCAL file path ffmpeg can read.
 *  - A Vercel Blob URL → download it into the uploads dir and return that path
 *    (`downloaded: true` so the caller can delete it after the export).
 *  - Anything else → a local uploaded path, validated inside the uploads dir by
 *    {@link resolveUploadPath} exactly as before.
 * This is the single entry point the export route uses for every media + LUT path,
 * so both the serverless (Blob) and local/Docker (disk) deploys work unchanged.
 */
export async function resolveMediaToLocalPath(
  src: string,
  label?: string,
): Promise<{ path: string; downloaded: boolean }> {
  if (isVercelBlobUrl(src)) {
    const u = new URL(src);
    await mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});
    const dest = join(UPLOAD_DIR, `${randomUUID()}${safeUrlExt(u)}`);
    let res: Response;
    try {
      // `redirect: "manual"` so a 3xx can't bounce an allow-listed Blob URL to a
      // non-allow-listed host (SSRF): we only ever validated the FIRST hop. Blob
      // public URLs serve bytes directly, so any redirect is treated as invalid.
      res = await fetch(src, { redirect: "manual" });
    } catch {
      throw new MediaNotOnServerError(label);
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new MediaNotOnServerError(label);
    }
    if (!res.ok) throw new MediaNotOnServerError(label);
    // Reject an oversized body BEFORE buffering it into memory (DoS). Content-Length
    // is advisory, so the post-buffer byteLength check below stays as a backstop.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) {
      throw new Error("media file too large");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BLOB_BYTES) throw new Error("media file too large");
    await writeFile(dest, buf);
    return { path: dest, downloaded: true };
  }
  return { path: await resolveUploadPath(src, label), downloaded: false };
}
