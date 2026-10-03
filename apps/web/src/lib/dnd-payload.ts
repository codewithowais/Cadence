/**
 * Drag payload plumbing for palette → timeline / preview drops.
 *
 * Browsers hide a drag's DATA until the drop (only the MIME types are visible
 * during dragover), but the timeline needs to know WHAT is being dragged while it
 * is still in flight (to size the drop preview and decide which lanes accept it).
 * So the drag source also publishes the payload here, in module scope, for the
 * lifetime of the drag. The DataTransfer copy is the source of truth on drop (and
 * works across windows); this is the live view.
 */
import type { DragEvent } from "react";
import type { DropPayload } from "./timeline-dnd";

/** MIME type carrying a JSON `DropPayload`. */
export const DROP_DND_ID = "application/x-cadence-drop";

let active: DropPayload | null = null;
const listeners = new Set<() => void>();

/** The payload currently being dragged (null when nothing from the palette is). */
export function getActiveDrag(): DropPayload | null {
  return active;
}

function setActive(p: DropPayload | null): void {
  active = p;
  for (const l of listeners) l();
}

/** Subscribe to drag start/end (e.g. to tint the lanes while a drag is live). */
export function subscribeActiveDrag(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Props that make any element a palette drag source. Spread onto the element:
 * `<button {...dragSource({ type: "sticker", emoji: "🔥" })} />`.
 */
export function dragSource(payload: DropPayload | null, label?: string) {
  return {
    draggable: payload != null,
    onDragStart: (e: DragEvent) => {
      if (!payload) return;
      e.dataTransfer.setData(DROP_DND_ID, JSON.stringify(payload));
      e.dataTransfer.setData("text/plain", label ?? payload.label ?? payload.type);
      e.dataTransfer.effectAllowed = "copy";
      setActive(payload);
    },
    onDragEnd: () => setActive(null),
  };
}

/** Read a drop payload off a DataTransfer (on drop), falling back to the live one. */
export function readDropPayload(dt: DataTransfer | null): DropPayload | null {
  if (dt) {
    try {
      const raw = dt.getData(DROP_DND_ID);
      if (raw) return JSON.parse(raw) as DropPayload;
    } catch {
      /* fall through to the live payload */
    }
  }
  return active;
}

/** True when a DataTransfer carries a palette payload (visible during dragover). */
export function hasDropPayload(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(DROP_DND_ID);
}
