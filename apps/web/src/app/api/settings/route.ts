import { NextResponse, type NextRequest } from "next/server";
import { updateUserName } from "@cadence/db";
import { requireSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Account settings mutations, tenant-scoped by the SESSION (never the client):
 *  - PATCH { name } → update the signed-in user's display name.
 *
 * The tenant scope (`orgId`) and identity (`userId`) both come from the verified
 * session. The repository pins (orgId, userId) with an EXISTS membership guard, so
 * a user can only ever rename their own account within an org they belong to.
 * Degrades gracefully: no workspace → 409; a DB error → 503 (never crashes).
 */
export async function PATCH(req: NextRequest) {
  const session = await requireSession();
  if (!session.orgId) {
    return NextResponse.json(
      { error: "No workspace is connected. Start Postgres (docker compose up db) and sign in again." },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "A display name is required." }, { status: 400 });
  }
  if (name.length > 120) {
    return NextResponse.json({ error: "That name is too long (max 120 characters)." }, { status: 400 });
  }

  try {
    const updated = await updateUserName({ orgId: session.orgId, userId: session.userId }, name);
    if (!updated) {
      return NextResponse.json({ error: "Your account isn't a member of this workspace." }, { status: 404 });
    }
    return NextResponse.json({ id: updated.id, name: updated.name, email: updated.email });
  } catch {
    return NextResponse.json({ error: "Couldn't reach the database to save your name." }, { status: 503 });
  }
}
