/**
 * Auth behind an interface (enterprise bones).
 *
 * The rest of the app depends only on `AuthProvider` — never on a concrete
 * implementation. Today that's `DevAuthProvider`: a signed, HTTP-only cookie
 * session for local development (free, no external service). Tomorrow, swap in an
 * enterprise SSO provider without touching call sites.
 *
 * ── How to swap in real SSO later ──────────────────────────────────────────
 * 1. Add a provider that implements `AuthProvider`, e.g. `OidcAuthProvider`,
 *    backed by Okta / Auth0 / Entra / Auth.js. `signIn` kicks off the OIDC
 *    redirect (or verifies an IdP callback); `getSession` reads/validates the
 *    resulting session (its own cookie or a JWT); `signOut` clears it + hits the
 *    IdP end-session endpoint.
 * 2. Point `getAuthProvider()` at it via an env flag (e.g. AUTH_PROVIDER=oidc),
 *    keeping DevAuthProvider as the free local default.
 * 3. Nothing else changes: routes/components keep calling `getSession()` etc.
 *
 * SECURITY: the dev cookie is signed with HMAC-SHA256 over SESSION_SECRET and
 * verified with a constant-time compare. It is HttpOnly + SameSite=Lax and
 * Secure in production. It is a *dev* auth (the caller asserts identity at
 * signIn); it is NOT a substitute for real SSO in production.
 */
import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cadence_session";
const DEFAULT_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

/** The authenticated principal + their active tenant. */
export interface Session {
  readonly userId: string;
  readonly email: string;
  /** Active tenant (org) for this session, if one has been selected. */
  readonly orgId?: string;
  /** Unix seconds when the session expires. */
  readonly expiresAt: number;
}

export interface SessionUser {
  readonly userId: string;
  readonly email: string;
  readonly orgId?: string;
}

export interface SignInInput {
  readonly userId: string;
  readonly email: string;
  readonly orgId?: string;
  /** Session lifetime in seconds (default 7 days). */
  readonly maxAgeSec?: number;
}

/** The stable contract every auth backend implements. */
export interface AuthProvider {
  /** The current session, or null if unauthenticated / expired / tampered. */
  getSession(): Promise<Session | null>;
  /** Convenience: the current user (subset of the session), or null. */
  getUser(): Promise<SessionUser | null>;
  /** Establish a session (dev: trust the input; SSO: verify the IdP). */
  signIn(input: SignInInput): Promise<Session>;
  /** Clear the session. */
  signOut(): Promise<void>;
}

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "SESSION_SECRET is not set (or too short). Set it in .env — see .env.example for how to generate one.",
    );
  }
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/** Encode `session` as `<base64url(json)>.<base64url(hmac)>`. */
export function encodeSession(session: Session): string {
  const body = b64url(JSON.stringify(session));
  return `${body}.${sign(body)}`;
}

/** Verify + decode a cookie token. Returns null on any tamper/expiry/parse error. */
export function decodeSession(token: string | undefined): Session | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = sign(body);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  // Constant-time compare; length check first (timingSafeEqual throws on mismatch).
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    if (typeof parsed.userId !== "string" || typeof parsed.email !== "string") return null;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Local dev auth: a signed HTTP-only cookie session. No database, no external
 * IdP — the free default so the app runs end to end offline.
 */
export class DevAuthProvider implements AuthProvider {
  async getSession(): Promise<Session | null> {
    const store = await cookies();
    return decodeSession(store.get(SESSION_COOKIE)?.value);
  }

  async getUser(): Promise<SessionUser | null> {
    const s = await this.getSession();
    return s ? { userId: s.userId, email: s.email, orgId: s.orgId } : null;
  }

  async signIn(input: SignInInput): Promise<Session> {
    const maxAge = input.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
    const session: Session = {
      userId: input.userId,
      email: input.email,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      expiresAt: Math.floor(Date.now() / 1000) + maxAge,
    };
    const store = await cookies();
    store.set(SESSION_COOKIE, encodeSession(session), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge,
    });
    return session;
  }

  async signOut(): Promise<void> {
    const store = await cookies();
    store.delete(SESSION_COOKIE);
  }
}

let provider: AuthProvider | undefined;

/**
 * The active auth provider. Swap the implementation here when enabling SSO
 * (e.g. `return new OidcAuthProvider()` under an AUTH_PROVIDER env flag).
 */
export function getAuthProvider(): AuthProvider {
  if (!provider) provider = new DevAuthProvider();
  return provider;
}
