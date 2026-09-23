"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EditDoc } from "@cadence/core";
import type { Message } from "@/lib/types";
import {
  closestIdeas,
  getIdea,
  ideaAction,
  nextSteps,
  recallRecent,
  type CommandAction,
  type EditorMode,
} from "@/lib/suggestions";
import { loadRecentPrompts, rememberPrompt } from "@/lib/recent-prompts";
import { NextSteps, type Chip } from "./NextSteps";
import { PromptLibrary } from "./PromptLibrary";

interface DirectorRailProps {
  messages: Message[];
  busy: boolean;
  /** A verb describing what `busy` is doing ("Applying your edit…", "Rendering…"). */
  busyLabel?: string;
  hasMedia: boolean;
  onSend: (text: string) => void;
  onFiles: (files: File[]) => void;
  /** When an export is running, a handler to cancel it (shows a Cancel button). */
  onCancel?: () => void;
  /** Collapse the chat rail to its slim re-open stub (shortcut: `[`). */
  onCollapse?: () => void;
  // ---- first-run ease & discoverability (all optional → the rail still works bare) ----
  /** What the project is — drives context-aware suggestions. */
  mode?: EditorMode;
  /** The live doc (next steps never suggest what's already applied). */
  doc?: EditDoc;
  /** An audio file is in the project (music suggestions become available). */
  hasAudio?: boolean;
  /** Run a suggestion / checklist CTA through the editor's existing paths. */
  onRunAction?: (action: CommandAction) => void;
  /** The "What can I say?" prompt library (controlled so ⌘K can open it). */
  libraryOpen?: boolean;
  onLibraryOpenChange?: (open: boolean) => void;
  /** Open the ⌘K command palette. */
  onOpenPalette?: () => void;
  /** The getting-started checklist, pinned above the conversation. */
  checklist?: ReactNode;
}

/** One-tap text-video starters (no media needed) — prompts come from the library. */
const TEXT_STARTERS: { id: string; label: string; hint: string }[] = [
  { id: "tv-announce", label: "Announcement", hint: "bold, animated" },
  { id: "tv-quote", label: "Quote", hint: "elegant serif" },
  { id: "tv-list", label: "Tips list", hint: "vertical, for Reels" },
  { id: "tv-neon", label: "Neon promo", hint: "glowing signs" },
];

