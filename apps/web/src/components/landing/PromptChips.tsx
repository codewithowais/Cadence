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

export function PromptChips() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
      <div className="rounded-3xl border border-line-soft bg-gradient-to-br from-elevated/70 to-panel/40 p-8 sm:p-12">
        <div className="max-w-2xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-teal">
            Start from a prompt
          </p>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">
            Not sure what to say? <span className="voice text-amber">Try one of these.</span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted">
            Tap a prompt to open the scratch editor with the idea ready to go — no account needed.
          </p>
        </div>

        <ul className="mt-8 flex flex-wrap gap-3">
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
