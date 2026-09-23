"use client";

import { useEffect, useId, useRef, useState } from "react";
import { TEMPLATES, type TemplateId } from "./templates";

/**
 * "New project" split control: the main button creates a Blank project; the caret
 * opens a menu of starter templates. Tenant scope is derived server-side from the
 * session — the client only sends a name + template id. On success it hands the
 * new project id back to the parent (which navigates / updates its list).
 */
export function NewProjectMenu({
  onCreated,
}: {
  onCreated: (project: { id: string; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<TemplateId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Close the menu on outside click / Escape.
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

  async function create(templateId: TemplateId, label: string) {
    if (busy) return;
    const suggested = templateId === "blank" ? "Untitled project" : label;
    const name = window.prompt("Name your project", suggested);
    if (name === null) return; // cancelled
    setBusy(templateId);
    setError(null);
    setOpen(false);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || suggested, templateId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Couldn't create project (${res.status}).`);
      }
      const created = (await res.json()) as { id: string; name: string };
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create project.");
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div ref={rootRef} className="relative inline-flex">
        <button
          type="button"
          onClick={() => create("blank", "Untitled project")}
          disabled={anyBusy}
          className="rounded-l-xl bg-amber px-4 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "blank" ? "Creating…" : "New project"}
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={anyBusy}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label="Choose a starter template"
          className="rounded-r-xl border-l border-ink/20 bg-amber px-2.5 py-2 text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open && (
          <div
            id={menuId}
            role="menu"
            aria-label="Starter templates"
            className="absolute right-0 top-full z-20 mt-2 max-h-[70vh] w-72 overflow-y-auto rounded-2xl border border-line bg-panel p-1.5 shadow-xl shadow-[rgba(24,34,38,0.14)]"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
              Start from a template
            </p>
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                disabled={anyBusy}
                onClick={() => create(t.id, t.label)}
                className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-elevated disabled:opacity-50"
              >
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-elevated text-amber">
                  <TemplateIcon id={t.id} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{t.label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{t.description}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

function TemplateIcon({ id }: { id: TemplateId }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (id.startsWith("text-")) {
    return (
      <svg {...common}>
        <path d="M4 7V5h16v2M9 19h6M12 5v14" />
      </svg>
    );
  }
  if (id === "talking-head") {
    return (
      <svg {...common}>
        <circle cx="12" cy="9" r="3.2" />
        <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
      </svg>
    );
  }
  if (id === "slideshow") {
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m7 15 3-3 2 2 3-4 2 3" />
        <circle cx="8.5" cy="9.5" r="1.2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 9h16" />
    </svg>
  );
}
