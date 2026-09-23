"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EditDoc, MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";
import {
  AUTOSAVE_DEBOUNCE_MS,
  buildDraft,
  draftHasContent,
  mediaToPersist,
  mediaToPrune,
  parseDraft,
  type ParsedDraft,
} from "./autosave";
import {
  deleteDraft,
  deleteStoredMedia,
  getDraftRecord,
  getStoredMedia,
  openAutosaveDb,
  putDraftRecord,
  putStoredMedia,
  storedToFile,
} from "./media-store";

export type AutosaveStatus =
  /** Not enabled for this editor (project-bound editors save to the DB). */
  | "off"
  /** Looking for a previous session on load. */
  | "checking"
  /** A previous session is on offer; saving is paused until the user chooses. */
  | "pending"
  | "idle"
  | "saving"
  | "saved"
  /** IndexedDB unusable (private mode / blocked storage) — work isn't kept. */
  | "unavailable"
  | "error";

export interface AutosaveState {
  status: AutosaveStatus;
  lastSavedAt: number | null;
  /** The recoverable previous session, while `status === "pending"`. */
  offer: ParsedDraft | null;
  /** Media (labels) that couldn't be kept because storage is full. */
  unsavedMedia: string[];
}

export interface RestoredSession {
  draft: ParsedDraft;
  files: Record<string, File>;
  /** Media the draft references whose bytes weren't stored (re-add to relink). */
  missing: MediaAsset[];
}

interface Options {
  enabled: boolean;
  draftKey: string;
  doc: EditDoc;
  mediaList: MediaAsset[];
  transcripts: Record<string, Transcript>;
  files: Record<string, File>;
}

/**
 * Autosave + crash recovery for the scratch editor. Debounces the recipe into
 * IndexedDB, writes each media File once, prunes Files the editor dropped, flushes
 * on tab hide, and on load offers the previous session (pausing saves until the
 * user restores or discards, so opening a fresh tab never clobbers the draft).
 */
export function useAutosave({ enabled, draftKey, doc, mediaList, transcripts, files }: Options) {
  const [state, setState] = useState<AutosaveState>({
    status: enabled ? "checking" : "off",
    lastSavedAt: null,
    offer: null,
    unsavedMedia: [],
  });
  const active = enabled && (state.status === "idle" || state.status === "saving" || state.status === "saved" || state.status === "error");

  // Latest values for the debounced / flush writers.
  const latest = useRef({ doc, mediaList, transcripts, files });
  latest.current = { doc, mediaList, transcripts, files };
  const persisted = useRef<Set<string>>(new Set());
  const failed = useRef<Set<string>>(new Set());
  const mediaChain = useRef<Promise<void>>(Promise.resolve());

  // ---- 1. On load: look for a previous session --------------------------------
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const db = await openAutosaveDb();
      if (cancelled) return;
      if (!db) {
        setState((s) => ({ ...s, status: "unavailable" }));
        return;
      }
      const raw = await getDraftRecord(draftKey);
      const draft = raw ? parseDraft(raw) : null;
      if (cancelled) return;
      if (raw && !draft) await deleteDraft(draftKey); // corrupt / old-format draft
      if (draft && draftHasContent(draft)) {
        setState((s) => ({ ...s, status: "pending", offer: draft }));
      } else {
        // Nothing to offer: clear any stale/orphaned media rows from an old session.
        await deleteDraft(draftKey);
        persisted.current = new Set();
        setState((s) => ({ ...s, status: "idle" }));
      }
    })().catch(() => {
      if (!cancelled) setState((s) => ({ ...s, status: "unavailable" }));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, draftKey]);

  // ---- 2. Write the recipe (debounced) ------------------------------------------
  const writeDraft = useCallback(async (): Promise<void> => {
    const { doc: d, mediaList: ml, transcripts: tr } = latest.current;
    const empty = !draftHasContent({ doc: d, mediaList: ml });
    setState((s) => ({ ...s, status: "saving" }));
    let ok: boolean;
    if (empty) {
      // Nothing worth restoring (fresh or "Start over") → no stale banner next time.
      await deleteDraft(draftKey);
      persisted.current = new Set();
      ok = true;
    } else {
      ok = await putDraftRecord(buildDraft({ key: draftKey, doc: d, mediaList: ml, transcripts: tr }));
    }
    setState((s) => ({ ...s, status: ok ? "saved" : "error", lastSavedAt: ok ? Date.now() : s.lastSavedAt }));
  }, [draftKey]);

  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => void writeDraft(), AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc, mediaList, transcripts, writeDraft]);

  // ---- 3. Persist / prune media Files (each written once, serialized) -----------
  useEffect(() => {
    if (!active) return;
    const ids = new Set(Object.keys(files));
    mediaChain.current = mediaChain.current.then(async () => {
      const toPrune = mediaToPrune(persisted.current, ids);
      if (toPrune.length) {
        await deleteStoredMedia(toPrune);
        for (const id of toPrune) persisted.current.delete(id);
      }
      for (const id of mediaToPersist(ids, persisted.current, failed.current)) {
        const file = latest.current.files[id];
        if (!file) continue;
        if (await putStoredMedia(draftKey, id, file)) persisted.current.add(id);
        else failed.current.add(id);
      }
      if (failed.current.size) {
        const labels = [...failed.current].map((id) => latest.current.files[id]?.name ?? id);
        setState((s) => ({ ...s, unsavedMedia: labels }));
      }
    }).catch(() => {});
  }, [active, files, draftKey]);

  // ---- 4. Flush when the tab is hidden / closed (best effort) -------------------
  useEffect(() => {
    if (!active) return;
    const flush = () => {
      if (document.visibilityState === "hidden") void writeDraft();
    };
    const onPageHide = () => void writeDraft();
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [active, writeDraft]);

  // ---- 5. The user's choice ------------------------------------------------------
  /** Load the offered session's media Files; the caller applies doc + media. */
  const restore = useCallback(async (): Promise<RestoredSession | null> => {
    const draft = state.offer;
    if (!draft) return null;
    const rows = await getStoredMedia(draftKey);
    const restored: Record<string, File> = {};
    for (const row of rows) {
      try {
        restored[row.id] = storedToFile(row);
      } catch {
        /* unreadable row → treated as missing */
      }
    }
    const known = new Map<string, MediaAsset>();
    for (const m of [...draft.mediaList, ...draft.doc.media]) known.set(m.id, m);
    const missing = [...known.values()].filter((m) => !restored[m.id]);
    persisted.current = new Set(Object.keys(restored));
    failed.current = new Set();
    setState((s) => ({ ...s, status: "idle", offer: null }));
    return { draft, files: restored, missing };
  }, [state.offer, draftKey]);

  const discard = useCallback(async (): Promise<void> => {
    await deleteDraft(draftKey);
    persisted.current = new Set();
    failed.current = new Set();
    setState((s) => ({ ...s, status: "idle", offer: null }));
  }, [draftKey]);

  return { ...state, restore, discard, flush: writeDraft };
}
