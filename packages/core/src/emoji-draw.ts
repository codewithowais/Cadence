/**
 * Color-emoji drawing for the shared canvas text path.
 *
 * WHY: canvas `fillText` renders emoji with whatever color-emoji font the machine
 * has — Apple Color Emoji on a Mac, Noto elsewhere, NOTHING in a Docker render
 * container — so the same doc looked different in the preview, the node renderer
 * and the ffmpeg export (which rasterizes text through Skia). Instead, `drawText`
 * wraps its context with `wrapEmojiCtx`: every emoji grapheme is drawn as a bundled
 * Twemoji sprite (CC-BY 4.0, apps/web/public/emoji/<hex>.svg) through a pluggable
 * `EmojiImageProvider`, so the browser preview, the node canvas and the export draw
 * the SAME artwork at the same size and position.
 *
 * Pure + isomorphic: no DOM/node imports here. The browser registers a provider that
 * loads sprites lazily (apps/web/src/lib/emoji-assets.ts); render-node registers a
 * synchronous disk provider. With NO provider registered `wrapEmojiCtx` returns the
 * context untouched, so legacy behavior (and every legacy test) is byte-identical.
 */
import type { Ctx2D } from "./draw";

/** Sprite candidates + a size hint (device px) → a drawable image, or null while loading / missing. */
export interface EmojiImageProvider {
  image(names: readonly string[], px: number): unknown | null;
}

let provider: EmojiImageProvider | null = null;
/** Register (or clear with null) the sprite provider. */
export function setEmojiImageProvider(p: EmojiImageProvider | null): void {
  provider = p;
}
export function getEmojiImageProvider(): EmojiImageProvider | null {
  return provider;
}

/** Raster size bucket (power of two, 64..512) for a requested device-px size — shared by every provider. */
export function emojiBucket(px: number): number {
  const b = 2 ** Math.ceil(Math.log2(Math.max(1, px)));
  return Math.max(64, Math.min(512, b));
}

/** Horizontal advance of one emoji, in font-size units (a native glyph is ~1.17em). */
export const EMOJI_ADVANCE = 1.18;
/** Drawn sprite edge, in font-size units. */
export const EMOJI_SPRITE = 1.12;

const QUICK = /[©®‼-㊙⃣️\u{1f000}-\u{1faff}]/u;
const EMOJI_CLUSTER = /\p{Emoji_Presentation}|\p{Regional_Indicator}|️|‍|⃣|\p{Emoji_Modifier}/u;
const PICTO_START = /^[\p{Extended_Pictographic}\p{Regional_Indicator}#*0-9]/u;

let segmenter: { segment(s: string): Iterable<{ segment: string }> } | null | undefined;
/** Grapheme clusters of `s` (ZWJ sequences, flags, keycaps and skin tones stay whole). */
export function splitGraphemes(s: string): string[] {
  if (segmenter === undefined) {
    const I = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => typeof segmenter }).Segmenter;
    segmenter = I ? (new I(undefined, { granularity: "grapheme" }) as typeof segmenter) : null;
  }
  if (!segmenter) return [...s];
  const out: string[] = [];
  for (const g of segmenter.segment(s)) out.push(g.segment);
  return out;
}

/** True when one grapheme cluster should render as an emoji sprite. */
export function isEmojiGrapheme(g: string): boolean {
  return PICTO_START.test(g) && EMOJI_CLUSTER.test(g);
}

export interface EmojiSegment {
  text: string;
  emoji: boolean;
}

const segCache = new Map<string, EmojiSegment[]>();

/** Split text into alternating plain / emoji runs (emoji runs are ONE grapheme each). */
export function emojiSegments(text: string): EmojiSegment[] {
  const hit = segCache.get(text);
  if (hit) return hit;
  const out: EmojiSegment[] = [];
  for (const g of splitGraphemes(text)) {
    const emoji = isEmojiGrapheme(g);
    const last = out[out.length - 1];
    if (!emoji && last && !last.emoji) last.text += g;
    else out.push({ text: g, emoji });
  }
  if (segCache.size > 400) segCache.clear();
  segCache.set(text, out);
  return out;
}

