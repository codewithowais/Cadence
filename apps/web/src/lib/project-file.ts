/**
 * Portable project files (`.cadence.json`) — PURE build / parse / media re-link.
 *
 * A project file is the recipe, not the footage: a versioned envelope around the
 * edit-doc plus the media registry (names, durations, sizes). Opening one restores
 * the whole edit; the media files are re-linked by adding them again (matched by
 * file name), so a project can move between browsers/machines. Plain edit-doc JSON
 * (the older "Duplicate as new" download) opens too.
 */
import { MediaAsset, parseEditDoc, type EditDoc } from "@cadence/core";

export const PROJECT_FILE_FORMAT = "cadence.project";
export const PROJECT_FILE_VERSION = 1;
/** Refuse absurd inputs before JSON.parse (a recipe is KBs, not MBs). */
export const MAX_PROJECT_FILE_BYTES = 20 * 1024 * 1024;

export interface ProjectFile {
  format: typeof PROJECT_FILE_FORMAT;
  version: typeof PROJECT_FILE_VERSION;
  savedAt: string;
  doc: EditDoc;
  mediaList: MediaAsset[];
}

export type ParsedProject = { ok: true; doc: EditDoc; mediaList: MediaAsset[] } | { ok: false; error: string };

export function buildProjectFile(doc: EditDoc, mediaList: MediaAsset[], now: Date = new Date()): ProjectFile {
  // The registry may hold assets the doc doesn't (added, not yet placed) and vice
  // versa (restored by undo) — keep the union so nothing is forgotten.
  const seen = new Set<string>();
  const media: MediaAsset[] = [];
  for (const m of [...mediaList, ...doc.media]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    media.push(m);
  }
  return { format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION, savedAt: now.toISOString(), doc, mediaList: media };
}

/** "My trip" → "My-trip.cadence.json" (filesystem-safe). */
export function projectFileName(title: string | undefined): string {
  const base = (title || "cadence").trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "cadence";
  return `${base}.cadence.json`;
}

export function parseProjectFile(text: string): ParsedProject {
  if (text.length > MAX_PROJECT_FILE_BYTES) return { ok: false, error: "That file is too large to be a Cadence project." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't valid JSON — pick a .cadence.json project file." };
  }
  if (!raw || typeof raw !== "object") return { ok: false, error: "That isn't a Cadence project file." };
  const o = raw as Record<string, unknown>;
  const isEnvelope = o.format === PROJECT_FILE_FORMAT;
  if (isEnvelope && o.version !== PROJECT_FILE_VERSION) {
    return { ok: false, error: `This project was saved by a newer Cadence (format v${String(o.version)}). Update and try again.` };
  }
  const docRaw = isEnvelope ? o.doc : o;
  if (!isEnvelope && !Array.isArray(o.tracks)) return { ok: false, error: "That isn't a Cadence project file." };
  let doc: EditDoc;
  try {
    doc = parseEditDoc(docRaw);
  } catch {
    return { ok: false, error: "That project file is damaged — its edit couldn't be read." };
  }
  const mediaList: MediaAsset[] = [];
  const list = isEnvelope && Array.isArray(o.mediaList) ? o.mediaList : doc.media;
  for (const m of list) {
    const p = MediaAsset.safeParse(m);
    if (p.success) mediaList.push(p.data);
  }
  return { ok: true, doc, mediaList };
}

const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * Pair newly added files with media the project references but has no File for,
 * by file name (the asset's `src`/`label` is the original name). Each asset and
 * each file is used at most once; kinds must agree when the file type is known.
 * Returns file index → media id.
 */
export function matchFilesToMissing(
  files: readonly { name: string; type?: string }[],
  missing: readonly MediaAsset[],
): Map<number, string> {
  const out = new Map<number, string>();
  const taken = new Set<string>();
  files.forEach((f, i) => {
    const name = norm(f.name);
    if (!name) return;
    const family = f.type?.split("/")[0];
    const hit = missing.find(
      (m) =>
        !taken.has(m.id) &&
        (norm(m.src) === name || norm(m.label) === name) &&
        (!family || (family === "video" && m.kind === "video") || (family === "image" && m.kind === "image") || (family === "audio" && m.kind === "audio")),
    );
    if (hit) {
      taken.add(hit.id);
      out.set(i, hit.id);
    }
  });
  return out;
}
