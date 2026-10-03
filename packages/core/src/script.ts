/**
 * Non-Latin SCRIPT helpers (pure): which writing system a string uses, its base
 * direction (RTL for Arabic / Urdu / Hebrew …), and the bundled font families that
 * cover it. The shared canvas text drawing uses these so Arabic / Urdu / Hindi text
 * shapes, orders and falls back to a real font identically in the browser preview and
 * the node export (shaping + bidi come from the canvas text engine itself).
 */

const ARABIC = /[؀-ۿݐ-ݿࡰ-࢟ࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ]/;
/** Right-to-left letters: Hebrew, Arabic (+ supplements / presentation forms), Syriac, Thaana, NKo. */
const RTL_CHAR = /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿߀-߿ࡰ-ࣿיִ-﷿ﹰ-﻿]/;
/** Any strong LEFT-to-right letter (Latin + Latin-extended, Greek, Cyrillic, Indic …). */
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿऀ-෿฀-๿぀-ヿ一-鿿가-힯]/;

export function hasArabicScript(text: string): boolean {
  return ARABIC.test(text);
}

export function hasDevanagariScript(text: string): boolean {
  return DEVANAGARI.test(text);
}

/**
 * Scripts whose letters JOIN or reorder into clusters. Per-letter spacing / per-letter
 * animation would tear them apart (Arabic loses its joins, Devanagari its conjuncts),
 * so the drawing code disables both for these (CSS does the same for letter-spacing).
 */
export function hasComplexScript(text: string): boolean {
  return ARABIC.test(text) || DEVANAGARI.test(text) || /[ঀ-෿]/.test(text);
}

/** Unicode bidi rule P2/P3: the paragraph is RTL when its FIRST strong character is. */
export function isRtlText(text: string): boolean {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return true;
    if (LTR_CHAR.test(ch)) return false;
  }
  return false;
}

/**
 * Bundled font families to list after the clip's own font so every glyph has a real
 * face to land on (the node canvas does per-glyph fallback ACROSS the listed
 * families, but never into an unregistered system font). The Latin alias keeps mixed
 * Latin + script text on the same design.
 */
export function scriptFallbackFamilies(text: string): string[] {
  const out: string[] = [];
  if (ARABIC.test(text)) out.push("'Noto Naskh Arabic'", "'Noto Naskh Arabic Latin'");
  if (DEVANAGARI.test(text)) out.push("'Noto Sans Devanagari'", "'Noto Sans Devanagari Latin'");
  return out;
}

/** Insert `families` right after the first family of a CSS font-family stack. */
export function withFallbackFamilies(stack: string, families: string[]): string {
  if (families.length === 0) return stack;
  const present = families.filter((f) => !stack.includes(f.replace(/'/g, "")) && !stack.includes(f));
  if (present.length === 0) return stack;
  const i = stack.indexOf(",");
  return i < 0 ? `${stack}, ${present.join(", ")}` : `${stack.slice(0, i)}, ${present.join(", ")}${stack.slice(i)}`;
}
