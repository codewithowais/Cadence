"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { relativeTime, type DashProject } from "./format";

type View = "grid" | "list";

/**
 * A single project tile with a kebab actions menu (Open / Rename / Duplicate /
 * Delete). All mutations are delegated to the parent hub, which owns the
 * (optimistic) list state; this component only renders + collects intent.
 */
export function ProjectCard({
  project,
  view,
  busy,
  onRename,
  onDuplicate,
  onDelete,
}: {
  project: DashProject;
  view: View;
  busy: boolean;
  onRename: (id: string, currentName: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const badges = (
    <div className="flex flex-wrap items-center gap-1.5">
      {project.aspect && (
        <span className="inline-flex items-center rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-muted">
          {project.aspect}
        </span>
      )}
      {project.resolution && (
        <span className="inline-flex items-center rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-muted">
          {project.resolution}
        </span>
      )}
    </div>
  );

  const updated = (
    <time dateTime={project.updatedAt} suppressHydrationWarning className="text-xs text-faint">
      Updated {relativeTime(project.updatedAt)}
    </time>
  );

  const menuButton = (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Actions for ${project.name}`}
        className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-text disabled:opacity-40"
      >
        {busy ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        )}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${project.name}`}
          className="absolute right-0 top-full z-20 mt-1.5 w-44 overflow-hidden rounded-xl border border-line bg-panel p-1 shadow-xl shadow-[rgba(41,35,28,0.14)]"
        >
          <Link
            href={`/project/${project.id}`}
            role="menuitem"
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-text transition hover:bg-elevated"
          >
            <MenuIcon name="open" /> Open
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRename(project.id, project.name);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-text transition hover:bg-elevated"
          >
            <MenuIcon name="rename" /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDuplicate(project.id);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-text transition hover:bg-elevated"
          >
            <MenuIcon name="duplicate" /> Duplicate
          </button>
          <div className="my-1 h-px bg-line-soft" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete(project.id, project.name);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-red-300 transition hover:bg-red-500/10"
          >
            <MenuIcon name="delete" /> Delete
          </button>
        </div>
      )}
    </div>
  );

  if (view === "list") {
    return (
      <div className="group flex items-center gap-3 rounded-xl border border-line-soft bg-panel/50 px-4 py-3 transition hover:border-amber/40">
        <Link href={`/project/${project.id}`} className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated text-amber">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v14H4z M4 9h16" /></svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-text">{project.name}</span>
            <span className="mt-0.5 flex items-center gap-2">{updated}</span>
          </span>
        </Link>
        <div className="hidden sm:block">{badges}</div>
        {menuButton}
      </div>
    );
  }

  return (
    <div className="group flex h-full flex-col rounded-2xl border border-line-soft bg-panel/50 p-5 transition hover:border-amber/40">
      <div className="flex items-start gap-3">
        <Link href={`/project/${project.id}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated text-amber">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v14H4z M4 9h16" /></svg>
        </Link>
        <Link href={`/project/${project.id}`} className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-text">{project.name}</h3>
          <p className="mt-0.5">{updated}</p>
        </Link>
        {menuButton}
      </div>
      <div className="mt-4 flex items-center justify-between">
        {badges}
        <Link
          href={`/project/${project.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-teal"
        >
          Open editor
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </Link>
      </div>
    </div>
  );
}

function MenuIcon({ name }: { name: "open" | "rename" | "duplicate" | "delete" }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "open") return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
  if (name === "rename") return <svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
  if (name === "duplicate") return <svg {...common}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
  return <svg {...common}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>;
}
