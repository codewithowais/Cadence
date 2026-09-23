import type { ComponentType, SVGProps } from "react";
import {
  ScissorsIcon,
  EraserIcon,
  FrameIcon,
  CaptionsIcon,
  LooksIcon,
  TitleIcon,
  BrollIcon,
  SpeedIcon,
  PhotoIcon,
  ExportIcon,
  PunchIcon,
} from "./icons";

type Feature = {
  title: string;
  body: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Honest note about what needs export / an install. */
  note?: string;
};

type Group = {
  kicker: string;
  heading: string;
  features: Feature[];
};

const GROUPS: Group[] = [
  {
    kicker: "Cut & shape",
    heading: "Turn raw footage into a tight edit",
    features: [
      {
        title: "Highlight cut",
        body: "Pick the strongest segments up to a target length — a 60-second cut from a long take.",
        Icon: ScissorsIcon,
      },
      {
        title: "Filler & pause removal",
        body: "Tighten a talking-head video by dropping filler words and dead air.",
        Icon: EraserIcon,
      },
      {
        title: "Reframe to any ratio",
        body: "9:16, 1:1, 4:5 or 16:9 — every clip re-anchors so nothing important leaves the frame.",
        Icon: FrameIcon,
      },
      {
        title: "Speed ramps & punch-in",
        body: "Ramp speed for energy and add a scale-pulse punch-in to land the emphasis.",
        Icon: SpeedIcon,
      },
    ],
  },
  {
    kicker: "Look & feel",
    heading: "Grade, caption and title — live",
    features: [
      {
        title: "Color looks, live-graded",
        body: "Warm, cool, vivid, cinematic, vintage, noir and more — applied on your real footage as you watch.",
        Icon: LooksIcon,
      },
      {
        title: "Burn-in captions",
        body: "Generated from the transcript, synced through the cuts, auto-fit to the frame with a readable pill.",
        Icon: CaptionsIcon,
      },
      {
        title: "Titles, lower-thirds & fades",
        body: "Static and kinetic title cards with fade in/out, plus fade from and to black.",
        Icon: TitleIcon,
      },
      {
        title: "B-roll & emphasis",
        body: "Overlay picture-in-picture b-roll in any corner, and punch in to highlight a moment.",
        Icon: PunchIcon,
      },
    ],
  },
  {
    kicker: "Create & deliver",
    heading: "From photos to a finished file",
    features: [
      {
        title: "Text videos — no footage needed",
        body: "Type a script, a quote or a list and get animated typography scenes: 10 themes, 24 fonts, 21 text animations and moving backgrounds. Exported exactly as previewed.",
        Icon: TitleIcon,
      },
      {
        title: "Photo → slideshow",
        body: "Turn a set of photos into a video with Ken Burns moves and crossfades — then treat it like any edit.",
        Icon: PhotoIcon,
      },
      {
        title: "B-roll compositing",
        body: "Layer clips and images over your main track, corner-anchored, sized to taste.",
        Icon: BrollIcon,
      },
      {
        title: "Faithful 4K export",
        body: "Lanczos scale, unsharp and denoise up to 3840×2160 — never alters faces or content.",
        Icon: ExportIcon,
        note: "Real .mp4 renders on export with ffmpeg (bundled in Docker).",
      },
    ],
  },
];

export function FeatureShowcase() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
      <div className="max-w-2xl">
        <p className="mb-3 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-teal">
          <span className="h-1.5 w-1.5 rounded-full bg-teal" /> Everything below is real today
        </p>
        <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">
          One conversation, the whole editing kit
        </h2>
        <p className="mt-4 text-base leading-relaxed text-muted">
          Ask for any of these in plain language — or chain several in a single request. The
          Director plans the steps, shows you the result on your own media, and leaves every
          choice editable.
        </p>
      </div>

      <div className="mt-12 space-y-14">
        {GROUPS.map((group) => (
          <div key={group.kicker}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-soft pb-3">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-amber">
                {group.kicker}
              </span>
              <h3 className="text-lg font-semibold tracking-tight text-text">{group.heading}</h3>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {group.features.map((f) => (
                <article
                  key={f.title}
                  className="group flex h-full flex-col rounded-2xl border border-line-soft bg-panel/50 p-5 transition duration-200 hover:-translate-y-0.5 hover:border-line hover:bg-panel"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-elevated text-amber transition-colors group-hover:border-amber/40">
                    <f.Icon className="h-5 w-5" />
                  </span>
                  <h4 className="mt-4 text-[15px] font-semibold tracking-tight text-text">
                    {f.title}
                  </h4>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{f.body}</p>
                  {f.note ? (
                    <p className="mt-3 border-t border-line-soft pt-3 text-xs leading-relaxed text-faint">
                      {f.note}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
