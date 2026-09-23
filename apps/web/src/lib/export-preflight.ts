/**
 * Export PRE-FLIGHT — pure checks run in the browser before any byte is uploaded,
 * so problems surface as clear, actionable messages in the export popover instead
 * of a failed render minutes later. No DOM, no I/O (unit-tested).
 */
import { docDurationSec, type EditDoc, type MediaAsset } from "@cadence/core";

export type PreflightLevel = "error" | "warn";

export interface PreflightIssue {
  level: PreflightLevel;
  /** Stable id (tests / analytics). */
  code: "empty" | "missing-media" | "huge-resolution" | "very-long" | "large-upload";
  message: string;
}

export interface PreflightInput {
  /** True when the editor holds the File for this media id (needed for upload). */
  hasFile: (mediaId: string) => boolean;
  /** Byte size of the File for a media id (0/undefined when unknown). */
  fileBytes?: (mediaId: string) => number | undefined;
  /** Output size after export settings (defaults to doc.meta). */
  output?: { width: number; height: number };
}

export interface PreflightResult {
  /** False when any `error` issue exists — the Export button is disabled. */
  ok: boolean;
  issues: PreflightIssue[];
  /** Media ids some clip actually uses (only these are uploaded). */
  usedMediaIds: string[];
  /** Media assets referenced by clips but whose File isn't loaded. */
  missing: MediaAsset[];
  /** Total bytes that would be uploaded. */
  uploadBytes: number;
}

/** 4K UHD pixel count — above this the free 512 MB server may run out of memory. */
export const HUGE_PIXELS = 3840 * 2160;
/** Longer than this, warn that the render will take a while. */
export const LONG_EXPORT_SEC = 30 * 60;
/** Uploads above this are slow on typical connections (and near Blob caps). */
export const LARGE_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Media ids referenced by any clip (video/image/audio clips carry `mediaId`). */
export function usedMediaIds(doc: EditDoc): string[] {
  const ids = new Set<string>();
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if ((c.kind === "video" || c.kind === "image" || c.kind === "audio") && c.mediaId) ids.add(c.mediaId);
    }
  }
  return [...ids];
}

/**
 * The doc to send to the server: `doc.media` trimmed to assets some clip uses, so
 * a leftover asset (removed from the timeline, or added but never placed) is never
 * uploaded — and can't fail the export when its file isn't loaded.
 */
export function stripUnusedMedia(doc: EditDoc): EditDoc {
  const used = new Set(usedMediaIds(doc));
  if (doc.media.every((m) => used.has(m.id))) return doc;
  return { ...doc, media: doc.media.filter((m) => used.has(m.id)) };
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

function names(list: MediaAsset[]): string {
  const labels = list.map((m) => `“${m.label ?? m.src ?? m.id}”`);
  return labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;
}

export function preflightExport(doc: EditDoc, input: PreflightInput): PreflightResult {
  const issues: PreflightIssue[] = [];
  const duration = docDurationSec(doc);
  const used = usedMediaIds(doc);
  const byId = new Map(doc.media.map((m) => [m.id, m]));

  if (!(duration > 0)) {
    issues.push({ level: "error", code: "empty", message: "Nothing to export yet — add media or make a text video first." });
  }

  const missing: MediaAsset[] = [];
  let uploadBytes = 0;
  for (const id of used) {
    const asset = byId.get(id) ?? ({ id, kind: "video", src: id } as MediaAsset);
    if (!input.hasFile(id)) missing.push(asset);
    else uploadBytes += input.fileBytes?.(id) ?? 0;
  }
  if (missing.length) {
    issues.push({
      level: "error",
      code: "missing-media",
      message:
        `${missing.length === 1 ? "A clip's" : `${missing.length} clips'`} media isn't loaded: ${names(missing)}. ` +
        `Add the same file${missing.length === 1 ? "" : "s"} again (Media room or drag-drop) — it re-links in place.`,
    });
  }

  const out = input.output ?? { width: doc.meta.width, height: doc.meta.height };
  if (out.width * out.height > HUGE_PIXELS) {
    issues.push({
      level: "warn",
      code: "huge-resolution",
      message: `${out.width}×${out.height} is larger than 4K — the render may run out of memory on a small server. Choose a lower quality if it fails.`,
    });
  }
  if (duration > LONG_EXPORT_SEC) {
    issues.push({
      level: "warn",
      code: "very-long",
      message: `This is a ${Math.round(duration / 60)}-minute video — expect a long render. Keep this tab open; you can cancel any time.`,
    });
  }
  if (uploadBytes > LARGE_UPLOAD_BYTES) {
    issues.push({
      level: "warn",
      code: "large-upload",
      message: `About ${fmtBytes(uploadBytes)} of media will be uploaded before rendering — this can take a while.`,
    });
  }

  return { ok: !issues.some((i) => i.level === "error"), issues, usedMediaIds: used, missing, uploadBytes };
}