/** Cheap check: does `text` contain at least one emoji cluster? */
export function hasEmoji(text: string): boolean {
  if (!text || !QUICK.test(text)) return false;
  return emojiSegments(text).some((s) => s.emoji);
}

/** The emoji count of `text` (grapheme clusters). */
export function countEmoji(text: string): number {
  return hasEmoji(text) ? emojiSegments(text).filter((s) => s.emoji).length : 0;
}

/**
 * Sprite file names (without `.svg`) for an emoji grapheme, in preference order.
 * Twemoji rule: code points joined with "-", lowercase hex, VS16 (fe0f) dropped
 * unless the sequence contains a ZWJ. The alternate spelling is tried second.
 */
export function emojiSpriteName(g: string): string[] {
  const cps = [...g].map((c) => c.codePointAt(0)!.toString(16));
  const stripped = cps.filter((c) => c !== "fe0f").join("-");
  const full = cps.join("-");
  const primary = cps.includes("200d") ? full : stripped;
  const alt = primary === full ? stripped : full;
  return primary === alt ? [primary] : [primary, alt];
}

/**
 * Wrap `ctx` so `fillText` / `strokeText` / `measureText` treat emoji graphemes as
 * fontPx-sized sprite cells. Plain strings take the untouched native path. `px` is
 * the canvas-pixels-per-composition-pixel scale (drives the sprite raster size).
 * Returns `ctx` itself when no provider is registered.
 */
export function wrapEmojiCtx(ctx: Ctx2D, fontPx: number, px = 1): Ctx2D {
  const prov = provider;
  if (!prov) return ctx;
  const adv = fontPx * EMOJI_ADVANCE;
  const size = fontPx * EMOJI_SPRITE;

  const measure = (text: string): number => {
    if (!hasEmoji(text)) return ctx.measureText(text).width;
    let w = 0;
    for (const s of emojiSegments(text)) w += s.emoji ? adv : ctx.measureText(s.text).width;
    return w;
  };

  const paint = (mode: "fill" | "stroke", text: string, x: number, y: number): void => {
    if (!hasEmoji(text)) {
      if (mode === "fill") ctx.fillText(text, x, y);
      else ctx.strokeText(text, x, y);
      return;
    }
    const segs = emojiSegments(text);
    const total = measure(text);
    const align = ctx.textAlign;
    let cx = align === "center" ? x - total / 2 : align === "right" || align === "end" ? x - total : x;
    ctx.textAlign = "left";
    for (const s of segs) {
      if (!s.emoji) {
        if (mode === "fill") ctx.fillText(s.text, cx, y);
        else ctx.strokeText(s.text, cx, y);
        cx += ctx.measureText(s.text).width;
        continue;
      }
      if (mode === "fill") {
        const img = prov.image(emojiSpriteName(s.text), size * px);
        if (img) (ctx as unknown as { drawImage(i: unknown, x: number, y: number, w: number, h: number): void }).drawImage(img, cx + (adv - size) / 2, y - size / 2, size, size);
        else ctx.fillText(s.text, cx, y); // still loading / no art → the platform glyph
      }
      cx += adv;
    }
    ctx.textAlign = align;
  };

  return new Proxy(ctx, {
    get(t, p) {
      if (p === "fillText") return (text: string, x: number, y: number) => paint("fill", text, x, y);
      if (p === "strokeText") return (text: string, x: number, y: number) => paint("stroke", text, x, y);
      if (p === "measureText") return (text: string) => ({ width: measure(text) });
      const v = Reflect.get(t, p) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
    set(t, p, v) {
      Reflect.set(t, p, v);
      return true;
    },
  });
}
