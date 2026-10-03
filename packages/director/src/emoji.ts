/**
 * EMOJI stickers + animated REACTION packs — pure doc operations shared by the
 * Director tools (`add_emoji`, `add_reaction`) and the web emoji picker.
 *
 * Edits-as-code: an emoji sticker is a plain TEXT clip whose text is the emoji —
 * so it rides the existing animation engine (intro / loop / exit), keyframes,
 * export overlays and the Text room with no new clip type — and the shared canvas
 * `drawText` renders it as a bundled color-emoji sprite (preview == node == export;
 * see @cadence/core emoji-draw). Clip ids are `emo-{uid}-{pack}-{n}` on the group's
 * own lane `emoji-{uid}`, so a group, its pack and each layer read back from the doc.
 */
import {
  findEmojiEntry,
  parseEditDoc,
  type EditDoc,
  type TextClip,
} from "@cadence/core";
import { GRAPHIC_POSITIONS, anchorCenter, type GraphicPosition } from "./graphics";

export { GRAPHIC_POSITIONS as EMOJI_POSITIONS };
export type EmojiPosition = GraphicPosition;

// ---- motion vocabulary ---------------------------------------------------------------

export const EMOJI_INTROS = ["pop", "bounce", "spin", "zoom-in", "tumble", "flip", "drop", "rise", "slide-left", "slide-right", "stomp", "fade", "none"] as const;
export const EMOJI_LOOPS = ["none", "float", "wiggle", "breathe", "pulse", "shake", "flicker"] as const;
export const EMOJI_EXITS = ["none", "fade", "zoom-out", "rise", "sink", "blow-up", "slide-left", "slide-right"] as const;
export type EmojiIntro = (typeof EMOJI_INTROS)[number];
export type EmojiLoop = (typeof EMOJI_LOOPS)[number];
export type EmojiExit = (typeof EMOJI_EXITS)[number];

const r2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

interface AnimOpts {
  intro?: EmojiIntro;
  loop?: EmojiLoop;
  exit?: EmojiExit;
  introSec?: number;
  loopSpeed?: number;
  loopAmount?: number;
  exitSec?: number;
  delaySec?: number;
  fromX?: number;
  fromY?: number;
}

/** A `TextAnim`-shaped object for an intro / loop / exit combo (composition px offsets). */
function animFor(o: AnimOpts, W: number, H: number): Record<string, unknown> {
  const intro = o.intro ?? "pop";
  const dur = o.introSec;
  const base: Record<string, unknown> = { style: "none", fromX: 0, fromY: 0, fromScale: 1, durationSec: 0 };
  switch (intro) {
    case "pop": Object.assign(base, { style: "pop", fromScale: 0.25, durationSec: dur ?? 0.45 }); break;
    case "bounce": Object.assign(base, { style: "bounce", fromY: -Math.round(H * 0.12), fromScale: 0.85, durationSec: dur ?? 0.8 }); break;
    case "spin": Object.assign(base, { style: "spin", fromScale: 0.2, durationSec: dur ?? 0.7 }); break;
    case "zoom-in": Object.assign(base, { style: "zoom-in", fromScale: 0.3, durationSec: dur ?? 0.4 }); break;
    case "tumble": Object.assign(base, { style: "tumble", fromScale: 0.4, durationSec: dur ?? 0.7 }); break;
    case "flip": Object.assign(base, { style: "flip", durationSec: dur ?? 0.6 }); break;
    case "drop": Object.assign(base, { style: "drop", durationSec: dur ?? 0.5 }); break;
    case "rise": Object.assign(base, { style: "rise", durationSec: dur ?? 0.5 }); break;
    case "slide-left": Object.assign(base, { style: "slide-left", durationSec: dur ?? 0.5 }); break;
    case "slide-right": Object.assign(base, { style: "slide-right", durationSec: dur ?? 0.5 }); break;
    case "stomp": Object.assign(base, { style: "stomp", durationSec: dur ?? 0.4 }); break;
    case "fade": Object.assign(base, { style: "fade", durationSec: dur ?? 0.4 }); break;
    case "none": break;
  }
  if (o.fromX !== undefined || o.fromY !== undefined) {
    // An explicit slide-from offset (reaction packs): eased kinetic travel.
    Object.assign(base, { style: base.style === "none" || base.style === "kinetic" ? "kinetic" : base.style, fromX: o.fromX ?? 0, fromY: o.fromY ?? 0, durationSec: dur ?? 0.9 });
    if (base.fromScale === 1) base.fromScale = 0.5;
  }
  if (o.delaySec) base.delaySec = o.delaySec;
  void W;
  const loop = o.loop ?? "none";
  base.loop = { style: loop, speed: o.loopSpeed ?? 0.8, amount: o.loopAmount ?? 0.5 };
  base.exit = { style: o.exit ?? "none", durationSec: o.exitSec ?? 0.4 };
  return base;
}

