"use client";

/**
 * Transform inspector — numeric position control for the selected layer(s):
 * X · Y · W · H · rotation · scale · opacity, a reference point (which point of the
 * box X/Y/W/H refer to), flip H/V, lock aspect, px / % units, 9-point + edge
 * align (to the canvas or the selection), distribute, Fit / Fill / Reset and
 * stacking order. Keyframe-aware: a ◆ marks a keyframed property, and editing it
 * writes a keyframe at the playhead. Every change is ONE edit-doc op through the
 * undoable `onCommit` — the same pure ops the on-canvas box and the Director use.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  boxToPatch,
  layerBoxesAt,
  resolvedTransform,
  rotatePoint,
  type AlignMode,
  type Box,
  type EditDoc,
  type KeyframeProp,
  type LayerBox,
  type NinePoint,
  type TransformPatch,
} from "@cadence/core";
import {
  alignClips,
  arrangeClip,
  distributeClips,
  fitClip,
  resetTransform,
  setTransforms,
  type ArrangeMode,
} from "@cadence/director";
import { getMeasureCtx } from "@/lib/stage-measure";
import type { CommitFn } from "./TransformLayer";

interface Props {
  doc: EditDoc;
  timeSec: number;
  /** Selected clip ids; the first is the one the numeric fields show. */
  selectedIds: string[];
  onCommit: CommitFn;
}

type Units = "px" | "%";
type RefPt = [number, number]; // sx, sy ∈ {-1, 0, 1}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const NINE: { key: NinePoint; label: string }[] = [
  { key: "top-left", label: "Top left" },
  { key: "top-center", label: "Top center" },
  { key: "top-right", label: "Top right" },
  { key: "middle-left", label: "Middle left" },
  { key: "center", label: "Center" },
  { key: "middle-right", label: "Middle right" },
  { key: "bottom-left", label: "Bottom left" },
  { key: "bottom-center", label: "Bottom center" },
  { key: "bottom-right", label: "Bottom right" },
];

const EDGES: { mode: AlignMode; label: string; glyph: ReactNode }[] = [
  { mode: "left", label: "Align left edges", glyph: <path d="M4 4v16M8 8h12M8 14h8" /> },
  { mode: "hcenter", label: "Align horizontal centers", glyph: <path d="M12 3v18M6 8h12M8 14h8" /> },
  { mode: "right", label: "Align right edges", glyph: <path d="M20 4v16M4 8h12M8 14h8" /> },
  { mode: "top", label: "Align top edges", glyph: <path d="M4 4h16M8 8v12M14 8v8" /> },
  { mode: "vmiddle", label: "Align vertical centers", glyph: <path d="M3 12h18M8 6v12M14 8v8" /> },
  { mode: "bottom", label: "Align bottom edges", glyph: <path d="M4 20h16M8 4v12M14 8v8" /> },
];

