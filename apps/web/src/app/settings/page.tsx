import Link from "next/link";
import { getMembership, type MembershipRow } from "@cadence/db";
import { requireSession } from "@/lib/session";
import { TopNav } from "@/components/TopNav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — Cadence" };

/** Best-effort membership/role lookup; null if the DB is down or no org. */
async function loadMembership(userId: string, orgId?: string): Promise<MembershipRow | null> {
  if (!orgId) return null;
  try {
    return await getMembership(userId, orgId);
  } catch {
    return null;
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line-soft py-3 last:border-0 sm:flex-row sm:items-center">
      <span className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-faint">{label}</span>
      <span className="truncate text-sm text-text">{value}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const session = await requireSession();
  const membership = await loadMembership(session.userId, session.orgId);

  return (
    <div className="min-h-dvh">
      <TopNav email={session.email} active="settings" />

      <main className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">Your account and active workspace.</p>

        <section className="mt-6 rounded-2xl border border-line-soft bg-panel/50 p-6">
          <h2 className="mb-2 text-sm font-semibold text-text">Account</h2>
          <Row label="Email" value={session.email} />
          <Row label="User ID" value={session.userId} />
        </section>

        <section className="mt-4 rounded-2xl border border-line-soft bg-panel/50 p-6">
          <h2 className="mb-2 text-sm font-semibold text-text">Workspace</h2>
          {session.orgId ? (
            <>
              <Row label="Org ID" value={session.orgId} />
              <Row label="Your role" value={membership?.role ?? "unknown (database unreachable)"} />
            </>
          ) : (
            <p className="text-sm text-muted">
              No workspace connected. Start Postgres with{" "}
              <code className="rounded bg-elevated px-1.5 py-0.5 text-xs text-text">docker compose up db</code> and
              sign in again to create one.
            </p>
          )}
        </section>

        <section className="mt-4 rounded-2xl border border-line-soft bg-panel/50 p-6">
          <h2 className="mb-2 text-sm font-semibold text-text">Session</h2>
          <p className="text-sm text-muted">
            Signed in with dev auth (a signed, HTTP-only cookie). This is swappable for enterprise SSO behind the
            same interface.
          </p>
          <form action="/api/auth/logout" method="post" className="mt-4">
            <button
              type="submit"
              className="rounded-xl border border-line bg-elevated px-4 py-2 text-sm font-semibold text-text transition hover:border-amber/40"
            >
              Sign out
            </button>
          </form>
        </section>

        <p className="mt-6 text-sm text-muted">
          <Link href="/dashboard" className="text-teal underline-offset-2 hover:underline">
            ← Back to projects
          </Link>
        </p>
      </main>
    </div>
  );
}
