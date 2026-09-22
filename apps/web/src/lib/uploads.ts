import { mkdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

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
 *   2. Serverless (`VERCEL` / AWS Lambda): only `os.tmpdir()` is writable there, and
 *      the ffmpeg export doesn't run on those platforms anyway, so ephemerality is
 *      acceptable — keep the old temp path.
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