/** A numeric field that commits on Enter / blur / arrow keys (Shift = ×10). */
function NumField(props: {
  label: string;
  testId: string;
  value: number | null;
  onCommit: (v: number) => void;
  step?: number;
  suffix?: string;
  keyframed?: boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
}) {
  const { label, testId, value, onCommit, step = 1, suffix, keyframed, disabled, min, max } = props;
  const shown = value === null ? "" : String(round2(value));
  const [text, setText] = useState(shown);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(shown);
  }, [shown, focus]);
  const clampV = (v: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (raw: string) => {
    const v = Number(raw.replace(",", "."));
    if (!Number.isFinite(v) || raw.trim() === "") {
      setText(shown);
      return;
    }
    onCommit(clampV(v));
  };
  return (
    <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
      <span className="w-[22px] shrink-0">
        {label}
        {keyframed && (
          <span className="ml-0.5 text-amber" title="Keyframed — editing sets a keyframe at the playhead" aria-hidden="true">
            ◆
          </span>
        )}
      </span>
      <span className="relative min-w-0 flex-1">
        <input
          data-testid={testId}
          aria-label={`${label}${keyframed ? " (keyframed)" : ""}`}
          type="text"
          inputMode="decimal"
          disabled={disabled}
          value={text}
          onFocus={(e) => {
            setFocus(true);
            e.currentTarget.select();
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => {
            setFocus(false);
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(text);
              (e.target as HTMLInputElement).select();
            } else if (e.key === "Escape") {
              setText(shown);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const cur = Number(text.replace(",", "."));
              const base = Number.isFinite(cur) ? cur : value ?? 0;
              const next = clampV(base + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
              setText(String(round2(next)));
              onCommit(next);
            }
          }}
          className="w-full rounded-md border border-line bg-elevated px-1.5 py-1 pr-5 text-right text-[11px] tabular-nums text-text outline-none focus:border-amber disabled:opacity-40"
        />
        {suffix && <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-faint">{suffix}</span>}
      </span>
    </label>
  );
}

function Ico({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const btn =
  "grid h-7 min-w-7 place-items-center rounded-md border border-line bg-elevated px-1.5 text-[11px] text-muted transition hover:border-amber/60 hover:text-text disabled:opacity-35 disabled:hover:border-line disabled:hover:text-muted";

export function TransformInspector({ doc, timeSec, selectedIds, onCommit }: Props) {
  const [units, setUnits] = useState<Units>("px");
  const [lock, setLock] = useState(true);
  const [ref, setRef] = useState<RefPt>([-1, -1]);
  const [relTo, setRelTo] = useState<"canvas" | "selection">("canvas");
  const [note, setNote] = useState<string | null>(null);
  const W = doc.meta.width;
  const H = doc.meta.height;
  const ctx = getMeasureCtx();

  const layers = useMemo(() => layerBoxesAt(doc, timeSec, ctx), [doc, timeSec, ctx]);
  const selected = selectedIds.map((id) => layers.find((l) => l.clipId === id)).filter((l): l is LayerBox => !!l);
  const primary = selected[0] ?? null;
  const movable = selected.filter((l) => l.movable);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(t);
  }, [note]);

  if (!primary) return null;

  const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === primary.clipId)!;
  const tf = resolvedTransform(clip, timeSec);
  const box = primary.box;
  const kf = (p: KeyframeProp): boolean => primary.keyframed.includes(p);
  const uniform = primary.resize === "uniform";
  const canResize = primary.movable && primary.resize !== "none";
  const curScale = box.w / (primary.base.w || 1);

  const refWorld = (b: Box, r: RefPt) => rotatePoint(b.cx + (r[0] * b.w) / 2, b.cy + (r[1] * b.h) / 2, b.cx, b.cy, b.rot);
  const refNow = refWorld(box, ref);

  const toUnit = (v: number, axis: "x" | "y"): number => (units === "px" ? v : (v / (axis === "x" ? W : H)) * 100);
  const fromUnit = (v: number, axis: "x" | "y"): number => (units === "px" ? v : (v / 100) * (axis === "x" ? W : H));

  /** Apply a patch to the primary layer (one undoable op, coalesced per field). */
  const applyPatch = (patch: TransformPatch, key: string) => {
    onCommit(
      (prev) => {
        try {
          return setTransforms(prev, [{ clipId: primary.clipId, patch }], { atSec: timeSec });
        } catch {
          return prev;
        }
      },
      { coalesce: `inspector-${primary.clipId}-${key}` },
    );
  };
  /** Resize keeping the chosen reference point fixed (W / H). */
  const applyBox = (next: Box, key: string) => {
    const after = refWorld(next, ref);
    const fixed: Box = { ...next, cx: next.cx + (refNow.x - after.x), cy: next.cy + (refNow.y - after.y) };
    applyPatch(boxToPatch(primary, fixed), key);
  };
  const run = (f: (d: EditDoc) => EditDoc, key?: string) => {
    let next: EditDoc;
    try {
      next = f(doc);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't apply that.");
      return;
    }
    onCommit(next, key ? { coalesce: key } : undefined);
  };

  /** Apply a box as-is (position / rotation / scale — nothing is pinned). */
  const applyFree = (next: Box, key: string) => applyPatch(boxToPatch(primary, next), key);
  const setX = (v: number) => applyFree({ ...box, cx: box.cx + (fromUnit(v, "x") - refNow.x) }, "x");
  const setY = (v: number) => applyFree({ ...box, cy: box.cy + (fromUnit(v, "y") - refNow.y) }, "y");
  const setW = (v: number) => {
    const nw = Math.max(1, fromUnit(v, "x"));
    const k = nw / box.w;
    applyBox({ ...box, w: nw, h: lock || uniform ? box.h * k : box.h }, "w");
  };
  const setH = (v: number) => {
    const nh = Math.max(1, fromUnit(v, "y"));
    const k = nh / box.h;
    applyBox({ ...box, h: nh, w: lock || uniform ? box.w * k : box.w }, "h");
  };
  const setRot = (v: number) => applyFree({ ...box, rot: v }, "rot");
  const setScalePct = (v: number) => {
    const k = Math.max(0.01, v / 100) / curScale;
    applyFree({ ...box, w: box.w * k, h: box.h * k }, "scale");
  };

  const ids = movable.map((l) => l.clipId);
  const alignTo = (to: AlignMode | NinePoint) => run((d) => alignClips(d, ids, to, { relativeTo: relTo, atSec: timeSec, ctx }));

  return (
    <aside
      aria-label="Transform"
      data-testid="transform-inspector"
      className="hidden w-[240px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-panel px-3 py-3 md:flex"
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h3 className="font-chrome text-xs font-semibold text-text">Position</h3>
          <p className="truncate text-[10px] text-faint">
            {selected.length > 1 ? `${selected.length} layers selected` : primary.label}
            {!primary.movable && !primary.background ? " · locked" : ""}
          </p>
        </div>
        <div role="group" aria-label="Units" className="flex overflow-hidden rounded-md border border-line text-[10px]">
          {(["px", "%"] as const).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={units === u}
              onClick={() => setUnits(u)}
              className={`px-2 py-0.5 ${units === u ? "bg-amber/15 text-amber" : "text-muted hover:text-text"}`}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      {primary.background ? (
        <p className="rounded-md bg-elevated px-2 py-1.5 text-[11px] leading-snug text-muted">
          Full-frame footage fills the preview. Use Overlay (b-roll) to place a smaller picture, or reframe the whole video.
        </p>
      ) : (
        <>
          <section aria-label="Position and size" className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <div className="grid shrink-0 grid-cols-3 gap-[3px]" role="group" aria-label="Reference point for X and Y">
                {[-1, 0, 1].flatMap((sy) =>
                  [-1, 0, 1].map((sx) => {
                    const on = ref[0] === sx && ref[1] === sy;
                    return (
                      <button
                        key={`${sx}${sy}`}
                        type="button"
                        aria-label={`Reference point ${sy < 0 ? "top" : sy > 0 ? "bottom" : "middle"} ${sx < 0 ? "left" : sx > 0 ? "right" : "center"}`}
                        aria-pressed={on}
                        onClick={() => setRef([sx, sy])}
                        className={`h-3 w-3 rounded-[2px] border ${on ? "border-amber bg-amber" : "border-line bg-elevated hover:border-amber/60"}`}
                      />
                    );
                  }),
                )}
              </div>
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-1.5">
                <NumField label="X" testId="field-x" value={toUnit(refNow.x, "x")} onCommit={setX} suffix={units} keyframed={kf("x")} disabled={!primary.movable} />
                <NumField label="Y" testId="field-y" value={toUnit(refNow.y, "y")} onCommit={setY} suffix={units} keyframed={kf("y")} disabled={!primary.movable} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-1.5">
                <NumField label="W" testId="field-w" value={toUnit(box.w, "x")} onCommit={setW} suffix={units} min={0.01} keyframed={uniform && kf("scale")} disabled={!canResize} />
                <NumField label="H" testId="field-h" value={toUnit(box.h, "y")} onCommit={setH} suffix={units} min={0.01} keyframed={uniform && kf("scale")} disabled={!canResize || primary.resize === "length"} />
              </div>
              <button
                type="button"
                aria-pressed={lock || uniform}
                aria-label="Lock aspect ratio"
                title={uniform ? "This layer always keeps its aspect ratio" : "Lock aspect ratio"}
                disabled={uniform}
                onClick={() => setLock((l) => !l)}
                className={`${btn} ${lock || uniform ? "border-amber/60 text-amber" : ""}`}
              >
                <Ico>
                  {lock || uniform ? <path d="M7 11V8a5 5 0 0110 0v3M5 11h14v9H5z" /> : <path d="M7 11V8a5 5 0 019.5-2M5 11h14v9H5z" />}
                </Ico>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <NumField label="∠" testId="field-rotation" value={box.rot} onCommit={setRot} suffix="°" keyframed={kf("rotation")} disabled={!primary.movable} step={1} />
              <NumField label="S" testId="field-scale" value={curScale * 100} onCommit={setScalePct} suffix="%" min={1} keyframed={kf("scale")} disabled={!canResize} />
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-1.5">
              <NumField
                label="α"
                testId="field-opacity"
                value={(tf?.opacity ?? 1) * 100}
                onCommit={(v) => applyPatch({ opacity: v / 100 }, "opacity")}
                suffix="%"
                min={0}
                max={100}
                keyframed={kf("opacity")}
                disabled={!primary.movable}
              />
              <button type="button" aria-label="Flip horizontal" aria-pressed={!!tf?.flipX} title="Flip horizontal" disabled={!primary.movable || primary.kind === "video" || primary.kind === "image"} onClick={() => applyPatch({ flipX: !tf?.flipX }, "flipx")} className={`${btn} ${tf?.flipX ? "border-amber/60 text-amber" : ""}`}>
                <Ico><path d="M12 3v18M8 7L3 12l5 5V7zM16 7l5 5-5 5V7z" /></Ico>
              </button>
              <button type="button" aria-label="Flip vertical" aria-pressed={!!tf?.flipY} title="Flip vertical" disabled={!primary.movable || primary.kind === "video" || primary.kind === "image"} onClick={() => applyPatch({ flipY: !tf?.flipY }, "flipy")} className={`${btn} ${tf?.flipY ? "border-amber/60 text-amber" : ""}`}>
                <Ico><path d="M3 12h18M7 8l5-5 5 5H7zM7 16l5 5 5-5H7z" /></Ico>
              </button>
            </div>
          </section>

          <section aria-label="Align" className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wide text-faint">Align</span>
              <div role="group" aria-label="Align relative to" className="flex overflow-hidden rounded-md border border-line text-[10px]">
                {(["canvas", "selection"] as const).map((r) => (
                  <button key={r} type="button" aria-pressed={relTo === r} onClick={() => setRelTo(r)} className={`px-1.5 py-0.5 capitalize ${relTo === r ? "bg-amber/15 text-amber" : "text-muted hover:text-text"}`}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <div className="grid grid-cols-3 gap-[3px]" role="group" aria-label="Align to a point">
                {NINE.map((n) => (
                  <button
                    key={n.key}
                    type="button"
                    aria-label={`Align ${n.label.toLowerCase()}`}
                    data-testid={`align-${n.key}`}
                    disabled={movable.length === 0 || (relTo === "selection" && movable.length < 2)}
                    onClick={() => alignTo(n.key)}
                    className="h-[18px] w-[18px] rounded-[3px] border border-line bg-elevated transition hover:border-amber hover:bg-amber/15 disabled:opacity-35"
                  />
                ))}
              </div>
              <div className="grid flex-1 grid-cols-3 gap-1">
                {EDGES.map((e) => (
                  <button key={e.mode} type="button" aria-label={e.label} title={e.label} data-testid={`align-${e.mode}`} disabled={movable.length === 0} onClick={() => alignTo(e.mode)} className={btn}>
                    <Ico>{e.glyph}</Ico>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" disabled={movable.length < 3} onClick={() => run((d) => distributeClips(d, ids, "h", { atSec: timeSec, ctx }))} className={btn} title="Space evenly, left to right (3+ layers)">
                Distribute ↔
              </button>
              <button type="button" disabled={movable.length < 3} onClick={() => run((d) => distributeClips(d, ids, "v", { atSec: timeSec, ctx }))} className={btn} title="Space evenly, top to bottom (3+ layers)">
                Distribute ↕
              </button>
            </div>
          </section>

          <section aria-label="Fit and reset" className="grid grid-cols-3 gap-1.5">
            <button type="button" disabled={!canResize} onClick={() => run((d) => fitClip(d, primary.clipId, "fit", { atSec: timeSec, ctx }))} className={btn} title="Scale to fit inside the frame">
              Fit
            </button>
            <button type="button" disabled={!canResize} onClick={() => run((d) => fitClip(d, primary.clipId, "fill", { atSec: timeSec, ctx }))} className={btn} title="Scale to cover the frame">
              Fill
            </button>
            <button
              type="button"
              data-testid="transform-reset"
              disabled={!primary.movable}
              onClick={() => run((d) => movable.reduce((acc, l) => resetTransform(acc, l.clipId), d))}
              className={btn}
              title="Reset position, size, rotation, flip and opacity"
            >
              Reset
            </button>
          </section>

          <section aria-label="Arrange" className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-faint">Arrange</span>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ["front", "To front"],
                  ["forward", "Forward"],
                  ["backward", "Backward"],
                  ["back", "To back"],
                ] as [ArrangeMode, string][]
              ).map(([mode, label]) => (
                <button key={mode} type="button" data-testid={`arrange-${mode}`} disabled={!primary.movable} onClick={() => run((d) => arrangeClip(d, primary.clipId, mode))} className={btn}>
                  {label}
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <p role="status" aria-live="polite" className="min-h-[14px] text-[10px] leading-tight text-amber-bright">
        {note ?? ""}
      </p>
    </aside>
  );
}
