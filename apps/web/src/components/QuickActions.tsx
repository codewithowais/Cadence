"use client";

interface QuickActionsProps {
  mode: "video" | "images" | "none";
  busy: boolean;
  onAction: (prompt: string) => void;
}

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
  { label: "Auto-mix", icon: "M4 10v4 M9 6v12 M14 8v8 M19 10v4", prompt: "auto-mix the audio" },
  { label: "Make 4K", icon: "M12 3l2.5 5 5.5.8-4 3.9 1 5.4L12 21l-5-2.6 1-5.4-4-3.9 5.5-.8z", prompt: "make it 4K high quality" },
];

const IMAGE_ACTIONS: Action[] = [
  { label: "Slideshow", icon: "M4 5h16v11H4z M8 20h8", prompt: "make a slideshow from my photos" },
  { label: "9:16", icon: "M8 3h8v18H8z", prompt: "make it vertical 9:16" },
  { label: "Warm look", icon: "M12 3a9 9 0 100 18 4 4 0 010-8 4 4 0 000-8z", prompt: "give it a warm look" },
  { label: "Cinematic", icon: "M3 7h18M3 12h18M3 17h18", prompt: "cinematic look" },
  { label: "Make 4K", icon: "M12 3l2.5 5 5.5.8-4 3.9 1 5.4L12 21l-5-2.6 1-5.4-4-3.9 5.5-.8z", prompt: "make it high quality 4K" },
];

export function QuickActions({ mode, busy, onAction }: QuickActionsProps) {
  if (mode === "none") return null;
  const actions = mode === "images" ? IMAGE_ACTIONS : VIDEO_ACTIONS;
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-faint">one-tap</span>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          disabled={busy}
          onClick={() => onAction(a.prompt)}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d={a.icon} />
          </svg>
          {a.label}
        </button>
      ))}
    </div>
  );
}
