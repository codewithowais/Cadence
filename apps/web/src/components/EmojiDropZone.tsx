"use client";

/**
 * Accepts emoji dragged from the picker (`application/x-cadence-emoji`, see
 * docs/agents/emoji-cycle-j.md) anywhere over its children — wrap the Stage with it.
 * The drop lands the emoji (or reaction pack) centered where the pointer is on the
 * frame, starting at the playhead, through the editor's undoable commit. Renders no
 * box of its own (`display: contents`), so layout is untouched.
 */
import type { DragEvent, ReactNode } from "react";
import { EMOJI_DRAG_MIME, decodeEmojiDrag, type EditDoc } from "@cadence/core";
import { insertEmojiPayload } from "@/lib/emoji-insert";

export function EmojiDropZone({
  doc,
  timeSec,
  onApplyDoc,
  onSelectClip,
  children,
}: {
  doc: EditDoc;
  timeSec: number;
  onApplyDoc: (doc: EditDoc) => void;
  onSelectClip?: (id: string | null) => void;
  children: ReactNode;
}) {
  const isEmoji = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes(EMOJI_DRAG_MIME);

  const onDragOver = (e: DragEvent) => {
    if (!isEmoji(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (e: DragEvent) => {
    if (!isEmoji(e)) return;
    e.preventDefault();
    const payload = decodeEmojiDrag(e.dataTransfer.getData(EMOJI_DRAG_MIME));
    if (!payload) return;
    // The preview canvases cover exactly the composition frame.
    const frame = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("canvas[data-layer]");
    const r = frame?.getBoundingClientRect();
    const inside = !!r && r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const at = inside && r ? { xFrac: (e.clientX - r.left) / r.width, yFrac: (e.clientY - r.top) / r.height } : {};
    const { doc: next, clipId } = insertEmojiPayload(doc, payload, { atSec: timeSec, ...at });
    onApplyDoc(next);
    onSelectClip?.(clipId);
  };

  return (
    <div className="contents" onDragOver={onDragOver} onDrop={onDrop} data-testid="emoji-drop-zone">
      {children}
    </div>
  );
}
