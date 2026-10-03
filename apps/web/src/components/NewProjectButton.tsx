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

  async function create(describe = false) {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      // "Describe a video" skips the naming prompt: the studio opens straight away and the project is
      // named from what you describe (rename it any time).
      const name = describe ? "Video from a description" : window.prompt("Name your project", "Untitled project");
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
      router.push(describe ? `/project/${id}?studio=1` : `/project/${id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create project.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void create(true)}
          disabled={busy || disabled}
          data-testid="new-describe"
          className="rounded-xl border border-line bg-elevated px-4 py-2 text-sm font-semibold text-text transition hover:border-amber/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Describe a video
        </button>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || disabled}
          className="rounded-xl bg-amber px-4 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Creating…" : "New project"}
        </button>
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
