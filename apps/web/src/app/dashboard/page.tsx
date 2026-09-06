import Link from "next/link";
import { listProjects, type ProjectRow } from "@cadence/db";
import { requireSession } from "@/lib/session";
import { TopNav } from "@/components/TopNav";
import { NewProjectButton } from "@/components/NewProjectButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Projects — Cadence" };

/** Load projects for the session's org. Never throws — the DB may be down. */
async function loadProjects(orgId: string | undefined): Promise<
  { ok: true; projects: ProjectRow[] } | { ok: false; reason: "no-org" | "db-down" }
> {
  if (!orgId) return { ok: false, reason: "no-org" };
  try {
    return { ok: true, projects: await listProjects(orgId) };
  } catch {
    return { ok: false, reason: "db-down" };
  }
}

export default async function DashboardPage() {
  const session = await requireSession();
  const result = await loadProjects(session.orgId);
  const hasWorkspace = result.ok;

  return (
    <div className="min-h-dvh">
      <TopNav email={session.email} active="dashboard" />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted">
              Each project keeps a versioned, append-only edit-doc history.
            </p>
          </div>
          <div className="ml-auto">
            <NewProjectButton disabled={!hasWorkspace} />
          </div>
        </div>

        {/* Graceful degradation: DB unavailable → clear, friendly state (no crash). */}
        {!result.ok && (
          <div className="mt-8 rounded-2xl border border-dashed border-line bg-panel/40 p-8 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-amber/10 text-amber">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></svg>
            </div>
            <h2 className="text-base font-semibold text-text">Connect a database to save projects</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              {result.reason === "db-down"
                ? "Cadence can't reach Postgres right now. Start it with "
                : "You're signed in, but no workspace is connected yet. Start Postgres with "}
              <code className="rounded bg-elevated px-1.5 py-0.5 text-xs text-text">docker compose up db</code>
              {result.reason === "no-org" ? ", then sign in again." : " and reload."}
            </p>
            <p className="mt-4 text-sm text-muted">
              Meanwhile you can{" "}
              <Link href="/editor" className="text-teal underline-offset-2 hover:underline">
                edit in the scratch workspace
              </Link>{" "}
              — no database needed.
            </p>
          </div>
        )}

        {/* Empty (but connected) state */}
        {result.ok && result.projects.length === 0 && (
          <div className="mt-8 rounded-2xl border border-dashed border-line bg-panel/40 p-10 text-center">
            <h2 className="text-base font-semibold text-text">No projects yet</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
              Create your first project, then describe the edit — the Director takes it from there.
            </p>
            <div className="mt-5 flex justify-center">
              <NewProjectButton disabled={false} />
            </div>
          </div>
        )}

        {/* Project grid */}
        {result.ok && result.projects.length > 0 && (
          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {result.projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/project/${p.id}`}
                  className="block rounded-2xl border border-line-soft bg-panel/50 p-5 transition hover:border-amber/40"
                >
                  <div className="flex items-start gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated text-amber">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v14H4z M4 9h16" /></svg>
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-text">{p.name}</h3>
                      <p className="mt-0.5 text-xs text-faint">
                        Updated {new Date(p.updated_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-teal">
                    Open editor
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
