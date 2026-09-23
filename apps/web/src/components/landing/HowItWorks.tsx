import { ChatIcon, EyeIcon, ExportIcon } from "./icons";

/** The three real steps — a true sequence, so they're numbered. */
const STEPS = [
  {
    title: "Say what you want",
    body: "Type it the way you'd say it: “cut a 30-second highlight, make it vertical with captions.” Add your video, photos or screenshots — or skip that and start from words.",
    Icon: ChatIcon,
  },
  {
    title: "Watch it happen, then adjust",
    body: "The edit plays right away on your own media. Change anything by asking again, tapping a button, or dragging on the timeline. Undo is always one click away.",
    Icon: EyeIcon,
  },
  {
    title: "Export the finished video",
    body: "Download a real .mp4 sized for YouTube, TikTok, Reels or anywhere else. It looks exactly like the preview — same fonts, same animations.",
    Icon: ExportIcon,
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
      <h2 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">How it works</h2>
      <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
        No timeline skills needed. If you can describe the video, you can make it.
      </p>
      <ol className="mt-10 grid gap-10 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex flex-col">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-amber text-base font-semibold text-onaccent">
                {i + 1}
              </span>
              <step.Icon className="h-5 w-5 text-amber" aria-hidden="true" />
            </div>
            <h3 className="mt-4 text-lg font-semibold tracking-tight text-text">{step.title}</h3>
            <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
