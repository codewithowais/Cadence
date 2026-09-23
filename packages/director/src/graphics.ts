/**
 * The GRAPHICS pack — one-click animated graphics (social CTAs, progress bars,
 * countdowns & timers, lower thirds, stickers, hand-drawn annotations) as PURE doc
 * operations shared by the Director tools and the web gallery/inspector.
 *
 * Edits-as-code: a graphic is plain EditDoc data — one or more SHAPE clips (text
 * and icons ride inside them as `parts`, so a label always moves with its pill and
 * exports in the right z-order) on the "graphics" track. Clip ids are
 * `gfx-{n}-{preset}-{role}` on the group's own lane `graphics-{n}`, so the group, its preset, and each layer's role read
 * back from the doc with no extra state: every edit (words, colors, timing,
 * position, size, motion) rebuilds the group from its preset deterministically.
 */
import {
  findFont,
  fontStack,
  formatNumber,
  parseEditDoc,
  docDurationSec,
  type EditDoc,
  type ShapeClip,
  type ShapeExitStyle,
  type ShapeIntroStyle,
  type ShapeKind,
  type ShapeLoopStyle,
  type ShapePart,
} from "@cadence/core";

// ---- small helpers -------------------------------------------------------------

const r2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const stack = (id: string, fallback = "sans-serif"): string => {
  const f = findFont(id);
  return f ? fontStack(f) : fallback;
};
const FONT = {
  bold: stack("montserrat"),
  body: stack("inter"),
  round: stack("poppins"),
  tall: stack("bebas-neue"),
  comic: stack("bangers"),
  mono: stack("space-grotesk"),
};

/**
 * Average glyph advances (em) per bundled face — measured once from the real font
 * files with the Skia renderer — so pills and bars are sized to their words without
 * a canvas (these ops also run in the browser and in tests). [lower, upper, digit, space]
 */
const FONT_METRICS: Record<string, [number, number, number, number]> = {
  montserrat: [0.6, 0.73, 0.61, 0.28],
  poppins: [0.61, 0.69, 0.6, 0.19],
  inter: [0.55, 0.69, 0.61, 0.26],
  "bebas-neue": [0.39, 0.39, 0.4, 0.16],
  bangers: [0.42, 0.42, 0.45, 0.2],
  "space-grotesk": [0.56, 0.63, 0.59, 0.25],
};

