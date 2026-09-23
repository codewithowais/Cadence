"use client";

/**
 * Editing speed & timeline craft — the editor-side state and keyboard map for the
 * CapCut / Premiere / Resolve muscle-memory features:
 *
 *  - transport: J/K/L shuttle (tap again for 2× / 4×), `,` / `.` frame step,
 *    ↑/↓ previous/next cut, ⇧↑/⇧↓ previous/next marker;
 *  - in/out marks (I / O, ⌥X clears) with "remove range" / "keep only range";
 *  - snapping on/off (N), remembered per browser;
 *  - multi-select (⇧/⌘-click, marquee, ⌘A, Esc) with group ripple-delete (Del),
 *    duplicate (⌘D) and nudge (⌥←/→);
 *  - split all tracks (⇧S), close gaps, content-preserving speed presets,
 *    freeze-frame hold (F), copy/paste attributes (⌘⇧C / ⌘⇧V).
 *
 * The playhead, shuttle rate, in/out marks, snapping and selection are UI state —
 * like the playhead they describe how you are working, not what the video is.
 * Everything that changes the VIDEO is a pure doc op routed through the editor's
 * undoable `commit`, exactly like the rest of the timeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { EditDoc } from "@cadence/core";
import {
  attributeGroupsOf,
  closeGap,
  closeGaps,
  copyClipAttributes,
  FREEZE_HOLD_SEC,
  insertFreezeFrame,
  isSequenceTrack,
  keepRange,
  nextEditPoint,
  nextMarkerTime,
  nudgeClips,
  pasteClipAttributes,
  retimeClip,
  rippleDeleteRange,
  splitAllAtTime,
  trackGaps,
  type AttributeGroup,
  type ClipAttributes,
  type TrackGap,
} from "@cadence/director";
import { duplicateClips, findClip, moveClip, rippleDeleteClips, MIN_CLIP_SEC } from "./edit-ops";
import { fmtTime } from "./format";

/** The craft controls the timeline (CutsStrip) renders — see `TimelineEdit.craft`. */
export interface TimelineCraft {
  // ---- snapping ------------------------------------------------------------
  snapping: boolean;
  onToggleSnapping: () => void;
  // ---- transport -----------------------------------------------------------
  /** Current shuttle rate: 0 idle, 1 = normal playback, ±2 / ±4 fast, −1 reverse. */
  shuttleRate: number;
  onPrevCut: () => void;
  onNextCut: () => void;
  // ---- in / out range ------------------------------------------------------
  inPoint: number | null;
  outPoint: number | null;
  onSetIn: () => void;
  onSetOut: () => void;
  onClearInOut: () => void;
  /** Ripple-delete the marked range across every unlocked track. */
  onRemoveRange: () => void;
  /** Keep only the marked range. */
  onKeepRange: () => void;
  // ---- multi-select --------------------------------------------------------
  /** Every selected clip id (the primary selection included), in pick order. */
  selectedIds: string[];
  /** ⇧/⌘-click: add or remove one clip from the selection. */
  onToggleSelect: (clipId: string) => void;
  /** Marquee: select these clips (added to the selection when `additive`). */
  onSelectMany: (clipIds: string[], additive: boolean) => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  onDuplicateSelected: () => void;
  /** Nudge the selection by whole frames (negative = earlier). */
  onNudgeSelected: (frames: number) => void;
  // ---- cutting -------------------------------------------------------------
  onSplitAll: () => void;
  /** Gaps on sequence lanes (drawn as click-to-close blocks). */
  gaps: TrackGap[];
  onCloseGap: (trackId: string, atSec: number) => void;
  onCloseAllGaps: () => void;
  /** Speed preset that keeps the same footage (the clip gets shorter / longer). */
  onRetime: (clipId: string, speed: number) => void;
  /** Insert a freeze-frame hold of the frame at the playhead into this clip. */
  onFreezeFrame: (clipId: string) => void;
  // ---- attributes ----------------------------------------------------------
  /** What's on the attribute clipboard (null = nothing copied yet). */
  attrClipboard: { groups: AttributeGroup[]; sourceKind: string } | null;
  onCopyAttributes: (clipId: string) => void;
  /** Paste onto the selection; `groups` limits what's pasted (default: all copied). */
  onPasteAttributes: (groups?: AttributeGroup[]) => void;
  /** Short, transient confirmation for non-undoable actions (copy, marks, snapping). */
  status: string | null;
}

