import { NextResponse, type NextRequest } from "next/server";
import { duplicateProject } from "@cadence/db";
import { requireSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Duplicate a project (name + latest edit-doc) within the SAME org. Tenant scope
 * comes from the session: the source is looked up by (orgId, projectId) and the
 * copy is written under the same orgId, all in one transaction with parameterized
 * queries — a project outside the caller's org matches nothing → 404. Degrades
 * gracefully when the DB is down (503).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session.orgId) {
    return NextResponse.json({ error: "No workspace connected." }, { status: 409 });
  }
  const { id: projectId } = await params;

  const body = await req.json().catch(() => ({}));
  const rawName = typeof body?.name === "string" ? body.name.trim() : "";
  const name = rawName.slice(0, 200) || undefined;

  try {
    const created = await duplicateProject(
      { orgId: session.orgId, projectId },
      { name, userId: session.userId },
    );
    if (!created) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({
      id: created.id,
      name: created.name,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
    });
  } catch {
    return NextResponse.json({ error: "Couldn't reach the database to duplicate." }, { status: 503 });
  }
}
