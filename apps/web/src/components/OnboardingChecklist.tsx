"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { EditDoc } from "@cadence/core";
import {
  onboardingProgress,
  onboardingSteps,
  type CommandAction,
  type OnboardingStep,
  type OnboardingStepId,
} from "@/lib/suggestions";

const KEY = "cadence:onboarding:v1";

interface Latched {
  edited: boolean;
  previewed: boolean;
  exported: boolean;
  dismissed: boolean;
}

const EMPTY: Latched = { edited: false, previewed: false, exported: false, dismissed: false };

function load(): Latched {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<Latched>;
    return { edited: !!v.edited, previewed: !!v.previewed, exported: !!v.exported, dismissed: !!v.dismissed };
  } catch {
    return EMPTY;
  }
}

interface OnboardingChecklistProps {
  doc: EditDoc;
  /** Something to play exists (footage, photos or a text video). */
  hasContent: boolean;
  playing: boolean;
  /** An .mp4 export is running. */
  exporting: boolean;
  onRun: (action: CommandAction) => void;
}

/** Calls to action per unfinished step (labels kept e2e-unambiguous). */
const CTAS: Record<OnboardingStepId, { label: string; action: CommandAction }[]> = {
  content: [
    { label: "Upload footage", action: { type: "ui", command: "addMedia" } },
    { label: "Write a text video", action: { type: "room", room: "text" } },
  ],
  edit: [{ label: "Show me ideas", action: { type: "ui", command: "library" } }],
  preview: [{ label: "Play the preview", action: { type: "ui", command: "play" } }],
  export: [{ label: "Open export options", action: { type: "room", room: "deliver" } }],
};

/**
 * Getting started: add something → make an edit → preview → download. Ticks
 * itself off from REAL editor state — content present, a doc change made while
 * content existed, playback, an export run — and remembers progress per browser.
 * Collapsed it's one line ("Next: …" + a button); expanded it lists every step.
 */
export function OnboardingChecklist({ doc, hasContent, playing, exporting, onRun }: OnboardingChecklistProps) {
  const [latched, setLatched] = useState<Latched>(EMPTY);
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const prev = useRef<{ doc: EditDoc; hadContent: boolean } | null>(null);

  // Hydrate once on the client (avoids an SSR mismatch; storage may be blocked).
  useEffect(() => {
    setLatched(load());
    setReady(true);
  }, []);

  const latch = (patch: Partial<Latched>) =>
    setLatched((l) => {
      const next = { ...l, ...patch };
      if (next.edited === l.edited && next.previewed === l.previewed && next.exported === l.exported && next.dismissed === l.dismissed) return l;
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — progress is best-effort */
      }
      return next;
    });

  // An edit = the doc changed while there was already something in it (so the
  // upload / first text video itself doesn't count as "your first edit").
  useEffect(() => {
    const p = prev.current;
    if (p && p.doc !== doc && p.hadContent && hasContent) latch({ edited: true });
    prev.current = { doc, hadContent: hasContent };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, hasContent]);
  useEffect(() => {
    if (playing && hasContent) latch({ previewed: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, hasContent]);
  useEffect(() => {
    if (exporting) latch({ exported: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exporting]);

  if (!ready || latched.dismissed) return null;

  const steps = onboardingSteps({ hasContent, edited: latched.edited, previewed: latched.previewed, exported: latched.exported });
  const { done, total, next } = onboardingProgress(steps);
  const complete = next === null;
  const pct = Math.round((done / total) * 100);

  return (
    <section aria-label="Getting started" className="mx-3 mb-1 rounded-xl border border-line bg-elevated/70 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <ProgressRing pct={pct} complete={complete} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-semibold text-text">{complete ? "You're all set" : "Getting started"}</span>
            <span className="text-[11px] tabular-nums text-faint" aria-hidden="true">
              {done}/{total}
            </span>
            <span className="sr-only" role="status">{`${done} of ${total} steps done`}</span>
          </div>
          <p className="truncate text-[11px] text-muted">
            {complete ? "Made, previewed and exported — nice work." : <>Next: {next.label.toLowerCase()}</>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={expanded ? "Collapse getting started steps" : "Show getting started steps"}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-line hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform ${expanded ? "rotate-180" : ""}`}><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <button
          type="button"
          onClick={() => latch({ dismissed: true })}
          aria-label="Hide getting started"
          title="Hide"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-line hover:text-text"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {!expanded && next && next.id !== "content" && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-[38px]">
          {CTAS[next.id].map((c) => (
            <CtaButton key={c.label} label={c.label} onClick={() => onRun(c.action)} />
          ))}
        </div>
      )}

      {expanded && (
        <ol id={listId} className="mt-2.5 space-y-2 border-t border-line-soft pt-2.5">
          {steps.map((s, i) => (
            <StepRow key={s.id} step={s} index={i} isNext={next?.id === s.id} onRun={onRun} />
          ))}
        </ol>
      )}
    </section>
  );
}

function StepRow({ step, index, isNext, onRun }: { step: OnboardingStep; index: number; isNext: boolean; onRun: (a: CommandAction) => void }) {
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden="true"
        className={[
          "mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold",
          step.done ? "border-teal bg-teal text-onaccent" : isNext ? "border-amber text-amber" : "border-line text-faint",
        ].join(" ")}
      >
        {step.done ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
        ) : (
          index + 1
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-xs ${step.done ? "text-muted line-through decoration-line" : "font-medium text-text"}`}>
          {step.label}
          <span className="sr-only">{step.done ? " — done" : " — to do"}</span>
        </p>
        {!step.done && <p className="mt-0.5 text-[11px] text-faint">{step.hint}</p>}
        {!step.done && isNext && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {CTAS[step.id].map((c) => (
              <CtaButton key={c.label} label={c.label} onClick={() => onRun(c.action)} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function CtaButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 text-[11px] font-semibold text-amber transition hover:bg-amber hover:text-onaccent"
    >
      {label}
    </button>
  );
}

function ProgressRing({ pct, complete }: { pct: number; complete: boolean }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative grid h-7 w-7 shrink-0 place-items-center" aria-hidden="true">
      <svg width="28" height="28" viewBox="0 0 28 28" className="-rotate-90">
        <circle cx="14" cy="14" r={r} fill="none" stroke="var(--color-line)" strokeWidth="3" />
        <circle
          cx="14"
          cy="14"
          r={r}
          fill="none"
          stroke={complete ? "var(--color-teal)" : "var(--color-amber)"}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          style={{ transition: "stroke-dashoffset 400ms ease" }}
        />
      </svg>
      {complete && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-teal)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="absolute"><path d="M5 12l5 5L20 7" /></svg>
      )}
    </span>
  );
}
