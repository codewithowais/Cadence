"use client";

import { useId, useState } from "react";

type Status = { kind: "idle" | "saving" } | { kind: "ok"; msg: string } | { kind: "error"; msg: string };

/**
 * Edit the signed-in user's display name. PATCHes /api/settings, which derives
 * the tenant + identity from the session (never trusts the client). Read-only
 * email/user-id are shown for context. Degrades gracefully: when the DB is down
 * the field is disabled and a friendly notice explains why.
 */
export function ProfileForm({
  email,
  userId,
  initialName,
  canEdit,
}: {
  email: string;
  userId: string;
  initialName: string | null;
  canEdit: boolean;
}) {
  const nameId = useId();
  const [name, setName] = useState(initialName ?? "");
  const [saved, setSaved] = useState(initialName ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const trimmed = name.trim();
  const dirty = trimmed !== (saved ?? "").trim();
  const tooLong = trimmed.length > 120;
  const canSave = canEdit && dirty && trimmed.length > 0 && !tooLong && status.kind !== "saving";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ kind: "error", msg: data?.error ?? "Couldn't save your name." });
        return;
      }
      setSaved(data?.name ?? trimmed);
      setName(data?.name ?? trimmed);
      setStatus({ kind: "ok", msg: "Saved." });
    } catch {
      setStatus({ kind: "error", msg: "Network error — please try again." });
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div>
        <label htmlFor={nameId} className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-faint">
          Display name
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (status.kind !== "idle") setStatus({ kind: "idle" });
          }}
          disabled={!canEdit}
          maxLength={200}
          autoComplete="name"
          placeholder={canEdit ? "Your name" : "Unavailable while offline"}
          aria-describedby={`${nameId}-help`}
          aria-invalid={tooLong || undefined}
          className="w-full rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-sm text-text outline-none transition placeholder:text-faint focus:border-amber/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p id={`${nameId}-help`} className="mt-1.5 text-xs text-faint">
          {tooLong ? (
            <span className="text-red-300">That name is too long (max 120 characters).</span>
          ) : (
            "This is how your name appears to your workspace."
          )}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <ReadOnly label="Email" value={email} />
        <ReadOnly label="User ID" value={userId} mono />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!canSave}
          className="rounded-xl bg-amber px-4 py-2 text-sm font-semibold text-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status.kind === "saving" ? "Saving…" : "Save changes"}
        </button>
        <span aria-live="polite" className="text-sm">
          {status.kind === "ok" && <span className="text-teal">{status.msg}</span>}
          {status.kind === "error" && <span className="text-red-300">{status.msg}</span>}
        </span>
      </div>

      {!canEdit && (
        <p className="rounded-xl border border-line-soft bg-elevated/60 px-3.5 py-2.5 text-sm text-muted">
          Editing your name needs the database. Start Postgres with{" "}
          <code className="rounded bg-panel px-1.5 py-0.5 text-xs text-text">docker compose up db</code> and reload.
        </p>
      )}
    </form>
  );
}

function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-line-soft bg-elevated/40 px-3.5 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</div>
      <div className={["mt-0.5 truncate text-sm text-text", mono ? "font-mono text-xs" : ""].join(" ")} title={value}>
        {value}
      </div>
    </div>
  );
}
