"use client"; // Error boundaries must be Client Components (Next.js error.js convention)

import { useEffect } from "react";

/**
 * Last-resort boundary for the scratch editor route (Next 16 `error.js`: props are
 * `error` + `retry`, per node_modules/next/dist/docs). Panel-level boundaries catch
 * almost everything first; this only shows if the editor shell itself fails. The
 * work is autosaved in this browser, so reloading offers "Restore your last session".
 */
export default function EditorError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("[cadence] editor crashed", error);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div role="alert" className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 text-center shadow-[0_16px_44px_-16px_rgba(24,34,38,0.22)]">
        <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-danger/10 text-danger" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
        </div>
        <h1 className="text-base font-semibold text-text">The editor hit a snag</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Your work is autosaved in this browser. Try again — or reload the page and choose
          <span className="font-semibold text-text"> Restore session</span>.
        </p>
        {error.digest && <p className="mt-2 font-mono text-[11px] text-faint">ref {error.digest}</p>}
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => retry()}
            className="rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-line bg-elevated px-4 py-2 text-sm text-muted transition hover:text-text"
          >
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}
