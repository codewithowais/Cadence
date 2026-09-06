import Link from "next/link";
import { getOrg, listOrgMembers, type OrgMemberRow, type OrgRow } from "@cadence/db";
import { requireSession } from "@/lib/session";
import { TopNav } from "@/components/TopNav";
import { SettingsView, type MemberVM } from "@/components/settings/SettingsView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — Cadence" };

/**
 * Best-effort tenant snapshot: the org + its member roster. Returns `dbDown` so
 * the UI degrades gracefully (friendly notices instead of a crash) when Postgres
 * is unreachable. All reads are tenant-scoped to the SESSION's orgId — never a
 * client-supplied value.
 */
async function loadWorkspace(
  orgId: string | undefined,
): Promise<{ org: OrgRow | null; members: OrgMemberRow[]; dbDown: boolean }> {
  if (!orgId) return { org: null, members: [], dbDown: false };
  try {
    const [org, members] = await Promise.all([getOrg(orgId), listOrgMembers({ orgId })]);
    return { org, members, dbDown: false };
  } catch {
    return { org: null, members: [], dbDown: true };
  }
}

export default async function SettingsPage() {
  const session = await requireSession();
  const { org, members, dbDown } = await loadWorkspace(session.orgId);

  const me = members.find((m) => m.id === session.userId) ?? null;
  const memberVMs: MemberVM[] = members.map((m) => ({
    id: m.id,
    email: m.email,
    name: m.name,
    role: m.role,
    isYou: m.id === session.userId,
  }));

  return (
    <div className="min-h-dvh">
      <TopNav email={session.email} active="settings" />

      <main className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">Manage your account, workspace, and editor defaults.</p>

        <SettingsView
          email={session.email}
          userId={session.userId}
          displayName={me?.name ?? null}
          orgId={session.orgId ?? null}
          orgName={org?.name ?? null}
          role={me?.role ?? null}
          members={memberVMs}
          dbDown={dbDown}
        />

        <p className="mt-6 text-sm text-muted">
          <Link href="/dashboard" className="text-teal underline-offset-2 hover:underline">
            ← Back to projects
          </Link>
        </p>
      </main>
    </div>
  );
}