export function DirectorRail({
  messages,
  busy,
  busyLabel,
  hasMedia,
  onSend,
  onFiles,
  onCancel,
  onCollapse,
  mode = hasMedia ? "video" : "none",
  doc,
  hasAudio = false,
  onRunAction,
  libraryOpen = false,
  onLibraryOpenChange,
  onOpenPalette,
  checklist,
}: DirectorRailProps) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Composer history: null = the live draft; n = the n-th most recent prompt.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef("");
  const [mod, setMod] = useState("⌘");

  useEffect(() => {
    if (typeof navigator !== "undefined" && !/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) setMod("Ctrl");
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Grow the composer with its content (capped by max-h via CSS).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const run = (a: CommandAction) => {
    if (onRunAction) onRunAction(a);
    else if (a.type === "prompt") onSend(a.prompt);
  };

  function submit() {
    const t = text.trim();
    // Describe-first: a request typed BEFORE media exists is allowed — the editor
    // queues it and runs it the moment footage loads. Only `busy` blocks send.
    if (!t || busy) return;
    rememberPrompt(t);
    onSend(t);
    setText("");
    setHistoryIndex(null);
    draftRef.current = "";
  }

  /** ↑ / ↓ walk recent prompts when the caret is on the first / last line. */
  function onHistoryKey(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    const el = e.currentTarget;
    const before = el.value.slice(0, el.selectionStart);
    const after = el.value.slice(el.selectionEnd);
    const onFirstLine = !before.includes("\n");
    const onLastLine = !after.includes("\n");
    if (e.key === "ArrowUp" && onFirstLine && (historyIndex !== null || el.value.trim() === "" || el.selectionStart === 0)) {
      const list = loadRecentPrompts();
      const step = recallRecent(list, historyIndex, "older");
      if (step.text === null) return false;
      if (historyIndex === null) draftRef.current = el.value;
      setHistoryIndex(step.index);
      setText(step.text);
      return true;
    }
    if (e.key === "ArrowDown" && onLastLine && historyIndex !== null) {
      const step = recallRecent(loadRecentPrompts(), historyIndex, "newer");
      setHistoryIndex(step.index);
      setText(step.text ?? draftRef.current);
      return true;
    }
    return false;
  }

  const insertPrompt = (prompt: string) => {
    setText(prompt);
    setHistoryIndex(null);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(prompt.length, prompt.length));
    }
  };

  // The replies to the latest request get the recovery / next-step chips.
  const lastYou = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "you") return i;
    return -1;
  }, [messages]);
  const last = messages[messages.length - 1];
  const currentHasRecovery = messages.slice(lastYou + 1).some((m) => m.kind === "unmatched" || m.kind === "failed");
  const showNext = !busy && !!doc && !!last && last.role === "director" && !currentHasRecovery && mode !== "none";
  const next: Chip[] = useMemo(
    () => (showNext && doc ? nextSteps({ doc, mode, lastTools: last?.tools ?? [], hasAudio }) : []),
    [showNext, doc, mode, last, hasAudio],
  );

  const openLibrary = onLibraryOpenChange ? () => onLibraryOpenChange(true) : undefined;

  return (
    <aside className="flex h-full w-full flex-col border-r border-line-soft bg-panel/40">
      {/* Slim, functional header (brand mark lives once in the rooms rail). */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-faint">Director</div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse the chat panel"
            title="Collapse chat ( [ )"
            className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-line hover:text-text"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 6l-6 6 6 6M18 6l-6 6 6 6" /></svg>
          </button>
        )}
      </div>

      {checklist}

      {/* Conversation */}
      <div ref={scrollRef} role="log" aria-label="Conversation with the Director" className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && !hasMedia && (
          <div className="mt-2 rounded-2xl border border-dashed border-line bg-elevated/40 p-6 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-amber/10 text-amber">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M8 8l4-4 4 4M4 20h16" /></svg>
            </div>
            <p className="text-sm text-text">Add a video — or photos</p>
            <p className="mx-auto mt-1 max-w-[16rem] text-xs text-muted">
              Edit a video, or turn a group of photos into one. You can even
              describe the edit below first — I&apos;ll run it the moment your
              footage loads. No timeline knowledge needed.
            </p>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="mt-4 rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright"
            >
              Choose video or photos
            </button>
            <div className="mt-5 border-t border-line-soft pt-4 text-left">
              <p className="text-xs font-medium text-text">…or make a video from words</p>
              <p className="mt-0.5 text-[11px] text-faint">No footage needed — tap one, or type your own script.</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {TEXT_STARTERS.map((s) => {
                  const prompt = getIdea(s.id)?.prompt;
                  if (!prompt) return null;
                  return (
                    <button
                      key={s.label}
                      type="button"
                      disabled={busy}
                      onClick={() => onSend(prompt)}
                      className="rounded-lg border border-line bg-elevated px-3 py-1.5 text-left text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-50"
                    >
                      <span className="font-medium text-text">{s.label}</span> — {s.hint}
                    </button>
                  );
                })}
              </div>
              {openLibrary && (
                <button
                  type="button"
                  onClick={openLibrary}
                  className="mt-3 text-[11px] font-medium text-amber underline-offset-2 hover:underline"
                >
                  See everything I can do →
                </button>
              )}
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          const current = i > lastYou;
          return (
            <div key={m.id} className={m.role === "you" ? "text-right" : "text-left"}>
              {m.kind === "unmatched" && m.request ? (
                <UnmatchedReply
                  message={m}
                  current={current}
                  mode={mode}
                  hasAudio={hasAudio}
                  busy={busy}
                  onRun={run}
                  onBrowse={openLibrary}
                />
              ) : (
                <div
                  className={[
                    "inline-block max-w-[92%] whitespace-pre-line rounded-2xl px-3.5 py-2.5 text-sm",
                    m.role === "you"
                      ? "voice bg-elevated text-text"
                      : m.tone === "error"
                        ? "border border-danger/30 bg-danger/10 text-danger"
                        : m.tone === "edit"
                          ? "border border-teal/25 bg-teal/10 text-text"
                          : "bg-elevated/60 text-muted",
                  ].join(" ")}
                >
                  {m.text}
                </div>
              )}
              {m.kind === "failed" && m.request && current && !busy && (
                <div className="mt-1.5">
                  <NextSteps
                    title="Oops"
                    ariaLabel="Recover from the error"
                    busy={busy}
                    chips={[{ id: "retry", label: "Try again", action: { type: "prompt", prompt: m.request } }]}
                    onRun={run}
                  />
                </div>
              )}
            </div>
          );
        })}

        {busy && (
          <div className="flex items-center gap-1.5 text-xs text-faint" role="status" aria-live="polite">
            <Dot /> <Dot delay="0.15s" /> <Dot delay="0.3s" />
            <span className="ml-1">{busyLabel || "Director is editing…"}</span>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="ml-2 rounded-full border border-line bg-elevated px-2.5 py-0.5 text-[11px] text-muted transition hover:border-danger/40 hover:text-danger"
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {next.length > 0 && (
          <NextSteps
            title="Next"
            ariaLabel="Suggested next steps"
            busy={busy}
            chips={next}
            onRun={run}
            more={openLibrary ? { label: "More ideas", onClick: openLibrary } : undefined}
          />
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-line-soft p-3">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-elevated px-2 py-2 focus-within:border-amber/40">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title={hasMedia ? "Add/replace media" : "Add video or photos"}
            aria-label={hasMedia ? "Add or replace media" : "Add video or photos"}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-line hover:text-text"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10M14 3v6h6M10 13l3 3 4-5" /></svg>
          </button>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setHistoryIndex(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
                return;
              }
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                if (onHistoryKey(e)) e.preventDefault();
              }
            }}
            rows={1}
            aria-label="Describe the edit"
            aria-describedby="composer-hint"
            placeholder={hasMedia ? "Describe the edit…" : "Describe a video — e.g. “text video: …” — or add footage"}
            disabled={busy}
            className="max-h-32 min-h-[2rem] flex-1 resize-none bg-transparent py-1 text-sm text-text placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !text.trim()}
            aria-label="Send"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber text-onaccent transition hover:bg-amber-bright disabled:opacity-30"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
          </button>
        </div>
        <div id="composer-hint" className="mt-1.5 flex items-center gap-2 px-1 text-[11px] text-faint">
          {openLibrary && (
            <button
              type="button"
              onClick={openLibrary}
              className="flex items-center gap-1 rounded-md font-medium text-muted transition hover:text-amber"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" /></svg>
              What can I say?
            </button>
          )}
          <span className="ml-auto hidden items-center gap-2 sm:flex">
            <span>↑ recent</span>
            {onOpenPalette && (
              <button type="button" onClick={onOpenPalette} className="rounded-md transition hover:text-text" title="Search every action">
                {mod}K all actions
              </button>
            )}
          </span>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="video/*,image/*,audio/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />

      {onLibraryOpenChange && (
        <PromptLibrary
          open={libraryOpen}
          onClose={() => onLibraryOpenChange(false)}
          mode={mode}
          hasAudio={hasAudio}
          onInsert={insertPrompt}
          onRun={run}
        />
      )}
    </aside>
  );
}

