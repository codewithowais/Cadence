"use client";

import { useEffect } from "react";

/** The canonical keyboard-shortcut list (also the source for the help popover). */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Space"], label: "Play / pause" },
  { keys: ["←", "→"], label: "Seek ±1s" },
  { keys: ["Shift", "←/→"], label: "Seek ±5s" },
  { keys: ["Home"], label: "Jump to start" },
  { keys: ["S"], label: "Split clip at playhead" },
  { keys: ["Del"], label: "Ripple-delete selected clip" },
  { keys: ["M"], label: "Add marker at playhead" },
  { keys: ["["], label: "Show / hide chat panel" },
  { keys: ["]"], label: "Show / hide code panel" },
  { keys: ["\\"], label: "Focus mode — hide both panels" },
  { keys: ["⌘/Ctrl", "Z"], label: "Undo" },
  { keys: ["⌘/Ctrl", "Shift", "Z"], label: "Redo" },
  { keys: ["?"], label: "This help" },
];

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-line bg-elevated px-1.5 py-0.5 text-[11px] font-medium text-muted shadow-sm">
      {children}
    </kbd>
  );
}

interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-line bg-panel p-5 shadow-[0_16px_44px_-16px_rgba(41,35,28,0.22)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight text-text">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-elevated text-muted transition hover:text-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <ul className="space-y-2.5">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted">{s.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {s.keys.map((k, i) => (
                  <span key={k} className="flex items-center gap-1">
                    {i > 0 && <span className="text-[11px] text-faint">+</span>}
                    <Key>{k}</Key>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] text-faint">Shortcuts are ignored while typing in a field.</p>
      </div>
    </div>
  );
}
