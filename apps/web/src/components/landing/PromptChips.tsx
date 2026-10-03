import Link from "next/link";

/**
 * Clickable example prompts. Each links straight into the scratch editor so a
 * visitor can try the idea immediately. The prompt travels as a `?prompt=`
 * query param — harmless if the editor ignores it, a head-start if it reads it.
 */
const PROMPTS: string[] = [
  "Make a text video: Big news. We just launched. Try it free today.",
  "Quote video: “Less is more.” — Mies van der Rohe",
  "Cut a 60-second highlight",
  "Make it vertical with captions",
  "Give it a cinematic look",
  "Remove the filler words",
  "Turn these photos into a slideshow",
  "Add a title card and fade in",
  "Punch in on the key moment",
  "Add b-roll in the corner",
  "Export in 4K",
];

function toEditorHref(prompt: string) {
  return `/editor?prompt=${encodeURIComponent(prompt)}`;
}

/** One-sentence "describe a video" starters: they open the studio with the sentence filled in. */
const DESCRIBE: string[] = [
  "30s Instagram promo for my coffee shop, warm vibe, upbeat music",
  "Birthday wish for Ayesha",
  "Explain how photosynthesis works in 45s",
  "Travel recap of Istanbul using my photos",
  "5 tips for better sleep",
];

function toStudioHref(prompt: string) {
  return `/editor?describe=${encodeURIComponent(prompt)}`;
}

export function PromptChips() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
      <div className="rounded-3xl border border-line-soft bg-gradient-to-br from-elevated/70 to-panel/40 p-8 sm:p-12">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">Not sure what to say? Try one of these</h2>
          <p className="mt-4 text-base leading-relaxed text-muted">
            Tap one to open the editor with it ready to go. No account needed. Prompts that need footage wait
            until you add it.
          </p>
        </div>

        <p className="mt-8 text-sm font-medium text-text">Describe a whole video in one sentence</p>
        <ul className="mt-3 flex flex-wrap gap-3" aria-label="Describe-a-video examples">
          {DESCRIBE.map((prompt) => (
            <li key={prompt}>
              <Link
                href={toStudioHref(prompt)}
                className="group inline-flex items-center gap-2 rounded-full border border-amber/40 bg-amber/5 px-4 py-2 text-sm text-text transition hover:border-amber hover:bg-amber/10"
              >
                <span aria-hidden="true" className="text-amber transition-transform group-hover:translate-x-0.5">
                  &rsaquo;
                </span>
                <span className="voice">{prompt}</span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="mt-8 text-sm font-medium text-text">Or edit and style what you have</p>
        <ul className="mt-3 flex flex-wrap gap-3">
          {PROMPTS.map((prompt) => (
            <li key={prompt}>
              <Link
                href={toEditorHref(prompt)}
                className="group inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-4 py-2 text-sm text-text transition hover:border-amber/50 hover:bg-panel"
              >
                <span
                  aria-hidden="true"
                  className="text-amber transition-transform group-hover:translate-x-0.5"
                >
                  &rsaquo;
                </span>
                <span className="voice">{prompt}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
