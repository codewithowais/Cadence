import Link from "next/link";

export function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20 pt-4">
      <div className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-elevated to-panel p-10 sm:p-14">
        {/* Amber whisper, CSS-only, purely decorative */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-amber/10 blur-3xl"
        />
        <div className="relative max-w-xl">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">
            Describe your next edit. <span className="voice text-amber">See it made.</span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted">
            Jump straight into the scratch workspace — no account, no setup, no timeline. Sign in
            whenever you want to save and version your projects.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/editor"
              className="rounded-xl bg-amber px-6 py-3 text-sm font-semibold text-ink transition hover:bg-amber-bright"
            >
              Open the editor
            </Link>
            <Link
              href="/login"
              className="rounded-xl border border-line bg-elevated px-6 py-3 text-sm font-semibold text-text transition hover:border-amber/40"
            >
              Sign in to save projects
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line-soft">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-amber font-bold text-ink">
            C
          </div>
          <span className="text-sm font-semibold tracking-tight">Cadence</span>
          <span className="text-xs text-faint">edits-as-code · runs locally · free-first</span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted">
          <Link href="/editor" className="transition hover:text-text">
            Scratch editor
          </Link>
          <Link href="/login" className="transition hover:text-text">
            Sign in
          </Link>
          <a href="#features" className="transition hover:text-text">
            Features
          </a>
          <a href="#faq" className="transition hover:text-text">
            FAQ
          </a>
        </nav>
      </div>
    </footer>
  );
}
