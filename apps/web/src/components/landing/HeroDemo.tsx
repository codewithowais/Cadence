"use client";

/**
 * The hero is the product: real Cadence text videos, built by the same
 * `buildTextVideo` the Director uses and drawn by the same canvas code as the
 * editor preview and the export. Each demo shows the words that made it.
 * Pauses off-screen; with reduced motion it shows a still and lets you step.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { docDurationSec, parseEditDoc, type EditDoc } from "@cadence/core";
import { buildTextVideo, type TextVideoTheme } from "@cadence/director";
import { SyntheticLayer } from "@/components/SyntheticLayer";

const DEMOS: { prompt: string; script: string; theme: TextVideoTheme }[] = [
  {
    prompt: "make a bold text video: Big news. We just launched. Edit videos just by typing.",
    script: "Big news.\nWe just launched.\nEdit videos just by typing.",
    theme: "bold",
  },
  {
    prompt: "make a neon promo: Tonight only. Live music. Doors at 9.",
    script: "Tonight only.\nLive music.\nDoors at 9.",
    theme: "neon",
  },
  {
    prompt: "elegant quote video: “Simplicity is the ultimate sophistication.” — Leonardo da Vinci",
    script: "“Simplicity is the ultimate sophistication.” — Leonardo da Vinci",
    theme: "elegant",
  },
  {
    prompt: "make an aurora text video: Your ideas. Your words. A finished video.",
    script: "Your ideas.\nYour words.\nA finished video.",
    theme: "aurora",
  },
];

export function HeroDemo() {
  const docs = useMemo<EditDoc[]>(
    () => DEMOS.map((d) => buildTextVideo(parseEditDoc({ version: 1 }), { script: d.script, theme: d.theme, aspect: "16:9" })),
    [],
  );
  const [index, setIndex] = useState(0);
  const [t, setT] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  const frameRef = useRef<HTMLDivElement>(null);
  const clock = useRef(0);
  const doc = docs[index]!;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReduced(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { threshold: 0.1 });
    io.observe(el);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  // Playback: advance time, then move on to the next demo.
  useEffect(() => {
    if (reduced || !visible) return;
    let raf = 0;
    let last = performance.now();
    const total = docDurationSec(doc);
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      clock.current += dt;
      if (clock.current >= total) {
        clock.current = 0;
        setIndex((i) => (i + 1) % docs.length);
      }
      setT(clock.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [doc, docs.length, reduced, visible]);

  const choose = (i: number) => {
    clock.current = reduced ? 1.4 : 0;
    setIndex(i);
    setT(clock.current);
  };

  return (
    <figure className="w-full">
      <div
        ref={frameRef}
        className="relative aspect-video w-full overflow-hidden rounded-[20px] bg-[#12181a] shadow-[0_30px_80px_-30px_rgba(18,24,26,0.55)] ring-1 ring-black/5"
      >
        {size.w > 0 && <SyntheticLayer doc={doc} timeSec={reduced ? 1.4 : t} layer="under" width={size.w} height={size.h} />}
      </div>
      <figcaption className="mt-4 flex items-start gap-3">
        <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber text-[11px] font-semibold text-onaccent" aria-hidden="true">
          C
        </span>
        <p className="min-h-[3.2em] text-[15px] leading-snug text-muted">
          <span className="sr-only">Made from the prompt: </span>
          <span className="voice text-text">{DEMOS[index]!.prompt}</span>
        </p>
      </figcaption>
      <div className="mt-3 flex items-center gap-2" role="group" aria-label="Choose a demo">
        {DEMOS.map((d, i) => (
          <button
            key={d.theme}
            type="button"
            onClick={() => choose(i)}
            aria-pressed={i === index}
            aria-label={`Show the ${d.theme} demo`}
            className={[
              "h-2 rounded-full transition-all",
              i === index ? "w-8 bg-amber" : "w-2 bg-line hover:bg-faint",
            ].join(" ")}
          />
        ))}
      </div>
    </figure>
  );
}
