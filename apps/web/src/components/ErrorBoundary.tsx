"use client";

import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Human name of the panel, used in the recover card ("the timeline"). */
  label: string;
  children: ReactNode;
  /**
   * When this value changes while the fallback is showing, the boundary retries
   * automatically — pass the doc so an Undo (or any edit) re-renders the panel.
   */
  resetKey?: unknown;
  /** Offer "Undo last change" — the usual fix when an edit broke a panel. */
  onUndo?: () => void;
  /** Tighter card for slim areas (toolbars / strips). */
  compact?: boolean;
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Panel-level error boundary: one crashing room / Stage / timeline shows a
 * friendly recover card while the rest of the editor keeps working (the doc lives
 * above the boundary, so nothing is lost). React only catches render errors with a
 * class component (getDerivedStateFromError / componentDidCatch).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Structured, greppable log line — never swallow silently.
    console.error(`[cadence] ${this.props.label} crashed`, error, info.componentStack);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    const { label, onUndo, compact, className, children } = this.props;
    if (!error) {
      return (
        <>
          <CrashProbe label={label} />
          {children}
        </>
      );
    }
    return (
      <div
        role="alert"
        className={[
          "flex flex-col items-start gap-2 rounded-2xl border border-danger/25 bg-panel text-left shadow-[0_10px_30px_-18px_rgba(24,34,38,0.35)]",
          compact ? "m-2 p-3" : "m-3 p-4",
          className ?? "",
        ].join(" ")}
      >
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-danger/10 text-danger" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
          </span>
          <p className="text-sm font-semibold text-text">The {label} hit a snag</p>
        </div>
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Your edit is safe — only this panel stopped. Try again{onUndo ? ", or undo the last change if it caused this" : ""}.
        </p>
        <details className="max-w-full text-[11px] text-faint">
          <summary className="cursor-pointer select-none hover:text-muted">Technical details</summary>
          <code className="mt-1 block max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-elevated px-2 py-1 font-mono text-[10px] text-muted">
            {error.message || String(error)}
          </code>
        </details>
        <div className="flex flex-wrap gap-2 pt-0.5">
          <button
            type="button"
            onClick={this.retry}
            className="rounded-lg bg-amber px-3 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright"
          >
            Try again
          </button>
          {onUndo && (
            <button
              type="button"
              onClick={onUndo}
              className="rounded-lg border border-line bg-elevated px-3 py-1.5 text-xs text-muted transition hover:text-text"
            >
              Undo last change
            </button>
          )}
        </div>
      </div>
    );
  }
}

/**
 * DEV/TEST-ONLY fault injection: `?cadence-crash=<label>` makes the named panel
 * throw once after mount, so e2e can prove the recover card works. Compiled out
 * of production builds (NODE_ENV is inlined), and it throws only after hydration
 * (never during SSR). "Try again" clears it.
 */
function CrashProbe({ label }: { label: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    try {
      const want = new URLSearchParams(window.location.search).get("cadence-crash");
      const key = `cadence-crash-fired:${label}`;
      if (want && want === label && !sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        setArmed(true);
      }
    } catch {
      /* storage blocked — no fault injection */
    }
  }, [label]);
  if (armed) throw new Error(`Injected test crash in ${label}`);
  return null;
}