/** Estimated rendered width of `text` (composition px) in a bundled face (±5%). */
export function estimateTextWidth(text: string, fontSize: number, font: string = FONT.bold, letterSpacing = 0, upper = false): number {
  const m = FONT_METRICS[findFont(font)?.id ?? "montserrat"] ?? FONT_METRICS.montserrat!;
  const s = upper ? text.toUpperCase() : text;
  let w = 0;
  let n = 0;
  for (const ch of s) {
    n++;
    if (/\s/.test(ch)) w += m[3];
    else if (/[ilIj.,:;'!|]/.test(ch)) w += m[0] * 0.5;
    else if (/[mwMW@%]/.test(ch)) w += (/[a-z]/.test(ch) ? m[0] : m[1]) * 1.4;
    else if (/[0-9]/.test(ch)) w += m[2];
    else if (/[A-Z]/.test(ch)) w += m[1];
    else w += m[0];
  }
  return (w * fontSize + letterSpacing * Math.max(0, n - 1)) * 1.04;
}

// ---- catalog ---------------------------------------------------------------------

export type GraphicCategory = "social" | "progress" | "countdown" | "lower-third" | "sticker" | "annotate";

export const GRAPHIC_CATEGORIES: { key: GraphicCategory; label: string; hint: string }[] = [
  { key: "social", label: "Social", hint: "Subscribe · Like · Follow" },
  { key: "lower-third", label: "Lower thirds", hint: "Names & titles" },
  { key: "countdown", label: "Countdowns", hint: "3-2-1 · timers · count-ups" },
  { key: "progress", label: "Progress", hint: "Bars · rings · stories" },
  { key: "sticker", label: "Stickers", hint: "Hearts · stars · badges" },
  { key: "annotate", label: "Annotate", hint: "Circles · arrows · marks" },
];

/** The nine placement anchors (title-safe margins). */
export const GRAPHIC_POSITIONS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type GraphicPosition = (typeof GRAPHIC_POSITIONS)[number];

/** Everything a preset needs to build (every field has a per-preset default). */
export interface GraphicParams {
  text: string;
  subtext: string;
  color: string;
  accent: string;
  atSec: number;
  durationSec: number;
  /** Countdown start / timer seconds / count-up target / story segments. */
  amount: number;
}

type Layer = { role: string; x: number; y: number; t0?: number; dur?: number; clip: Record<string, unknown> };

interface BuildCtx {
  u: number;
  W: number;
  H: number;
}

export interface GraphicPresetDef {
  key: string;
  label: string;
  category: GraphicCategory;
  blurb: string;
  defaults: Omit<GraphicParams, "atSec" | "durationSec"> & { durationSec: number | "doc"; position: GraphicPosition };
  /** Labels for the editable text fields (absent ⇒ the preset has no such text). */
  fields: { text?: string; subtext?: string; amount?: { label: string; min: number; max: number; step: number } };
  /** Full-frame presets (progress bars) are placed by the builder, not by anchor. */
  fixed?: boolean;
  /** Where the primary / accent colors live, for read-back. */
  paint: { color: Ref; accent?: Ref };
  /** Where the text / subtext live, for read-back. */
  words?: { text?: Ref; subtext?: Ref };
  build: (p: GraphicParams, c: BuildCtx) => Layer[];
}

/** [role, field] where field is "fill" | "stroke" | "knob" | "part{n}". */
type Ref = [string, string];

// ---- clip builders -----------------------------------------------------------------

interface ShapeSpec {
  shape: ShapeKind;
  w: number;
  h: number;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  rotation?: number;
  anim?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  parts?: Record<string, unknown>[];
}

function layer(role: string, x: number, y: number, spec: ShapeSpec, t0 = 0, dur?: number): Layer {
  const { rotation, ...rest } = spec;
  return {
    role,
    x,
    y,
    t0,
    dur,
    clip: {
      kind: "shape",
      fill: "",
      stroke: "",
      strokeWidth: 0,
      radius: 0,
      ...rest,
      w: r2(Math.max(1, spec.w)),
      h: r2(Math.max(1, spec.h)),
      ...(rotation ? { _rotation: rotation } : {}),
    },
  };
}

interface TextSpec {
  font?: string;
  size: number;
  weight?: "normal" | "medium" | "semibold" | "bold";
  color: string;
  dx?: number;
  dy?: number;
  align?: "left" | "center" | "right";
  ls?: number;
  upper?: boolean;
  italic?: boolean;
  anim?: Record<string, unknown>;
  counter?: Record<string, unknown>;
  shadow?: boolean;
}

function txt(text: string, s: TextSpec): Record<string, unknown> {
  return {
    kind: "text",
    text,
    dx: r2(s.dx ?? 0),
    dy: r2(s.dy ?? 0),
    fontFamily: s.font ?? FONT.bold,
    fontSize: r2(s.size),
    fontWeight: s.weight ?? "bold",
    color: s.color,
    align: s.align ?? "center",
    letterSpacing: r2(s.ls ?? 0),
    uppercase: s.upper ?? false,
    italic: s.italic ?? false,
    ...(s.anim ? { anim: s.anim } : {}),
    ...(s.counter ? { counter: s.counter } : {}),
    ...(s.shadow ? { shadow: { color: "#000000b3", blur: r2(s.size * 0.22), offsetX: 0, offsetY: r2(s.size * 0.06) } } : {}),
  };
}

function icon(shape: ShapeKind, w: number, h: number, color: string, dx = 0, dy = 0, strokeWidth = 0): Record<string, unknown> {
  return { kind: "icon", shape, w: r2(w), h: r2(h), color, dx: r2(dx), dy: r2(dy), strokeWidth: r2(strokeWidth) };
}

const anim = (
  style: ShapeIntroStyle,
  durationSec: number,
  opts: { delay?: number; exit?: ShapeExitStyle; exitSec?: number; loop?: ShapeLoopStyle; speed?: number; amount?: number } = {},
): Record<string, unknown> => ({
  style,
  durationSec,
  delaySec: opts.delay ?? 0,
  exit: { style: opts.exit ?? "none", durationSec: opts.exitSec ?? 0.35 },
  loop: { style: opts.loop ?? "none", speed: opts.speed ?? 1, amount: opts.amount ?? 0.5 },
});

/** A text intro for parts (baseline / rise / fade …) with a delay. */
const textIn = (style: string, durationSec: number, delaySec: number): Record<string, unknown> => ({ style, durationSec, delaySec });

// ---- the presets -----------------------------------------------------------------------

const INK = "#0b0d12";

/** A pill-shaped CTA button: optional leading icon + a label, sized to the words. */
function ctaPill(
  p: GraphicParams,
  u: number,
  o: { fill: string; ink: string; h: number; fs: number; font: string; upper?: boolean; icon?: { shape: ShapeKind; w: number; h: number; color: string }; radius?: number; leadGap?: number },
): { w: number; spec: ShapeSpec } {
  const pad = o.h * 0.36;
  const tw = estimateTextWidth(p.text, o.fs, o.font, o.upper ? o.fs * 0.04 : 0, o.upper);
  const iw = o.icon ? o.icon.w + (o.leadGap ?? o.h * 0.18) : 0;
  const w = pad * 2 + iw + tw;
  const parts: Record<string, unknown>[] = [];
  if (o.icon) parts.push(icon(o.icon.shape, o.icon.w, o.icon.h, o.icon.color, -w / 2 + pad + o.icon.w / 2, 0));
  parts.push(txt(p.text, { font: o.font, size: o.fs, color: o.ink, dx: -w / 2 + pad + iw + tw / 2, upper: o.upper, ls: o.upper ? o.fs * 0.04 : 0 }));
  return { w, spec: { shape: "rect", w, h: o.h, fill: o.fill, radius: o.radius ?? o.h / 2, parts } };
}

export const GRAPHIC_PRESETS: GraphicPresetDef[] = [
  // ---- social -------------------------------------------------------------------------
  {
    key: "subscribe",
    label: "Subscribe + bell",
    category: "social",
    blurb: "YouTube-style button that pops in, pulses, and rings its bell.",
    defaults: { text: "Subscribe", subtext: "", color: "#ff1f3d", accent: "#ffffff", amount: 0, durationSec: 4.5, position: "bottom" },
    fields: { text: "Button text" },
    paint: { color: ["btn", "fill"], accent: ["bell", "fill"] },
    words: { text: ["btn", "part1"] },
    build: (p, { u }) => {
      const h = 104 * u;
      const { w, spec } = ctaPill(p, u, { fill: p.color, ink: p.accent, h, fs: 42 * u, font: FONT.bold, upper: true, radius: 22 * u, icon: { shape: "play", w: 34 * u, h: 38 * u, color: p.accent } });
      const bw = 92 * u;
      const gap = 24 * u;
      const total = w + gap + bw;
      return [
        layer("btn", -total / 2 + w / 2, 0, { ...spec, anim: anim("pop", 0.5, { loop: "pulse", speed: 0.8, amount: 0.35, exit: "shrink" }) }),
        layer("bell", total / 2 - bw / 2, 0, { shape: "bell", w: bw, h: bw, fill: p.accent, anim: anim("pop", 0.45, { delay: 0.45, loop: "swing", speed: 1.3, amount: 0.9, exit: "shrink" }) }),
      ];
    },
  },
  {
    key: "like",
    label: "Like",
    category: "social",
    blurb: "A dark pill with a beating heart.",
    defaults: { text: "Like", subtext: "", color: "#15171e", accent: "#ff3b5c", amount: 0, durationSec: 4, position: "bottom" },
    fields: { text: "Button text" },
    paint: { color: ["btn", "fill"], accent: ["heart", "fill"] },
    words: { text: ["btn", "part0"] },
    build: (p, { u }) => {
      const h = 100 * u;
      const hs = 58 * u;
      const pad = h * 0.36;
      const fs = 42 * u;
      const tw = estimateTextWidth(p.text, fs, FONT.round);
      const w = pad * 2 + hs + h * 0.2 + tw;
      return [
        layer("btn", 0, 0, { shape: "rect", w, h, fill: p.color, fillOpacity: 0.94, radius: h / 2, parts: [txt(p.text, { font: FONT.round, size: fs, color: "#ffffff", dx: -w / 2 + pad + hs + h * 0.2 + tw / 2 })], anim: anim("pop", 0.5, { exit: "shrink" }) }),
        layer("heart", -w / 2 + pad + hs / 2, 0, { shape: "heart", w: hs, h: hs * 0.92, fill: p.accent, anim: anim("pop", 0.45, { delay: 0.25, loop: "heartbeat", speed: 1.1, amount: 0.9, exit: "shrink" }) }),
      ];
    },
  },
  {
    key: "follow",
    label: "Follow",
    category: "social",
    blurb: "A bright “+ Follow” pill that hops for attention.",
    defaults: { text: "Follow", subtext: "", color: "#1d9bf0", accent: "#ffffff", amount: 0, durationSec: 4, position: "bottom" },
    fields: { text: "Button text" },
    paint: { color: ["btn", "fill"], accent: ["btn", "part2"] },
    words: { text: ["btn", "part2"] },
    build: (p, { u }) => {
      // A drawn "+" (two bars) leads the label — crisper than a glyph at any size.
      const h = 100 * u;
      const fs = 42 * u;
      const pad = h * 0.36;
      const plus = 28 * u;
      const gap = 16 * u;
      const tw = estimateTextWidth(p.text, fs, FONT.round);
      const w = pad * 2 + plus + gap + tw;
      const px = -w / 2 + pad + plus / 2;
      return [
        layer("btn", 0, 0, {
          shape: "rect",
          w,
          h,
          fill: p.color,
          radius: h / 2,
          parts: [
            icon("rect", plus, 7 * u, p.accent, px, 0),
            icon("rect", 7 * u, plus, p.accent, px, 0),
            txt(p.text, { font: FONT.round, size: fs, color: p.accent, dx: -w / 2 + pad + plus + gap + tw / 2 }),
          ],
          anim: anim("pop", 0.5, { loop: "bounce", speed: 0.9, amount: 0.3, exit: "shrink" }),
        }),
      ];
    },
  },
  {
    key: "link-in-bio",
    label: "Link in bio",
    category: "social",
    blurb: "A white pill with a floating arrow pointing up to your profile.",
    defaults: { text: "Link in bio", subtext: "", color: "#ffffff", accent: "#111318", amount: 0, durationSec: 4, position: "bottom" },
    fields: { text: "Button text" },
    paint: { color: ["btn", "fill"], accent: ["btn", "part0"] },
    words: { text: ["btn", "part0"] },
    build: (p, { u }) => {
      const h = 96 * u;
      const fs = 40 * u;
      const w = estimateTextWidth(p.text, fs, FONT.round) + h * 0.8;
      return [
        layer("btn", 0, 0, { shape: "rect", w, h, fill: p.color, radius: h / 2, parts: [txt(p.text, { font: FONT.round, size: fs, color: p.accent })], anim: anim("pop", 0.5, { exit: "shrink" }) }),
        layer("chev", 0, -h / 2 - 52 * u, { shape: "chevron", w: 64 * u, h: 32 * u, stroke: p.color, strokeWidth: 10 * u, anim: anim("slide-up", 0.45, { delay: 0.3, loop: "float", speed: 1.2, amount: 1, exit: "fade" }) }),
      ];
    },
  },
  {
    key: "swipe-up",
    label: "Swipe up",
    category: "social",
    blurb: "Stacked chevrons that float above a “Swipe up” call.",
    defaults: { text: "Swipe up", subtext: "", color: "#ffffff", accent: "#ffffff", amount: 0, durationSec: 4, position: "bottom" },
    fields: { text: "Call to action" },
    paint: { color: ["chev1", "stroke"], accent: ["label", "part0"] },
    words: { text: ["label", "part0"] },
    build: (p, { u }) => {
      const fs = 46 * u;
      const tw = estimateTextWidth(p.text, fs, FONT.bold, fs * 0.06, true);
      return [
        layer("chev2", 0, -118 * u, { shape: "chevron", w: 60 * u, h: 28 * u, stroke: p.color, strokeWidth: 9 * u, anim: anim("slide-up", 0.45, { delay: 0.2, loop: "float", speed: 1.2, amount: 1, exit: "fade" }) }, 0.15),
        layer("chev1", 0, -70 * u, { shape: "chevron", w: 76 * u, h: 36 * u, stroke: p.color, strokeWidth: 10 * u, anim: anim("slide-up", 0.45, { delay: 0.1, loop: "float", speed: 1.2, amount: 1, exit: "fade" }) }),
        layer("label", 0, 0, { shape: "rect", w: tw + 24 * u, h: fs * 1.5, parts: [txt(p.text, { size: fs, color: p.accent, upper: true, ls: fs * 0.06, shadow: true })], anim: anim("slide-up", 0.5, { exit: "fade" }) }),
      ];
    },
  },
  {
    key: "comment",
    label: "Comment below",
    category: "social",
    blurb: "A speech bubble that pops in and wiggles.",
    defaults: { text: "Comment below", subtext: "", color: "#ffffff", accent: "#111318", amount: 0, durationSec: 4, position: "bottom-right" },
    fields: { text: "Bubble text" },
    paint: { color: ["bubble", "fill"], accent: ["bubble", "part0"] },
    words: { text: ["bubble", "part0"] },
    build: (p, { u }) => {
      const fs = 40 * u;
      const w = estimateTextWidth(p.text, fs, FONT.round) + 70 * u;
      const h = (fs * 1.9) / 0.78;
      return [layer("bubble", 0, 0, { shape: "speech", w, h, fill: p.color, parts: [txt(p.text, { font: FONT.round, size: fs, color: p.accent, dy: -h * 0.11 })], anim: anim("pop", 0.5, { loop: "wiggle", speed: 0.6, amount: 0.3, exit: "shrink" }) })];
    },
  },

  // ---- lower thirds ------------------------------------------------------------------
  {
    key: "lt-bar",
    label: "Bar slide",
    category: "lower-third",
    blurb: "An accent edge, then a dark bar sweeps out and the name rises in.",
    defaults: { text: "Jane Doe", subtext: "Founder, Cadence", color: "#0b0d12", accent: "#ffb547", amount: 0, durationSec: 5, position: "bottom-left" },
    fields: { text: "Name", subtext: "Title" },
    paint: { color: ["bar", "fill"], accent: ["edge", "fill"] },
    words: { text: ["bar", "part0"], subtext: ["bar", "part1"] },
    build: (p, { u }) => {
      const nf = 54 * u;
      const tf = 32 * u;
      const pad = 40 * u;
      const w = Math.max(estimateTextWidth(p.text, nf), estimateTextWidth(p.subtext, tf, FONT.body)) + pad * 2;
      const h = 148 * u;
      const e = 14 * u;
      const total = e + w;
      return [
        layer("edge", -total / 2 + e / 2, 0, { shape: "rect", w: e, h, fill: p.accent, anim: anim("grow-y", 0.35, { exit: "fade", exitSec: 0.3 }) }),
        layer("bar", -total / 2 + e + w / 2, 0, {
          shape: "rect",
          w,
          h,
          fill: p.color,
          fillOpacity: 0.9,
          parts: [
            txt(p.text, { size: nf, color: "#ffffff", align: "left", dx: -w / 2 + pad, dy: -h * 0.16, anim: textIn("baseline", 0.5, 0.3) }),
            txt(p.subtext, { font: FONT.body, size: tf, weight: "medium", color: "#c9d1e0", align: "left", dx: -w / 2 + pad, dy: h * 0.22, anim: textIn("baseline", 0.5, 0.42) }),
          ],
          anim: anim("grow-x", 0.45, { delay: 0.12, exit: "shrink-x", exitSec: 0.4 }),
        }),
      ];
    },
  },
  {
    key: "lt-underline",
    label: "Underline draw",
    category: "lower-third",
    blurb: "Clean type over footage with an accent underline that draws on.",
    defaults: { text: "Jane Doe", subtext: "Founder, Cadence", color: "#ffffff", accent: "#ffb547", amount: 0, durationSec: 5, position: "bottom-left" },
    fields: { text: "Name", subtext: "Title" },
    paint: { color: ["type", "part0"], accent: ["line", "fill"] },
    words: { text: ["type", "part0"], subtext: ["type", "part1"] },
    build: (p, { u }) => {
      const nf = 60 * u;
      const tf = 34 * u;
      const nw = estimateTextWidth(p.text, nf);
      const w = Math.max(nw, estimateTextWidth(p.subtext, tf, FONT.body)) + 20 * u;
      const h = 170 * u;
      return [
        layer("type", 0, 0, {
          shape: "rect",
          w,
          h,
          parts: [
            txt(p.text, { size: nf, color: p.color, align: "left", dx: -w / 2, dy: -h * 0.2, anim: textIn("rise", 0.5, 0.2), shadow: true }),
            txt(p.subtext, { font: FONT.body, size: tf, weight: "medium", color: p.color, align: "left", dx: -w / 2, dy: h * 0.33, anim: textIn("fade", 0.5, 0.5), shadow: true }),
          ],
          anim: anim("none", 0, { exit: "fade", exitSec: 0.35 }),
        }),
        layer("line", -w / 2 + nw / 2, h * 0.08, { shape: "rect", w: nw, h: 8 * u, fill: p.accent, radius: 4 * u, anim: anim("grow-x", 0.5, { delay: 0.1, exit: "shrink-x", exitSec: 0.35 }) }),
      ];
    },
  },
  {
    key: "lt-boxed",
    label: "Boxed",
    category: "lower-third",
    blurb: "Stacked name and title boxes that unfold one after the other.",
    defaults: { text: "Jane Doe", subtext: "Founder, Cadence", color: "#ffffff", accent: "#6d5dfc", amount: 0, durationSec: 5, position: "bottom-left" },
    fields: { text: "Name", subtext: "Title" },
    paint: { color: ["name", "fill"], accent: ["title", "fill"] },
    words: { text: ["name", "part0"], subtext: ["title", "part0"] },
    build: (p, { u }) => {
      const nf = 50 * u;
      const tf = 30 * u;
      const nw = estimateTextWidth(p.text, nf) + 56 * u;
      const tw = estimateTextWidth(p.subtext, tf, FONT.body) + 44 * u;
      const nh = 88 * u;
      const th = 60 * u;
      const total = Math.max(nw, tw);
      return [
        layer("name", -total / 2 + nw / 2, -th / 2, { shape: "rect", w: nw, h: nh, fill: p.color, radius: 8 * u, parts: [txt(p.text, { size: nf, color: INK })], anim: anim("grow-x", 0.4, { exit: "shrink-x", exitSec: 0.35 }) }),
        layer("title", -total / 2 + tw / 2, nh / 2, { shape: "rect", w: tw, h: th, fill: p.accent, radius: 8 * u, parts: [txt(p.subtext, { font: FONT.body, size: tf, weight: "semibold", color: "#ffffff" })], anim: anim("grow-x", 0.4, { delay: 0.2, exit: "shrink-x", exitSec: 0.3 }) }),
      ];
    },
  },
  {
    key: "lt-split",
    label: "Split color",
    category: "lower-third",
    blurb: "A bold two-tone strip: name on accent, title on dark.",
    defaults: { text: "Jane Doe", subtext: "Founder, Cadence", color: "#0b0d12", accent: "#ff3b5c", amount: 0, durationSec: 5, position: "bottom-left" },
    fields: { text: "Name", subtext: "Title" },
    paint: { color: ["right", "fill"], accent: ["left", "fill"] },
    words: { text: ["left", "part0"], subtext: ["right", "part0"] },
    build: (p, { u }) => {
      const nf = 48 * u;
      const tf = 32 * u;
      const h = 104 * u;
      const lw = estimateTextWidth(p.text, nf, FONT.bold, 0, true) + 60 * u;
      const rw = estimateTextWidth(p.subtext, tf, FONT.body) + 60 * u;
      const total = lw + rw;
      return [
        layer("left", -total / 2 + lw / 2, 0, { shape: "rect", w: lw, h, fill: p.accent, parts: [txt(p.text, { size: nf, color: "#ffffff", upper: true })], anim: anim("grow-x", 0.4, { exit: "shrink-x", exitSec: 0.3 }) }),
        layer("right", total / 2 - rw / 2, 0, { shape: "rect", w: rw, h, fill: p.color, fillOpacity: 0.92, parts: [txt(p.subtext, { font: FONT.body, size: tf, weight: "medium", color: "#e8ecf4" })], anim: anim("grow-x", 0.45, { delay: 0.25, exit: "shrink-x", exitSec: 0.3 }) }),
      ];
    },
  },
  {
    key: "lt-pill",
    label: "Glass pill",
    category: "lower-third",
    blurb: "A rounded glass pill with an accent avatar dot that slides in.",
    defaults: { text: "Jane Doe", subtext: "Founder, Cadence", color: "#111827", accent: "#22d3ee", amount: 0, durationSec: 5, position: "bottom-left" },
    fields: { text: "Name", subtext: "Title" },
    paint: { color: ["pill", "fill"], accent: ["pill", "part0"] },
    words: { text: ["pill", "part1"], subtext: ["pill", "part2"] },
    build: (p, { u }) => {
      const nf = 44 * u;
      const tf = 28 * u;
      const h = 124 * u;
      const dot = 76 * u;
      const pad = 24 * u;
      const tw = Math.max(estimateTextWidth(p.text, nf), estimateTextWidth(p.subtext, tf, FONT.body));
      const w = pad + dot + 24 * u + tw + h * 0.4;
      const tx = -w / 2 + pad + dot + 24 * u;
      return [
        layer("pill", 0, 0, {
          shape: "rect",
          w,
          h,
          fill: p.color,
          fillOpacity: 0.88,
          radius: h / 2,
          parts: [
            icon("ellipse", dot, dot, p.accent, -w / 2 + pad + dot / 2, 0),
            txt(p.text, { font: FONT.round, size: nf, color: "#ffffff", align: "left", dx: tx, dy: -h * 0.14 }),
            txt(p.subtext, { font: FONT.body, size: tf, weight: "medium", color: "#aeb8c8", align: "left", dx: tx, dy: h * 0.2 }),
          ],
          anim: anim("slide-right", 0.55, { exit: "slide-left", exitSec: 0.4 }),
        }),
      ];
    },
  },
  {
    key: "lt-line",
    label: "Accent line",
    category: "lower-third",
    blurb: "A minimal vertical rule; the words wipe in beside it.",
    defaults: { text: "Jane Doe", subtext: "Founder, Cadence", color: "#ffffff", accent: "#ffb547", amount: 0, durationSec: 5, position: "bottom-left" },
    fields: { text: "Name", subtext: "Title" },
    paint: { color: ["type", "part0"], accent: ["rule", "fill"] },
    words: { text: ["type", "part0"], subtext: ["type", "part1"] },
    build: (p, { u }) => {
      const nf = 56 * u;
      const tf = 32 * u;
      const h = 140 * u;
      const w = Math.max(estimateTextWidth(p.text, nf), estimateTextWidth(p.subtext, tf, FONT.body)) + 16 * u;
      const gap = 26 * u;
      const e = 6 * u;
      const total = e + gap + w;
      return [
        layer("rule", -total / 2 + e / 2, 0, { shape: "rect", w: e, h, fill: p.accent, radius: e / 2, anim: anim("grow-y", 0.4, { exit: "fade", exitSec: 0.3 }) }),
        layer("type", total / 2 - w / 2, 0, {
          shape: "rect",
          w,
          h,
          parts: [
            txt(p.text, { size: nf, color: p.color, align: "left", dx: -w / 2, dy: -h * 0.17, shadow: true }),
            txt(p.subtext, { font: FONT.body, size: tf, weight: "medium", color: p.color, align: "left", dx: -w / 2, dy: h * 0.25, shadow: true }),
          ],
          anim: anim("wipe", 0.6, { delay: 0.25, exit: "wipe", exitSec: 0.4 }),
        }),
      ];
    },
  },

  // ---- countdowns & timers -------------------------------------------------------------
  {
    key: "countdown-321",
    label: "3-2-1 Go",
    category: "countdown",
    blurb: "Each number pops in a sweeping ring, then GO! bursts out.",
    defaults: { text: "GO!", subtext: "", color: "#0b0d12", accent: "#ffd54a", amount: 3, durationSec: 4, position: "center" },
    fields: { text: "Final word", amount: { label: "Count from", min: 1, max: 10, step: 1 } },
    paint: { color: ["n1", "fill"], accent: ["go", "fill"] },
    words: { text: ["go", "part0"] },
    build: (p, { u }) => {
      const from = Math.round(clamp(p.amount, 1, 10));
      const step = p.durationSec / (from + 1);
      const D = 300 * u;
      const out: Layer[] = [];
      for (let k = from; k >= 1; k--) {
        out.push(
          layer(`n${k}`, 0, 0, {
            shape: "ellipse",
            w: D,
            h: D,
            fill: p.color,
            fillOpacity: 0.62,
            stroke: p.accent,
            strokeWidth: 14 * u,
            progress: { style: "draw", from: 0, to: 1, easing: "linear" },
            parts: [txt(String(k), { font: FONT.tall, size: 190 * u, weight: "normal", color: "#ffffff", dy: 6 * u })],
            anim: anim("pop", Math.min(0.3, step * 0.4), { exit: "fade", exitSec: Math.min(0.15, step * 0.2) }),
          }, (from - k) * step, step),
        );
      }
      out.push(
        layer("go", 0, 0, {
          shape: "burst",
          w: D * 1.2,
          h: D * 1.2,
          fill: p.accent,
          parts: [txt(p.text, { font: FONT.comic, size: 120 * u, weight: "normal", color: INK, dy: 4 * u })],
          anim: anim("pop", Math.min(0.4, step * 0.5), { loop: "pulse", speed: 1.6, amount: 0.5, exit: "shrink", exitSec: Math.min(0.25, step * 0.3) }),
        }, from * step, step),
      );
      return out;
    },
  },
  {
    key: "timer",
    label: "Timer",
    category: "countdown",
    blurb: "A mm:ss countdown that ticks down to 00:00.",
    defaults: { text: "", subtext: "", color: "#0b0d12", accent: "#ffffff", amount: 10, durationSec: 11, position: "top-right" },
    fields: { amount: { label: "Seconds", min: 3, max: 3600, step: 1 } },
    paint: { color: ["timer", "fill"], accent: ["timer", "part1"] },
    build: (p, { u }) => {
      const secs = Math.round(clamp(p.amount, 1, 3600));
      const fs = 64 * u;
      const h = 108 * u;
      const tw = estimateTextWidth(secs >= 3600 ? "00:00:00" : "00:00", fs, FONT.mono);
      const dot = 22 * u;
      const w = tw + dot + h * 0.9;
      return [
        layer("timer", 0, 0, {
          shape: "rect",
          w,
          h,
          fill: p.color,
          fillOpacity: 0.78,
          radius: h / 2,
          parts: [
            icon("ellipse", dot, dot, "#ff3b5c", -w / 2 + h * 0.4 + dot / 2, 0),
            txt("", { font: FONT.mono, size: fs, color: p.accent, dx: dot / 2 + 6 * u, counter: { from: secs, to: 0, format: secs >= 3600 ? "hh:mm:ss" : "mm:ss", mode: "tick" } }),
          ],
          anim: anim("pop", 0.45, { exit: "pop", exitSec: 0.4 }),
        }),
      ];
    },
  },
  {
    key: "timer-ring",
    label: "Ring timer",
    category: "countdown",
    blurb: "Seconds count down inside a ring that empties as time runs out.",
    defaults: { text: "", subtext: "", color: "#0b0d12", accent: "#22d3ee", amount: 10, durationSec: 11, position: "center" },
    fields: { amount: { label: "Seconds", min: 3, max: 600, step: 1 } },
    paint: { color: ["ring", "fill"], accent: ["ring", "stroke"] },
    build: (p, { u }) => {
      const secs = Math.round(clamp(p.amount, 1, 600));
      const D = 270 * u;
      return [
        layer("track", 0, 0, { shape: "ellipse", w: D, h: D, stroke: "#ffffff33", strokeWidth: 14 * u, anim: anim("grow", 0.4, { exit: "fade" }) }),
        layer("ring", 0, 0, {
          shape: "ellipse",
          w: D,
          h: D,
          fill: p.color,
          fillOpacity: 0.55,
          stroke: p.accent,
          strokeWidth: 14 * u,
          progress: { style: "draw", from: 1, to: 0, easing: "linear" },
          parts: [txt("", { font: FONT.tall, size: 150 * u, weight: "normal", color: "#ffffff", dy: 5 * u, counter: { from: secs, to: 0, format: "number", mode: "tick" } })],
          anim: anim("grow", 0.4, { exit: "fade" }),
        }),
      ];
    },
  },
  {
    key: "countup",
    label: "Count-up",
    category: "countdown",
    blurb: "A big number that races up to your milestone.",
    defaults: { text: "", subtext: "followers", color: "#ffffff", accent: "#ffd54a", amount: 10000, durationSec: 3.5, position: "center" },
    fields: { subtext: "Label", amount: { label: "Count to", min: 1, max: 100000000, step: 1 } },
    paint: { color: ["count", "part0"], accent: ["count", "part1"] },
    words: { subtext: ["count", "part1"] },
    build: (p, { u }) => {
      const to = Math.round(Math.max(1, p.amount));
      const fs = 150 * u;
      const lf = 46 * u;
      const w = Math.max(estimateTextWidth(formatNumber(to), fs, FONT.bold), estimateTextWidth(p.subtext, lf, FONT.bold, lf * 0.08, true)) + 40 * u;
      const h = fs + lf * 2;
      return [
        layer("count", 0, 0, {
          shape: "rect",
          w,
          h,
          parts: [
            txt("", { size: fs, color: p.color, dy: -lf * 0.55, shadow: true, counter: { from: 0, to, format: "number", mode: "smooth", easing: "ease-out" } }),
            txt(p.subtext, { size: lf, color: p.accent, dy: fs * 0.5, upper: true, ls: lf * 0.08, shadow: true }),
          ],
          anim: anim("pop", 0.5, { exit: "fade" }),
        }),
      ];
    },
  },

  // ---- progress -----------------------------------------------------------------------
  {
    key: "progress-top",
    label: "Top line",
    category: "progress",
    blurb: "A thin bar across the top that fills over the video.",
    defaults: { text: "", subtext: "", color: "#ffd54a", accent: "#ffffff", amount: 0, durationSec: "doc", position: "top" },
    fields: {},
    fixed: true,
    paint: { color: ["bar", "fill"], accent: ["track", "fill"] },
    build: (p, { u, W, H }) => {
      const h = 10 * u;
      const y = -H / 2 + h / 2;
      return [
        layer("track", 0, y, { shape: "rect", w: W, h, fill: p.accent, fillOpacity: 0.22 }),
        layer("bar", 0, y, { shape: "rect", w: W, h, fill: p.color, progress: { from: 0, to: 1, easing: "linear" } }),
      ];
    },
  },
  {
    key: "progress-bottom",
    label: "Knob bar",
    category: "progress",
    blurb: "A rounded bar along the bottom with a gliding knob.",
    defaults: { text: "", subtext: "", color: "#ff3b5c", accent: "#ffffff", amount: 0, durationSec: "doc", position: "bottom" },
    fields: {},
    fixed: true,
    paint: { color: ["bar", "fill"], accent: ["bar", "knob"] },
    build: (p, { u, W, H }) => {
      const h = 12 * u;
      const w = W - Math.min(W, H) * 0.12;
      const y = H / 2 - Math.min(W, H) * 0.07;
      return [
        layer("track", 0, y, { shape: "rect", w, h, fill: "#ffffff", fillOpacity: 0.25, radius: h / 2 }),
        layer("bar", 0, y, { shape: "rect", w, h, fill: p.color, radius: h / 2, progress: { from: 0, to: 1, easing: "linear", knob: p.accent } }),
      ];
    },
  },
  {
    key: "progress-story",
    label: "Story segments",
    category: "progress",
    blurb: "Instagram-style segments across the top, filling one after another.",
    defaults: { text: "", subtext: "", color: "#ffffff", accent: "#ffffff", amount: 3, durationSec: "doc", position: "top" },
    fields: { amount: { label: "Segments", min: 2, max: 12, step: 1 } },
    fixed: true,
    paint: { color: ["seg0", "fill"], accent: ["seg0bg", "fill"] },
    build: (p, { u, W, H }) => {
      const n = Math.round(clamp(p.amount, 2, 12));
      const m = Math.min(W, H) * 0.03;
      const gap = 8 * u;
      const h = 7 * u;
      const sw = (W - m * 2 - gap * (n - 1)) / n;
      const y = -H / 2 + m + h / 2;
      const seg = p.durationSec / n;
      const out: Layer[] = [];
      for (let i = 0; i < n; i++) {
        const x = -W / 2 + m + sw / 2 + i * (sw + gap);
        out.push(layer(`seg${i}bg`, x, y, { shape: "rect", w: sw, h, fill: p.accent, fillOpacity: 0.35, radius: h / 2 }));
        out.push(layer(`seg${i}`, x, y, { shape: "rect", w: sw, h, fill: p.color, radius: h / 2, progress: { from: 0, to: 1, easing: "linear", startSec: r2(i * seg), durationSec: r2(Math.max(0.01, seg)) } }));
      }
      return out;
    },
  },
  {
    key: "progress-ring",
    label: "Percent ring",
    category: "progress",
    blurb: "A ring that fills to 100% with a live percentage inside.",
    defaults: { text: "", subtext: "", color: "#0b0d12", accent: "#4dff88", amount: 100, durationSec: 4, position: "center" },
    fields: { amount: { label: "Fill to %", min: 1, max: 100, step: 1 } },
    paint: { color: ["ring", "fill"], accent: ["ring", "stroke"] },
    build: (p, { u }) => {
      const pct = Math.round(clamp(p.amount, 1, 100));
      const D = 260 * u;
      return [
        layer("track", 0, 0, { shape: "ellipse", w: D, h: D, stroke: "#ffffff33", strokeWidth: 16 * u, anim: anim("grow", 0.4, { exit: "fade" }) }),
        layer("ring", 0, 0, {
          shape: "ellipse",
          w: D,
          h: D,
          fill: p.color,
          fillOpacity: 0.55,
          stroke: p.accent,
          strokeWidth: 16 * u,
          progress: { style: "draw", from: 0, to: pct / 100, easing: "ease-in-out", durationSec: r2(Math.max(0.5, p.durationSec * 0.7)) },
          parts: [txt("", { size: 64 * u, color: "#ffffff", counter: { from: 0, to: pct, format: "percent", mode: "smooth", easing: "ease-out" } })],
          anim: anim("grow", 0.4, { exit: "fade" }),
        }),
      ];
    },
  },

  // ---- stickers -------------------------------------------------------------------------
  {
    key: "heart",
    label: "Heart",
    category: "sticker",
    blurb: "Pops in and keeps beating.",
    defaults: { text: "", subtext: "", color: "#ff3b5c", accent: "#ffffff", amount: 0, durationSec: 3, position: "top-right" },
    fields: {},
    paint: { color: ["heart", "fill"] },
    build: (p, { u }) => [layer("heart", 0, 0, { shape: "heart", w: 190 * u, h: 175 * u, fill: p.color, anim: anim("pop", 0.5, { loop: "heartbeat", speed: 1.1, amount: 0.9, exit: "shrink" }) })],
  },
  {
    key: "star",
    label: "Star",
    category: "sticker",
    blurb: "Spins in, then wiggles.",
    defaults: { text: "", subtext: "", color: "#ffd54a", accent: "#ffffff", amount: 0, durationSec: 3, position: "top-right" },
    fields: {},
    paint: { color: ["star", "fill"] },
    build: (p, { u }) => [layer("star", 0, 0, { shape: "star", w: 200 * u, h: 192 * u, fill: p.color, anim: anim("spin", 0.6, { loop: "wiggle", speed: 0.7, amount: 0.6, exit: "shrink" }) })],
  },
  {
    key: "badge-new",
    label: "NEW! badge",
    category: "sticker",
    blurb: "A starburst badge with your word, pulsing.",
    defaults: { text: "NEW!", subtext: "", color: "#ffd54a", accent: "#111318", amount: 0, durationSec: 3.5, position: "top-right" },
    fields: { text: "Badge word" },
    paint: { color: ["badge", "fill"], accent: ["badge", "part0"] },
    words: { text: ["badge", "part0"] },
    build: (p, { u }) => {
      const D = 240 * u;
      const fs = Math.min(76 * u, (D * 0.62) / Math.max(1, [...p.text].length * 0.55));
      return [layer("badge", 0, 0, { shape: "burst", w: D, h: D, fill: p.color, rotation: -12, parts: [txt(p.text, { font: FONT.comic, size: fs, weight: "normal", color: p.accent })], anim: anim("pop", 0.5, { loop: "pulse", speed: 1.2, amount: 0.6, exit: "shrink" }) })];
    },
  },
  {
    key: "badge-sale",
    label: "SALE badge",
    category: "sticker",
    blurb: "A hot starburst that wiggles for attention.",
    defaults: { text: "SALE", subtext: "", color: "#ff3b5c", accent: "#ffffff", amount: 0, durationSec: 3.5, position: "top-left" },
    fields: { text: "Badge word" },
    paint: { color: ["badge", "fill"], accent: ["badge", "part0"] },
    words: { text: ["badge", "part0"] },
    build: (p, { u }) => {
      const D = 240 * u;
      const fs = Math.min(66 * u, (D * 0.62) / Math.max(1, [...p.text].length * 0.6));
      return [layer("badge", 0, 0, { shape: "burst", w: D, h: D, fill: p.color, rotation: 10, parts: [txt(p.text, { size: fs, color: p.accent, upper: true })], anim: anim("pop", 0.5, { loop: "wiggle", speed: 0.8, amount: 0.7, exit: "shrink" }) })];
    },
  },
  {
    key: "wow",
    label: "WOW! bubble",
    category: "sticker",
    blurb: "A comic speech bubble.",
    defaults: { text: "WOW!", subtext: "", color: "#ffd54a", accent: "#111318", amount: 0, durationSec: 3, position: "top-left" },
    fields: { text: "Bubble word" },
    paint: { color: ["bubble", "fill"], accent: ["bubble", "part0"] },
    words: { text: ["bubble", "part0"] },
    build: (p, { u }) => {
      const fs = 80 * u;
      const w = estimateTextWidth(p.text, fs, FONT.comic) + 90 * u;
      const h = (fs * 1.6) / 0.78;
      return [layer("bubble", 0, 0, { shape: "speech", w, h, fill: p.color, parts: [txt(p.text, { font: FONT.comic, size: fs, weight: "normal", color: p.accent, dy: -h * 0.11 })], anim: anim("pop", 0.45, { loop: "wiggle", speed: 0.9, amount: 0.5, exit: "shrink" }) })];
    },
  },
  {
    key: "sparkles",
    label: "Sparkles",
    category: "sticker",
    blurb: "Three twinkling sparkles.",
    defaults: { text: "", subtext: "", color: "#fff3b0", accent: "#ffffff", amount: 0, durationSec: 3, position: "top-right" },
    fields: {},
    paint: { color: ["s1", "fill"] },
    build: (p, { u }) => [
      layer("s1", -20 * u, 10 * u, { shape: "sparkle", w: 130 * u, h: 130 * u, fill: p.color, anim: anim("spin", 0.6, { loop: "pulse", speed: 1.1, amount: 0.9, exit: "shrink" }) }),
      layer("s2", 70 * u, -70 * u, { shape: "sparkle", w: 70 * u, h: 70 * u, fill: p.color, anim: anim("grow", 0.45, { delay: 0.2, loop: "pulse", speed: 1.4, amount: 1, exit: "shrink" }) }, 0.1),
      layer("s3", -95 * u, -60 * u, { shape: "sparkle", w: 50 * u, h: 50 * u, fill: p.color, anim: anim("grow", 0.45, { delay: 0.35, loop: "pulse", speed: 1.7, amount: 1, exit: "shrink" }) }, 0.2),
    ],
  },
  {
    key: "done",
    label: "Check done",
    category: "sticker",
    blurb: "A green disc pops and a check mark draws on.",
    defaults: { text: "", subtext: "", color: "#22c55e", accent: "#ffffff", amount: 0, durationSec: 3, position: "top-right" },
    fields: {},
    paint: { color: ["disc", "fill"], accent: ["check", "stroke"] },
    build: (p, { u }) => [
      layer("disc", 0, 0, { shape: "ellipse", w: 170 * u, h: 170 * u, fill: p.color, anim: anim("pop", 0.45, { exit: "shrink" }) }),
      layer("check", 0, 4 * u, { shape: "check", w: 86 * u, h: 64 * u, stroke: p.accent, strokeWidth: 15 * u, anim: anim("draw", 0.45, { delay: 0.3, exit: "fade", exitSec: 0.25 }) }),
    ],
  },

  // ---- annotations ----------------------------------------------------------------------
  {
    key: "circle-mark",
    label: "Circle it",
    category: "annotate",
    blurb: "A hand-drawn loop draws around something.",
    defaults: { text: "", subtext: "", color: "#ff3b5c", accent: "#ffffff", amount: 0, durationSec: 3, position: "center" },
    fields: {},
    paint: { color: ["mark", "stroke"] },
    build: (p, { u }) => [layer("mark", 0, 0, { shape: "scribble", w: 440 * u, h: 270 * u, stroke: p.color, strokeWidth: 11 * u, anim: anim("draw", 0.8, { exit: "fade", exitSec: 0.3 }) })],
  },
  {
    key: "arrow-mark",
    label: "Curved arrow",
    category: "annotate",
    blurb: "A swooping arrow draws on to point at it.",
    defaults: { text: "", subtext: "", color: "#ffd54a", accent: "#ffffff", amount: 0, durationSec: 3, position: "center" },
    fields: {},
    paint: { color: ["mark", "stroke"] },
    build: (p, { u }) => [layer("mark", 0, 0, { shape: "arrow-curve", w: 320 * u, h: 190 * u, stroke: p.color, strokeWidth: 12 * u, anim: anim("draw", 0.6, { exit: "fade", exitSec: 0.3 }) })],
  },
  {
    key: "underline-mark",
    label: "Scribble underline",
    category: "annotate",
    blurb: "A wavy marker underline.",
    defaults: { text: "", subtext: "", color: "#ffd54a", accent: "#ffffff", amount: 0, durationSec: 3, position: "center" },
    fields: {},
    paint: { color: ["mark", "stroke"] },
    build: (p, { u }) => [layer("mark", 0, 0, { shape: "squiggle", w: 440 * u, h: 36 * u, stroke: p.color, strokeWidth: 10 * u, anim: anim("draw", 0.6, { exit: "fade", exitSec: 0.3 }) })],
  },
  {
    key: "box-mark",
    label: "Box it",
    category: "annotate",
    blurb: "A rounded outline draws around a region.",
    defaults: { text: "", subtext: "", color: "#22d3ee", accent: "#ffffff", amount: 0, durationSec: 3, position: "center" },
    fields: {},
    paint: { color: ["mark", "stroke"] },
    build: (p, { u }) => [layer("mark", 0, 0, { shape: "rect", w: 460 * u, h: 260 * u, stroke: p.color, strokeWidth: 8 * u, radius: 20 * u, anim: anim("draw", 0.7, { exit: "fade", exitSec: 0.3 }) })],
  },
  {
    key: "check-mark",
    label: "Tick",
    category: "annotate",
    blurb: "A bold check mark draws on.",
    defaults: { text: "", subtext: "", color: "#4dff88", accent: "#ffffff", amount: 0, durationSec: 3, position: "center" },
    fields: {},
    paint: { color: ["mark", "stroke"] },
    build: (p, { u }) => [layer("mark", 0, 0, { shape: "check", w: 170 * u, h: 130 * u, stroke: p.color, strokeWidth: 18 * u, anim: anim("draw", 0.5, { exit: "fade", exitSec: 0.3 }) })],
  },
  {
    key: "pointer-mark",
    label: "Pointer arrow",
    category: "annotate",
    blurb: "A straight arrow that slides in and nudges.",
    defaults: { text: "", subtext: "", color: "#ffffff", accent: "#ffffff", amount: 0, durationSec: 3, position: "center" },
    fields: {},
    paint: { color: ["mark", "stroke"] },
    build: (p, { u }) => [layer("mark", 0, 0, { shape: "arrow", w: 260 * u, h: 14 * u, stroke: p.color, strokeWidth: 14 * u, anim: anim("slide-right", 0.45, { exit: "fade" }) })],
  },
];

export const GRAPHIC_PRESET_KEYS: string[] = GRAPHIC_PRESETS.map((p) => p.key);

export function findGraphicPreset(key: string): GraphicPresetDef | undefined {
  return GRAPHIC_PRESETS.find((p) => p.key === key);
}

// ---- groups (read back from clip ids) ----------------------------------------------------

/** Graphics live on their own lanes: `graphics-{n}` (one per group). */
export const GRAPHICS_TRACK_PREFIX = "graphics-";
export const graphicTrackId = (uid: number): string => `${GRAPHICS_TRACK_PREFIX}${uid}`;
const ID_RE = /^gfx-(\d+)-([a-z0-9-]+?)-([a-z0-9]+)$/;

/** Parse a graphics clip id → { group, uid, preset, role } (null when not a graphic). */
export function parseGraphicId(id: string): { group: string; uid: number; preset: string; role: string } | null {
  const m = ID_RE.exec(id);
  if (!m || !findGraphicPreset(m[2]!)) return null;
  return { group: `gfx-${m[1]}`, uid: Number(m[1]), preset: m[2]!, role: m[3]! };
}

export interface GraphicGroup {
  /** "gfx-{n}" — stable across edits. */
  id: string;
  uid: number;
  preset: string;
  layers: { role: string; clip: ShapeClip; trackId: string }[];
  start: number;
  end: number;
}

/** Every graphic group in the doc, in insertion order. */
export function graphicGroups(doc: EditDoc): GraphicGroup[] {
  const map = new Map<string, GraphicGroup>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "shape") continue;
      const g = parseGraphicId(clip.id);
      if (!g) continue;
      let grp = map.get(g.group);
      if (!grp) {
        grp = { id: g.group, uid: g.uid, preset: g.preset, layers: [], start: Infinity, end: -Infinity };
        map.set(g.group, grp);
      }
      grp.layers.push({ role: g.role, clip, trackId: track.id });
      grp.start = Math.min(grp.start, clip.start);
      grp.end = Math.max(grp.end, clip.start + clip.duration);
    }
  }
  return [...map.values()].sort((a, b) => a.uid - b.uid);
}

