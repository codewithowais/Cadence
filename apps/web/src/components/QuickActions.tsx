"use client";

import { useMemo } from "react";
import type { EditDoc } from "@cadence/core";
import { docFacts, type DocFacts } from "@/lib/suggestions";

interface QuickActionsProps {
  mode: "video" | "images" | "text" | "none";
  busy: boolean;
  onAction: (prompt: string) => void;
  /** The live doc — chips already applied get a quiet check (name unchanged). */
  doc?: EditDoc;
  /** Open the full "What can I say?" prompt library. */
  onMore?: () => void;
}

/** Which doc fact shows a chip is already applied. */
const APPLIED: Record<string, (f: DocFacts) => boolean> = {
  "9:16": (f) => f.portrait,
  Captions: (f) => f.captions,
  Music: (f) => f.music,
  "Fade in/out": (f) => f.fades,
  "Make 4K": (f) => f.quality,
};

interface Action {
  label: string;
  icon: string;
  prompt: string;
}

const VIDEO_ACTIONS: Action[] = [
  { label: "Highlight", icon: "M8 5v14l11-7z", prompt: "cut a 60-second highlight of the best parts" },
  { label: "Remove filler", icon: "M4 7h16M4 12h10M4 17h7", prompt: "remove the filler words and pauses" },
  { label: "9:16", icon: "M8 3h8v18H8z", prompt: "make it vertical 9:16" },
  { label: "Captions", icon: "M4 5h16v14H4z M7 10h4 M7 14h7", prompt: "add captions" },
  { label: "Cinematic", icon: "M3 7h18M3 12h18M3 17h18", prompt: "give it a cinematic look" },
  { label: "Punch-in", icon: "M11 4a7 7 0 105 12l4 4 M11 8v6 M8 11h6", prompt: "punch in for emphasis at 2s" },
  { label: "B-roll", icon: "M3 5h18v14H3z M13 12h6v5h-6z", prompt: "add b-roll as picture-in-picture" },
  { label: "Kinetic title", icon: "M4 6h16 M9 6v12 M12 18l4-4 M12 14l4 4", prompt: 'add an animated title that says "Cadence"' },
  { label: "Music", icon: "M9 18V5l10-2v13 M9 18a3 3 0 11-6 0 3 3 0 016 0z M19 16a3 3 0 11-6 0 3 3 0 016 0z", prompt: "add background music" },
  { label: "Fade in/out", icon: "M3 12h18 M6 6l0 12 M18 6l0 12", prompt: "add a fade in and out" },
  { label: "Auto-mix", icon: "M4 10v4 M9 6v12 M14 8v8 M19 10v4", prompt: "auto-mix the audio" },
  { label: "Make 4K", icon: "M12 3l2.5 5 5.5.8-4 3.9 1 5.4L12 21l-5-2.6 1-5.4-4-3.9 5.5-.8z", prompt: "make it 4K high quality" },
];

const IMAGE_ACTIONS: Action[] = [
  { label: "Slideshow", icon: "M4 5h16v11H4z M8 20h8", prompt: "make a slideshow from my photos" },
  { label: "9:16", icon: "M8 3h8v18H8z", prompt: "make it vertical 9:16" },
  { label: "Warm look", icon: "M12 3a9 9 0 100 18 4 4 0 010-8 4 4 0 000-8z", prompt: "give it a warm look" },
  { label: "Vintage", icon: "M4 5h16v14H4z M4 9h16", prompt: "vintage look" },
  { label: "Kinetic title", icon: "M4 6h16 M9 6v12 M12 18l4-4 M12 14l4 4", prompt: 'add an animated title that says "Cadence"' },
  { label: "Music", icon: "M9 18V5l10-2v13 M9 18a3 3 0 11-6 0 3 3 0 016 0z M19 16a3 3 0 11-6 0 3 3 0 016 0z", prompt: "add background music" },
  { label: "Fade in/out", icon: "M3 12h18 M6 6l0 12 M18 6l0 12", prompt: "add a fade in and out" },
  { label: "Make 4K", icon: "M12 3l2.5 5 5.5.8-4 3.9 1 5.4L12 21l-5-2.6 1-5.4-4-3.9 5.5-.8z", prompt: "make it high quality 4K" },
];

const TEXT_ACTIONS: Action[] = [
  { label: "Letters pop", icon: "M4 18l4-12 4 12 M5.5 14h5 M15 18V8 M15 8a3 3 0 016 0v10", prompt: "letters pop in one by one" },
  { label: "Words rise", icon: "M12 20V6 M7 11l5-5 5 5", prompt: "words rise in one by one" },
  { label: "Typewriter", icon: "M4 6h16v10H4z M8 20h8 M7 10h2 M11 10h2 M15 10h2", prompt: "typewriter text" },
  { label: "Neon glow", icon: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5L18 18", prompt: "neon glow text" },
  { label: "Gradient text", icon: "M4 17l8-12 8 12z", prompt: "gradient text" },
  { label: "Aurora bg", icon: "M3 17c4-8 14-8 18 0 M6 14c3-4 9-4 12 0", prompt: "aurora background" },
  { label: "Wiggle", icon: "M3 12c3-6 6 6 9 0s6 6 9 0", prompt: "add a wiggle to the text" },
  { label: "9:16", icon: "M8 3h8v18H8z", prompt: "make it vertical 9:16" },
  { label: "Slower", icon: "M12 6v6l4 2 M12 21a9 9 0 110-18 9 9 0 010 18z", prompt: "make the text animation slower" },
  { label: "Music", icon: "M9 18V5l10-2v13 M9 18a3 3 0 11-6 0 3 3 0 016 0z M19 16a3 3 0 11-6 0 3 3 0 016 0z", prompt: "add background music" },
  { label: "Make 4K", icon: "M12 3l2.5 5 5.5.8-4 3.9 1 5.4L12 21l-5-2.6 1-5.4-4-3.9 5.5-.8z", prompt: "make it 4K high quality" },
];

export function QuickActions({ mode, busy, onAction, doc, onMore }: QuickActionsProps) {
  const facts = useMemo(() => (doc ? docFacts(doc) : null), [doc]);
  if (mode === "none") return null;
  const actions = mode === "images" ? IMAGE_ACTIONS : mode === "text" ? TEXT_ACTIONS : VIDEO_ACTIONS;
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">one-tap</span>
      {actions.map((a) => {
        const applied = !!facts && !!APPLIED[a.label]?.(facts);
        return (
          <button
            key={a.label}
            type="button"
            disabled={busy}
            onClick={() => onAction(a.prompt)}
            title={applied ? `${a.label} — already applied (tap to redo)` : a.prompt}
            className={[
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition hover:border-amber/40 hover:text-text disabled:opacity-50",
              applied ? "border-teal/30 bg-teal/5 text-teal" : "border-line bg-elevated text-muted",
            ].join(" ")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={applied ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={applied ? "M5 12l5 5L20 7" : a.icon} />
            </svg>
            {a.label}
          </button>
        );
      })}
      {onMore && (
        <button
          type="button"
          onClick={onMore}
          aria-label="More one-tap ideas"
          title="Browse everything the Director can do"
          className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium text-amber transition hover:bg-amber/10"
        >
          More
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      )}
    </div>
  );
}
