"use client";

/**
 * Editor-side glue for timeline drag-and-drop: the drop mode (insert / overwrite),
 * the callbacks the timeline calls on a drop / move (each one a pure doc op from
 * `timeline-dnd.ts` routed through the editor's undoable `commit`), and the
 * drop-on-preview handlers for the Stage. Keeps `Editor.tsx` to a few wiring lines.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { EditDoc, MediaAsset } from "@cadence/core";
import { hasDropPayload, readDropPayload } from "./dnd-payload";
import {
  dropItemIntoDoc,
  moveClipsGroup,
  placeClip,
  type DropMode,
  type DropPayload,
} from "./timeline-dnd";
import { findClip } from "./edit-ops";

const MODE_KEY = "cadence:dropMode";

/** What the timeline (CutsStrip) calls — see `TimelineEdit.dnd`. */
export interface TimelineDnd {
  /** Where dropped / moved clips go: "insert" (ripple on the main lane) or "overwrite". */
  mode: DropMode;
  onSetMode: (m: DropMode) => void;
  /** Look a media asset up by id (drop previews need its duration). */
  getMedia: (mediaId: string) => MediaAsset | undefined;
  /** Media id → playable URL (filmstrip thumbnails + audio waveforms read these). */
  mediaUrls: Record<string, string>;
  /** Drop a palette item (media / text style / sticker / graphic) on a lane at a time. */
  onDropItem: (payload: DropPayload, o: { trackId: string; startSec: number; mode?: DropMode }) => boolean;
  /** Move one clip to a lane + time (same lane = reposition / reorder). */
  onPlaceClip: (clipId: string, trackId: string, startSec: number, mode?: DropMode) => boolean;
  /** Move a multi-selection as one unit (mouse group-drag). */
  onMoveGroup: (ids: string[], o: { deltaSec: number; laneSteps: number; blockIndex: number | null; mode?: DropMode }) => boolean;
}

export interface TimelineDndDeps {
  doc: EditDoc;
  commit: (next: EditDoc | ((prev: EditDoc) => EditDoc), opts?: { coalesce?: string }) => void;
  notify: (text: string) => void;
  setPlaying: (v: boolean) => void;
  setSelectedClipId: (id: string | null) => void;
  projectMedia: MediaAsset[];
  urls: Record<string, string>;
  timeSec: number;
}

export interface TimelineDndApi {
  dnd: TimelineDnd;
  /** Spread on a wrapper around the preview: dropping a palette item adds it as an overlay. */
  stageDrop: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
}

/** The preview frame (the element carrying the composition aspect ratio) inside `root`. */
function previewFrame(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[style*="aspect-ratio"]');
}

