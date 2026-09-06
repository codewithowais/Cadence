import { NextResponse, type NextRequest } from "next/server";
import { getProject, saveEditDocVersion } from "@cadence/db";
import { requireSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Save a new edit-doc version for a project. Append-only + tenant-scoped:
 *  - the scope (orgId) is taken from the session, never the client;
 *  - the project id is verified to belong to that org before any write;
 *  - the doc is validated by `parseEditDoc` inside the repository before it lands.
 * Degrades gracefully when the DB is down (503) so the editor can stay in scratch.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session.orgId) {
    return NextResponse.json({ error: "No workspace connected." }, { status: 409 });
  }
  const { id: projectId } = await params;
  const body = await req.json().catch(() => ({}));

  try {
    const scope = { orgId: session.orgId, projectId };
    const project = await getProject(scope);
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

    const saved = await saveEditDocVersion(scope, body?.doc, session.userId);
    return NextResponse.json({ version: saved.version, createdAt: saved.createdAt });
  } catch (err) {
    // Validation errors (bad doc) → 400; anything else (DB down) → 503.
    const message = err instanceof Error ? err.message : "Save failed.";
    const isValidation = /parse|invalid|expected|zod/i.test(message);
    return NextResponse.json(
      { error: isValidation ? "That edit-doc failed validation." : "Couldn't reach the database to save." },
      { status: isValidation ? 400 : 503 },
    );
  }
}
