"use client";

import { useEffect, useState } from "react";

interface UndoToastProps {
  /**
   * The toast to show. A new `id` (re)shows the toast and restarts its timer;
   * `null` hides it. `text` is the edit summary (e.g. "Cinematic look applied").
   */
  toast: { id: string; text: string } | null;
  /** Wired to the editor's history undo — reverts the edit the toast announced. */
  onUndo: () => void;
  /** Dismiss (also called after auto-timeout and after Undo). */
  onDismiss: () => void;
  /** How long the toast stays before auto-dismissing (ms). */
  durationMs?: number;
}

/**
 * A small "<summary> · Undo" confirmation shown after a Director edit lands, so
 * the change visibly registers and one tap reverses it. Uses the existing
 * `commit`/history undo — the toast doesn't hold its own snapshot, it just calls
 * `undo()`, which reverts the most recent commit (the edit just made). Auto-
 * dismisses; accessible as an `aria-live` status. Reduced-motion safe (the app's
 * global stylesheet neutralizes the slide, leaving a plain fade).
 */
export function UndoToast({ toast, onUndo, onDismiss, durationMs = 6000 }: UndoToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = window.setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, durationMs);
    return () => window.clearTimeout(t);
    // Restart whenever a new toast id arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id]);

  if (!toast || !visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-[90vw] items-center gap-3 rounded-full border border-line bg-panel/95 py-2 pl-4 pr-2 text-sm text-text shadow-[0_16px_44px_-16px_rgba(24,34,38,0.24)] backdrop-blur">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-teal/15 text-teal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <span className="truncate text-muted">{toast.text}</span>
        <button
          type="button"
          onClick={() => {
            onUndo();
            setVisible(false);
            onDismiss();
          }}
          className="shrink-0 rounded-full border border-amber/40 bg-amber/10 px-3 py-1 text-xs font-semibold text-amber transition hover:bg-amber/20"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => {
            setVisible(false);
            onDismiss();
          }}
          aria-label="Dismiss"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-faint transition hover:text-text"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
