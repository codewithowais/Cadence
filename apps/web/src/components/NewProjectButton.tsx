"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Creates a project via POST /api/projects (tenant scope is derived server-side
 * from the session) and navigates to its editor. Disabled when no workspace is
 * connected — the dashboard shows the "connect a database" state instead.
 */
export function NewProjectButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const name = window.prompt("Name your project", "Untitled project");
      if (name === null) {
        setBusy(false);
        return;
      }
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Untitled project" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Couldn't create project (${res.status}).`);
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/project/${id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create project.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={create}
        disabled={busy || disabled}
        className="rounded-xl bg-amber px-4 py-2 text-sm font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Creating…" : "New project"}
      </button>
      {error && <span className="text-xs text-red-300">{error}</span>}
    </div>
  );
}
