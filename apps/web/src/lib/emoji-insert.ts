/**
 * Insert an emoji sticker / reaction pack into the doc — shared by the picker
 * (click → playhead), the Stage drop zone (drag → where it lands) and anything
 * that accepts `EMOJI_DRAG_MIME` (see docs/agents/emoji-cycle-j.md).
 */
import type { EditDoc, EmojiDragPayload } from "@cadence/core";
import { addEmoji, addReaction } from "@cadence/director";

export interface EmojiPlacement {
  /** Timeline start (seconds). */
  atSec: number;
  /** Where the center lands, as fractions of the frame (absent ⇒ centered / the pack's own anchor). */
  xFrac?: number;
  yFrac?: number;
}

/** Apply a payload (single emoji or reaction pack) to the doc. Returns the new doc + the first clip id. */
export function insertEmojiPayload(doc: EditDoc, payload: Pick<EmojiDragPayload, "emoji" | "pack">, at: EmojiPlacement): { doc: EditDoc; clipId: string | null } {
  const atSec = Math.round(Math.max(0, at.atSec) * 100) / 100;
  const pos = { xFrac: at.xFrac, yFrac: at.yFrac };
  if (payload.pack && payload.pack !== "sticker") {
    const r = addReaction(doc, { pack: payload.pack, ...(payload.emoji ? { emoji: payload.emoji } : {}), atSec, ...pos });
    return { doc: r.doc, clipId: r.clipIds[0] ?? null };
  }
  const r = addEmoji(doc, { emoji: payload.emoji, atSec, intro: "pop", exit: "fade", ...pos });
  return { doc: r.doc, clipId: r.clipIds[0] ?? null };
}