/** The group a clip belongs to (by clip id or group id), or null. */
export function findGraphicGroup(doc: EditDoc, id: string | null | undefined): GraphicGroup | null {
  if (!id) return null;
  const gid = id.startsWith("gfx-") && !ID_RE.test(id) ? id : parseGraphicId(id)?.group;
  if (!gid) return null;
  return graphicGroups(doc).find((g) => g.id === gid) ?? null;
}

// ---- geometry: bbox + placement -------------------------------------------------------------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function layerBox(x: number, y: number, w: number, h: number, scale: number): Box {
  return { x0: x - (w * scale) / 2, y0: y - (h * scale) / 2, x1: x + (w * scale) / 2, y1: y + (h * scale) / 2 };
}

function unionBox(boxes: Box[]): Box {
  return boxes.reduce(
    (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
}

/** The bounding box of a group's layers (composition px). */
export function graphicBounds(group: GraphicGroup): Box {
  return unionBox(group.layers.map(({ clip }) => layerBox(clip.transform.x, clip.transform.y, clip.w, clip.h, clip.transform.scale)));
}

/** The center a group of size bw×bh takes at `pos` inside a W×H frame (title-safe). */
export function anchorCenter(pos: GraphicPosition, bw: number, bh: number, W: number, H: number): { x: number; y: number } {
  const mx = Math.min(W, H) * 0.06;
  const my = Math.min(W, H) * 0.07;
  const col = pos.endsWith("left") || pos === "left" ? 0 : pos.endsWith("right") || pos === "right" ? 2 : 1;
  const row = pos.startsWith("top") ? 0 : pos.startsWith("bottom") ? 2 : 1;
  const x = col === 0 ? mx + bw / 2 : col === 2 ? W - mx - bw / 2 : W / 2;
  const y = row === 0 ? my + bh / 2 : row === 2 ? H - my - bh / 2 : H / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

// ---- build / insert -----------------------------------------------------------------------------

export interface AddGraphicInput {
  preset: string;
  text?: string;
  subtext?: string;
  color?: string;
  accent?: string;
  atSec?: number;
  durationSec?: number;
  amount?: number;
  position?: GraphicPosition;
  /** Explicit group center (composition px) — wins over `position`. */
  x?: number;
  y?: number;
  scale?: number;
}

function resolveParams(doc: EditDoc, def: GraphicPresetDef, input: Partial<AddGraphicInput>): GraphicParams {
  const docDur = docDurationSec(doc);
  const atSec = r2(Math.max(0, input.atSec ?? 0));
  const d = def.defaults.durationSec;
  const fallback = d === "doc" ? Math.max(1, (docDur || 10) - atSec) : d;
  let durationSec = r2(Math.max(0.5, input.durationSec ?? fallback));
  const amount = input.amount ?? def.defaults.amount;
  // A timer needs one second per value plus the final 00:00.
  if ((def.key === "timer" || def.key === "timer-ring") && input.durationSec === undefined) durationSec = Math.round(clamp(amount, 1, 3600)) + 1;
  if (def.key === "countdown-321" && input.durationSec === undefined) durationSec = Math.round(clamp(amount, 1, 10)) + 1;
  return {
    text: input.text ?? def.defaults.text,
    subtext: input.subtext ?? def.defaults.subtext,
    color: input.color ?? def.defaults.color,
    accent: input.accent ?? def.defaults.accent,
    atSec,
    durationSec,
    amount,
  };
}

/** Build a preset's layers as raw clip objects placed at `center` with `scale`. */
function buildLayers(
  doc: EditDoc,
  def: GraphicPresetDef,
  p: GraphicParams,
  uid: number,
  place: { position?: GraphicPosition; x?: number; y?: number; scale?: number },
): Record<string, unknown>[] {
  const W = doc.meta.width;
  const H = doc.meta.height;
  const u = Math.min(W, H) / 1080;
  const layers = def.build(p, { u, W, H });
  const scale = def.fixed ? 1 : clamp(place.scale ?? 1, 0.2, 4);
  const box = unionBox(layers.map((l) => layerBox(l.x, l.y, l.clip.w as number, l.clip.h as number, 1)));
  const bw = (box.x1 - box.x0) * scale;
  const bh = (box.y1 - box.y0) * scale;
  const localCx = (box.x0 + box.x1) / 2;
  const localCy = (box.y0 + box.y1) / 2;
  let cx: number;
  let cy: number;
  if (def.fixed) {
    cx = W / 2;
    cy = H / 2;
  } else if (place.x !== undefined && place.y !== undefined) {
    cx = place.x;
    cy = place.y;
  } else {
    const c = anchorCenter(place.position ?? def.defaults.position, bw, bh, W, H);
    cx = c.x;
    cy = c.y;
  }
  return layers.map((l) => {
    const { _rotation, ...clip } = l.clip as Record<string, unknown> & { _rotation?: number };
    const start = r2(p.atSec + (l.t0 ?? 0));
    const duration = r2(Math.max(0.1, l.dur ?? p.durationSec - (l.t0 ?? 0)));
    const x = def.fixed ? cx + l.x : cx + (l.x - localCx) * scale;
    const y = def.fixed ? cy + l.y : cy + (l.y - localCy) * scale;
    return {
      ...clip,
      id: `gfx-${uid}-${def.key}-${l.role}`,
      start,
      duration,
      transform: { x: r2(x), y: r2(y), scale: r2(scale), rotation: _rotation ?? 0, opacity: 1 },
    };
  });
}

function nextUid(doc: EditDoc): number {
  return graphicGroups(doc).reduce((m, g) => Math.max(m, g.uid), 0) + 1;
}

/**
 * Insert a graphic preset (see GRAPHIC_PRESETS) at `atSec` on its own new lane
 * (`graphics-{n}`, named after the preset) on top of the stack. Returns the new doc and the group id.
 * Pure; the input doc is untouched.
 */
export function addGraphic(doc: EditDoc, input: AddGraphicInput): { doc: EditDoc; groupId: string; clipIds: string[] } {
  const def = findGraphicPreset(input.preset);
  if (!def) throw new Error(`Unknown graphic "${input.preset}". Try one of: ${GRAPHIC_PRESET_KEYS.join(", ")}.`);
  const clone: EditDoc = structuredClone(doc);
  const uid = nextUid(clone);
  const p = resolveParams(clone, def, input);
  const clips = buildLayers(clone, def, p, uid, input);
  // Each graphic gets its own named lane on top of the stack: it reads as one item
  // on the timeline, can be hidden / locked on its own, and newer graphics sit above.
  const track = { id: graphicTrackId(uid), kind: "visual" as const, name: def.label, clips: [] as unknown[], hidden: false, locked: false, muted: false, solo: false };
  track.clips.push(...clips);
  (clone.tracks as unknown[]).push(track);
  return { doc: parseEditDoc(clone), groupId: `gfx-${uid}`, clipIds: clips.map((c) => c.id as string) };
}

// ---- read-back ----------------------------------------------------------------------------------

function readRef(group: GraphicGroup, ref: Ref | undefined): string | undefined {
  if (!ref) return undefined;
  const layer = group.layers.find((l) => l.role === ref[0]);
  if (!layer) return undefined;
  const c = layer.clip;
  if (ref[1] === "fill") return c.fill || undefined;
  if (ref[1] === "stroke") return c.stroke || undefined;
  if (ref[1] === "knob") return c.progress?.knob || undefined;
  const m = /^part(\d+)$/.exec(ref[1]);
  if (m) {
    const part = c.parts?.[Number(m[1])];
    if (!part) return undefined;
    return part.kind === "text" ? part.color : part.color;
  }
  return undefined;
}

function readWords(group: GraphicGroup, ref: Ref | undefined): string | undefined {
  if (!ref) return undefined;
  const layer = group.layers.find((l) => l.role === ref[0]);
  const m = /^part(\d+)$/.exec(ref[1]);
  const part = m ? layer?.clip.parts?.[Number(m[1])] : undefined;
  return part && part.kind === "text" ? part.text : undefined;
}

/** The editable parameters of a group, read back from its clips. */
export function graphicParams(group: GraphicGroup): GraphicParams & { scale: number; center: { x: number; y: number } } {
  const def = findGraphicPreset(group.preset)!;
  const b = graphicBounds(group);
  const first = group.layers[0]!.clip;
  let amount = def.defaults.amount;
  if (group.preset === "countdown-321") amount = group.layers.filter((l) => /^n\d+$/.test(l.role)).length || amount;
  else if (group.preset === "progress-story") amount = group.layers.filter((l) => /^seg\d+$/.test(l.role)).length || amount;
  else {
    for (const l of group.layers) {
      for (const part of l.clip.parts ?? []) {
        if (part.kind === "text" && part.counter) amount = part.counter.mode === "smooth" ? part.counter.to : part.counter.from;
      }
    }
  }
  return {
    text: readWords(group, def.words?.text) ?? def.defaults.text,
    subtext: readWords(group, def.words?.subtext) ?? def.defaults.subtext,
    color: readRef(group, def.paint.color) ?? def.defaults.color,
    accent: readRef(group, def.paint.accent) ?? def.defaults.accent,
    atSec: r2(group.start),
    durationSec: r2(group.end - group.start),
    amount,
    scale: first.transform.scale,
    center: { x: r2((b.x0 + b.x1) / 2), y: r2((b.y0 + b.y1) / 2) },
  };
}

// ---- edit / remove -------------------------------------------------------------------------------

export interface EditGraphicPatch {
  text?: string;
  subtext?: string;
  color?: string;
  accent?: string;
  atSec?: number;
  durationSec?: number;
  amount?: number;
  position?: GraphicPosition;
  x?: number;
  y?: number;
  scale?: number;
  /** Replace the intro / loop / exit of the group's animated layers. */
  intro?: ShapeIntroStyle;
  loop?: ShapeLoopStyle;
  exit?: ShapeExitStyle;
  /** Relative motion speed (0.5 = twice as fast … 2 = half speed) for intros/exits. */
  speed?: number;
}

/**
 * Edit a graphic group: the preset is rebuilt from its current parameters + the
 * patch (so a longer label widens its pill, a new duration re-times every beat)
 * and put back in place — same id, same track position, same center and size
 * unless the patch moves / scales it. Motion overrides are re-applied on top.
 */
export function editGraphic(doc: EditDoc, groupId: string, patch: EditGraphicPatch): EditDoc {
  const group = findGraphicGroup(doc, groupId);
  if (!group) throw new Error(`No graphic "${groupId}" in this project.`);
  const def = findGraphicPreset(group.preset)!;
  const cur = graphicParams(group);
  const motion = currentMotion(group);
  const p = resolveParams(doc, def, {
    text: patch.text ?? cur.text,
    subtext: patch.subtext ?? cur.subtext,
    color: patch.color ?? cur.color,
    accent: patch.accent ?? cur.accent,
    atSec: patch.atSec ?? cur.atSec,
    amount: patch.amount ?? cur.amount,
    durationSec: patch.durationSec ?? (patch.amount !== undefined && (def.key === "timer" || def.key === "timer-ring" || def.key === "countdown-321") ? undefined : cur.durationSec),
  });
  const moved = patch.position !== undefined || (patch.x !== undefined && patch.y !== undefined);
  const rebuilt = buildLayers(doc, def, p, group.uid, {
    ...(moved ? { position: patch.position, x: patch.x, y: patch.y } : { x: cur.center.x, y: cur.center.y }),
    scale: patch.scale ?? cur.scale,
  });
  const override = {
    intro: patch.intro ?? motion.intro,
    loop: patch.loop ?? motion.loop,
    exit: patch.exit ?? motion.exit,
    speed: patch.speed ?? motion.speed,
  };
  for (const c of rebuilt) applyMotion(c, override);

  const clone: EditDoc = structuredClone(doc);
  const ids = new Set(group.layers.map((l) => l.clip.id));
  let inserted = false;
  for (const track of clone.tracks) {
    const idx = track.clips.findIndex((c) => ids.has(c.id));
    if (idx < 0) continue;
    const kept = track.clips.filter((c) => !ids.has(c.id));
    if (!inserted) {
      const before = track.clips.slice(0, idx).filter((c) => !ids.has(c.id)).length;
      (kept as unknown[]).splice(before, 0, ...rebuilt);
      inserted = true;
    }
    track.clips = kept;
  }
  return parseEditDoc(clone);
}

/** Remove every layer of a graphic group (drops its lane when it empties). */
export function removeGraphic(doc: EditDoc, groupId: string): EditDoc {
  const group = findGraphicGroup(doc, groupId);
  if (!group) return doc;
  const ids = new Set(group.layers.map((l) => l.clip.id));
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) track.clips = track.clips.filter((c) => !ids.has(c.id));
  clone.tracks = clone.tracks.filter((t) => !t.id.startsWith(GRAPHICS_TRACK_PREFIX) || t.clips.length > 0);
  return parseEditDoc(clone);
}

// ---- motion overrides ----------------------------------------------------------------------------

interface MotionOverride {
  intro?: ShapeIntroStyle;
  loop?: ShapeLoopStyle;
  exit?: ShapeExitStyle;
  speed?: number;
}

/** The user's motion overrides, read back from a marker on the group's layers. */
function currentMotion(group: GraphicGroup): MotionOverride {
  // Overrides are stored on every layer as `anim` values; a layer whose anim
  // differs from its preset default carries the override. We read the first layer
  // that has an anim and compare to a fresh build.
  const def = findGraphicPreset(group.preset)!;
  const fresh = def.build({ ...graphicParams(group) }, { u: 1, W: 1920, H: 1080 });
  const out: MotionOverride = {};
  for (const l of group.layers) {
    const a = l.clip.anim;
    const f = fresh.find((x) => x.role === l.role)?.clip.anim as { style?: string; durationSec?: number; loop?: { style?: string }; exit?: { style?: string } } | undefined;
    if (!a || !f) continue;
    if (f.style !== "none" && a.style !== f.style) out.intro = a.style;
    if (f.loop?.style !== undefined && a.loop.style !== f.loop.style) out.loop = a.loop.style;
    if (f.exit?.style !== undefined && f.exit.style !== "none" && a.exit.style !== f.exit.style) out.exit = a.exit.style;
    if (f.durationSec && a.durationSec && Math.abs(a.durationSec / f.durationSec - 1) > 0.01) out.speed = r2(a.durationSec / f.durationSec);
    break;
  }
  return out;
}

function applyMotion(clip: Record<string, unknown>, o: MotionOverride): void {
  const a = clip.anim as { style: string; durationSec: number; delaySec: number; exit: { style: string; durationSec: number }; loop: { style: string; speed: number; amount: number } } | undefined;
  if (!a) return;
  if (o.intro && a.style !== "none") {
    a.style = o.intro;
    if (a.durationSec <= 0) a.durationSec = 0.5;
  }
  if (o.loop) {
    a.loop.style = o.loop;
    if (a.loop.amount <= 0) a.loop.amount = 0.5;
  }
  if (o.exit && a.exit.style !== "none") a.exit.style = o.exit;
  if (o.speed && o.speed !== 1) {
    a.durationSec = r2(a.durationSec * o.speed);
    a.delaySec = r2(a.delaySec * o.speed);
    a.exit.durationSec = r2(a.exit.durationSec * o.speed);
  }
}

// ---- animate ANY shape ----------------------------------------------------------------------------

export interface AnimateShapeInput {
  /** One shape (by id); absent ⇒ every non-graphic shape in the doc. */
  clipId?: string;
  style?: ShapeIntroStyle;
  durationSec?: number;
  delaySec?: number;
  exit?: ShapeExitStyle;
  exitSec?: number;
  loop?: ShapeLoopStyle;
  loopSpeed?: number;
  loopAmount?: number;
}

/** Set the intro / exit / loop motion of a shape (or every plain shape). Pure. */
export function animateShape(doc: EditDoc, input: AnimateShapeInput): { doc: EditDoc; count: number } {
  const clone: EditDoc = structuredClone(doc);
  let count = 0;
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "shape") continue;
      if (input.clipId ? clip.id !== input.clipId : parseGraphicId(clip.id) !== null) continue;
      const a = clip.anim ?? {
        style: "none" as ShapeIntroStyle,
        durationSec: 0.5,
        delaySec: 0,
        exit: { style: "none" as ShapeExitStyle, durationSec: 0.4 },
        loop: { style: "none" as ShapeLoopStyle, speed: 1, amount: 0.5 },
      };
      if (input.style !== undefined) a.style = input.style;
      if (input.durationSec !== undefined) a.durationSec = r2(clamp(input.durationSec, 0, 10));
      if (input.delaySec !== undefined) a.delaySec = r2(clamp(input.delaySec, 0, 30));
      if (input.exit !== undefined) a.exit.style = input.exit;
      if (input.exitSec !== undefined) a.exit.durationSec = r2(clamp(input.exitSec, 0, 10));
      if (input.loop !== undefined) a.loop.style = input.loop;
      if (input.loopSpeed !== undefined) a.loop.speed = r2(clamp(input.loopSpeed, 0.05, 8));
      if (input.loopAmount !== undefined) a.loop.amount = r2(clamp(input.loopAmount, 0, 1));
      const isStatic = a.style === "none" && a.exit.style === "none" && a.loop.style === "none";
      if (isStatic) delete (clip as { anim?: unknown }).anim;
      else clip.anim = a;
      count++;
    }
  }
  return { doc: parseEditDoc(clone), count };
}

/** Human summary of a group for lists ("Subscribe + bell · 2.0s–6.5s"). */
export function describeGraphic(group: GraphicGroup): string {
  const def = findGraphicPreset(group.preset)!;
  return `${def.label} · ${group.start.toFixed(1)}s–${group.end.toFixed(1)}s`;
}

/** Unused-part guard for types: ShapePart is re-exported for UI helpers. */
export type { ShapePart };
