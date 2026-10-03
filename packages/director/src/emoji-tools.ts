/**
 * Director tools for emoji stickers + reaction packs (`add_emoji`, `add_reaction`,
 * `edit_emoji`) — typed wrappers over the pure ops in emoji.ts, plus the plain
 * language router the StubDirector uses ("add a fire emoji at the top right",
 * "pop hearts when I say love", "add confetti"). The same ops back the web picker.
 */
import { z } from "zod";
import { bestEmoji, countEmoji, docDurationSec, emojiSegments, searchEmoji, type EditDoc } from "@cadence/core";
import type { ProjectState } from "./project";
import type { DirectorTool, ToolResult } from "./tools";
import {
  EMOJI_EXITS,
  EMOJI_INTROS,
  EMOJI_LOOPS,
  EMOJI_POSITIONS,
  REACTION_PACKS,
  REACTION_PACK_KEYS,
  addEmoji,
  addReaction,
  editEmoji,
  findReactionPack,
  timesWhenSaid,
  type AddEmojiInput,
  type AddReactionInput,
  type EditEmojiPatch,
} from "./emoji";
import { parseAt, parsePosition } from "./graphics-tools";

function commit(project: ProjectState, doc: EditDoc, summary: string): ToolResult {
  project.setDoc(doc);
  return { summary, durationSec: docDurationSec(project.doc) };
}

const Position = z.enum(EMOJI_POSITIONS);
const Frac = z.number().min(0).max(1);

/** Resolve an emoji from a literal emoji character or a plain-language name ("fire", "heart eyes"). */
export function resolveEmoji(emoji?: string, query?: string): string | undefined {
  const lit = emoji?.trim();
  if (lit && countEmoji(lit) > 0) return lit;
  const q = (query ?? emoji ?? "").trim();
  if (!q) return undefined;
  const e = bestEmoji(q) ?? bestEmoji(q.replace(/s$/, ""));
  return e?.emoji;
}

// ---- add_emoji ----------------------------------------------------------------------------

export interface AddEmojiToolInput extends Omit<AddEmojiInput, "emoji"> {
  emoji?: string;
  query?: string;
}

export const addEmojiTool: DirectorTool<AddEmojiToolInput> = {
  name: "add_emoji",
  description:
    "Add an animated COLOR EMOJI sticker (any standard Unicode emoji; editable afterwards). Pass `emoji` (the character, e.g. 🔥) or `query` (a name/keyword like 'fire', 'heart eyes', 'party popper'). `position` is one of 9 title-safe anchors (or xFrac/yFrac 0..1), `scale` the size (1 = 20% of the short side), `intro` pop/bounce/spin/zoom-in/tumble/flip/drop/rise/slide/stomp/fade, `loop` float/wiggle/breathe/pulse/shake/flicker, `exit` fade/zoom-out/rise/sink/blow-up. Starts at `atSec` (default 0) for `durationSec` (default 3).",
  inputSchema: z.object({
    emoji: z.string().max(40).optional(),
    query: z.string().max(60).optional(),
    atSec: z.number().nonnegative().optional(),
    durationSec: z.number().positive().max(600).optional(),
    position: Position.optional(),
    xFrac: Frac.optional(),
    yFrac: Frac.optional(),
    scale: z.number().min(0.15).max(5).optional(),
    intro: z.enum(EMOJI_INTROS).optional(),
    loop: z.enum(EMOJI_LOOPS).optional(),
    exit: z.enum(EMOJI_EXITS).optional(),
    rotation: z.number().min(-360).max(360).optional(),
  }) as z.ZodType<AddEmojiToolInput>,
  async execute(input, ctx) {
    const emoji = resolveEmoji(input.emoji, input.query);
    if (!emoji) throw new Error(`I couldn't find an emoji for “${input.query ?? input.emoji ?? ""}”. Try a simpler word like “fire” or “heart”.`);
    const { query: _q, ...rest } = input;
    void _q;
    const { doc, groupId } = addEmoji(ctx.project.doc, { ...rest, emoji });
    return commit(ctx.project, doc, `Added ${emoji} at ${(input.atSec ?? 0).toFixed(1)}s (${groupId}) — edit it in Design → Emoji.`);
  },
};

// ---- add_reaction -------------------------------------------------------------------------

export interface AddReactionToolInput extends Omit<AddReactionInput, "emoji"> {
  emoji?: string;
  query?: string;
  /** Play the pack every time this word is spoken (needs a transcript). */
  whenSaid?: string;
}

