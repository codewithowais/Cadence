import { NextResponse, type NextRequest } from "next/server";
import { createProject, saveEditDocVersion } from "@cadence/db";
import { requireSession } from "@/lib/session";
import { buildTemplateDoc, isTemplateId } from "@/components/dashboard/templates";

export const runtime = "nodejs";

/**
 * Create a project in the signed-in user's org. Tenant scope (`orgId`) comes from
 * the session — never from the request body. An optional `templateId` seeds the
 * project's first edit-doc from a validated starter template (the client sends
 * only the id; the seed doc is built + validated server-side). Degrades
 * gracefully: a session with no org (DB was down at sign-in) → 409; a DB error at
 * create time → 503.
 */
export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session.orgId) {
    return NextResponse.json(
      { error: "No workspace is connected. Start Postgres (docker compose up db) and sign in again." },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim() || "Untitled project";
  const templateId = isTemplateId(body?.templateId) ? body.templateId : "blank";

  try {
    const project = await createProject(session.orgId, name);

    // Seed the first edit-doc from the chosen template (blank → no seed). Built
    // and validated server-side; the scope pins (orgId, projectId) for the write.
    const seed = buildTemplateDoc(templateId);
    if (seed) {
      await saveEditDocVersion({ orgId: session.orgId, projectId: project.id }, seed, session.userId);
    }

    return NextResponse.json({ id: project.id, name: project.name });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach the database. Is Postgres running?" },
      { status: 503 },
    );
  }
}