// ---- ids / groups ---------------------------------------------------------------------

export const EMOJI_TRACK_PREFIX = "emoji-";
export const emojiTrackId = (uid: number): string => `${EMOJI_TRACK_PREFIX}${uid}`;
const ID_RE = /^emo-(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*?)-(\d+)$/;

export function parseEmojiId(id: string): { group: string; uid: number; pack: string; n: number } | null {
  const m = ID_RE.exec(id);
  return m ? { group: `emo-${m[1]}`, uid: Number(m[1]), pack: m[2]!, n: Number(m[3]) } : null;
}

export interface EmojiGroup {
  id: string;
  uid: number;
  /** "sticker" for a single emoji, else a REACTION_PACKS key. */
  pack: string;
  clips: TextClip[];
  start: number;
  end: number;
}

/** Every emoji group in the doc, in insertion order. */
export function emojiGroups(doc: EditDoc): EmojiGroup[] {
  const map = new Map<string, EmojiGroup>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "text") continue;
      const g = parseEmojiId(clip.id);
      if (!g) continue;
      let grp = map.get(g.group);
      if (!grp) {
        grp = { id: g.group, uid: g.uid, pack: g.pack, clips: [], start: Infinity, end: -Infinity };
        map.set(g.group, grp);
      }
      grp.clips.push(clip);
      grp.start = Math.min(grp.start, clip.start);
      grp.end = Math.max(grp.end, clip.start + clip.duration);
    }
  }
  return [...map.values()];
}

export const findEmojiGroup = (doc: EditDoc, id: string): EmojiGroup | undefined => emojiGroups(doc).find((g) => g.id === id);

const nextUid = (doc: EditDoc): number => emojiGroups(doc).reduce((m, g) => Math.max(m, g.uid), 0) + 1;

// ---- layout -----------------------------------------------------------------------------

interface Frame {
  W: number;
  H: number;
  /** Base emoji font size (px) for scale 1. */
  base: number;
}
const frameOf = (doc: EditDoc): Frame => ({ W: doc.meta.width, H: doc.meta.height, base: Math.round(Math.min(doc.meta.width, doc.meta.height) * 0.2) });

/** Deterministic PRNG (so a pack lays out the same way every time). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Piece {
  emoji: string;
  x: number;
  y: number;
  size: number; // multiple of the base size
  t0: number;
  dur: number;
  anim: AnimOpts;
  rotation?: number;
}

export interface ReactionPackDef {
  key: string;
  label: string;
  blurb: string;
  /** Default emoji(s) — the first is the picker label. */
  emoji: string[];
  /** Lay the pack out around anchor (cx, cy). `emoji` = the chosen emoji (or the pack's own mix). */
  build: (f: Frame, a: { x: number; y: number }, emoji: string[], dur: number, rand: () => number) => Piece[];
}

const pick = (list: string[], i: number): string => list[i % list.length]!;

