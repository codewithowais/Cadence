import Link from "next/link";
import { getLatestEditDoc, listProjects, type ProjectRow } from "@cadence/db";
import { requireSession } from "@/lib/session";
import { TopNav } from "@/components/TopNav";
import { ProjectHub } from "@/components/dashboard/ProjectHub";
import { aspectLabel, resolutionLabel, type DashProject } from "@/components/dashboard/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Projects — Cadence" };

/**
 * Derive an aspect/format badge for a project from its latest edit-doc meta.
 * Best-effort + tenant-scoped: a per-project read failure (or missing doc) just
 * yields no badges — it never fails the whole dashboard.
 */
async function badgesFor(
  orgId: string,
  project: ProjectRow,
): Promise<Pick<DashProject, "aspect" | "resolution">> {
  try {
    const latest = await getLatestEditDoc({ orgId, projectId: project.id });
    if (!latest) return {};
    const { width, height } = latest.doc.meta;
    return { aspect: aspectLabel(width, height), resolution: resolutionLabel(height) };
  } catch {
    return {};
  }
}

/** Load + enrich projects for the session's org. Never throws — the DB may be down. */
async function loadProjects(orgId: string | undefined): Promise<
  { ok: true; projects: DashProject[] } | { ok: false; reason: "no-org" | "db-down" }
> {
  if (!orgId) return { ok: false, reason: "no-org" };
  try {
    const rows = await listProjects(orgId);
    const projects = await Promise.all(
      rows.map(async (p): Promise<DashProject> => ({
        id: p.id,
        name: p.name,
        createdAt: new Date(p.created_at).toISOString(),
        updatedAt: new Date(p.updated_at).toISOString(),
        ...(await badgesFor(orgId, p)),
      })),
    );
    return { ok: true, projects };
  } catch {
    return { ok: false, reason: "db-down" };
  }
}

export default async function DashboardPage() {
  const session = await requireSession();
  const result = await loadProjects(session.orgId);

  return (
    <div className="min-h-dvh">
      <TopNav email={session.email} active="dashboard" />

      <main className="mx-auto max-w-6xl px-6 py-8">
        {result.ok ? (
          <ProjectHub initialProjects={result.projects} />
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
              <p className="mt-1 text-sm text-muted">
                Each project keeps a versioned, append-only edit-doc history.
              </p>
            </div>

            {/* Graceful degradation: DB unavailable / no workspace → clear, friendly state (no crash). */}
            <div className="mt-8 rounded-2xl border border-dashed border-line bg-panel/40 p-8 text-center">
              <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-amber/10 text-amber">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></svg>
              </div>
              <h2 className="text-base font-semibold text-text">
                {result.reason === "db-down" ? "Can’t reach the database" : "No workspace connected"}
              </h2>
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
          </>
        )}
      </main>
    </div>
  );
}
