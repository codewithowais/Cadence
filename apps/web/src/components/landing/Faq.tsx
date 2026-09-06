type QA = { q: string; a: React.ReactNode };

const FAQS: QA[] = [
  {
    q: "Is Cadence free?",
    a: (
      <>
        Yes — it is free-first and runs locally by default. The Director, live preview and editing
        tools use deterministic, offline defaults with no API keys required. Optional AI
        super-resolution is off by default and the only piece that can be metered; you opt into it
        explicitly.
      </>
    ),
  },
  {
    q: "Does it change or fake faces?",
    a: (
      <>
        No. The faithful upscale (Lanczos scale, unsharp, denoise) is contract-enforced to never
        alter faces, identity or content — it sharpens what is already there rather than inventing
        detail. Even the optional AI super-resolution providers are identity-preserving by contract.
      </>
    ),
  },
  {
    q: "Do I need to install anything?",
    a: (
      <>
        Not to edit and preview — that all runs in your browser on your real media. To render a
        final <code className="rounded bg-elevated px-1 py-0.5 text-[0.85em] text-text">.mp4</code>{" "}
        you need ffmpeg, which is baked into the Docker image (so{" "}
        <code className="rounded bg-elevated px-1 py-0.5 text-[0.85em] text-text">docker compose up</code>{" "}
        just works). On your own machine, point{" "}
        <code className="rounded bg-elevated px-1 py-0.5 text-[0.85em] text-text">FFMPEG_PATH</code>{" "}
        at any ffmpeg binary. You can always export the edit-doc JSON without installing anything.
      </>
    ),
  },
  {
    q: "What about my privacy?",
    a: (
      <>
        Cadence is local-first. Your footage is probed and previewed directly in the browser — there
        is no upload round-trip to watch your edit come together. Signing in provisions a personal
        workspace so projects can be saved, but the editing itself stays on your machine.
      </>
    ),
  },
  {
    q: "Do I need to know how to use a timeline?",
    a: (
      <>
        No. You describe the edit in plain language and the Director turns it into a declarative
        edit-doc — the single source of truth. There is a cuts timeline you can click through if you
        want it, but nothing about the flow requires it.
      </>
    ),
  },
];

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
      <div className="text-center">
        <p className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-amber">
          Questions
        </p>
        <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">
          Straight answers
        </h2>
      </div>

      <div className="mt-10 divide-y divide-line-soft border-y border-line-soft">
        {FAQS.map((item) => (
          <details key={item.q} className="group py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-3 text-left text-[15px] font-medium text-text transition hover:text-amber [&::-webkit-details-marker]:hidden">
              {item.q}
              <span
                aria-hidden="true"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line text-muted transition-transform duration-200 group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p className="pb-4 pr-10 text-sm leading-relaxed text-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