export const REACTION_PACKS: ReactionPackDef[] = [
  {
    key: "burst",
    label: "Burst",
    blurb: "A ring of emoji bursts outward from one point (🔥 fire burst)",
    emoji: ["🔥"],
    build: (f, a, emoji, dur) => {
      const n = 9;
      return Array.from({ length: n }, (_, i) => {
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        const ring = f.base * (i % 2 ? 1.5 : 1.05);
        const dx = Math.cos(ang) * ring;
        const dy = Math.sin(ang) * ring;
        return {
          emoji: pick(emoji, i),
          x: a.x + dx,
          y: a.y + dy,
          size: i % 2 ? 0.55 : 0.75,
          t0: i * 0.04,
          dur: Math.max(0.8, dur - i * 0.04),
          anim: { intro: "pop", fromX: -dx * 0.9, fromY: -dy * 0.9, introSec: 0.55, exit: "fade", exitSec: 0.45 },
        } satisfies Piece;
      });
    },
  },
  {
    key: "float-up",
    label: "Float up",
    blurb: "Emoji drift upward from the bottom like reactions on a live stream (❤️)",
    emoji: ["❤️"],
    build: (f, a, emoji, dur, rand) => {
      const n = 8;
      return Array.from({ length: n }, (_, i) => {
        const x = clamp(a.x + (rand() - 0.5) * f.W * 0.55, f.W * 0.1, f.W * 0.9);
        const y = f.H * (0.3 + rand() * 0.3);
        return {
          emoji: pick(emoji, i),
          x,
          y,
          size: 0.45 + rand() * 0.45,
          t0: i * 0.18,
          dur: Math.max(1.2, dur - i * 0.18),
          anim: { intro: "rise", fromX: (rand() - 0.5) * f.W * 0.08, fromY: f.H * (0.45 + rand() * 0.2), introSec: 1.5, loop: "wiggle", loopAmount: 0.5, loopSpeed: 0.7, exit: "fade", exitSec: 0.5 },
        } satisfies Piece;
      });
    },
  },
  {
    key: "clap",
    label: "Clap spam",
    blurb: "A row of claps pulsing in rhythm (👏)",
    emoji: ["👏"],
    build: (f, a, emoji, dur) => {
      const n = 5;
      return Array.from({ length: n }, (_, i) => ({
        emoji: pick(emoji, i),
        x: clamp(a.x + (i - (n - 1) / 2) * f.base * 0.9, f.W * 0.08, f.W * 0.92),
        y: a.y + (i % 2 ? -1 : 1) * f.base * 0.12,
        size: i === 2 ? 1 : 0.7,
        t0: i * 0.12,
        dur: Math.max(0.8, dur - i * 0.12),
        anim: { intro: "pop" as const, introSec: 0.3, loop: "breathe" as const, loopSpeed: 3.2, loopAmount: 1, exit: "fade" as const, exitSec: 0.35 },
      }));
    },
  },
  {
    key: "laugh",
    label: "Laugh shake",
    blurb: "A big emoji shakes with laughter, with a few small ones popping around it (😂)",
    emoji: ["😂"],
    build: (f, a, emoji, dur) => {
      const out: Piece[] = [
        { emoji: pick(emoji, 0), x: a.x, y: a.y, size: 1.25, t0: 0, dur, anim: { intro: "pop", introSec: 0.35, loop: "shake", loopSpeed: 1, loopAmount: 1, exit: "fade", exitSec: 0.4 } },
      ];
      const offs: [number, number][] = [[-1.1, -0.6], [1.15, -0.45], [-0.95, 0.7], [1.0, 0.75]];
      offs.forEach(([dx, dy], i) =>
        out.push({ emoji: pick(emoji, i + 1), x: a.x + dx * f.base, y: a.y + dy * f.base, size: 0.5, t0: 0.15 + i * 0.12, dur: Math.max(0.8, dur - 0.15 - i * 0.12), anim: { intro: "pop", introSec: 0.3, loop: "wiggle", loopAmount: 1, loopSpeed: 1.2, exit: "fade", exitSec: 0.35 } }),
      );
      return out;
    },
  },
  {
    key: "party",
    label: "Confetti / party",
    blurb: "Party emoji rain across the frame (🎉 🎊 ✨ 🥳 🎈)",
    emoji: ["🎉", "🎊", "✨", "🥳", "🎈"],
    build: (f, _a, emoji, dur, rand) => {
      const n = 16;
      return Array.from({ length: n }, (_, i) => {
        const x = f.W * (0.06 + 0.88 * ((i + rand() * 0.8) / n));
        const y = f.H * (0.12 + rand() * 0.5);
        return {
          emoji: pick(emoji, i),
          x,
          y,
          size: 0.35 + rand() * 0.5,
          t0: rand() * 0.6,
          dur: Math.max(1, dur - 0.3),
          anim: { intro: "rise", fromX: (rand() - 0.5) * f.W * 0.2, fromY: -f.H * (0.5 + rand() * 0.3), introSec: 0.8 + rand() * 0.5, loop: i % 3 === 0 ? "wiggle" : "float", loopAmount: 0.5, loopSpeed: 0.6 + rand() * 0.6, exit: "fade", exitSec: 0.5 },
        } satisfies Piece;
      });
    },
  },
  {
    key: "sparkle",
    label: "Sparkle",
    blurb: "Twinkling sparkles scattered around a point (✨)",
    emoji: ["✨"],
    build: (f, a, emoji, dur, rand) =>
      Array.from({ length: 7 }, (_, i) => ({
        emoji: pick(emoji, i),
        x: a.x + (rand() - 0.5) * f.base * 3.2,
        y: a.y + (rand() - 0.5) * f.base * 2.2,
        size: 0.35 + rand() * 0.55,
        t0: i * 0.15,
        dur: Math.max(0.8, dur - i * 0.15),
        anim: { intro: "zoom-in" as const, introSec: 0.35, loop: "flicker" as const, loopSpeed: 0.5 + rand() * 0.5, loopAmount: 0.8, exit: "fade" as const, exitSec: 0.4 },
      })),
  },
  {
    key: "pop",
    label: "Pop",
    blurb: "A few emoji pop in one after another across the frame (💕 hearts when someone says love)",
    emoji: ["💕", "❤️", "💖"],
    build: (f, a, emoji, dur, rand) =>
      Array.from({ length: 6 }, (_, i) => ({
        emoji: pick(emoji, i),
        x: clamp(a.x + (i - 2.5) * f.base * 0.62 + (rand() - 0.5) * f.base * 0.3, f.W * 0.08, f.W * 0.92),
        y: a.y + (rand() - 0.5) * f.base * 1.2,
        size: 0.5 + rand() * 0.5,
        t0: i * 0.1,
        dur: Math.max(0.8, dur - i * 0.1),
        anim: { intro: "pop" as const, introSec: 0.4, loop: "float" as const, loopAmount: 0.6, loopSpeed: 0.8, exit: "zoom-out" as const, exitSec: 0.35 },
      })),
  },
];

