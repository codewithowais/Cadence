import Link from "next/link";

export const metadata = {
  title: "Cadence — describe the edit, see it made",
};

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Say it in plain language",
    body: "“Cut a 60-second highlight, make it vertical with captions, give it a cinematic look.” The Director plans it and shows you — always editable.",
  },
  {
    title: "Edits-as-code",
    body: "Every project is a declarative edit-doc — the single source of truth. Version it, open it, hand it to any renderer. Store the recipe, not opaque state.",
  },
  {
    title: "Instant, honest preview",
    body: "The browser seeks your real footage and applies looks, motion and captions live. No upload round-trip. Export renders a faithful .mp4 with ffmpeg.",
  },
];

const STEPS = ["Add a video or a set of photos", "Describe the edit", "Nudge anything, then export"];

export default function LandingPage() {
  return (
    <div className="min-h-dvh">
      {/* Top bar */}
      <header className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber font-bold text-ink">C</div>
          <span className="text-sm font-semibold tracking-tight">Cadence</span>
        </div>
        <nav className="ml-auto flex items-center gap-2 text-sm">
          <Link href="/editor" className="rounded-lg px-3 py-1.5 text-muted transition hover:text-text">
            Try the scratch editor
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-line bg-elevated px-3 py-1.5 font-medium text-text transition hover:border-amber/40"
          >
            Sign in
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pb-8 pt-10 sm:pt-20">
        <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-elevated px-3 py-1 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-teal" /> Prompt-native video editing
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          Describe the edit.{" "}
          <span className="voice text-amber">Cadence makes it</span>{" "}
          — and shows you.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          A mass-market, enterprise-shaped video editor with an AI Director at the spine.
          You talk; it edits your real footage into a posted-ready video — every step visible,
          every step editable. Zero timeline knowledge required.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/editor"
            className="rounded-xl bg-amber px-5 py-3 text-sm font-semibold text-ink transition hover:bg-amber-bright"
          >
            Open editor
          </Link>
          <Link
            href="/login"
            className="rounded-xl border border-line bg-elevated px-5 py-3 text-sm font-semibold text-text transition hover:border-amber/40"
          >
            Sign in to save projects
          </Link>
        </div>

        <ol className="mt-10 flex flex-wrap gap-x-8 gap-y-2 text-sm text-faint">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded-full border border-line text-[11px] text-muted">
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
      </section>

      {/* What it does */}
      <section className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-line-soft bg-panel/50 p-6 transition hover:border-line"
            >
              <h2 className="text-base font-semibold tracking-tight text-text">{f.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="flex flex-col items-start gap-4 rounded-2xl border border-line-soft bg-gradient-to-br from-elevated to-panel p-8 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Ready to try it?</h2>
            <p className="mt-1 text-sm text-muted">
              Jump straight in — no account needed to edit in the scratch workspace.
            </p>
          </div>
          <div className="flex gap-3 sm:ml-auto">
            <Link
              href="/editor"
              className="rounded-xl bg-amber px-5 py-3 text-sm font-semibold text-ink transition hover:bg-amber-bright"
            >
              Open editor
            </Link>
            <Link
              href="/login"
              className="rounded-xl border border-line bg-elevated px-5 py-3 text-sm font-semibold text-text transition hover:border-amber/40"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <footer className="mx-auto max-w-6xl px-6 pb-10 text-xs text-faint">
        Cadence — edits-as-code. Runs locally, free-first.
      </footer>
    </div>
  );
}
