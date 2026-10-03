import Link from "next/link";

/**
 * "New in Cadence" — the newest abilities, each explained in one plain sentence plus
 * the words you could say. Keep it honest: only what ships.
 */
const NEW: { title: string; body: string; say: string }[] = [
  {
    title: "Make a video from one sentence",
    body: "Type what you want. Cadence writes the scenes, picks the look and music, and shows you a plan to tweak before it builds the video.",
    say: "30s Instagram promo for my coffee shop, warm vibe",
  },
  {
    title: "Split a finished video into clips",
    body: "Drop in a video that's already made. Cadence finds where each scene changes and cuts it into separate clips you can move, trim or delete.",
    say: "split this video into scenes",
  },
  {
    title: "Any size you want",
    body: "Pick a ready-made size for YouTube, TikTok or Instagram, or type your own like 21:9 or 1080 by 1350. Bars around the video can be a color or a soft blur.",
    say: "make it 21:9",
  },
  {
    title: "Move things exactly where you want",
    body: "Click anything on the preview and drag it, resize it or rotate it. Guides help it snap to the center and edges. Or type exact numbers.",
    say: "move the title to the top left",
  },
  {
    title: "A better timeline",
    body: "A real ruler with time, little pictures on your clips, and sound waves on your audio. Drag clips to reorder them, or drag photos, text and stickers straight onto the timeline.",
    say: "drag a photo onto the timeline",
  },
  {
    title: "Thousands of emoji",
    body: "Every standard emoji, with search and skin tones, in full color — in the preview and in the exported video. Add animated bursts like fire, hearts and confetti.",
    say: "pop hearts when I say love",
  },
  {
    title: "Viral-style captions",
    body: "Captions that light up each word as it's spoken, in one-tap styles. Works with Urdu, Arabic and Hindi too.",
    say: "hormozi captions",
  },
  {
    title: "Pro finishing",
    body: "Import color looks (LUTs), grade many clips at once, slow down or speed up with one tap, and handwriting-style text. What you see is what you export.",
    say: "slow motion",
  },
];

export function WhatsNew() {
  return (
    <section id="new" className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
      <h2 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">New in Cadence</h2>
      <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
        The latest things you can do, in plain words. Each one works by typing a sentence or by clicking and dragging — your choice.
      </p>
      <div className="mt-10 grid gap-x-10 gap-y-10 md:grid-cols-2">
        {NEW.map((n) => (
          <div key={n.title} className="flex flex-col border-l-2 border-amber/40 pl-5">
            <h3 className="text-lg font-semibold tracking-tight text-text">{n.title}</h3>
            <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{n.body}</p>
            <p className="voice mt-3 text-[16px] leading-snug text-text">“{n.say}”</p>
          </div>
        ))}
      </div>
      <div className="mt-10">
        <Link
          href="/editor"
          className="rounded-xl bg-amber px-5 py-3 text-sm font-semibold text-onaccent transition hover:bg-amber-bright"
        >
          Try it in the editor
        </Link>
      </div>
    </section>
  );
}