export interface EditingCraftDeps {
  doc: EditDoc;
  commit: (next: EditDoc | ((prev: EditDoc) => EditDoc), opts?: { coalesce?: string }) => void;
  timeSec: number;
  durationSec: number;
  playing: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setTimeSec: Dispatch<SetStateAction<number>>;
  /** The editor's seek (stops playback, clamps to the timeline). */
  seek: (t: number) => void;
  selectedClipId: string | null;
  setSelectedClipId: (id: string | null) => void;
  /** "<summary> · Undo" toast for doc edits. */
  notify: (text: string) => void;
}

export interface EditingCraft {
  craft: TimelineCraft;
  /**
   * Handle a window keydown for the craft shortcuts. Returns true when the key
   * was consumed (the caller then stops); false lets the editor's own shortcuts
   * run. Call it BEFORE the editor's handler, with its "typing in a field" flag.
   */
  handleKey: (e: KeyboardEvent, typing: boolean) => boolean;
}

const SHUTTLE_STEPS = [1, 2, 4];
const SNAP_KEY = "cadence:snap";

export function useEditingCraft(deps: EditingCraftDeps): EditingCraft {
  const { doc, commit, timeSec, durationSec, playing, setPlaying, setTimeSec, seek, selectedClipId, setSelectedClipId, notify } = deps;
  const fps = Math.max(1, doc.meta.fps || 30);

  // ---- transient status line ----------------------------------------------
  const [status, setStatus] = useState<string | null>(null);
  const statusTimer = useRef<number | null>(null);
  const flash = useCallback((text: string) => {
    setStatus(text);
    if (statusTimer.current != null) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), 2600);
  }, []);
  useEffect(() => () => {
    if (statusTimer.current != null) window.clearTimeout(statusTimer.current);
  }, []);

  // ---- snapping ------------------------------------------------------------
  const [snapping, setSnapping] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(SNAP_KEY) === "0") setSnapping(false);
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);
  const onToggleSnapping = useCallback(() => {
    setSnapping((s) => {
      const next = !s;
      try {
        localStorage.setItem(SNAP_KEY, next ? "1" : "0");
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);
  const snapRef = useRef(snapping);
  useEffect(() => {
    if (snapRef.current !== snapping) flash(snapping ? "Snapping on" : "Snapping off");
    snapRef.current = snapping;
  }, [snapping, flash]);

  // ---- shuttle (J/K/L) -----------------------------------------------------
  // Rate 1 forward is REAL playback (with sound, via `playing`). Every other
  // rate scrubs the picture from a rAF loop (browsers can't play <video>
  // backwards, and fast-forward audio isn't useful when scanning).
  const [loopRate, setLoopRate] = useState(0);
  // The last few playhead positions the shuttle loop itself wrote. A render can
  // lag the loop by a tick, so "is this time ours?" checks the recent window —
  // any other value means someone else seeked (ruler click, ←/→, a room).
  const written = useRef<number[]>([]);
  const timeRef = useRef(timeSec);
  timeRef.current = timeSec;
  useEffect(() => {
    if (loopRate === 0) return;
    let raf = 0;
    let last = performance.now();
    let pos = timeRef.current;
    written.current = [pos];
    const write = (t: number) => {
      written.current.push(t);
      if (written.current.length > 12) written.current.shift();
      setTimeSec(t);
    };
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      pos += dt * loopRate;
      if (pos <= 0 || pos >= durationSec) {
        write(Math.max(0, Math.min(durationSec, pos)));
        setLoopRate(0); // reached an end of the timeline
        return;
      }
      write(pos);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopRate, durationSec, setTimeSec]);
  // A seek from anywhere else (a ruler click, ←/→, a room) stands the shuttle
  // down. The tolerance absorbs a last in-flight tick from normal playback when
  // L steps 1× → 2×; our own frame steps / jumps stop the loop explicitly.
  useEffect(() => {
    if (loopRate === 0) return;
    if (!written.current.some((t) => Math.abs(t - timeSec) < 0.1)) setLoopRate(0);
  }, [timeSec, loopRate]);
  // Normal playback started elsewhere (Space, the Stage button) ends a shuttle.
  useEffect(() => {
    if (playing) setLoopRate(0);
  }, [playing]);
  const shuttleRate = playing ? 1 : loopRate;

  const shuttle = useCallback(
    (dir: 1 | -1 | 0) => {
      if (dir === 0) {
        setLoopRate(0);
        setPlaying(false);
        return;
      }
      const cur = playing ? 1 : loopRate;
      const sameWay = Math.sign(cur) === dir;
      const step = sameWay ? SHUTTLE_STEPS[Math.min(SHUTTLE_STEPS.length - 1, SHUTTLE_STEPS.indexOf(Math.abs(cur)) + 1)]! : 1;
      const rate = step * dir;
      if (rate === 1) {
        setLoopRate(0);
        if (timeSec >= durationSec - 1e-3) setTimeSec(0);
        setPlaying(true);
      } else {
        setPlaying(false);
        setLoopRate(rate);
      }
      flash(rate === 1 ? "Play" : rate === -1 ? "Reverse" : `${rate > 0 ? "Fast forward" : "Rewind"} ${Math.abs(rate)}×`);
    },
    [playing, loopRate, timeSec, durationSec, setPlaying, setTimeSec, flash],
  );

  /** Seek from a craft control: always ends a shuttle first. */
  const jump = useCallback(
    (t: number) => {
      setLoopRate(0);
      seek(t);
    },
    [seek],
  );
  const stepFrames = useCallback((n: number) => jump(timeSec + n / fps), [jump, timeSec, fps]);

  const onPrevCut = useCallback(() => {
    const t = nextEditPoint(doc, timeSec, -1);
    if (t != null) jump(t);
  }, [doc, timeSec, jump]);
  const onNextCut = useCallback(() => {
    const t = nextEditPoint(doc, timeSec, 1);
    if (t != null) jump(t);
  }, [doc, timeSec, jump]);
  const jumpMarker = useCallback(
    (dir: 1 | -1) => {
      const t = nextMarkerTime(doc, timeSec, dir);
      if (t != null) jump(t);
      else flash(dir > 0 ? "No marker after the playhead" : "No marker before the playhead");
    },
    [doc, timeSec, jump, flash],
  );

  // ---- in / out ------------------------------------------------------------
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const onSetIn = useCallback(() => {
    const t = r3(timeSec);
    setInPoint(t);
    if (outPoint != null && outPoint <= t + MIN_CLIP_SEC) setOutPoint(null);
    flash(`In ${fmtTime(t)}`);
  }, [timeSec, outPoint, flash]);
  const onSetOut = useCallback(() => {
    const t = r3(timeSec);
    setOutPoint(t);
    if (inPoint != null && inPoint >= t - MIN_CLIP_SEC) setInPoint(null);
    flash(`Out ${fmtTime(t)}`);
  }, [timeSec, inPoint, flash]);
  const onClearInOut = useCallback(() => {
    setInPoint(null);
    setOutPoint(null);
  }, []);
  // Keep the marks inside the timeline as it changes length.
  useEffect(() => {
    if (inPoint != null && inPoint >= durationSec) setInPoint(null);
    if (outPoint != null && outPoint > durationSec + 1e-3) setOutPoint(durationSec > 0 ? r3(durationSec) : null);
  }, [durationSec, inPoint, outPoint]);
  const range = useMemo((): [number, number] | null => {
    if (inPoint == null && outPoint == null) return null;
    const a = inPoint ?? 0;
    const b = outPoint ?? durationSec;
    return b - a >= MIN_CLIP_SEC ? [a, b] : null;
  }, [inPoint, outPoint, durationSec]);
  const onRemoveRange = useCallback(() => {
    if (!range) return;
    const [a, b] = range;
    setPlaying(false);
    setLoopRate(0);
    commit(rippleDeleteRange(doc, a, b));
    onClearInOut();
    seek(a);
    notify(`Removed ${fmtTime(a)}–${fmtTime(b)} (${(b - a).toFixed(1)}s)`);
  }, [range, doc, commit, seek, notify, onClearInOut, setPlaying]);
  const onKeepRange = useCallback(() => {
    if (!range) return;
    const [a, b] = range;
    setPlaying(false);
    setLoopRate(0);
    commit(keepRange(doc, a, b));
    onClearInOut();
    seek(0);
    notify(`Kept only ${fmtTime(a)}–${fmtTime(b)}`);
  }, [range, doc, commit, seek, notify, onClearInOut, setPlaying]);

  // ---- multi-select --------------------------------------------------------
  const [multi, setMulti] = useState<string[]>([]);
  const selectedIds = useMemo(
    () => (multi.length > 1 ? multi : selectedClipId ? [selectedClipId] : []),
    [multi, selectedClipId],
  );
  // A plain click elsewhere (a clip not in the group) collapses to one clip.
  useEffect(() => {
    if (multi.length === 0) return;
    if (!selectedClipId || !multi.includes(selectedClipId)) setMulti([]);
  }, [selectedClipId, multi]);
  // Drop ids that no longer exist (undo, Director rewrite, delete).
  useEffect(() => {
    if (multi.length === 0) return;
    const alive = multi.filter((id) => findClip(doc, id));
    if (alive.length !== multi.length) setMulti(alive.length > 1 ? alive : []);
  }, [doc, multi]);

  const applySelection = useCallback(
    (ids: string[]) => {
      setMulti(ids.length > 1 ? ids : []);
      setSelectedClipId(ids.length > 0 ? ids[ids.length - 1]! : null);
    },
    [setSelectedClipId],
  );
  const onToggleSelect = useCallback(
    (clipId: string) => {
      const next = selectedIds.includes(clipId) ? selectedIds.filter((id) => id !== clipId) : [...selectedIds, clipId];
      applySelection(next);
    },
    [selectedIds, applySelection],
  );
  const onSelectMany = useCallback(
    (clipIds: string[], additive: boolean) => {
      const next = additive ? [...selectedIds, ...clipIds.filter((id) => !selectedIds.includes(id))] : clipIds;
      applySelection(next);
      if (clipIds.length > 0) flash(`${next.length} clip${next.length === 1 ? "" : "s"} selected`);
    },
    [selectedIds, applySelection, flash],
  );
  const onClearSelection = useCallback(() => applySelection([]), [applySelection]);
  const selectAll = useCallback(() => {
    const ids: string[] = [];
    for (const t of doc.tracks) if (!t.locked && !t.hidden) for (const c of t.clips) ids.push(c.id);
    applySelection(ids);
    flash(`${ids.length} clip${ids.length === 1 ? "" : "s"} selected`);
  }, [doc, applySelection, flash]);

  const onDeleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    setPlaying(false);
    const n = selectedIds.length;
    commit(rippleDeleteClips(doc, selectedIds));
    applySelection([]);
    notify(`Deleted ${n} clip${n === 1 ? "" : "s"}`);
  }, [selectedIds, doc, commit, applySelection, notify, setPlaying]);
  const onDuplicateSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    setPlaying(false);
    const n = selectedIds.length;
    commit(duplicateClips(doc, selectedIds));
    notify(`Duplicated ${n} clip${n === 1 ? "" : "s"}`);
  }, [selectedIds, doc, commit, notify, setPlaying]);
  const onNudgeSelected = useCallback(
    (frames: number) => {
      if (selectedIds.length === 0 || frames === 0) return;
      setPlaying(false);
      if (selectedIds.length === 1) {
        const f = findClip(doc, selectedIds[0]!);
        const magnetic =
          !!f && isSequenceTrack(f.track) && (f.track.kind === "audio" ? f.clip.kind === "audio" : f.clip.kind === "video" || f.clip.kind === "image");
        if (magnetic) {
          commit(moveClip(doc, f!.clip.id, frames < 0 ? "earlier" : "later"));
          return;
        }
      }
      const next = nudgeClips(doc, selectedIds, frames / fps);
      if (next === doc) flash("Clips on the main track stay back to back — drag to reorder them");
      else commit(next, { coalesce: `nudge-${selectedIds.join(",")}` });
    },
    [selectedIds, doc, fps, commit, flash, setPlaying],
  );

  // ---- cutting -------------------------------------------------------------
  const onSplitAll = useCallback(() => {
    setPlaying(false);
    const next = splitAllAtTime(doc, timeSec);
    if (next === doc) {
      flash("Nothing under the playhead to split");
      return;
    }
    commit(next);
    notify(`Split every track at ${fmtTime(timeSec)}`);
  }, [doc, timeSec, commit, notify, flash, setPlaying]);

  const gaps = useMemo(() => trackGaps(doc).filter((g) => !doc.tracks.find((t) => t.id === g.trackId)?.locked), [doc]);
  const onCloseGap = useCallback(
    (trackId: string, atSec: number) => {
      setPlaying(false);
      commit(closeGap(doc, trackId, atSec));
      notify("Closed the gap");
    },
    [doc, commit, notify, setPlaying],
  );
  const onCloseAllGaps = useCallback(() => {
    const n = gaps.length;
    if (n === 0) return;
    setPlaying(false);
    commit(closeGaps(doc));
    notify(`Closed ${n} gap${n === 1 ? "" : "s"}`);
  }, [gaps.length, doc, commit, notify, setPlaying]);

  const onRetime = useCallback(
    (clipId: string, speed: number) => {
      setPlaying(false);
      commit(retimeClip(doc, clipId, speed));
    },
    [doc, commit, setPlaying],
  );

  const onFreezeFrame = useCallback(
    (clipId: string) => {
      const f = findClip(doc, clipId);
      if (!f || f.clip.kind !== "video") return;
      setPlaying(false);
      const next = insertFreezeFrame(doc, clipId, timeSec, FREEZE_HOLD_SEC);
      if (JSON.stringify(next) === JSON.stringify(doc)) {
        flash("Freeze frame needs a video clip on the main track");
        return;
      }
      commit(next);
      notify(`Froze the frame at ${fmtTime(Math.max(f.clip.start, Math.min(timeSec, f.clip.start + f.clip.duration)))} for ${FREEZE_HOLD_SEC}s`);
    },
    [doc, timeSec, commit, notify, flash, setPlaying],
  );
  /** The clip F acts on: the selected video, else the main video under the playhead. */
  const freezeTarget = useCallback((): string | null => {
    if (selectedClipId) {
      const f = findClip(doc, selectedClipId);
      if (f && f.clip.kind === "video") return f.clip.id;
    }
    for (const t of doc.tracks) {
      if (t.kind !== "visual" || !isSequenceTrack(t) || t.locked) continue;
      for (const c of t.clips) if (c.kind === "video" && timeSec >= c.start && timeSec < c.start + c.duration) return c.id;
    }
    return null;
  }, [doc, selectedClipId, timeSec]);

  // ---- attributes ------------------------------------------------------------
  const [clipboard, setClipboard] = useState<ClipAttributes | null>(null);
  const attrClipboard = useMemo(
    () => (clipboard ? { groups: attributeGroupsOf(clipboard), sourceKind: clipboard.sourceKind } : null),
    [clipboard],
  );
  const onCopyAttributes = useCallback(
    (clipId: string) => {
      const a = copyClipAttributes(doc, clipId);
      if (!a) {
        flash("This clip has no attributes to copy");
        return;
      }
      setClipboard(a);
      flash(`Copied ${a.sourceKind} attributes — select clips and paste (⌘⇧V)`);
    },
    [doc, flash],
  );
  const onPasteAttributes = useCallback(
    (groups?: AttributeGroup[]) => {
      if (!clipboard || selectedIds.length === 0) return;
      setPlaying(false);
      const next = pasteClipAttributes(doc, selectedIds, clipboard, groups);
      if (JSON.stringify(next) === JSON.stringify(doc)) {
        flash("Nothing to paste onto this selection");
        return;
      }
      commit(next);
      const n = selectedIds.length;
      notify(`Pasted attributes onto ${n} clip${n === 1 ? "" : "s"}`);
    },
    [clipboard, selectedIds, doc, commit, notify, flash, setPlaying],
  );

  // ---- keyboard ----------------------------------------------------------------
  const handleKey = (e: KeyboardEvent, typing: boolean): boolean => {
    if (typing) return false;
    const mod = e.metaKey || e.ctrlKey;
    const hasContent = durationSec > 0;
    const primary = selectedClipId;
    const consume = (fn: () => void): boolean => {
      e.preventDefault();
      fn();
      return true;
    };

    if (mod) {
      if (e.shiftKey && e.code === "KeyC") return primary ? consume(() => onCopyAttributes(primary)) : false;
      if (e.shiftKey && e.code === "KeyV") return clipboard && selectedIds.length > 0 ? consume(() => onPasteAttributes()) : false;
      if (!e.shiftKey && !e.altKey && e.code === "KeyA" && hasContent) return consume(selectAll);
      if (!e.shiftKey && !e.altKey && e.code === "KeyD" && selectedIds.length > 0) return consume(onDuplicateSelected);
      return false;
    }
    if (e.altKey) {
      if (e.code === "KeyX") return consume(onClearInOut);
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && selectedIds.length > 0) {
        const n = (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
        return consume(() => onNudgeSelected(n));
      }
      return false;
    }
    if (e.key === "Escape") {
      // An open dialog (shortcuts sheet, palette, popover) owns Esc first.
      if (document.querySelector('[role="dialog"]')) return false;
      if (selectedIds.length > 0) return consume(onClearSelection);
      if (inPoint != null || outPoint != null) return consume(onClearInOut);
      return false;
    }
    if (!hasContent) return false;
    // ↑/↓ on a focused slider keep adjusting the slider.
    const onSlider = (e.target as HTMLElement | null)?.getAttribute?.("type") === "range" || (e.target as HTMLElement | null)?.getAttribute?.("role") === "slider";
    if (e.key === "n" || e.key === "N") return consume(onToggleSnapping);
    if (e.key === "j" || e.key === "J") return consume(() => shuttle(-1));
    if (e.key === "k" || e.key === "K") return consume(() => shuttle(0));
    if (e.key === "l" || e.key === "L") return consume(() => shuttle(1));
    if (e.key === " " && loopRate !== 0) return consume(() => shuttle(0));
    if (e.code === "Comma") return consume(() => stepFrames(e.shiftKey ? -10 : -1));
    if (e.code === "Period") return consume(() => stepFrames(e.shiftKey ? 10 : 1));
    if (e.key === "i" || e.key === "I") return consume(onSetIn);
    if (e.key === "o" || e.key === "O") return consume(onSetOut);
    if (e.key === "ArrowUp" && !onSlider) return consume(() => (e.shiftKey ? jumpMarker(-1) : onPrevCut()));
    if (e.key === "ArrowDown" && !onSlider) return consume(() => (e.shiftKey ? jumpMarker(1) : onNextCut()));
    if (e.key === "S" && e.shiftKey) return consume(onSplitAll);
    if (e.key === "f" || e.key === "F") {
      const id = freezeTarget();
      return id ? consume(() => onFreezeFrame(id)) : false;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedIds.length > 1) return consume(onDeleteSelected);
      if (!primary && range) return consume(onRemoveRange);
      return false;
    }
    return false;
  };

  const craft: TimelineCraft = {
    snapping,
    onToggleSnapping,
    shuttleRate,
    onPrevCut,
    onNextCut,
    inPoint,
    outPoint,
    onSetIn,
    onSetOut,
    onClearInOut,
    onRemoveRange,
    onKeepRange,
    selectedIds,
    onToggleSelect,
    onSelectMany,
    onClearSelection,
    onDeleteSelected,
    onDuplicateSelected,
    onNudgeSelected,
    onSplitAll,
    gaps,
    onCloseGap,
    onCloseAllGaps,
    onRetime,
    onFreezeFrame,
    attrClipboard,
    onCopyAttributes,
    onPasteAttributes,
    status,
  };

  return { craft, handleKey };
}