export const addReactionTool: DirectorTool<AddReactionToolInput> = {
  name: "add_reaction",
  description:
    `Add an ANIMATED REACTION PACK of emoji: ${REACTION_PACKS.map((p) => `${p.key} (${p.blurb})`).join("; ")}. ` +
    "`emoji`/`query` override the pack's emoji. `whenSaid` plays the pack at every moment a word is spoken in the transcript (e.g. whenSaid:'love'); otherwise it plays at `atSec` (default 0). `position`/`scale`/`durationSec` as for add_emoji.",
  inputSchema: z.object({
    pack: z.enum(REACTION_PACK_KEYS as [string, ...string[]]),
    emoji: z.string().max(40).optional(),
    query: z.string().max(60).optional(),
    whenSaid: z.string().max(60).optional(),
    atSec: z.union([z.number().nonnegative(), z.array(z.number().nonnegative()).max(12)]).optional(),
    durationSec: z.number().positive().max(30).optional(),
    position: Position.optional(),
    xFrac: Frac.optional(),
    yFrac: Frac.optional(),
    scale: z.number().min(0.3).max(3).optional(),
  }) as z.ZodType<AddReactionToolInput>,
  async execute(input, ctx) {
    const def = findReactionPack(input.pack)!;
    let atSec = input.atSec;
    let when = "";
    if (input.whenSaid) {
      const transcripts = ctx.project.media.map((m) => ctx.project.getTranscript(m.id)).filter((t): t is NonNullable<typeof t> => !!t);
      if (transcripts.length === 0) throw new Error("I need the transcript to time that — still understanding the video, try again in a moment.");
      const times = timesWhenSaid(ctx.project.doc, transcripts, input.whenSaid);
      if (times.length === 0) throw new Error(`I couldn't find “${input.whenSaid}” being said in the video.`);
      atSec = times;
      when = ` ${times.length}× when “${input.whenSaid}” is said`;
    }
    const emoji = resolveEmoji(input.emoji, input.query);
    const { doc, groupId } = addReaction(ctx.project.doc, {
      pack: input.pack,
      ...(emoji ? { emoji } : {}),
      ...(atSec !== undefined ? { atSec } : {}),
      durationSec: input.durationSec,
      position: input.position,
      xFrac: input.xFrac,
      yFrac: input.yFrac,
      scale: input.scale,
    });
    return commit(ctx.project, doc, `Added the ${def.label.toLowerCase()} reaction (${emoji ?? def.emoji.join(" ")})${when} (${groupId}) — edit it in Design → Emoji.`);
  },
};

// ---- edit_emoji -----------------------------------------------------------------------------

export interface EditEmojiToolInput extends EditEmojiPatch {
  /** Group id (emo-N); omit to edit the most recently added emoji group. */
  group?: string;
}

export const editEmojiTool: DirectorTool<EditEmojiToolInput> = {
  name: "edit_emoji",
  description:
    "Edit or remove an emoji sticker / reaction group (all its pieces at once): swap `emoji` (stickers), resize with `scale` (multiplier), move (`position` or xFrac/yFrac), retime (`atSec`), re-animate (`intro`/`loop`/`exit`), or `remove`. `group` is the id returned when it was added (default: the newest).",
  inputSchema: z.object({
    group: z.string().optional(),
    emoji: z.string().max(40).optional(),
    scale: z.number().min(0.1).max(6).optional(),
    position: Position.optional(),
    xFrac: Frac.optional(),
    yFrac: Frac.optional(),
    atSec: z.number().nonnegative().optional(),
    intro: z.enum(EMOJI_INTROS).optional(),
    loop: z.enum(EMOJI_LOOPS).optional(),
    exit: z.enum(EMOJI_EXITS).optional(),
    remove: z.boolean().optional(),
  }) as z.ZodType<EditEmojiToolInput>,
  async execute(input, ctx) {
    const groups = new Set<string>();
    for (const t of ctx.project.doc.tracks) for (const c of t.clips) {
      const m = /^(emo-\d+)-/.exec(c.id);
      if (m) groups.add(m[1]!);
    }
    const ids = [...groups];
    const id = input.group ?? ids[ids.length - 1];
    if (!id) return { summary: "No emoji to edit yet — add one first (Design → Emoji).", durationSec: docDurationSec(ctx.project.doc) };
    const { group: _g, ...patch } = input;
    void _g;
    const doc = editEmoji(ctx.project.doc, id, patch);
    return commit(ctx.project, doc, input.remove ? `Removed ${id}.` : `Updated ${id}.`);
  },
};

// ---- natural-language routing (used by the StubDirector) --------------------------------------

export interface EmojiRequest {
  tool: DirectorTool<never>;
  input: Record<string, unknown>;
}

const LEAD = "(?:add|put|drop|place|throw|slap|stick|show|insert|give me|pop|include)";

/**
 * Read emoji requests into tool calls and return the request with the matched
 * phrases blanked out (`rest`) so the graphics router doesn't also fire on them
 * ("pop hearts when I say love" must not add the heart STICKER graphic too).
 */
