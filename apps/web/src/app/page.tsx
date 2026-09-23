import Link from "next/link";
import { HeroDemo } from "@/components/landing/HeroDemo";
import { StartingPoints } from "@/components/landing/StartingPoints";
import { FeatureIndex } from "@/components/landing/FeatureIndex";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { PromptChips } from "@/components/landing/PromptChips";
import { Faq } from "@/components/landing/Faq";
import { FinalCta, SiteFooter } from "@/components/landing/FinalCta";

export const metadata = {
  title: "Cadence — describe the video, watch it get made",
  description:
    "Cadence is a video editor you talk to. Cut footage, add captions, make vertical videos, turn photos into slideshows, or make an animated text video from words alone — then export a real .mp4. Free to start.",
};

const TEXT_VIDEO_PROMPT = "make a text video: Big news. We just launched. Try it free today.";

export default function LandingPage() {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-5">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Cadence home">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber font-bold text-onaccent">C</div>
          <span className="text-sm font-semibold tracking-tight">Cadence</span>
        </Link>
        <nav className="ml-auto flex items-center gap-1 text-sm sm:gap-2" aria-label="Main">
          <a href="#start" className="hidden rounded-lg px-3 py-1.5 text-muted transition hover:text-text md:inline-block">
            What you can make
          </a>
          <a href="#features" className="hidden rounded-lg px-3 py-1.5 text-muted transition hover:text-text sm:inline-block">
            All features
          </a>
          <a href="#how-it-works" className="hidden rounded-lg px-3 py-1.5 text-muted transition hover:text-text md:inline-block">
            How it works
          </a>
          <Link
            href="/login"
            className="rounded-lg px-3 py-1.5 text-muted transition hover:text-text"
          >
            Sign in
          </Link>
          <Link
            href="/editor"
            className="rounded-lg bg-amber px-3.5 py-1.5 font-semibold text-onaccent transition hover:bg-amber-bright"
          >
            Open the editor
          </Link>
        </nav>
      </header>

      {/* Hero: the product itself — a real Cadence text video, playing. */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-16 pt-8 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-14">
        <div>
          <h1 className="text-[2.6rem] font-semibold leading-[1.04] tracking-[-0.025em] sm:text-6xl">
            Describe the video. Watch it get made.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            Cadence is a video editor you talk to. Tell it what you want in everyday words — it cuts your
            footage, adds captions, fixes the sound, or makes a whole animated video from text. Everything
            it does stays editable, and the file you export looks exactly like the preview.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/editor"
              className="rounded-xl bg-amber px-5 py-3 text-sm font-semibold text-onaccent transition hover:bg-amber-bright"
            >
              Open the editor
            </Link>
            <Link
              href={`/editor?prompt=${encodeURIComponent(TEXT_VIDEO_PROMPT)}`}
              className="rounded-xl border border-line bg-elevated px-5 py-3 text-sm font-semibold text-text transition hover:border-amber/50"
            >
              Make a text video now
            </Link>
          </div>
          <p className="mt-5 text-sm text-faint">Free, no account needed. Works with video, photos, screenshots — or no footage at all.</p>
        </div>
        <HeroDemo />
      </section>

      <StartingPoints />
      <FeatureIndex />
      <HowItWorks />
      <PromptChips />
      <Faq />
      <FinalCta />
      <SiteFooter />
    </div>
  );
}