export function useTimelineDnd(deps: TimelineDndDeps): TimelineDndApi {
  const { doc, commit, notify, setPlaying, setSelectedClipId, projectMedia, urls, timeSec } = deps;
  const [mode, setMode] = useState<DropMode>("insert");
  useEffect(() => {
    try {
      if (localStorage.getItem(MODE_KEY) === "overwrite") setMode("overwrite");
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);
  const onSetMode = useCallback((m: DropMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* noop */
    }
  }, []);

  const getMedia = useCallback((id: string) => projectMedia.find((m) => m.id === id) ?? doc.media.find((m) => m.id === id), [projectMedia, doc.media]);

  const onDropItem = useCallback(
    (payload: DropPayload, o: { trackId: string; startSec: number; mode?: DropMode }): boolean => {
      const media = payload.type === "media" ? getMedia(payload.mediaId) : undefined;
      const res = dropItemIntoDoc(doc, payload, { startSec: o.startSec, trackId: o.trackId, mode: o.mode ?? mode, media });
      if (!res) {
        notify("That can't go on this track");
        return false;
      }
      setPlaying(false);
      commit(res.doc);
      if (res.clipId) setSelectedClipId(res.clipId);
      notify(res.summary);
      return true;
    },
    [doc, mode, getMedia, commit, notify, setPlaying, setSelectedClipId],
  );

  const onPlaceClip = useCallback(
    (clipId: string, trackId: string, startSec: number, m?: DropMode): boolean => {
      const next = placeClip(doc, clipId, trackId, startSec, m ?? mode);
      // A drop back where it started is not an edit (no empty undo step).
      if (next === doc || JSON.stringify(next) === JSON.stringify(doc)) return false;
      setPlaying(false);
      commit(next);
      return true;
    },
    [doc, mode, commit, setPlaying],
  );

  const onMoveGroup = useCallback(
    (ids: string[], o: { deltaSec: number; laneSteps: number; blockIndex: number | null; mode?: DropMode }): boolean => {
      const next = moveClipsGroup(doc, ids, { deltaSec: o.deltaSec, laneSteps: o.laneSteps, mode: o.mode ?? mode, blockIndex: o.blockIndex });
      if (JSON.stringify(next) === JSON.stringify(doc)) return false;
      setPlaying(false);
      commit(next);
      notify(`Moved ${ids.length} clips`);
      return true;
    },
    [doc, mode, commit, notify, setPlaying],
  );

  const dnd: TimelineDnd = { mode, onSetMode, getMedia, mediaUrls: urls, onDropItem, onPlaceClip, onMoveGroup };

  // ---- drop on the preview (Stage) → overlay at the drop point --------------------
  const hint = useRef<HTMLDivElement | null>(null);
  const outlined = useRef<HTMLElement | null>(null);
  const clearHint = useCallback(() => {
    hint.current?.remove();
    hint.current = null;
    if (outlined.current) {
      outlined.current.style.outline = "";
      outlined.current.style.outlineOffset = "";
      outlined.current = null;
    }
  }, []);
  useEffect(() => clearHint, [clearHint]);

  // Audio has no picture to place, but still lands on a free audio lane at the playhead.
  const acceptsStage = (e: DragEvent<HTMLElement>): boolean => hasDropPayload(e.dataTransfer);

  const onDragOver = (e: DragEvent<HTMLElement>): void => {
    if (!acceptsStage(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const frame = previewFrame(e.currentTarget);
    if (frame && outlined.current !== frame) {
      if (outlined.current) outlined.current.style.outline = "";
      frame.style.outline = "2px dashed var(--color-amber)";
      frame.style.outlineOffset = "-2px";
      outlined.current = frame;
    }
    if (!hint.current) {
      const el = document.createElement("div");
      el.setAttribute("data-testid", "stage-drop-hint");
      el.setAttribute("aria-hidden", "true");
      el.textContent = "Drop to add as an overlay";
      el.style.cssText =
        "position:fixed;z-index:70;pointer-events:none;padding:3px 8px;border-radius:999px;font:600 11px system-ui,sans-serif;background:var(--color-amber);color:var(--color-onaccent, #111);box-shadow:0 4px 14px rgba(0,0,0,.4)";
      document.body.appendChild(el);
      hint.current = el;
    }
    hint.current.style.left = `${e.clientX + 14}px`;
    hint.current.style.top = `${e.clientY + 14}px`;
  };
  const onDragLeave = (e: DragEvent<HTMLElement>): void => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    clearHint();
  };
  const onDrop = (e: DragEvent<HTMLElement>): void => {
    if (!hasDropPayload(e.dataTransfer)) return;
    const payload = readDropPayload(e.dataTransfer);
    const frame = previewFrame(e.currentTarget) ?? e.currentTarget;
    const r = frame.getBoundingClientRect();
    clearHint();
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation();
    const xFrac = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    const yFrac = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
    const media = payload.type === "media" ? getMedia(payload.mediaId) : undefined;
    const res = dropItemIntoDoc(doc, payload, { startSec: Math.max(0, timeSec), trackId: null, mode: "insert", at: { xFrac, yFrac }, media });
    if (!res) {
      notify("Couldn't add that to the preview");
      return;
    }
    setPlaying(false);
    commit(res.doc);
    if (res.clipId) setSelectedClipId(res.clipId);
    // The clip may have been created off-screen of the playhead; make sure the user sees why it is there.
    const f = res.clipId ? findClip(res.doc, res.clipId) : null;
    notify(f ? `${res.summary} at ${f.clip.start.toFixed(1)}s` : res.summary);
  };

  return { dnd, stageDrop: { onDragOver, onDragLeave, onDrop } };
}