export const REACTION_PACK_KEYS = REACTION_PACKS.map((p) => p.key);
export const findReactionPack = (key: string): ReactionPackDef | undefined => REACTION_PACKS.find((p) => p.key === key);

// ---- build ------------------------------------------------------------------------------

function textClip(id: string, p: Piece, f: Frame, start: number): Record<string, unknown> {
  const fontSize = Math.max(8, Math.round(f.base * p.size));
  return {
    id,
    kind: "text",
    start: r2(Math.max(0, start + p.t0)),
    duration: r2(Math.max(0.2, p.dur)),
    text: p.emoji,
    fontSize,
    color: "#ffffff",
    align: "center",
    transform: { x: Math.round(p.x), y: Math.round(p.y), ...(p.rotation ? { rotation: p.rotation } : {}) },
    anim: animFor(p.anim, f.W, f.H),
  };
}

function appendGroup(doc: EditDoc, uid: number, name: string, clips: Record<string, unknown>[]): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  (clone.tracks as unknown[]).push({ id: emojiTrackId(uid), kind: "visual", name, clips, hidden: false, locked: false, muted: false, solo: false });
  return parseEditDoc(clone);
}

const wordsOf = (e: string): string => findEmojiEntry(e)?.name ?? "emoji";

export interface AddEmojiInput {
  emoji: string;
  atSec?: number;
  durationSec?: number;
  /** One of 9 title-safe anchors (default: center). */
  position?: EmojiPosition;
  /** Explicit center as FRACTIONS of the frame (0..1) — overrides `position`. */
  xFrac?: number;
  yFrac?: number;
  /** Size multiplier (default 1 = 20% of the short side). */
  scale?: number;
  intro?: EmojiIntro;
  loop?: EmojiLoop;
  exit?: EmojiExit;
  rotation?: number;
}

