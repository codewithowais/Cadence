import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** Where /api/upload stores media. The ONLY directory export is allowed to read. */
export const UPLOAD_DIR = join(tmpdir(), "cadence-uploads");

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
