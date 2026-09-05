import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** Where /api/upload stores media. The ONLY directory export is allowed to read. */
export const UPLOAD_DIR = join(tmpdir(), "cadence-uploads");

/**
 * Resolve a client-supplied media path to a real path that is provably INSIDE
 * the uploads dir — or throw. The export route hands media paths to ffmpeg, so
 * without this a crafted `media.src` ("/etc/passwd", "http://…") would be an
 * arbitrary-file-read / SSRF. realpath() also collapses symlinks and "..".
 */
export async function resolveUploadPath(clientPath: string): Promise<string> {
  const base = await realpath(UPLOAD_DIR); // uploads dir must exist (created on first upload)
  let real: string;
  try {
    real = await realpath(clientPath);
  } catch {
    throw new Error("invalid media path");
  }
  if (real !== base && !real.startsWith(base + sep)) {
    throw new Error("invalid media path");
  }
  return real;
}
