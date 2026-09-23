import Link from "next/link";

/**
 * "Start from whatever you have" — the four ways into Cadence, each with the
 * exact words you could type. Every "Try it" opens the editor with that prompt.
 */
const POINTS: { title: string; body: string; prompt: string; needs: string }[] = [
  {
    title: "A video you recorded",
    body: "Talking head, vlog, podcast or event. Cadence transcribes it, finds the best parts, and tidies it up.",
    prompt: "cut a 60-second highlight, make it vertical with captions",
    needs: "Add your video after it opens.",
  },
  {
    title: "A handful of photos",
    body: "Holiday, product shots or a portfolio. They become a moving slideshow with gentle zooms and crossfades.",
    prompt: "make a slideshow from my photos with a warm look",
    needs: "Add your photos after it opens.",
  },
  {
    title: "Just words",
    body: "An announcement, a quote, tips or a story. No footage at all — you get animated text scenes, ready to post.",
    prompt: "make a vertical list video: 3 tips for better sleep\n1. No screens after 10pm\n2. Keep the room cool\n3. Same bedtime every night",
    needs: "Works right away. Nothing to upload.",
  },
  {
    title: "App screenshots",
    body: "Show how your product works: a cursor glides, clicks and types across your screens like a real demo.",
    prompt: "make an interactive demo from these screenshots",
    needs: "Add your screenshots after it opens.",
  },
];

export function StartingPoints() {
  return (
    <section id="start" className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
      <h2 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Start from whatever you have</h2>
      <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
        You don&apos;t need to know editing words. Say it the way you&apos;d say it to a friend who edits videos.
      </p>
      <div className="mt-10 grid gap-x-10 gap-y-12 md:grid-cols-2">
        {POINTS.map((p) => (
          <div key={p.title} className="flex flex-col border-l-2 border-amber/40 pl-5">
            <h3 className="text-lg font-semibold tracking-tight text-text">{p.title}</h3>
            <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{p.body}</p>
            <blockquote className="voice mt-4 whitespace-pre-line text-[17px] leading-snug text-text">
              “{p.prompt}”
            </blockquote>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Link
                href={`/editor?prompt=${encodeURIComponent(p.prompt)}`}
                className="rounded-lg bg-amber px-3.5 py-1.5 text-sm font-semibold text-onaccent transition hover:bg-amber-bright"
              >
                Try it
              </Link>
              <span className="text-xs text-faint">{p.needs}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
