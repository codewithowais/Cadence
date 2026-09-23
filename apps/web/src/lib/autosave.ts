/**
 * Autosave drafts — the PURE half (build / validate / describe). The IndexedDB
 * half lives in media-store.ts and the React wiring in use-autosave.ts.
 *
 * A draft is the recipe (edit-doc) + the media registry + cached transcripts. The
 * media BYTES are stored separately (one record per File) so a doc change never
 * rewrites hundreds of MB, and each File is written exactly once.
 */
import { MediaAsset, docDurationSec, parseEditDoc, type EditDoc } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

export const DRAFT_VERSION = 1;
/** The scratch /editor's single draft slot. */
export const SCRATCH_DRAFT_KEY = "scratch";
/** How long after the last change the draft is written. */
export const AUTOSAVE_DEBOUNCE_MS = 800;

/** What is written to the `drafts` store (structured-clone friendly: plain data). */
export interface DraftRecord {
  v: typeof DRAFT_VERSION;
  key: string;
  savedAt: number;
  doc: EditDoc;
  mediaList: MediaAsset[];
  transcripts: Record<string, Transcript>;
}

/** One persisted media File (the `media` store). */
export interface StoredMedia {
  id: string;
  draftKey: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
  size: number;
}

/** A validated draft, ready to restore. */
export interface ParsedDraft {
  key: string;
  savedAt: number;
  doc: EditDoc;
  mediaList: MediaAsset[];
  transcripts: Record<string, Transcript>;
}

export function buildDraft(input: {
  key: string;
  doc: EditDoc;
  mediaList: MediaAsset[];
  transcripts: Record<string, Transcript>;
  now?: number;
}): DraftRecord {
  return {
    v: DRAFT_VERSION,
    key: input.key,
    savedAt: input.now ?? Date.now(),
    doc: input.doc,
    mediaList: input.mediaList,
    transcripts: input.transcripts,
  };
}

/**
 * Validate an unknown value read back from storage. Returns null for anything
 * that isn't a restorable draft (wrong version, schema-invalid doc) — a corrupt
 * draft must never crash the editor on load. Invalid media entries / transcripts
 * are dropped individually rather than failing the whole draft.
 */
export function parseDraft(raw: unknown): ParsedDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftRecord>;
  if (r.v !== DRAFT_VERSION || typeof r.key !== "string") return null;
  let doc: EditDoc;
  try {
    doc = parseEditDoc(r.doc);
  } catch {
    return null;
  }
  const mediaList: MediaAsset[] = [];
  for (const m of Array.isArray(r.mediaList) ? r.mediaList : []) {
    const p = MediaAsset.safeParse(m);
    if (p.success) mediaList.push(p.data);
  }
  const transcripts: Record<string, Transcript> = {};
  if (r.transcripts && typeof r.transcripts === "object") {
    for (const [id, t] of Object.entries(r.transcripts)) {
      if (t && typeof t === "object" && Array.isArray((t as Transcript).segments)) transcripts[id] = t as Transcript;
    }
  }
  const savedAt = typeof r.savedAt === "number" && Number.isFinite(r.savedAt) ? r.savedAt : 0;
  return { key: r.key, savedAt, doc, mediaList, transcripts };
}

/** Worth offering to restore: something is on the timeline or media was added. */
export function draftHasContent(d: Pick<ParsedDraft, "doc" | "mediaList">): boolean {
  return docDurationSec(d.doc) > 0 || d.mediaList.length > 0 || d.doc.media.length > 0;
}

/** Every media asset the draft knows about (registry ∪ doc.media), de-duplicated. */
export function draftMedia(d: Pick<ParsedDraft, "doc" | "mediaList">): MediaAsset[] {
  const seen = new Set<string>();
  const out: MediaAsset[] = [];
  for (const m of [...d.mediaList, ...d.doc.media]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** Media ids present in `files` that aren't persisted yet (write these). */
export function mediaToPersist(fileIds: Iterable<string>, persisted: ReadonlySet<string>, failed: ReadonlySet<string> = new Set()): string[] {
  return [...fileIds].filter((id) => !persisted.has(id) && !failed.has(id));
}

/** Persisted media ids no longer held by the editor (delete these). */
export function mediaToPrune(persisted: Iterable<string>, fileIds: ReadonlySet<string>): string[] {
  return [...persisted].filter((id) => !fileIds.has(id));
}

/** "just now" · "5 min ago" · "2 h ago" · "yesterday" · "3 days ago". */
export function describeDraftAge(savedAt: number, now: number = Date.now()): string {
  const s = Math.max(0, (now - savedAt) / 1000);
  if (!savedAt || s < 45) return "just now";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d <= 1 ? "yesterday" : `${d} days ago`;
}

/** One-line summary for the recovery banner, e.g. "3 media · 0:42". */
export function draftSummary(d: Pick<ParsedDraft, "doc" | "mediaList">): string {
  const n = draftMedia(d).length;
  const dur = docDurationSec(d.doc);
  const mm = Math.floor(dur / 60);
  const ss = String(Math.floor(dur % 60)).padStart(2, "0");
  const parts: string[] = [];
  if (n > 0) parts.push(`${n} media file${n === 1 ? "" : "s"}`);
  if (dur > 0) parts.push(`${mm}:${ss}`);
  return parts.join(" · ") || "an empty project";
}
