"use client";

import { useEffect } from "react";

/** A group heading in the shortcuts sheet. */
export type ShortcutGroup = "Playback" | "Navigate" | "Cut & edit" | "Select" | "Panels";

/** The canonical keyboard-shortcut list (also the source for the help popover). */
export const SHORTCUTS: { keys: string[]; label: string; group: ShortcutGroup }[] = [
  // Playback
  { keys: ["Space"], label: "Play / pause", group: "Playback" },
  { keys: ["L"], label: "Play forward — tap again for 2× / 4×", group: "Playback" },
  { keys: ["J"], label: "Play backward — tap again for 2× / 4×", group: "Playback" },
  { keys: ["K"], label: "Stop", group: "Playback" },
  // Navigate
  { keys: ["← / →"], label: "Seek ±1s", group: "Navigate" },
  { keys: ["Shift", "← / →"], label: "Seek ±5s", group: "Navigate" },
  { keys: [", / ."], label: "Step one frame back / forward", group: "Navigate" },
  { keys: ["Shift", ", / ."], label: "Step 10 frames", group: "Navigate" },
  { keys: ["↑ / ↓"], label: "Previous / next cut", group: "Navigate" },
  { keys: ["Shift", "↑ / ↓"], label: "Previous / next marker", group: "Navigate" },
  { keys: ["Home"], label: "Jump to start", group: "Navigate" },
  // Cut & edit
  { keys: ["S"], label: "Split clip at playhead", group: "Cut & edit" },
  { keys: ["Shift", "S"], label: "Split all tracks at playhead", group: "Cut & edit" },
  { keys: ["I / O"], label: "Mark in / out", group: "Cut & edit" },
  { keys: ["⌥/Alt", "X"], label: "Clear in / out", group: "Cut & edit" },
  { keys: ["Del"], label: "Ripple-delete selection (or the in/out range)", group: "Cut & edit" },
  { keys: ["F"], label: "Freeze frame here (2s hold)", group: "Cut & edit" },
  { keys: ["N"], label: "Snapping on / off", group: "Cut & edit" },
  { keys: ["M"], label: "Add marker at playhead", group: "Cut & edit" },
  { keys: ["⌘/Ctrl", "D"], label: "Duplicate selection", group: "Cut & edit" },
  { keys: ["⌥/Alt", "← / →"], label: "Nudge selection one frame (Shift = 10)", group: "Cut & edit" },
  { keys: ["⌘/Ctrl", "Shift", "C"], label: "Copy clip attributes", group: "Cut & edit" },
  { keys: ["⌘/Ctrl", "Shift", "V"], label: "Paste attributes onto selection", group: "Cut & edit" },
  { keys: ["⌘/Ctrl", "Z"], label: "Undo", group: "Cut & edit" },
  { keys: ["⌘/Ctrl", "Shift", "Z"], label: "Redo", group: "Cut & edit" },
  // Select
  { keys: ["Shift/⌘", "Click"], label: "Add / remove a clip from the selection", group: "Select" },
  { keys: ["Shift", "Drag"], label: "Marquee-select clips (drag from the ruler or an empty lane)", group: "Select" },
  { keys: ["⌘/Ctrl", "A"], label: "Select every clip", group: "Select" },
  { keys: ["Esc"], label: "Clear the selection / in-out marks", group: "Select" },
  // Panels
  { keys: ["["], label: "Show / hide chat panel", group: "Panels" },
  { keys: ["]"], label: "Show / hide code panel", group: "Panels" },
  { keys: ["\\"], label: "Focus mode — hide both panels", group: "Panels" },
  { keys: ["⌘/Ctrl", "K"], label: "Command palette (search every action)", group: "Panels" },
  { keys: ["?"], label: "This help", group: "Panels" },
];

const GROUP_ORDER: ShortcutGroup[] = ["Playback", "Navigate", "Cut & edit", "Select", "Panels"];

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
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-panel p-5 shadow-[0_16px_44px_-16px_rgba(24,34,38,0.22)]"
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
        <div className="-mr-2 grid min-h-0 gap-x-8 gap-y-5 overflow-y-auto pr-2 sm:grid-cols-2">
          {GROUP_ORDER.map((group) => (
            <section key={group} aria-label={group}>
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">{group}</h3>
              <ul className="space-y-2">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
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
            </section>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-faint">Shortcuts are ignored while typing in a field.</p>
      </div>
    </div>
  );
}
