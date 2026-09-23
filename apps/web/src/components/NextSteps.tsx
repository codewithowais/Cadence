"use client";

import type { CommandAction } from "@/lib/suggestions";

export interface Chip {
  id: string;
  label: string;
  action: CommandAction;
}

interface NextStepsProps {
  chips: Chip[];
  /** Small caption before the chips ("Next", "Closest", …). */
  title: string;
  /** Accessible name for the group. */
  ariaLabel: string;
  busy: boolean;
  onRun: (action: CommandAction) => void;
  /** Optional trailing link-style button (e.g. "See all ideas"). */
  more?: { label: string; onClick: () => void };
}

/**
 * A row of one-tap follow-ups under a Director reply. Each chip runs an
 * existing path (a Director prompt or an editor action) — no logic of its own.
 * The download step gets the accent treatment: it's the finish line.
 */
export function NextSteps({ chips, title, ariaLabel, busy, onRun, more }: NextStepsProps) {
  if (chips.length === 0 && !more) return null;
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap items-center gap-1.5 pt-0.5">
      <span className="w-full text-[10px] font-semibold uppercase tracking-wider text-faint">{title}</span>
      {chips.map((c) => {
        const finish = c.action.type === "ui" && c.action.command === "export";
        return (
          <button
            key={c.id}
            type="button"
            disabled={busy}
            onClick={() => onRun(c.action)}
            className={[
              "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-50",
              finish
                ? "border-amber/50 bg-amber/10 font-medium text-amber hover:bg-amber hover:text-onaccent"
                : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
            ].join(" ")}
          >
            {finish ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            )}
            {c.label}
          </button>
        );
      })}
      {more && (
        <button
          type="button"
          onClick={more.onClick}
          className="rounded-full px-2 py-1 text-xs font-medium text-amber underline-offset-2 transition hover:underline"
        >
          {more.label}
        </button>
      )}
    </div>
  );
}