function resolveAnchor(f: Frame, size: number, input: { position?: EmojiPosition; xFrac?: number; yFrac?: number }): { x: number; y: number } {
  if (input.xFrac !== undefined || input.yFrac !== undefined) {
    return { x: Math.round(clamp(input.xFrac ?? 0.5, 0, 1) * f.W), y: Math.round(clamp(input.yFrac ?? 0.5, 0, 1) * f.H) };
  }
  const box = size * 1.2;
  return anchorCenter(input.position ?? "center", box, box, f.W, f.H);
}

/** Insert ONE emoji sticker (an animated text clip) on its own lane. Pure. */
export function addEmoji(doc: EditDoc, input: AddEmojiInput): { doc: EditDoc; groupId: string; clipIds: string[] } {
  const emoji = input.emoji.trim();
  if (!emoji) throw new Error("Which emoji? Try “add a fire emoji”.");
  const f = frameOf(doc);
  const uid = nextUid(doc);
  const scale = clamp(input.scale ?? 1, 0.15, 5);
  const size = f.base * scale;
  const at = resolveAnchor(f, size, input);
  const id = `emo-${uid}-sticker-1`;
  const clip = textClip(
    id,
    {
      emoji,
      x: at.x,
      y: at.y,
      size: scale,
      t0: 0,
      dur: input.durationSec ?? 3,
      rotation: input.rotation,
      anim: { intro: input.intro ?? "pop", loop: input.loop ?? "none", exit: input.exit ?? "fade", exitSec: 0.3, loopSpeed: input.loop === "shake" ? 1 : 0.8 },
    },
    f,
    Math.max(0, input.atSec ?? 0),
  );
  const out = appendGroup(doc, uid, `Emoji ${wordsOf(emoji)}`, [clip]);
  return { doc: out, groupId: `emo-${uid}`, clipIds: [id] };
}

export interface AddReactionInput {
  /** A REACTION_PACKS key. */
  pack: string;
  /** Override the pack's emoji (a single emoji, or several to mix). */
  emoji?: string | string[];
  /** One start time, or several (e.g. every time a word is said) — the pack plays at each. */
  atSec?: number | number[];
  durationSec?: number;
  position?: EmojiPosition;
  xFrac?: number;
  yFrac?: number;
  scale?: number;
}

/** Insert an animated reaction PACK (several staggered emoji clips) on one lane. Pure. */
export function addReaction(doc: EditDoc, input: AddReactionInput): { doc: EditDoc; groupId: string; clipIds: string[] } {
  const def = findReactionPack(input.pack);
  if (!def) throw new Error(`Unknown reaction “${input.pack}”. Try one of: ${REACTION_PACK_KEYS.join(", ")}.`);
  const f = frameOf(doc);
  const uid = nextUid(doc);
  const emoji = (Array.isArray(input.emoji) ? input.emoji : input.emoji ? [input.emoji] : def.emoji).filter(Boolean);
  const list = emoji.length ? emoji : def.emoji;
  const scale = clamp(input.scale ?? 1, 0.3, 3);
  const f2: Frame = { ...f, base: Math.round(f.base * scale) };
  const times = (Array.isArray(input.atSec) ? input.atSec : [input.atSec ?? 0]).map((t) => Math.max(0, t)).slice(0, 12);
  const defaultAnchor = def.key === "float-up" ? { position: "bottom" as EmojiPosition } : def.key === "party" ? { position: "top" as EmojiPosition } : { position: "center" as EmojiPosition };
  const anchor = resolveAnchor(f2, f2.base * 1.4, {
    position: input.position ?? defaultAnchor.position,
    xFrac: input.xFrac,
    yFrac: input.yFrac,
  });
  const dur = clamp(input.durationSec ?? (def.key === "burst" ? 1.8 : def.key === "party" ? 3.5 : 2.6), 0.6, 30);
  const clips: Record<string, unknown>[] = [];
  const ids: string[] = [];
  let n = 0;
  times.forEach((t, k) => {
    const pieces = def.build(f2, anchor, list, dur, rng(uid * 7919 + k * 104729 + 17));
    for (const p of pieces) {
      n++;
      const id = `emo-${uid}-${def.key}-${n}`;
      ids.push(id);
      clips.push(textClip(id, p, f2, t));
    }
  });
  const out = appendGroup(doc, uid, def.label, clips);
  return { doc: out, groupId: `emo-${uid}`, clipIds: ids };
}

// ---- edit / remove ------------------------------------------------------------------------

