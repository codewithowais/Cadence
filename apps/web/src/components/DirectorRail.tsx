"use client";

import { useEffect, useRef, useState } from "react";
import type { Message } from "@/lib/types";

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
}

const SUGGESTIONS = [
  "Cut a 60-second highlight of the best parts",
  "Make it vertical with captions",
  "Give it a cinematic look",
];

export function DirectorRail({ messages, busy, busyLabel, hasMedia, onSend, onFiles, onCancel, onCollapse }: DirectorRailProps) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  function submit() {
    const t = text.trim();
    // Describe-first: a request typed BEFORE media exists is allowed — the editor
    // queues it and runs it the moment footage loads. Only `busy` blocks send.
    if (!t || busy) return;
    onSend(t);
    setText("");
  }

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

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && !hasMedia && (
          <div className="mt-6 rounded-2xl border border-dashed border-line bg-elevated/40 p-6 text-center">
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
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === "you" ? "text-right" : "text-left"}>
            <div
              className={[
                "inline-block max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm",
                m.role === "you"
                  ? "voice bg-elevated text-text"
                  : m.tone === "error"
                    ? "border border-red-500/30 bg-red-500/10 text-red-300"
                    : m.tone === "edit"
                      ? "border border-teal/25 bg-teal/10 text-text"
                      : "bg-elevated/60 text-muted",
              ].join(" ")}
            >
              {m.text}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-1.5 text-xs text-faint" role="status" aria-live="polite">
            <Dot /> <Dot delay="0.15s" /> <Dot delay="0.3s" />
            <span className="ml-1">{busyLabel || "Director is editing…"}</span>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="ml-2 rounded-full border border-line bg-elevated px-2.5 py-0.5 text-[11px] text-muted transition hover:border-red-500/40 hover:text-red-300"
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {hasMedia && messages.length <= 2 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => onSend(s)}
                className="rounded-full border border-line bg-elevated px-3 py-1.5 text-left text-xs text-muted transition hover:border-amber/40 hover:text-text disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-line-soft p-3">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-elevated px-2 py-2 focus-within:border-amber/40">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title={hasMedia ? "Add/replace media" : "Add video or photos"}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-line hover:text-text"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10M14 3v6h6M10 13l3 3 4-5" /></svg>
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={hasMedia ? "Describe the edit…" : "Describe what you want — add footage next…"}
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
    </aside>
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
