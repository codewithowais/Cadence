/**
 * Server-side session helpers, layered on the swappable `AuthProvider`
 * (see lib/auth.ts). Pages/routes derive their tenant scope from HERE — never
 * from client-supplied org/user ids.
 */
import { redirect } from "next/navigation";
import { createHash } from "node:crypto";
import { getAuthProvider, type Session } from "@/lib/auth";

/** The current session, or null. */
export async function getSession(): Promise<Session | null> {
  return getAuthProvider().getSession();
}

/**
 * Require an authenticated session; redirect unauthenticated visitors to /login.
 * Auth-gated pages/routes call this first so the rest of the handler can trust it.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * A stable, deterministic pseudo user-id derived from the email, used ONLY when
 * the database is unavailable so sign-in still works offline (scratch mode). When
 * the DB is up, real UUIDs from `provisionAccount` are used instead.
 */
export function deterministicUserId(email: string): string {
  return `dev-${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}`;
}

/** Loosely validate an email for the dev sign-in form. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
