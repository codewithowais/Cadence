import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const metadata = { title: "Sign in — Cadence" };

/**
 * Dev sign-in. Posts to /api/auth/login, which establishes a signed cookie
 * session and redirects to /dashboard. No password — the caller asserts identity
 * (this is dev auth; swappable for real SSO behind the same AuthProvider).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <div className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber font-bold text-ink">C</div>
          <span className="text-sm font-semibold tracking-tight">Cadence</span>
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1.5 text-sm text-muted">
          Dev sign-in — enter your email to open your workspace. No password needed.
        </p>

        {error && (
          <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <form action="/api/auth/login" method="post" className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-muted">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@studio.com"
              className="w-full rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-sm text-text placeholder:text-faint focus:border-amber/40 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="name" className="mb-1.5 block text-xs font-medium text-muted">
              Name <span className="text-faint">(optional)</span>
            </label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Your name"
              className="w-full rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-sm text-text placeholder:text-faint focus:border-amber/40 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-xl bg-amber px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-amber-bright"
          >
            Continue
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-muted">
          <Link href="/editor" className="text-teal underline-offset-2 hover:underline">
            Continue without an account
          </Link>{" "}
          <span className="text-faint">— edit in the scratch workspace.</span>
        </p>
      </div>
    </div>
  );
}
