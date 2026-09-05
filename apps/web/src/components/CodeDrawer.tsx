import type { EditDoc } from "@cadence/core";

interface CodeDrawerProps {
  doc: EditDoc;
  onClose: () => void;
}

/** The escape hatch: the edit is code. Pros can read the exact edit-doc. */
export function CodeDrawer({ doc, onClose }: CodeDrawerProps) {
  return (
    <aside className="flex w-full max-w-[420px] shrink-0 flex-col border-l border-line-soft bg-panel">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
        <div className="text-sm font-semibold text-text">edit-doc</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close code"
          className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-line hover:text-text"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <pre className="flex-1 overflow-auto p-4 text-[11px] leading-relaxed text-muted">
        <code>{JSON.stringify(doc, null, 2)}</code>
      </pre>
      <div className="border-t border-line-soft px-4 py-2 text-[11px] text-faint">
        This document is the single source of truth. Every edit is a change to it.
      </div>
    </aside>
  );
}
