"use client";

/**
 * The on-canvas selection box (Canva / CapCut / After-Effects style) for the Stage:
 * drag to move · 8 resize handles (Shift = keep aspect, Alt = from centre) · rotate
 * handle (Shift snaps 15°) · arrow-key nudge (Shift ×10) · smart guides + snapping
 * (Alt bypasses) · double-click text to edit it in place.
 *
 * It owns NO document state. A gesture builds a DRAFT doc from the doc as it was at
 * pointer-down (`onDraft` — the Stage previews it live) and lands ONE edit-doc op on
 * pointer-up (`onCommit` → the editor's undoable `commit`), so a whole drag is a
 * single undo step. All geometry is the pure math in `@cadence/core/transform`; all
 * mutation is `@cadence/director/transform-ops` (keyframe-aware at the playhead).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import {
  CORNER_HANDLES,
  boxAabb,
  boxToPatch,
  hitTestLayers,
  layerBoxesAt,
  pointInBox,
  resizeBox,
  rotationFromPointer,
  snapMove,
  snapPoint,
  unionRect,
  type Box,
  type EditDoc,
  type Guide,
  type HandleId,
  type LayerBox,
  type TextClip,
} from "@cadence/core";
import { moveClipsBy, setTransforms } from "@cadence/director";
import { getMeasureCtx } from "@/lib/stage-measure";
import { patchText } from "@/lib/text-edit";

export type CommitFn = (next: EditDoc | ((prev: EditDoc) => EditDoc), opts?: { coalesce?: string }) => void;

interface Props {
  /** The doc being PREVIEWED (committed doc, or the live draft mid-gesture). */
  doc: EditDoc;
  /** The committed doc — every gesture is computed from it, never from a draft. */
  baseDoc: EditDoc;
  timeSec: number;
  /** Displayed CSS size of the composition frame. */
  width: number;
  height: number;
  playing: boolean;
  selectedIds: string[];
  /** Select a layer (null clears). `toggle` = Shift/⌘-click add/remove. */
  onSelect: (id: string | null, toggle: boolean) => void;
  onDraft: (doc: EditDoc | null) => void;
  onCommit: CommitFn;
}

type DragKind = "move" | "resize" | "rotate";
interface Drag {
  kind: DragKind;
  pointerId: number;
  base: EditDoc;
  start: { x: number; y: number };
  startClient: { x: number; y: number };
  /** The layers being moved (move) or the single primary layer (resize / rotate). */
  layers: LayerBox[];
  others: Box[];
  handle?: HandleId;
  moved: boolean;
  last: EditDoc | null;
  atSec: number;
}

const HANDLE_ANGLE: Record<HandleId, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
function handleCursor(h: HandleId, rot: number): string {
  const a = (((HANDLE_ANGLE[h] + rot) % 180) + 180) % 180;
  return CURSORS[Math.round(a / 45) % 4]!;
}

const HANDLE_POS: Record<HandleId, [number, number]> = {
  nw: [0, 0],
  n: [50, 0],
  ne: [100, 0],
  e: [100, 50],
  se: [100, 100],
  s: [50, 100],
  sw: [0, 100],
  w: [0, 50],
};

const ROTATE_OFFSET_PX = 26; // screen px above the top edge
const SELECT = "#2f9bff";
const GUIDE = "#ff3d81";

/** Re-render when web fonts finish loading so text boxes re-measure at the real size. */
function useFontTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (typeof document === "undefined" || !("fonts" in document)) return;
    const bump = () => setTick((n) => n + 1);
    document.fonts.addEventListener?.("loadingdone", bump);
    return () => document.fonts.removeEventListener?.("loadingdone", bump);
  }, []);
  return tick;
}

