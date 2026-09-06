import Link from "next/link";
import { FeatureShowcase } from "@/components/landing/FeatureShowcase";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { PromptChips } from "@/components/landing/PromptChips";
import { Faq } from "@/components/landing/Faq";
import { FinalCta, SiteFooter } from "@/components/landing/FinalCta";

export const metadata = {
  title: "Cadence — describe the edit, see it made",
  description:
    "A prompt-native video editor. Describe the edit in plain language; Cadence makes it on your real footage — highlight cuts, captions, looks, titles, slideshows and faithful 4K export. Free-first, local-first.",
};

const STEPS = ["Add a video or a set of photos", "Describe the edit", "Nudge anything, then export"];

const STATS: { value: string; label: string }[] = [
  { value: "0", label: "timelines to learn" },
  { value: "9:16", label: "and 4 more ratios" },
  { value: "4K", label: "faithful export" },
  { value: "$0", label: "to start, free-first" },
];

export default function LandingPage() {
  return (
    <div className="min-h-dvh">
      {/* Decorative hero glow — CSS only, respects reduced motion via globals.css */}
      <style>{`
        @keyframes cadence-drift {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.55; }
          50% { transform: translate3d(2%, 3%, 0) scale(1.08); opacity: 0.8; }
        }
        .cadence-orb { animation: cadence-drift 14s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .cadence-orb { animation: none; }
        }
      `}</style>

      {/* Top bar */}
      <header className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber font-bold text-ink">C</div>
          <span className="text-sm font-semibold tracking-tight">Cadence</span>
        </div>
        <nav className="ml-auto flex items-center gap-1 text-sm sm:gap-2">
          <a
            href="#features"
            className="hidden rounded-lg px-3 py-1.5 text-muted transition hover:text-text sm:inline-block"
          >
            Features
          </a>
          <a
            href="#how-it-works"
            className="hidden rounded-lg px-3 py-1.5 text-muted transition hover:text-text sm:inline-block"
          >
            How it works
          </a>
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
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="cadence-orb pointer-events-none absolute -left-32 -top-40 -z-10 h-[36rem] w-[36rem] rounded-full bg-amber/10 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="cadence-orb pointer-events-none absolute -right-40 top-10 -z-10 h-[30rem] w-[30rem] rounded-full bg-teal/10 blur-3xl"
          style={{ animationDelay: "-7s" }}
        />

        <div className="mx-auto max-w-6xl px-6 pb-10 pt-10 sm:pt-20">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-elevated px-3 py-1 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-teal" /> Prompt-native video editing
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Describe the edit.{" "}
            <span className="voice text-amber">Cadence makes it</span>{" "}
            — and shows you.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
            A mass-market, enterprise-shaped video editor with an AI Director at the spine. You talk;
            it edits your real footage into a posted-ready video — every step visible, every step
            editable. Zero timeline knowledge required.
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

          {/* Quick stat strip */}
          <dl className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line-soft bg-line-soft sm:grid-cols-4">
            {STATS.map((stat) => (
              <div key={stat.label} className="bg-panel/60 px-5 py-5">
                <dt className="voice text-2xl text-amber sm:text-3xl">{stat.value}</dt>
                <dd className="mt-1 text-xs leading-snug text-muted">{stat.label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <FeatureShowcase />
      <HowItWorks />
      <PromptChips />
      <Faq />
      <FinalCta />
      <SiteFooter />
    </div>
  );
}
