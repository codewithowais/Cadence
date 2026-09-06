import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { SignInForm } from "@/components/auth/SignInForm";

export const runtime = "nodejs";
export const metadata = { title: "Sign in — Cadence" };

const TRUST_POINTS: { title: string; body: string }[] = [
  {
    title: "Local-first, free by default",
    body: "The Director, live preview and editing tools run offline on your real media — no API keys, no upload round-trip.",
  },
  {
    title: "Faithful by contract",
    body: "Upscale and enhance sharpen what's already there. Faces, identity and content are never altered or invented.",
  },
  {
    title: "Always editable",
    body: "Every prompt becomes a declarative edit-doc — the single source of truth you can inspect and adjust by hand.",
  },
];

/**
 * Dev sign-in. The form posts to /api/auth/login, which establishes a signed
 * cookie session and redirects to /dashboard. No password — the caller asserts
 * identity (this is dev auth; swappable for real SSO behind the same AuthProvider).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      {/* Hero / value prop */}
      <section className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-panel px-10 py-12 lg:flex xl:px-16">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(600px 320px at 15% 0%, rgba(245,185,68,0.10), transparent 60%), radial-gradient(520px 360px at 100% 100%, rgba(69,211,196,0.08), transparent 55%)",
          }}
        />
        <div className="relative">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber font-bold text-ink">C</div>
            <span className="text-sm font-semibold tracking-tight">Cadence</span>
          </Link>
        </div>

        <div className="relative max-w-md">
          <p className="text-xs font-medium uppercase tracking-widest text-teal">Prompt-native video editor</p>
          <h2 className="mt-4 text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
            Describe the edit.{" "}
            <span className="voice text-amber">Cadence makes it</span>{" "}
            — and shows you, always editable.
          </h2>
          <ul className="mt-10 space-y-6">
            {TRUST_POINTS.map((p) => (
              <li key={p.title} className="flex gap-3.5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full border border-teal/30 bg-teal/10 text-teal"
                >
                  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
                    <path
                      d="M4.5 10.5l3 3 8-8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-text">{p.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{p.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-faint">Free-first · local-first · your footage stays on your machine.</p>
      </section>

      {/* Sign-in card */}
      <section className="flex min-h-dvh items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          {/* Compact logo — shown only when the hero is hidden (small screens). */}
          <Link href="/" className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber font-bold text-ink">C</div>
            <span className="text-sm font-semibold tracking-tight">Cadence</span>
          </Link>

          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1.5 text-sm text-muted">
            Enter your email to open your workspace. No password needed.
          </p>

          <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-amber/25 bg-amber/10 px-3 py-1 text-xs text-amber">
            <span className="h-1.5 w-1.5 rounded-full bg-amber" aria-hidden="true" />
            Dev sign-in — local auth, not real SSO
          </div>

          <div className="mt-6">
            <SignInForm initialError={error} />
          </div>

          <p className="mt-8 text-center text-xs leading-relaxed text-faint">
            This is a local development sign-in. It provisions a personal workspace so projects can
            be saved — the editing itself stays on your machine.
          </p>
        </div>
      </section>
    </main>
  );
}
