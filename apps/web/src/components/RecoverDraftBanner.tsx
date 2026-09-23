"use client";

import { useState } from "react";
import { describeDraftAge, draftSummary, type ParsedDraft } from "@/lib/autosave";

interface RecoverDraftBannerProps {
  draft: ParsedDraft;
  onRestore: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
}

/**
 * "Restore your last session?" — shown on load when the scratch editor finds an
 * autosaved draft. Non-modal (never steals focus); autosave stays paused until the
 * user chooses, so ignoring it can't overwrite the saved session.
 */
export function RecoverDraftBanner({ draft, onRestore, onDiscard }: RecoverDraftBannerProps) {
  const [working, setWorking] = useState<"restore" | "discard" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const title = draft.doc.meta.title?.trim() || "Untitled";

  const run = async (which: "restore" | "discard") => {
    setWorking(which);
    try {
      await (which === "restore" ? onRestore() : onDiscard());
    } finally {
      setWorking(null);
    }
  };

  return (
    <section
      aria-label="Restore your last session"
      className="flex flex-wrap items-center gap-3 border-b border-teal/25 bg-teal/[0.07] px-4 py-2.5"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-teal/15 text-teal" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>
      </span>
      <div className="min-w-0 flex-1 text-xs leading-snug">
        <p className="font-semibold text-text">
          Welcome back — restore your last session?
        </p>
        <p className="truncate text-muted">
          <span className="voice text-text">“{title}”</span> · {draftSummary(draft)} · saved {describeDraftAge(draft.savedAt)}.{" "}
          <span className="text-faint">Autosave is paused until you choose.</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {confirmDiscard ? (
          <>
            <span className="text-[11px] text-muted">Delete it for good?</span>
            <button
              type="button"
              onClick={() => void run("discard")}
              disabled={working !== null}
              className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs font-semibold text-danger transition hover:bg-danger/15 disabled:opacity-50"
            >
              {working === "discard" ? "Discarding…" : "Yes, discard"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDiscard(false)}
              className="rounded-lg border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:text-text"
            >
              Keep it
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirmDiscard(true)}
              disabled={working !== null}
              className="rounded-lg border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:text-text disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void run("restore")}
              disabled={working !== null}
              className="rounded-lg bg-amber px-3 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:opacity-50"
            >
              {working === "restore" ? "Restoring…" : "Restore session"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
