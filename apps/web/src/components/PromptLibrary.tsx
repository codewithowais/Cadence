"use client";

import { useEffect, useMemo, useState } from "react";
import {
  GOALS,
  PROMPT_LIBRARY,
  fuzzyScore,
  ideaAction,
  isAvailable,
  needsLabel,
  type CommandAction,
  type EditorMode,
  type GoalKey,
  type PromptIdea,
} from "@/lib/suggestions";
import { ROOM_COMMANDS } from "@/lib/commands";
import { Overlay } from "./Overlay";

interface PromptLibraryProps {
  open: boolean;
  onClose: () => void;
  mode: EditorMode;
  hasAudio: boolean;
  /** Put a prompt in the composer so it can be tweaked before sending. */
  onInsert: (prompt: string) => void;
  /** Run an idea right away (prompt → Director, room → open it). */
  onRun: (action: CommandAction) => void;
}

type Filter = GoalKey | "all" | "now";

/**
 * "What can I say?" — every verified prompt, browsable by goal and searchable.
 * Clicking an idea drops it into the composer (tweak, then ↵); the ▶ button runs
 * it straight away. Ideas that need footage the project doesn't have are shown
 * with a badge rather than hidden, so the whole product is discoverable.
 */
export function PromptLibrary({ open, onClose, mode, hasAudio, onInsert, onRun }: PromptLibraryProps) {
  const [filter, setFilter] = useState<Filter>("now");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const ideas = useMemo(() => {
    const q = query.trim();
    let list = PROMPT_LIBRARY.map((idea, index) => ({ idea, index, ok: isAvailable(idea.needs, mode, hasAudio) }));
    if (q) {
      list = list
        .map((r) => ({ ...r, score: fuzzyScore(q, `${r.idea.label} ${r.idea.prompt ?? ""}`, r.idea.keywords ?? []) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score || a.index - b.index);
    } else if (filter === "now") {
      // Things you can say first; room shortcuts after.
      list = list.filter((r) => r.ok).sort((a, b) => Number(!!a.idea.room) - Number(!!b.idea.room) || a.index - b.index);
    } else if (filter !== "all") {
      list = list.filter((r) => r.idea.goal === filter).sort((a, b) => Number(b.ok) - Number(a.ok) || a.index - b.index);
    }
    return list;
  }, [query, filter, mode, hasAudio]);

  const nowCount = useMemo(() => PROMPT_LIBRARY.filter((i) => isAvailable(i.needs, mode, hasAudio)).length, [mode, hasAudio]);
  const goalLabel = (g: GoalKey) => GOALS.find((x) => x.key === g)?.label ?? g;

  const filters: { key: Filter; label: string; count?: number }[] = [
    { key: "now", label: "Works now", count: nowCount },
    ...GOALS.map((g) => ({ key: g.key as Filter, label: g.label })),
    { key: "all", label: "Everything", count: PROMPT_LIBRARY.length },
  ];

  const insert = (idea: PromptIdea) => {
    if (idea.prompt) {
      onClose();
      onInsert(idea.prompt);
    } else {
      onClose();
      onRun(ideaAction(idea));
    }
  };

  return (
    <Overlay open={open} onClose={onClose} label="Prompt ideas" panelClassName="max-w-3xl h-[min(640px,86vh)]">
      <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 pb-3 pt-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-text">What can I say?</h2>
          <p className="mt-0.5 text-xs text-muted">
            Pick an idea to drop it in the chat box — change any words, then press ↵. Or tap ▶ to run it now.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close prompt ideas"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-elevated text-muted transition hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="px-5 pt-3">
        <label className="flex items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2 focus-within:border-amber/50">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-faint" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search prompt ideas"
            placeholder="Search ideas — “shorter”, “subtitles”, “music”…"
            className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-faint focus:outline-none focus-visible:outline-none"
          />
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-5 pt-3 md:flex-row">
        <nav aria-label="Idea goals" className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 md:mx-0 md:w-48 md:flex-col md:overflow-y-auto md:px-0">
          {filters.map((f) => {
            const on = !query.trim() && filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => {
                  setFilter(f.key);
                  setQuery("");
                }}
                aria-pressed={on}
                className={[
                  "flex shrink-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition",
                  on ? "bg-teal/10 font-semibold text-teal" : "text-muted hover:bg-elevated hover:text-text",
                ].join(" ")}
              >
                <span className="whitespace-nowrap">{f.label}</span>
                {f.count !== undefined && <span className="tabular-nums text-[10px] text-faint">{f.count}</span>}
              </button>
            );
          })}
        </nav>
        <ul aria-label="Ideas" className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {ideas.length === 0 && (
            <li className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
              No idea matches “{query}” — just type it in the chat box, the Director will try.
            </li>
          )}
          {ideas.map(({ idea, ok }) => {
            const room = idea.room ? ROOM_COMMANDS.find((r) => r.room === idea.room)?.label : null;
            return (
              <li key={idea.id} className={`group flex items-stretch gap-1.5 ${ok ? "" : "opacity-70"}`}>
                <button
                  type="button"
                  onClick={() => insert(idea)}
                  className="min-w-0 flex-1 rounded-xl border border-line bg-elevated px-3 py-2 text-left transition hover:border-amber/40 focus-visible:border-amber/50"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text">{idea.label}</span>
                    {!ok && (
                      <span className="shrink-0 rounded-full border border-line-soft px-1.5 py-px text-[10px] text-faint">{needsLabel(idea.needs)}</span>
                    )}
                    {(query.trim() || filter === "now" || filter === "all") && (
                      <span className="ml-auto hidden shrink-0 text-[10px] text-faint sm:inline">{goalLabel(idea.goal)}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {idea.prompt ? <span className="voice">“{idea.prompt.split("\n")[0]}”</span> : `Opens the ${room} room`}
                  </span>
                </button>
                {idea.prompt && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onRun(ideaAction(idea));
                    }}
                    aria-label={`Run now: ${idea.label}`}
                    title="Run now"
                    className="grid w-10 shrink-0 place-items-center rounded-xl border border-line bg-elevated text-muted transition hover:border-amber/40 hover:bg-amber hover:text-onaccent"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Overlay>
  );
}
