import { pingDb } from "@cadence/db";

export const runtime = "nodejs";
// Health should reflect live state, never a cached response.
export const dynamic = "force-dynamic";

/**
 * Liveness + DB readiness. Returns { status, db } where `db` is a boolean from a
 * real `SELECT 1` round-trip. Degrades gracefully: if the DB is down (or
 * DATABASE_URL unset) `pingDb` returns false rather than throwing, so this route
 * still responds — with 200 { status: "ok", db: false } — for uptime probes.
 */
export async function GET() {
  const db = await pingDb();
  return Response.json(
    { status: "ok", db },
    { headers: { "cache-control": "no-store" } },
  );
}
