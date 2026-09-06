"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { DashProject } from "./format";
import { NewProjectMenu } from "./NewProjectMenu";
import { ProjectCard } from "./ProjectCard";

type View = "grid" | "list";
type Sort = "updated" | "name" | "created";

const VIEW_KEY = "cadence.dashboard.view";
const SORT_KEY = "cadence.dashboard.sort";

/** Read a persisted preference without throwing when storage is unavailable. */
function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* storage blocked — use the fallback */
  }
  return fallback;
}

function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked — ignore */
  }
}

/**
 * Client-side project hub: search, sort, grid/list toggle, and per-project
 * actions (open / rename / duplicate / delete) with optimistic updates. It owns
 * the working copy of the project list; the server passes the initial, already
 * tenant-scoped set. All mutations go through the session-scoped API routes.
 */
export function ProjectHub({ initialProjects }: { initialProjects: DashProject[] }) {
  const router = useRouter();
  const [projects, setProjects] = useState<DashProject[]>(initialProjects);
  const [query, setQuery] = useState("");
  // Start from the SSR-safe defaults so server + first client render match, then
  // hydrate persisted preferences after mount (below).
  const [sort, setSort] = useState<Sort>("updated");
  const [view, setView] = useState<View>("grid");
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setSort(readPref<Sort>(SORT_KEY, ["updated", "name", "created"], "updated"));
    setView(readPref<View>(VIEW_KEY, ["grid", "list"], "grid"));
  }, []);

  const setSortPref = (s: Sort) => {
    setSort(s);
    writePref(SORT_KEY, s);
  };
  const setViewPref = (v: View) => {
    setView(v);
    writePref(VIEW_KEY, v);
  };
  const mark = (id: string, on: boolean) =>
    setPending((p) => {
      const next = { ...p };
      if (on) next[id] = true;
      else delete next[id];
      return next;
    });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects.slice();
    filtered.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      const key = sort === "created" ? "createdAt" : "updatedAt";
      return new Date(b[key]).getTime() - new Date(a[key]).getTime();
    });
    return filtered;
  }, [projects, query, sort]);

  function handleCreated(created: { id: string; name: string }) {
    // Navigate straight into the new project's editor (matches prior behavior).
    router.push(`/project/${created.id}`);
    router.refresh();
  }

  async function handleRename(id: string, currentName: string) {
    const name = window.prompt("Rename project", currentName);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) return;

    const prev = projects;
    const now = new Date().toISOString();
    setNotice(null);
    // Optimistic: reflect the new name immediately.
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, name: trimmed, updatedAt: now } : p)));
    mark(id, true);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Rename failed (${res.status}).`);
      }
    } catch (err) {
      setProjects(prev); // revert
      setNotice(err instanceof Error ? err.message : "Couldn't rename project.");
    } finally {
      mark(id, false);
    }
  }

  async function handleDuplicate(id: string) {
    setNotice(null);
    mark(id, true);
    try {
      const res = await fetch(`/api/projects/${id}/duplicate`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Duplicate failed (${res.status}).`);
      }
      const created = (await res.json()) as {
        id: string;
        name: string;
        createdAt: string;
        updatedAt: string;
      };
      const source = projects.find((p) => p.id === id);
      // Insert the copy right after its source, carrying over the format badges.
      setProjects((list) => {
        const idx = list.findIndex((p) => p.id === id);
        const copy: DashProject = {
          id: created.id,
          name: created.name,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          aspect: source?.aspect,
          resolution: source?.resolution,
        };
        const next = list.slice();
        next.splice(idx < 0 ? next.length : idx + 1, 0, copy);
        return next;
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't duplicate project.");
    } finally {
      mark(id, false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This permanently removes the project and its edit history.`)) {
      return;
    }
    const prev = projects;
    setNotice(null);
    // Optimistic removal.
    setProjects((list) => list.filter((p) => p.id !== id));
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Delete failed (${res.status}).`);
      }
    } catch (err) {
      setProjects(prev); // revert
      setNotice(err instanceof Error ? err.message : "Couldn't delete project.");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">
            Each project keeps a versioned, append-only edit-doc history.
          </p>
        </div>
        <div className="ml-auto">
          <NewProjectMenu onCreated={handleCreated} />
        </div>
      </div>

      {/* Toolbar: search · sort · view toggle */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span className="sr-only">Search projects</span>
          <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects"
            className="w-full rounded-xl border border-line-soft bg-panel/60 py-2 pl-9 pr-3 text-sm text-text placeholder:text-faint outline-none transition focus:border-amber/50"
          />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSortPref(e.target.value as Sort)}
              className="rounded-lg border border-line-soft bg-panel/60 px-2.5 py-2 text-sm text-text outline-none transition focus:border-amber/50"
            >
              <option value="updated">Recently updated</option>
              <option value="name">Name (A–Z)</option>
              <option value="created">Recently created</option>
            </select>
          </label>

          <div className="inline-flex rounded-lg border border-line-soft bg-panel/60 p-0.5" role="group" aria-label="View">
            <button
              type="button"
              onClick={() => setViewPref("grid")}
              aria-pressed={view === "grid"}
              aria-label="Grid view"
              className={[
                "grid h-8 w-8 place-items-center rounded-md transition",
                view === "grid" ? "bg-elevated text-text" : "text-muted hover:text-text",
              ].join(" ")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
            </button>
            <button
              type="button"
              onClick={() => setViewPref("list")}
              aria-pressed={view === "list"}
              aria-label="List view"
              className={[
                "grid h-8 w-8 place-items-center rounded-md transition",
                view === "list" ? "bg-elevated text-text" : "text-muted hover:text-text",
              ].join(" ")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
            </button>
          </div>
        </div>
      </div>

      {notice && (
        <div role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          {notice}
        </div>
      )}

      {/* Results */}
      {visible.length === 0 ? (
        query.trim() ? (
          <div className="mt-8 rounded-2xl border border-dashed border-line bg-panel/40 p-10 text-center">
            <h2 className="text-base font-semibold text-text">No projects match “{query.trim()}”</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
              Try a different search, or clear it to see all your projects.
            </p>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mt-4 rounded-lg border border-line bg-elevated px-3 py-1.5 text-sm text-text transition hover:border-amber/40"
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="mt-8 rounded-2xl border border-dashed border-line bg-panel/40 p-10 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-amber/10 text-amber">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v14H4z M4 9h16" /><path d="m10 13 4 2-4 2z" /></svg>
            </div>
            <h2 className="text-base font-semibold text-text">No projects yet</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
              Create your first project — start blank or pick a template, then describe the edit and the Director takes it from there.
            </p>
            <div className="mt-5 flex justify-center">
              <NewProjectMenu onCreated={handleCreated} />
            </div>
          </div>
        )
      ) : view === "grid" ? (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((p) => (
            <li key={p.id}>
              <ProjectCard
                project={p}
                view="grid"
                busy={!!pending[p.id]}
                onRename={handleRename}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {visible.map((p) => (
            <li key={p.id}>
              <ProjectCard
                project={p}
                view="list"
                busy={!!pending[p.id]}
                onRename={handleRename}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
