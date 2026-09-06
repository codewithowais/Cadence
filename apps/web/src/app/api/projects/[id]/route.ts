import { NextResponse, type NextRequest } from "next/server";
import { deleteProject, renameProject } from "@cadence/db";
import { requireSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Per-project mutations, all tenant-scoped by the SESSION's org (never the client):
 *  - PATCH  { name } → rename
 *  - DELETE          → delete (cascades to media + edit-doc history)
 *
 * The repository pins (orgId, projectId) in a parameterized WHERE clause, so a
 * project that isn't in the caller's org simply matches zero rows → 404 (no
 * cross-tenant read or write is possible). Degrades gracefully when the DB is
 * down (503) instead of crashing.
 */

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session.orgId) {
    return NextResponse.json({ error: "No workspace connected." }, { status: 409 });
  }
  const { id: projectId } = await params;

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "A project name is required." }, { status: 400 });
  }
  if (name.length > 200) {
    return NextResponse.json({ error: "That name is too long (max 200 characters)." }, { status: 400 });
  }

  try {
    const updated = await renameProject({ orgId: session.orgId, projectId }, name);
    if (!updated) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({ id: updated.id, name: updated.name, updatedAt: updated.updated_at });
  } catch {
    return NextResponse.json({ error: "Couldn't reach the database to rename." }, { status: 503 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session.orgId) {
    return NextResponse.json({ error: "No workspace connected." }, { status: 409 });
  }
  const { id: projectId } = await params;

  try {
    const deleted = await deleteProject({ orgId: session.orgId, projectId });
    if (!deleted) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Couldn't reach the database to delete." }, { status: 503 });
  }
}