/** "I didn't catch that" — the closest things the Director CAN do, one tap each. */
function UnmatchedReply({
  message,
  current,
  mode,
  hasAudio,
  busy,
  onRun,
  onBrowse,
}: {
  message: Message;
  current: boolean;
  mode: EditorMode;
  hasAudio: boolean;
  busy: boolean;
  onRun: (a: CommandAction) => void;
  onBrowse?: () => void;
}) {
  const ideas = useMemo(() => closestIdeas(message.request ?? "", { mode, hasAudio }), [message.request, mode, hasAudio]);
  const chips: Chip[] = ideas.map((i) => ({ id: i.id, label: i.label, action: ideaAction(i) }));
  return (
    <div className="inline-block max-w-[92%] space-y-2 rounded-2xl bg-elevated/60 px-3.5 py-2.5 text-left text-sm text-muted">
      <p>
        I&apos;m not sure how to do <span className="voice text-text">“{message.request}”</span> yet.
        {chips.length > 0 && current ? " Closest things I can do:" : ""}
      </p>
      {current && (
        <NextSteps
          title="Try"
          ariaLabel="Closest things I can do"
          busy={busy}
          chips={chips}
          onRun={onRun}
          more={onBrowse ? { label: "See all ideas", onClick: onBrowse } : undefined}
        />
      )}
      <details className="text-xs">
        <summary className="cursor-pointer select-none text-faint hover:text-muted">More examples</summary>
        <p className="mt-1.5 whitespace-pre-line">{message.text}</p>
      </details>
    </div>
  );
}

function Dot({ delay = "0s" }: { delay?: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber"
      style={{ animationDelay: delay }}
    />
  );
}