export function parseEmojiRequest(req: string): { requests: EmojiRequest[]; rest: string } {
  const out: EmojiRequest[] = [];
  let rest = req;
  const position = parsePosition(req);
  const atSec = parseAt(req);
  const base = { ...(position ? { position } : {}), ...(atSec !== undefined ? { atSec } : {}) };
  const blank = (m: RegExpExecArray): void => {
    rest = rest.replace(m[0], " ");
  };
  const reaction = (pack: string, extra: Record<string, unknown> = {}): void => {
    out.push({ tool: addReactionTool as DirectorTool<never>, input: { pack, ...base, ...extra } });
  };

  // "pop hearts when I say love" → a reaction timed to the spoken word.
  const when = new RegExp(
    `\\b${LEAD}\\s+(?:some\\s+|a\\s+few\\s+|the\\s+)?(.+?)\\s+(?:every time|whenever|each time|when)\\s+(?:i|they|he|she|we|you|someone|the speaker)\\s+(?:say|says|said|mention|mentions|mentioned)\\s+(?:the word\\s+)?["'“]?([a-z0-9' ]+?)["'”]?(?=$|[.,!?]|\\s+(?:in|at|on|to|and)\\b)`,
  ).exec(req);
  if (when) {
    const what = when[1]!.trim();
    const word = when[2]!.trim();
    const packWord = /confetti|party|celebrat/.test(what) ? "party" : /fire|burst/.test(what) ? "burst" : /clap|applause/.test(what) ? "clap" : /laugh|lol|haha/.test(what) ? "laugh" : /sparkle/.test(what) ? "sparkle" : "pop";
    const lit = emojiSegments(what).find((s) => s.emoji)?.text;
    const nameOnly = what.replace(/\b(emojis?|reactions?|stickers?|animations?)\b/g, "").trim();
    const emoji = packWord === "pop" ? (/\bhearts?\b/.test(nameOnly) ? undefined : (lit ?? resolveEmoji(undefined, nameOnly))) : lit;
    reaction(packWord, { whenSaid: word, ...(emoji ? { emoji } : {}) });
    blank(when);
    return { requests: out, rest };
  }

  // Literal emoji characters ("add 🔥 and 😂 at the top").
  const lits = emojiSegments(req).filter((s) => s.emoji).map((s) => s.text);
  if (lits.length > 0 && new RegExp(`\\b${LEAD}\\b|emoji`).test(req)) {
    [...new Set(lits)].slice(0, 6).forEach((e, i) => {
      out.push({ tool: addEmojiTool as DirectorTool<never>, input: { emoji: e, ...base, ...(base.position ? {} : i > 0 ? { xFrac: Math.min(0.9, 0.3 + i * 0.2), yFrac: 0.5 } : {}) } });
    });
    rest = rest.replace(/\p{Extended_Pictographic}️?/gu, " ");
    return { requests: out, rest };
  }

  // Reaction packs.
  const pk = (re: RegExp, pack: string, extra: (m: RegExpExecArray) => Record<string, unknown> = () => ({})): boolean => {
    const m = re.exec(req);
    if (!m) return false;
    reaction(pack, extra(m));
    blank(m);
    return true;
  };
  const burst = /\b(?:an? )?(?:([a-z]+) )?burst of (?:([a-z ]+?) )?(?:emoji|emojis)\b|\b([a-z]+) (?:emoji )?burst\b/.exec(req);
  if (burst && !/\bstar ?burst\b|\bsunburst\b/.test(burst[0]!)) {
    const word = (burst[2] ?? burst[3] ?? burst[1] ?? "fire").trim();
    reaction("burst", { emoji: resolveEmoji(undefined, word) ?? "🔥" });
    blank(burst);
  }
  pk(/\bconfetti\b|\bparty (?:time|emoji|popper|mode|vibes?)\b|\bcelebrat(?:e|ion)\b/, "party");
  pk(/\bclap(?:ping)? (?:spam|reaction|emoji)s?\b|\bapplause\b|\bround of applause\b|\badd (?:some )?claps\b/, "clap");
  pk(/\blaugh(?:ing|ter)? (?:reaction|shake|spam)\b|\blaugh(?:ing)? emoji reaction\b/, "laugh");
  pk(/\b(?:hearts?|love) (?:floating|float|rising|rise|drifting|drift)(?: up)?\b|\bfloating (?:hearts?|emoji)\b|\bfloat(?:ing)? up\b/, "float-up", (m) => (/heart|love/.test(m[0]) ? { emoji: "❤️" } : {}));
  pk(/\bsparkle (?:pack|burst|reaction|emoji)\b/, "sparkle");

  // A single named emoji: "add a fire emoji", "put a heart eyes emoji at the top right".
  const one = new RegExp(`\\b${LEAD}\\s+(?:an?\\s+|the\\s+|some\\s+)?([a-z][a-z' -]{0,30}?)\\s+emojis?\\b`).exec(req);
  if (one) {
    const name = one[1]!.trim();
    const e = resolveEmoji(undefined, name) ?? searchEmoji(name, 1)[0]?.emoji;
    if (e) {
      out.push({ tool: addEmojiTool as DirectorTool<never>, input: { emoji: e, ...base } });
      blank(one);
    }
  }
  return { requests: out, rest };
}