export function TransformLayer(props: Props) {
  const { doc, baseDoc, timeSec, width, height, playing, selectedIds, onSelect, onDraft, onCommit } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [hud, setHud] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const fontTick = useFontTick();
  const W = doc.meta.width;
  const H = doc.meta.height;
  const s = width > 0 ? width / W : 1;

  const layers = useMemo(() => layerBoxesAt(doc, timeSec, getMeasureCtx()), [doc, timeSec, fontTick]);
  const byId = useMemo(() => new Map(layers.map((l) => [l.clipId, l])), [layers]);
  const selected = selectedIds.map((id) => byId.get(id)).filter((l): l is LayerBox => !!l);
  const primary = selected.length === 1 ? selected[0]! : null;

  const toComp = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return { x: 0, y: 0 };
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const thr = 6 / Math.max(0.05, s); // snap distance: 6 screen px, in composition px

  // ---- gestures -------------------------------------------------------------

  const begin = (e: PointerEvent, kind: DragKind, layer: LayerBox[], handle?: HandleId) => {
    const base = baseDoc;
    const ids = new Set(layer.map((l) => l.clipId));
    // Re-resolve the boxes from the committed doc so the gesture starts from it exactly.
    const fresh = layerBoxesAt(base, timeSec, getMeasureCtx());
    dragRef.current = {
      kind,
      pointerId: e.pointerId,
      base,
      start: toComp(e),
      startClient: { x: e.clientX, y: e.clientY },
      layers: fresh.filter((l) => ids.has(l.clipId)),
      others: fresh.filter((l) => !ids.has(l.clipId) && !l.background).map((l) => l.box),
      handle,
      moved: false,
      last: null,
      atSec: timeSec,
    };
    (rootRef.current as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
    rootRef.current?.focus({ preventScroll: true });
  };

  const onBodyDown = (e: PointerEvent) => {
    if (playing || e.button !== 0 || editing) return;
    const p = toComp(e);
    const pad = 4 / Math.max(0.05, s);
    // Dragging inside a selected layer keeps the (multi-)selection; else the top-most hit.
    const inSel = selected.find((l) => !l.background && pointInBox(l.box, p.x, p.y, pad));
    const hit = inSel ?? hitTestLayers(layers, p.x, p.y, pad);
    const toggle = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!hit) {
      if (!toggle) onSelect(null, false);
      return;
    }
    if (!inSel) onSelect(hit.clipId, toggle);
    else if (toggle) {
      onSelect(hit.clipId, true);
      return;
    }
    const moving = inSel && selected.length > 1 ? selected.filter((l) => l.movable) : hit.movable ? [hit] : [];
    if (moving.length > 0) begin(e, "move", moving);
    else rootRef.current?.focus({ preventScroll: true });
  };

  const onHandleDown = (e: PointerEvent, handle: HandleId) => {
    if (!primary || !primary.movable || e.button !== 0) return;
    e.stopPropagation();
    begin(e, "resize", [primary], handle);
  };
  const onRotateDown = (e: PointerEvent) => {
    if (!primary || !primary.movable || e.button !== 0) return;
    e.stopPropagation();
    begin(e, "rotate", [primary]);
  };

  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      if (playing) return;
      const p = toComp(e);
      const h = hitTestLayers(layers, p.x, p.y, 4 / Math.max(0.05, s));
      setHover(h?.clipId ?? null);
      return;
    }
    if (!d.moved && Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < 3) return;
    d.moved = true;
    const p = toComp(e);
    const snapOn = !e.altKey || d.kind === "resize"; // Alt = no snap (move) / from-centre (resize)
    try {
      let next: EditDoc;
      if (d.kind === "move") {
        let dx = p.x - d.start.x;
        let dy = p.y - d.start.y;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const union = unionRect(d.layers.map((l) => boxAabb(l.box)));
        const moving: Box = {
          cx: (union.left + union.right) / 2 + dx,
          cy: (union.top + union.bottom) / 2 + dy,
          w: union.right - union.left,
          h: union.bottom - union.top,
          rot: 0,
        };
        if (snapOn && !e.altKey) {
          const sn = snapMove(moving, d.others, W, H, thr);
          dx += sn.dx;
          dy += sn.dy;
          setGuides(sn.guides);
        } else setGuides([]);
        const entries = d.layers.map((l) => {
          const patch = boxToPatch(l, { ...l.box, cx: l.box.cx + dx, cy: l.box.cy + dy });
          return { clipId: l.clipId, patch: { x: patch.x, y: patch.y } };
        });
        next = setTransforms(d.base, entries, { atSec: d.atSec });
        setHud(`${Math.round(moving.cx - moving.w / 2)}, ${Math.round(moving.cy - moving.h / 2)}`);
      } else if (d.kind === "resize") {
        const l = d.layers[0]!;
        let px = p.x;
        let py = p.y;
        if (!e.altKey && l.box.rot === 0) {
          const sp = snapPoint(px, py, d.others, W, H, thr);
          px = sp.x;
          py = sp.y;
          setGuides(sp.guides);
        } else setGuides([]);
        const keep = e.shiftKey || l.resize === "uniform";
        const box = resizeBox(l.box, d.handle!, px, py, { keepAspect: keep, fromCenter: e.altKey, minSize: 12 });
        const patch = boxToPatch(l, l.resize === "length" ? { ...box, h: l.box.h, cy: l.box.cy, cx: box.cx } : box);
        next = setTransforms(d.base, [{ clipId: l.clipId, patch }], { atSec: d.atSec });
        setHud(`${Math.round(box.w)} × ${Math.round(box.h)}`);
      } else {
        const l = d.layers[0]!;
        const rot = rotationFromPointer(l.box, p.x, p.y, e.shiftKey ? 15 : 0);
        const patch = boxToPatch(l, { ...l.box, rot });
        next = setTransforms(d.base, [{ clipId: l.clipId, patch }], { atSec: d.atSec });
        setHud(`${Math.round(rot)}°`);
      }
      d.last = next;
      onDraft(next);
    } catch {
      /* a gesture that can't apply (locked / not spatial) is simply ignored */
    }
  };

  const end = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    (rootRef.current as HTMLElement | null)?.releasePointerCapture?.(e.pointerId);
    setGuides([]);
    setHud(null);
    if (d.moved && d.last) onCommit(d.last);
    onDraft(null);
  };

  // ---- keyboard: arrow nudge · Esc -------------------------------------------

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
    if (e.key === "Escape") {
      if (selectedIds.length) {
        e.stopPropagation();
        onSelect(null, false);
      }
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
    if (!d || selected.length === 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const ids = selected.filter((l) => l.movable).map((l) => l.clipId);
    if (ids.length === 0) return;
    e.preventDefault();
    e.stopPropagation(); // arrows scrub the playhead elsewhere — here they nudge the layer
    onCommit(
      (prev) => {
        try {
          return moveClipsBy(prev, ids, d[0]!, d[1]!, { atSec: timeSec, ctx: getMeasureCtx() });
        } catch {
          return prev;
        }
      },
      { coalesce: `nudge-xy-${ids.join(",")}` },
    );
  };

  // ---- in-place text edit ---------------------------------------------------

  const onDouble = (e: MouseEvent) => {
    if (playing) return;
    const p = toComp(e);
    const hit = hitTestLayers(layers, p.x, p.y, 4 / Math.max(0.05, s));
    if (hit?.kind !== "text") return;
    const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === hit.clipId) as TextClip | undefined;
    if (!clip || clip.counter) return;
    onSelect(hit.clipId, false);
    setEditing(hit.clipId);
  };

  const editClip = editing ? (doc.tracks.flatMap((t) => t.clips).find((c) => c.id === editing) as TextClip | undefined) : undefined;
  const editLayer = editing ? byId.get(editing) : undefined;

  // ---- render ---------------------------------------------------------------

  const cursor = hover || selected.length ? "move" : "default";
  const showHandles = !!primary && primary.movable && !playing && !editing;

  return (
    <div
      ref={rootRef}
      role="group"
      tabIndex={0}
      data-testid="transform-layer"
      data-comp={`${W}x${H}`}
      aria-label={
        primary
          ? `Selected ${primary.label.toLowerCase()} layer on the preview. Arrow keys nudge it, Shift for 10 pixels.`
          : "Preview layers. Click a title, shape or overlay to move, resize or rotate it."
      }
      className="absolute inset-0 z-30 touch-none outline-none"
      style={{ cursor }}
      onPointerDown={onBodyDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={onDouble}
      onKeyDown={onKey}
    >
      {/* Smart guides */}
      {guides.length > 0 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {guides.map((g, i) => (
            <line
              key={i}
              data-testid="snap-guide"
              data-kind={g.kind}
              x1={g.axis === "x" ? g.pos : g.from}
              x2={g.axis === "x" ? g.pos : g.to}
              y1={g.axis === "x" ? g.from : g.pos}
              y2={g.axis === "x" ? g.to : g.pos}
              stroke={GUIDE}
              strokeWidth={1}
              strokeDasharray={g.kind === "safe" ? "6 5" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}

      {/* Hover outline (not for the selection) */}
      {!playing && hover && !selectedIds.includes(hover) && byId.get(hover) && (
        <BoxOutline layer={byId.get(hover)!} s={s} color={SELECT} faint />
      )}

      {/* Selection outlines */}
      {!playing &&
        selected.map((l) => (
          <div
            key={l.clipId}
            data-testid="transform-box"
            data-clip={l.clipId}
            data-primary={primary?.clipId === l.clipId ? "true" : "false"}
            data-box={`${Math.round(l.box.cx)},${Math.round(l.box.cy)},${Math.round(l.box.w)},${Math.round(l.box.h)},${Math.round(l.box.rot)}`}
            className="pointer-events-none absolute"
            style={{
              left: l.box.cx * s,
              top: l.box.cy * s,
              width: l.box.w * s,
              height: l.box.h * s,
              transform: `translate(-50%, -50%) rotate(${l.box.rot}deg)`,
              border: `1.5px ${l.background ? "dashed" : "solid"} ${SELECT}`,
              boxShadow: "0 0 0 1px rgba(255,255,255,0.35)",
            }}
          >
            {showHandles && primary?.clipId === l.clipId && (
              <>
                {l.handles.map((h) => (
                  <span
                    key={h}
                    data-handle={h}
                    role="button"
                    aria-label={`Resize ${h}`}
                    className="pointer-events-auto absolute block h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rounded-[2px] border bg-white"
                    style={{
                      left: `${HANDLE_POS[h][0]}%`,
                      top: `${HANDLE_POS[h][1]}%`,
                      borderColor: SELECT,
                      cursor: handleCursor(h, l.box.rot),
                      width: CORNER_HANDLES.includes(h) ? 11 : 9,
                      height: CORNER_HANDLES.includes(h) ? 11 : 9,
                    }}
                    onPointerDown={(e) => onHandleDown(e, h)}
                  />
                ))}
                <span
                  className="pointer-events-none absolute left-1/2 w-px -translate-x-1/2"
                  style={{ top: -ROTATE_OFFSET_PX, height: ROTATE_OFFSET_PX, background: SELECT }}
                />
                <span
                  data-handle="rotate"
                  role="button"
                  aria-label="Rotate"
                  className="pointer-events-auto absolute left-1/2 block h-[14px] w-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full border bg-white"
                  style={{ top: -ROTATE_OFFSET_PX, borderColor: SELECT, cursor: "grab" }}
                  onPointerDown={onRotateDown}
                />
              </>
            )}
          </div>
        ))}

      {/* Multi-selection bounds */}
      {!playing && selected.length > 1 && (() => {
        const u = unionRect(selected.map((l) => boxAabb(l.box)));
        return (
          <div
            data-testid="transform-group"
            className="pointer-events-none absolute"
            style={{ left: u.left * s, top: u.top * s, width: (u.right - u.left) * s, height: (u.bottom - u.top) * s, border: `1px dashed ${SELECT}` }}
          />
        );
      })()}

      {/* Live readout */}
      {hud && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-md bg-black/75 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white" data-testid="transform-hud">
          {hud}
        </div>
      )}

      {/* In-place text editor */}
      {editClip && editLayer && (
        <TextEditor
          clip={editClip}
          layer={editLayer}
          s={s}
          onDone={(text) => {
            setEditing(null);
            if (text !== null && text !== editClip.text) onCommit((prev) => patchText(prev, editClip.id, { text }));
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

function BoxOutline({ layer, s, color, faint }: { layer: LayerBox; s: number; color: string; faint?: boolean }) {
  const b = layer.box;
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: b.cx * s,
        top: b.cy * s,
        width: b.w * s,
        height: b.h * s,
        transform: `translate(-50%, -50%) rotate(${b.rot}deg)`,
        border: `1px solid ${color}`,
        opacity: faint ? 0.6 : 1,
      }}
    />
  );
}

/** A textarea laid over the text layer; Enter / click-away commits, Esc cancels. */
function TextEditor({ clip, layer, s, onDone }: { clip: TextClip; layer: LayerBox; s: number; onDone: (text: string | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(clip.text);
  const doneRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  const finish = (text: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(text);
  };
  const b = layer.box;
  const fontPx = Math.max(10, clip.fontSize * (b.w / (layer.base.w || 1)) * s);
  return (
    <textarea
      ref={ref}
      data-testid="text-editor"
      aria-label="Edit text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") finish(null);
        else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(value);
        }
      }}
      className="absolute resize-none overflow-hidden rounded-sm border-2 p-0 leading-[1.2] outline-none"
      style={{
        left: b.cx * s,
        top: b.cy * s,
        minWidth: Math.max(80, b.w * s + 16),
        width: Math.max(80, b.w * s + 16),
        height: Math.max(fontPx * 1.3, b.h * s + 8),
        transform: `translate(-50%, -50%) rotate(${b.rot}deg)`,
        borderColor: SELECT,
        background: "rgba(18,24,26,0.94)",
        color: clip.color,
        fontFamily: clip.fontFamily,
        fontSize: fontPx,
        fontWeight: clip.fontWeight === "bold" ? 700 : clip.fontWeight === "semibold" ? 600 : clip.fontWeight === "medium" ? 500 : 400,
        fontStyle: clip.italic ? "italic" : "normal",
        textAlign: clip.align,
        textTransform: clip.uppercase ? "uppercase" : "none",
        letterSpacing: clip.letterSpacing ? clip.letterSpacing * s : undefined,
      }}
    />
  );
}
