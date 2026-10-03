"use client";

import { useState } from "react";
import type { EditDoc } from "@cadence/core";
import { GENRE_LABELS, isTextVideo, storyboardOf } from "@cadence/director";
import { openPromptStudio, STUDIO_EXAMPLES } from "@/lib/prompt-studio-bus";

/**
 * The Text room's "Describe" tab: start a video from one sentence (opens the studio), and — once
 * a video exists — the refinement chips. Chips send ordinary phrases to the Director, so they
 * work (and undo) exactly like typing them.
 */
export function PromptVideoPane({ doc, busy, onAction }: { doc: EditDoc; busy: boolean; onAction: (prompt: string) => void }) {
  const [text, setText] = useState("");
  const board = storyboardOf(doc);
  const text0 = isTextVideo(doc);

  const chips: { label: string; prompt: string; needsBoard?: boolean }[] = [
    { label: "Regenerate", prompt: "regenerate it with fresh copy", needsBoard: true },
    { label: "Make it punchier", prompt: "make it punchier" },
    { label: "Make it shorter", prompt: "make it shorter" },
    { label: "Make it longer", prompt: "make it longer", needsBoard: true },
    { label: "Different style", prompt: "give it a different style" },
  ];

  return (
    <div className="flex flex-col gap-3" aria-label="Describe your video">
      <div>
        <h3 className="text-xs font-semibold text-text">Make a whole video from one sentence</h3>
        <p className="mt-0.5 text-[11px] text-faint">I plan the scenes and write the copy. You review the storyboard, then it's built — with or without your photos.</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          openPromptStudio({ prompt: text.trim() || undefined });
          setText("");
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Describe your video"
          placeholder="30s Instagram promo for my coffee shop…"
          className="voice min-w-0 flex-1 rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-text placeholder:text-faint"
        />
        <button type="submit" className="shrink-0 rounded-lg bg-amber px-3 py-2 text-xs font-semibold text-onaccent transition hover:bg-amber-bright">
          Open studio
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-faint">Try:</span>
        {STUDIO_EXAMPLES.slice(0, 5).map((ex) => (
          <button
            key={ex.label}
            type="button"
            onClick={() => openPromptStudio({ prompt: ex.prompt })}
            className="rounded-full border border-line bg-elevated px-2.5 py-1 text-[11px] text-muted transition hover:border-amber/40 hover:text-text"
          >
            {ex.label}
          </button>
        ))}
      </div>

      {(board || text0) && (
        <div className="border-t border-line-soft pt-3">
          {board && (
            <p className="mb-2 text-[11px] text-muted">
              Made from <span className="voice text-text">“{board.prompt}”</span> · {GENRE_LABELS[board.genre]}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Refine the video">
            {chips
              .filter((c) => !c.needsBoard || board)
              .map((c) => (
                <button
                  key={c.label}
                  type="button"
                  disabled={busy}
                  onClick={() => onAction(c.prompt)}
                  className="rounded-full border border-line bg-elevated px-2.5 py-1 text-[11px] text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-50"
                >
                  {c.label}
                </button>
              ))}
            {board && (
              <button
                type="button"
                onClick={() => openPromptStudio({ review: true })}
                className="rounded-full border border-teal/40 bg-teal/10 px-2.5 py-1 text-[11px] font-medium text-teal transition hover:bg-teal/20"
              >
                Review storyboard
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
