"use client";

import { useCallback, useMemo, useState } from "react";
import type { EditDoc } from "@cadence/core";

/**
 * Bounded undo/redo history for the edit-doc — the editor's single source of
 * truth. EVERY doc mutation (Director result, color slider, nudge, room action,
 * title rename) must route through `commit`, so history stays consistent.
 *
 * Design notes:
 *  - No-op guard: committing a doc deep-equal to the present one is dropped, so
 *    we never push a duplicate step (e.g. re-applying the same preset).
 *  - Coalescing: rapid successive commits sharing a `coalesce` key (a slider
 *    drag) collapse into a SINGLE undo step — the baseline stays the pre-drag
 *    doc — instead of flooding the stack with one entry per pixel.
 *  - Pure updater: all bookkeeping (lastKey/lastTime) lives INSIDE the state
 *    object, never in a ref mutated from within the updater, so React 18
 *    StrictMode's double-invoked updaters can't corrupt it.
 *  - `reset` replaces the doc AND clears history — used when the whole project
 *    changes (new media loaded), where an undo into the old doc would reference
 *    media whose object URLs have been revoked.
 */

const LIMIT = 100;
const COALESCE_MS = 600;

const docEqual = (a: EditDoc, b: EditDoc): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

interface HState {
  past: EditDoc[];
  present: EditDoc;
  future: EditDoc[];
  /** Coalesce key of the last commit, for merging rapid slider drags. */
  lastKey: string | null;
  lastTime: number;
}

export interface DocHistory {
  doc: EditDoc;
  /**
   * Apply a new doc (value or updater). Pushes the previous doc onto the undo
   * stack and clears redo — unless it's a no-op, or it coalesces with the
   * previous commit (same `coalesce` key within a short window).
   */
  commit: (next: EditDoc | ((prev: EditDoc) => EditDoc), opts?: { coalesce?: string }) => void;
  /** Replace the doc and clear all history (new project / new media). */
  reset: (doc: EditDoc) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useDocHistory(initial: EditDoc): DocHistory {
  const [state, setState] = useState<HState>(() => ({
    past: [],
    present: initial,
    future: [],
    lastKey: null,
    lastTime: 0,
  }));

  const commit = useCallback<DocHistory["commit"]>((next, opts) => {
    const now = Date.now();
    const coalesce = opts?.coalesce;
    setState((s) => {
      const nextDoc = typeof next === "function" ? next(s.present) : next;
      if (docEqual(nextDoc, s.present)) return s; // drop no-ops
      const canMerge =
        coalesce != null && coalesce === s.lastKey && now - s.lastTime < COALESCE_MS;
      const past = canMerge ? s.past : [...s.past, s.present].slice(-LIMIT);
      return { past, present: nextDoc, future: [], lastKey: coalesce ?? null, lastTime: now };
    });
  }, []);

  const reset = useCallback((doc: EditDoc) => {
    setState({ past: [], present: doc, future: [], lastKey: null, lastTime: 0 });
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      if (s.past.length === 0) return s;
      const prev = s.past[s.past.length - 1]!;
      return {
        past: s.past.slice(0, -1),
        present: prev,
        future: [s.present, ...s.future],
        lastKey: null,
        lastTime: 0,
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      if (s.future.length === 0) return s;
      const nextDoc = s.future[0]!;
      return {
        past: [...s.past, s.present].slice(-LIMIT),
        present: nextDoc,
        future: s.future.slice(1),
        lastKey: null,
        lastTime: 0,
      };
    });
  }, []);

  return useMemo(
    () => ({
      doc: state.present,
      commit,
      reset,
      undo,
      redo,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
    }),
    [state.present, state.past.length, state.future.length, commit, reset, undo, redo],
  );
}
