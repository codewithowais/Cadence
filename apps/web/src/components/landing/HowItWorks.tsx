import { UploadIcon, ChatIcon, EyeIcon, ExportIcon } from "./icons";

const STEPS = [
  {
    n: "01",
    title: "Add your media",
    body: "Drop in a video, a set of photos, or an audio track. Cadence probes it in the browser — no upload round-trip.",
    Icon: UploadIcon,
  },
  {
    n: "02",
    title: "Describe the edit",
    body: "Say it plainly: “cut a 60s highlight, make it vertical with captions, cinematic look.” The Director plans and calls the tools.",
    Icon: ChatIcon,
  },
  {
    n: "03",
    title: "Preview & nudge",
    body: "Watch it play on your real footage with looks, motion and captions live. Adjust anything — the edit-doc is yours to tweak.",
    Icon: EyeIcon,
  },
  {
    n: "04",
    title: "Export",
    body: "Render a faithful .mp4 with ffmpeg, or export the edit-doc JSON and hand the recipe to any renderer.",
    Icon: ExportIcon,
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-y border-line-soft bg-panel/30">
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
        <div className="max-w-2xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-amber">
            How it works
          </p>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">
            Four steps, no timeline knowledge
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted">
            The flow is the same whether you are trimming a keynote or building a slideshow from
            a folder of photos.
          </p>
        </div>

        <ol className="relative mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {/* Connective line across the row on wide screens */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 top-6 hidden h-px bg-gradient-to-r from-transparent via-line to-transparent lg:block"
          />
          {STEPS.map((step, i) => (
            <li key={step.n} className="relative">
              <div className="flex items-center gap-3">
                <span className="relative z-10 grid h-12 w-12 shrink-0 place-items-center rounded-full border border-line bg-elevated text-amber">
                  <step.Icon className="h-5 w-5" />
                </span>
                <span className="voice text-2xl text-faint">{step.n}</span>
                {i < STEPS.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="ml-auto text-line-soft lg:hidden"
                  >
                    &darr;
                  </span>
                ) : null}
              </div>
              <h3 className="mt-4 text-base font-semibold tracking-tight text-text">
                {step.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
