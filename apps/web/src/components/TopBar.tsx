"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { EditDoc } from "@cadence/core";
import { fmtTime } from "@/lib/format";
import type { ExportSettings } from "@/lib/export-presets";
import { ExportMenu } from "./ExportMenu";

interface TopBarProps {
  title: string;
  /** Rename the project (writes doc.meta.title through the undoable commit path). */
  onRename: (title: string) => void;
  mediaLabel: string | null;
  durationSec: number;
  cutCount: number;
  codeOpen: boolean;
  onToggleCode: () => void;
  /** The live doc (seeds the export options popover). */
  doc: EditDoc;
  onExport: (settings: ExportSettings) => void;
  canExport: boolean;
  busy?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Clear the timeline and start a fresh project (asks to confirm first). */
  onStartOver: () => void;
  /** Download the edit-doc as a portable JSON copy. */
  onDuplicate: () => void;
  onShowShortcuts: () => void;
  /** Optional link back (e.g. /dashboard). */
  backHref?: string;
  /** Optional save handler (project-bound editor). Absent = no Save button. */
  onSave?: () => void;
  saveState?: "idle" | "saving" | "saved" | "error";
  /** Open the ⌘K command palette (search every action). */
  onOpenPalette?: () => void;
}

/** Click-to-rename project title. Enter/blur commits, Escape cancels. */
function EditableTitle({ title, onRename }: { title: string; onRename: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const t = draft.trim();
    if (t && t !== title) onRename(t);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          e.stopPropagation();
        }}
        aria-label="Project title"
        maxLength={120}
        className="min-w-0 max-w-[42vw] rounded-md border border-amber/40 bg-elevated px-1.5 py-0.5 text-sm font-semibold tracking-tight text-text focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => { setDraft(title); setEditing(true); }}
      title="Rename project"
      className="group flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left transition hover:bg-elevated"
    >
      <span className="truncate text-sm font-semibold tracking-tight text-text">{title}</span>
      <svg className="shrink-0 text-faint opacity-0 transition group-hover:opacity-100" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
    </button>
  );
}

function OverflowMenu(props: {
  onStartOver: () => void;
  onDuplicate: () => void;
  onShowShortcuts: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const item = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-elevated text-muted transition hover:text-text"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-52 rounded-2xl border border-line bg-panel p-1.5 shadow-[0_16px_44px_-16px_rgba(24,34,38,0.22)]">
          <button type="button" role="menuitem" className={`${item} text-muted hover:bg-elevated hover:text-text`} onClick={() => { setOpen(false); props.onShowShortcuts(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" /></svg>
            Keyboard shortcuts
          </button>
          <button type="button" role="menuitem" className={`${item} text-muted hover:bg-elevated hover:text-text`} onClick={() => { setOpen(false); props.onDuplicate(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            Duplicate as new
          </button>
          <button type="button" role="menuitem" className={`${item} text-danger hover:bg-danger/10`} onClick={() => { setOpen(false); props.onStartOver(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            Start over
          </button>
        </div>
      )}
    </div>
  );
}

function IconButton({
  onClick,
  disabled,
  label,
  path,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  path: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-elevated text-muted transition hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
    </button>
  );
}

export function TopBar(props: TopBarProps) {
  const saveLabel =
    props.saveState === "saving" ? "Saving…" : props.saveState === "saved" ? "Saved ✓" : "Save";
  return (
    <header className="flex items-center gap-3 border-b border-line-soft bg-panel/50 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {props.backHref && (
          <Link
            href={props.backHref}
            title="Back to dashboard"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-elevated text-muted transition hover:text-text"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </Link>
        )}
        <EditableTitle title={props.title} onRename={props.onRename} />
        {props.mediaLabel && (
          <span className="hidden truncate rounded-full border border-line bg-elevated px-2.5 py-1 text-xs text-muted sm:inline">
            {props.mediaLabel}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2 text-xs text-faint">
        {props.durationSec > 0 && (
          <span className="hidden tabular-nums sm:inline">
            {props.cutCount > 0 ? `${props.cutCount} cuts · ` : ""}
            {fmtTime(props.durationSec)}
          </span>
        )}
        {props.onOpenPalette && (
          <button
            type="button"
            onClick={props.onOpenPalette}
            aria-label="Search actions"
            aria-keyshortcuts="Meta+K Control+K"
            title="Search every action (⌘K / Ctrl+K)"
            className="flex h-8 items-center gap-2 rounded-lg border border-line bg-elevated px-2.5 text-muted transition hover:border-amber/40 hover:text-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <span className="hidden lg:inline">Search</span>
            <kbd className="hidden rounded border border-line-soft px-1 text-[10px] font-medium text-faint md:inline" aria-hidden="true">⌘K</kbd>
          </button>
        )}
        <div className="flex items-center gap-1">
          <IconButton onClick={props.onUndo} disabled={!props.canUndo} label="Undo (⌘Z)" path="M9 14 4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-1" />
          <IconButton onClick={props.onRedo} disabled={!props.canRedo} label="Redo (⌘⇧Z)" path="m15 14 5-5-5-5 M20 9H9a5 5 0 0 0 0 10h1" />
        </div>
        <button
          type="button"
          onClick={props.onToggleCode}
          aria-pressed={props.codeOpen}
          className={[
            "rounded-lg border px-2.5 py-1.5 font-medium transition",
            props.codeOpen
              ? "border-teal/40 bg-teal/10 text-teal"
              : "border-line bg-elevated text-muted hover:text-text hover:border-line",
          ].join(" ")}
        >
          {"{ } code"}
        </button>
        {props.onSave && (
          <button
            type="button"
            onClick={props.onSave}
            disabled={props.saveState === "saving"}
            className="rounded-lg border border-teal/40 bg-teal/10 px-3 py-1.5 font-semibold text-teal transition hover:bg-teal/20 disabled:opacity-50"
          >
            {saveLabel}
          </button>
        )}
        <ExportMenu doc={props.doc} canExport={props.canExport} busy={props.busy} onExport={props.onExport} />
        <OverflowMenu
          onStartOver={props.onStartOver}
          onDuplicate={props.onDuplicate}
          onShowShortcuts={props.onShowShortcuts}
        />
      </div>
    </header>
  );
}
