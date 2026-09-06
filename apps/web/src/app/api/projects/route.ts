import { NextResponse, type NextRequest } from "next/server";
import { createProject } from "@cadence/db";
import { requireSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Create a project in the signed-in user's org. Tenant scope (`orgId`) comes from
 * the session — never from the request body. Degrades gracefully: a session with
 * no org (DB was down at sign-in) → 409; a DB error at create time → 503.
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

  try {
    const project = await createProject(session.orgId, name);
    return NextResponse.json({ id: project.id, name: project.name });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach the database. Is Postgres running?" },
      { status: 503 },
    );
  }
}
