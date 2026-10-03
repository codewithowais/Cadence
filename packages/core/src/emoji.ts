/**
 * The emoji CATALOG API — pure, isomorphic helpers over the generated
 * `emoji-catalog.ts` (every standard Unicode emoji with Twemoji art, grouped, with
 * keywords and skin-tone variants), shared by the web picker and the Director.
 */
import { EMOJI_GROUPS, EMOJI_ROWS, EMOJI_SUBGROUPS } from "./emoji-catalog";

export { EMOJI_GROUPS, EMOJI_SUBGROUPS };

export interface EmojiEntry {
  /** The base emoji (default / yellow skin tone). */
  emoji: string;
  name: string;
  keywords: string;
  /** Index into EMOJI_GROUPS. */
  group: number;
  /** Subgroup key (e.g. "face-smiling"). */
  subgroup: string;
  /** Skin-tone variants for tones 1..5 (light → dark), when the emoji has them. */
  skins?: readonly string[];
}

export const EMOJI_CATALOG: readonly EmojiEntry[] = EMOJI_ROWS.map((r) => ({
  emoji: r[0],
  name: r[1],
  keywords: r[2],
  group: r[3],
  subgroup: EMOJI_SUBGROUPS[r[4]] ?? "",
  ...(r[5] ? { skins: r[5] } : {}),
}));

/** Skin-tone choices (0 = default yellow). */
export const SKIN_TONES = [
  { tone: 0, label: "Default", swatch: "#ffcc4d" },
  { tone: 1, label: "Light", swatch: "#f7dece" },
  { tone: 2, label: "Medium-light", swatch: "#f3d2a2" },
  { tone: 3, label: "Medium", swatch: "#d5ab88" },
  { tone: 4, label: "Medium-dark", swatch: "#af7e57" },
  { tone: 5, label: "Dark", swatch: "#7c533e" },
] as const;
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;

const BY_EMOJI = new Map<string, EmojiEntry>();
for (const e of EMOJI_CATALOG) {
  BY_EMOJI.set(e.emoji, e);
  for (const s of e.skins ?? []) BY_EMOJI.set(s, e);
}
// Also resolve the VS16-stripped / VS16-added spellings of every entry.
for (const [k, e] of [...BY_EMOJI]) {
  const bare = k.replace(/\uFE0F/g, "");
  if (!BY_EMOJI.has(bare)) BY_EMOJI.set(bare, e);
}

/** Total emoji available, counting every skin-tone variant. */
export function emojiTotal(): number {
  return EMOJI_CATALOG.reduce((n, e) => n + 1 + (e.skins?.length ?? 0), 0);
}

/** The catalog entry for an emoji (base OR skin-toned form), if standard. */
export function findEmojiEntry(emoji: string): EmojiEntry | undefined {
  return BY_EMOJI.get(emoji) ?? BY_EMOJI.get(emoji.replace(/️/g, ""));
}

/** The emoji to show/insert for `e` at `tone` (falls back to the base when it has no variants). */
export function emojiWithTone(e: EmojiEntry, tone: SkinTone): string {
  return tone > 0 && e.skins ? (e.skins[tone - 1] ?? e.emoji) : e.emoji;
}

/** Entries of one group (by group index), in Unicode order. */
export function emojiInGroup(group: number): readonly EmojiEntry[] {
  return EMOJI_CATALOG.filter((e) => e.group === group);
}

const tokens = (q: string): string[] => q.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);

/**
 * Search by name + keywords. Every query token must match (prefix match inside a
 * word); names rank above keywords, whole-name and prefix matches rank highest.
 * Also accepts the emoji character itself. Deterministic order (score, then Unicode order).
 */
export function searchEmoji(query: string, limit = 120): EmojiEntry[] {
  const q = query.trim();
  if (!q) return [];
  const direct = findEmojiEntry(q);
  if (direct) return [direct];
  const toks = tokens(q);
  if (toks.length === 0) return [];
  const scored: { e: EmojiEntry; s: number; i: number }[] = [];
  EMOJI_CATALOG.forEach((e, i) => {
    const name = e.name.toLowerCase();
    const nameWords = name.split(/[^a-z0-9+]+/).filter(Boolean);
    const kw = e.keywords.split(" ");
    let score = 0;
    for (const t of toks) {
      if (name === t) score += 100;
      else if (nameWords.includes(t)) score += 40;
      else if (nameWords.some((w) => w.startsWith(t))) score += 25;
      else if (kw.includes(t)) score += 15;
      else if (kw.some((w) => w.startsWith(t))) score += 8;
      else return; // a token matched nothing → not a hit
    }
    if (name.startsWith(toks[0]!)) score += 10;
    scored.push({ e, s: score, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.e);
}

/** The single best emoji for a word/phrase ("fire", "party popper", "heart eyes"), or undefined. */
export function bestEmoji(query: string): EmojiEntry | undefined {
  return searchEmoji(query, 1)[0];
}

// ---- recents + favorites (pure list helpers; persistence lives in the web app) -----

/** Move/insert `emoji` at the front of a most-recent-first list, capped at `max`. */
export function pushRecent(list: readonly string[], emoji: string, max = 32): string[] {
  return [emoji, ...list.filter((x) => x !== emoji)].slice(0, max);
}

/** Add `emoji` to a favorites list if absent, else remove it. */
export function toggleFavorite(list: readonly string[], emoji: string): string[] {
  return list.includes(emoji) ? list.filter((x) => x !== emoji) : [...list, emoji];
}

// ---- drag & drop payload (documented in docs/agents/emoji-cycle-j.md) -------------

/** dataTransfer MIME for dragging an emoji from the picker onto the Stage / timeline. */
export const EMOJI_DRAG_MIME = "application/x-cadence-emoji";

/** JSON carried by `EMOJI_DRAG_MIME` (also mirrored as text/plain = the emoji itself). */
export interface EmojiDragPayload {
  v: 1;
  /** The emoji (already skin-toned). */
  emoji: string;
  /** Optional reaction pack key (see REACTION_PACKS in @cadence/director); absent = a single sticker. */
  pack?: string;
}

export function encodeEmojiDrag(p: Omit<EmojiDragPayload, "v">): string {
  return JSON.stringify({ v: 1, ...p });
}

/** Parse a drag payload defensively; null on anything malformed. */
export function decodeEmojiDrag(raw: string | null | undefined): EmojiDragPayload | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<EmojiDragPayload>;
    if (o && o.v === 1 && typeof o.emoji === "string" && o.emoji.length > 0 && o.emoji.length <= 64) {
      return { v: 1, emoji: o.emoji, ...(typeof o.pack === "string" ? { pack: o.pack } : {}) };
    }
  } catch {
    /* malformed */
  }
  return null;
}