export interface EditEmojiPatch {
  emoji?: string;
  /** Multiply every size by this. */
  scale?: number;
  /** Move the whole group so its center lands at this fraction of the frame. */
  xFrac?: number;
  yFrac?: number;
  position?: EmojiPosition;
  atSec?: number;
  intro?: EmojiIntro;
  loop?: EmojiLoop;
  exit?: EmojiExit;
  remove?: boolean;
}

/** Edit / retime / move / restyle / remove an emoji group (all of its clips at once). Pure. */
export function editEmoji(doc: EditDoc, groupId: string, patch: EditEmojiPatch): EditDoc {
  const g = findEmojiGroup(doc, groupId);
  if (!g) throw new Error(`No emoji group “${groupId}”.`);
  const clone: EditDoc = structuredClone(doc);
  if (patch.remove) {
    clone.tracks = clone.tracks.filter((t) => t.id !== emojiTrackId(g.uid));
    return parseEditDoc(clone);
  }
  const f = frameOf(clone);
  const track = clone.tracks.find((t) => t.id === emojiTrackId(g.uid));
  if (!track) throw new Error(`Emoji group “${groupId}” has no lane.`);
  const clips = track.clips.filter((c): c is TextClip => c.kind === "text" && parseEmojiId(c.id)?.group === groupId);
  const cx = clips.reduce((s, c) => s + c.transform.x, 0) / clips.length;
  const cy = clips.reduce((s, c) => s + c.transform.y, 0) / clips.length;
  let dx = 0;
  let dy = 0;
  if (patch.xFrac !== undefined || patch.yFrac !== undefined || patch.position) {
    const to = resolveAnchor(f, clips[0]!.fontSize, patch);
    dx = to.x - cx;
    dy = to.y - cy;
  }
  const dt = patch.atSec !== undefined ? patch.atSec - g.start : 0;
  for (const c of clips) {
    if (patch.emoji && g.pack === "sticker") c.text = patch.emoji;
    if (patch.scale) c.fontSize = Math.max(8, Math.round(c.fontSize * clamp(patch.scale, 0.1, 6)));
    c.transform = { ...c.transform, x: Math.round(c.transform.x + dx), y: Math.round(c.transform.y + dy) };
    c.start = r2(Math.max(0, c.start + dt));
    if (patch.intro || patch.loop || patch.exit) {
      const cur = c.anim;
      const next = animFor({ intro: patch.intro ?? (cur.style as EmojiIntro) ?? "pop", loop: patch.loop ?? (cur.loop.style as EmojiLoop), exit: patch.exit ?? (cur.exit.style as EmojiExit), loopSpeed: cur.loop.speed, loopAmount: cur.loop.amount, exitSec: cur.exit.durationSec }, f.W, f.H);
      if (!patch.intro) Object.assign(next, { style: cur.style, fromX: cur.fromX, fromY: cur.fromY, fromScale: cur.fromScale, durationSec: cur.durationSec });
      c.anim = next as unknown as TextClip["anim"];
    }
  }
  return parseEditDoc(clone);
}

// ---- "when I say …" -------------------------------------------------------------------------

/** Timeline times (seconds) at which `phrase` (one word) is spoken, mapped through the current cuts. */
export function timesWhenSaid(
  doc: EditDoc,
  transcripts: { words: { text: string; start: number; end: number }[] }[],
  phrase: string,
  limit = 12,
): number[] {
  const want = phrase.toLowerCase().replace(/[^a-z0-9' ]/g, "").trim();
  if (!want) return [];
  const out: number[] = [];
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9']/g, "");
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      const speed = clip.speed ?? 1;
      const lo = clip.sourceIn;
      const hi = clip.sourceIn + clip.duration * speed;
      for (const tr of transcripts) {
        for (let i = 0; i < tr.words.length; i++) {
          const w = tr.words[i]!;
          if (w.start < lo - 1e-6 || w.start >= hi) continue;
          const first = norm(w.text);
          const parts = want.split(" ");
          if (parts.length === 1 ? first === parts[0] : parts.every((p, k) => norm(tr.words[i + k]?.text ?? "") === p)) {
            out.push(r2(clip.start + (w.start - lo) / speed));
          }
        }
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b).slice(0, limit);
}
