"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { rankCommands, type Command, type CommandGroup } from "@/lib/commands";
import { Kbd, Overlay } from "./Overlay";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Everything runnable right now (see `buildCommands`). */
  commands: Command[];
  /** Run a command through the editor's existing paths. The palette closes first. */
  onRun: (command: Command) => void;
}

const GROUP_LABEL: Record<CommandGroup, string> = {
  Suggested: "Suggested next",
  Recent: "Recent prompts",
  Project: "Project",
  Rooms: "Rooms",
  Edits: "Edits you can ask for",
  Ask: "Ask the Director",
};

const GROUP_ICON: Record<CommandGroup, string> = {
  Suggested: "M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8L12 14.6l-5 3.6 1.9-5.8L4 8.8h6.1z",
  Recent: "M12 7v5l3 2 M12 21a9 9 0 110-18 9 9 0 010 18z",
  Project: "M4 6h16 M4 12h16 M4 18h10",
  Rooms: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  Edits: "M12 20h9 M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
  Ask: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z",
};

/**
 * ⌘K / Ctrl+K — fuzzy-search every action and run it. A combobox over a listbox
 * (`aria-activedescendant`), ↑/↓/Home/End to move, ↵ to run, Esc to close. Free
 * text that matches nothing becomes "Ask the Director: …", so it's never a dead end.
 */
export function CommandPalette({ open, onClose, commands, onRun }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const results = useMemo(() => rankCommands(commands, query), [commands, query]);
  useEffect(() => setActive(0), [query]);

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const run = (c: Command | undefined) => {
    if (!c || c.disabled) return;
    onClose();
    onRun(c);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = results.length;
    if (n === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + n) % n);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    }
  };

  // Render with group headers wherever the group changes.
  let lastGroup: CommandGroup | null = null;

  return (
    <Overlay open={open} onClose={onClose} label="Command palette" placement="top" panelClassName="max-w-xl max-h-[70vh]">
      <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-faint" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={results[active] ? optionId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Search actions, rooms and edits"
          placeholder="Search or describe an edit…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-faint focus:outline-none focus-visible:outline-none"
        />
        <Kbd>esc</Kbd>
      </div>
      <ul ref={listRef} id={`${baseId}-list`} role="listbox" aria-label="Actions" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {results.map((c, i) => {
          const header = c.group !== lastGroup ? GROUP_LABEL[c.group] : null;
          lastGroup = c.group;
          const isActive = i === active;
          return (
            <li key={c.id} role="presentation">
              {header && (
                <div role="presentation" className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-faint first:pt-1">
                  {header}
                </div>
              )}
              <div
                id={optionId(i)}
                role="option"
                aria-selected={isActive}
                aria-disabled={c.disabled || undefined}
                data-index={i}
                onMouseMove={() => !isActive && setActive(i)}
                onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
                onClick={() => run(c)}
                className={[
                  "flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition-colors",
                  isActive ? "bg-amber/10 text-text" : "text-muted",
                  c.disabled ? "cursor-not-allowed opacity-50" : "",
                ].join(" ")}
              >
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${isActive ? "border-amber/40 bg-elevated text-amber" : "border-line-soft bg-elevated/60 text-faint"}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={GROUP_ICON[c.group]} /></svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${c.group === "Recent" ? "voice" : ""} ${isActive ? "text-text" : "text-text/90"}`}>{c.title}</span>
                  {c.hint && <span className="block truncate text-[11px] text-faint">{c.hint}</span>}
                </span>
                {c.shortcut && (
                  <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                    {c.shortcut.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                )}
                {isActive && !c.disabled && (
                  <span className="shrink-0 text-[11px] font-medium text-amber" aria-hidden="true">↵</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3 border-t border-line-soft px-4 py-2 text-[11px] text-faint">
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd> run</span>
        <span className="ml-auto" aria-live="polite">{results.length} {results.length === 1 ? "result" : "results"}</span>
      </div>
    </Overlay>
  );
}
