import { NextResponse, type NextRequest } from "next/server";
import { provisionAccount } from "@cadence/db";
import { getAuthProvider } from "@/lib/auth";
import { deterministicUserId, isValidEmail } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Dev sign-in. Accepts the login form (email + optional name), establishes a
 * signed cookie session, and redirects to /dashboard.
 *
 * Tenant scope is derived server-side, never trusted from the client:
 *  - DB up  → `provisionAccount` find-or-creates the user + their org (idempotent,
 *    transactional); the session carries the real user id + org id.
 *  - DB down → still signs in with a deterministic user id (no org). The dashboard
 *    then shows a friendly "connect a database" state instead of crashing.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const email = String(form?.get("email") ?? "").trim();
  const name = String(form?.get("name") ?? "").trim() || null;

  const loginUrl = new URL("/login", req.url);
  if (!isValidEmail(email)) {
    loginUrl.searchParams.set("error", "Enter a valid email address.");
    return NextResponse.redirect(loginUrl, 303);
  }

  const auth = getAuthProvider();
  try {
    const { user, org } = await provisionAccount(email, name);
    await auth.signIn({ userId: user.id, email: user.email, orgId: org.id });
  } catch {
    // Graceful degradation: DB unavailable → sign in without a tenant (scratch).
    await auth.signIn({ userId: deterministicUserId(email), email });
  }

  return NextResponse.redirect(new URL("/dashboard", req.url), 303);
}
