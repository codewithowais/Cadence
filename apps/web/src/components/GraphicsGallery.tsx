"use client";

/**
 * GRAPHICS — the one-click motion-graphics gallery (social CTAs, lower thirds,
 * countdowns & timers, progress bars, stickers, hand-drawn annotations) plus the
 * inspector that keeps every inserted graphic editable (words, colors, position,
 * size, timing, motion) and a motion panel for any plain shape.
 *
 * Every tile is a live canvas drawn by the SAME `drawShape` the Stage and the
 * export use (it animates while hovered or focused), and every control applies a
 * PURE op from @cadence/director through the editor's undoable commit — so what
 * you click is exactly what exports.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  SHAPE_EXIT_STYLES,
  SHAPE_INTRO_STYLES,
  SHAPE_LOOP_STYLES,
  drawShape,
  parseEditDoc,
  type EditDoc,
  type ShapeClip,
  type ShapeExitStyle,
  type ShapeIntroStyle,
  type ShapeLoopStyle,
} from "@cadence/core";
import {
  GRAPHIC_CATEGORIES,
  GRAPHIC_POSITIONS,
  GRAPHIC_PRESETS,
  addGraphic,
  animateShape,
  describeGraphic,
  editGraphic,
  findGraphicGroup,
  findGraphicPreset,
  graphicBounds,
  graphicGroups,
  graphicParams,
  removeGraphic,
  type EditGraphicPatch,
  type GraphicCategory,
  type GraphicPosition,
  type GraphicPresetDef,
} from "@cadence/director";
import { graphicFonts, loadGraphicFonts } from "@/lib/graphics-fonts";

const CAT_KEY = "cadence:gfxCat";
const PW = 640; // preview composition (16:9) — drawn scaled into each tile
const PH = 360;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const titleCase = (s: string): string => s.replace(/(^|-)(\w)/g, (_m, p, c) => `${p === "-" ? " " : ""}${c.toUpperCase()}`);

const SWATCHES = ["#ff1f3d", "#ff3b5c", "#ffb547", "#ffd54a", "#4dff88", "#22c55e", "#22d3ee", "#1d9bf0", "#6d5dfc", "#ffffff", "#111318", "#0b0d12"];

// ---- preview ------------------------------------------------------------------------

/** A preset built into a small preview comp, centered and fit to the tile. */
function previewDoc(def: GraphicPresetDef): { doc: EditDoc; dur: number } {
  const base = parseEditDoc({ version: 1, meta: { width: PW, height: PH }, tracks: [] });
  const dur = def.defaults.durationSec === "doc" ? 4 : Math.min(6, def.defaults.durationSec);
  const first = addGraphic(base, { preset: def.key, atSec: 0, durationSec: dur, position: "center" });
  if (def.fixed) return { doc: first.doc, dur };
  const g = findGraphicGroup(first.doc, first.groupId)!;
  const b = graphicBounds(g);
  const k = Math.min((PW * 0.78) / Math.max(1, b.x1 - b.x0), (PH * 0.66) / Math.max(1, b.y1 - b.y0), 2.6);
  return { doc: addGraphic(base, { preset: def.key, atSec: 0, durationSec: dur, x: PW / 2, y: PH / 2, scale: round2(k) }).doc, dur };
}

function useLoopTime(active: boolean, period: number): number {
  const [t, setT] = useState(-1);
  useEffect(() => {
    if (!active) {
      setT(-1);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setT(((now - t0) / 1000) % period);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, period]);
  return t;
}

/** Live canvas preview of a preset (animates while `animate`). */
export function GraphicPreview({ def, animate }: { def: GraphicPresetDef; animate: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { doc, dur } = useMemo(() => previewDoc(def), [def]);
  const clips = useMemo(() => doc.tracks.flatMap((t) => t.clips).filter((c): c is ShapeClip => c.kind === "shape"), [doc]);
  const [fontsTick, setFontsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    loadGraphicFonts(graphicFonts(doc)).then(() => alive && setFontsTick((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [doc]);
  const loopT = useLoopTime(animate, dur + 0.6);
  // At rest: a settled, fully-drawn moment (after intros, before exits).
  const t = loopT >= 0 ? Math.min(loopT, dur - 0.01) : Math.min(dur * 0.6, 2.2);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 160;
    const h = cv.clientHeight || 90;
    if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
    if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const s = cv.width / PW;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createLinearGradient(0, 0, cv.width, cv.height);
    g.addColorStop(0, "#39465e");
    g.addColorStop(1, "#171c28");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    for (const c of clips) {
      if (t < c.start || t >= c.start + c.duration) continue;
      ctx.save();
      drawShape(ctx, c, t, { pxScale: s });
      ctx.restore();
    }
  }, [clips, t, fontsTick]);
  return <canvas ref={ref} aria-hidden="true" className="block h-full w-full" />;
}

function PresetTile({ def, disabled, onAdd }: { def: GraphicPresetDef; disabled?: boolean; onAdd: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={disabled}
      aria-label={`Add ${def.label}`}
      title={def.blurb}
      data-preset={def.key}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className="group flex flex-col overflow-hidden rounded-lg border border-line bg-elevated text-left transition hover:border-amber/50 focus-visible:border-amber disabled:opacity-40"
    >
      <span className="block aspect-video w-full">
        <GraphicPreview def={def} animate={hover} />
      </span>
      <span className="truncate px-1.5 py-1 text-[11px] text-muted group-hover:text-text">{def.label}</span>
    </button>
  );
}

// ---- small controls -----------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-faint">{title}</h3>
        {hint && <span className="text-[10px] text-faint/80">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  fmt,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex min-w-[190px] flex-1 items-center gap-2 text-[11px] text-muted">
      <span className="w-16 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--color-amber)]"
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-faint">{fmt ? fmt(value) : value}</span>
    </label>
  );
}

function ColorRow({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (hex: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <label className="flex items-center gap-1.5 text-[11px] text-muted">
        <input
          type="color"
          value={value.slice(0, 7)}
          disabled={disabled}
          aria-label={`${label} (custom)`}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-line bg-elevated p-0.5 disabled:opacity-40"
        />
        <span className="w-12">{label}</span>
      </label>
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          disabled={disabled}
          aria-label={`${label} ${c}`}
          aria-pressed={value.slice(0, 7).toLowerCase() === c}
          onClick={() => onChange(c)}
          className={`h-5 w-5 rounded-full border transition ${value.slice(0, 7).toLowerCase() === c ? "ring-2 ring-teal" : "border-line hover:scale-110"}`}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

function Select<T extends string>({ label, value, options, disabled, onChange }: { label: string; value: T; options: readonly T[]; disabled?: boolean; onChange: (v: T) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-md border border-line bg-elevated px-2 py-1 text-[11px] text-text disabled:opacity-40"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o === "none" ? "None" : titleCase(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

function PositionGrid({ disabled, onPick, active }: { disabled?: boolean; onPick: (p: GraphicPosition) => void; active?: GraphicPosition }) {
  return (
    <div className="grid w-[96px] grid-cols-3 gap-1" role="group" aria-label="Graphic position">
      {GRAPHIC_POSITIONS.map((p) => (
        <button
          key={p}
          type="button"
          disabled={disabled}
          title={titleCase(p)}
          aria-label={`Move to ${p.replace("-", " ")}`}
          aria-pressed={active === p}
          onClick={() => onPick(p)}
          className={["h-7 rounded border transition disabled:opacity-40", active === p ? "border-teal/60 bg-teal/20" : "border-line bg-elevated hover:border-amber/50"].join(" ")}
        >
          <span className="mx-auto block h-1.5 w-1.5 rounded-full bg-current opacity-60" />
        </button>
      ))}
    </div>
  );
}

// ---- the gallery ---------------------------------------------------------------------

export interface GraphicsGalleryProps {
  doc: EditDoc;
  busy: boolean;
  timeSec: number;
  selectedClipId?: string | null;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onSelectClip?: (id: string | null) => void;
  onSeek?: (t: number) => void;
}

export function GraphicsGallery(props: GraphicsGalleryProps) {
  const { doc, busy, timeSec, selectedClipId, onApplyDoc, onSelectClip, onSeek } = props;
  const [cat, setCat] = useState<GraphicCategory>("social");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CAT_KEY) as GraphicCategory | null;
      if (saved && GRAPHIC_CATEGORIES.some((c) => c.key === saved)) setCat(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const choose = (c: GraphicCategory) => {
    setCat(c);
    try {
      localStorage.setItem(CAT_KEY, c);
    } catch {
      /* ignore */
    }
  };

  const groups = graphicGroups(doc);
  const group = findGraphicGroup(doc, selectedClipId);
  const plainShape = !group
    ? (doc.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId && c.kind === "shape") as ShapeClip | undefined)
    : undefined;
  const presets = GRAPHIC_PRESETS.filter((p) => p.category === cat);

  const insert = (def: GraphicPresetDef) => {
    // Progress bars track the whole video; everything else lands at the playhead.
    const atSec = def.defaults.durationSec === "doc" ? 0 : round2(Math.max(0, timeSec));
    const { doc: next, clipIds } = addGraphic(doc, { preset: def.key, atSec });
    onApplyDoc(next);
    onSelectClip?.(clipIds[0] ?? null);
    if (def.defaults.durationSec !== "doc") onSeek?.(atSec);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="graphics-gallery">
      <div role="tablist" aria-label="Graphic categories" className="flex flex-wrap gap-1.5">
        {GRAPHIC_CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={c.key === cat}
            title={c.hint}
            onClick={() => choose(c.key)}
            className={[
              "rounded-full border px-3 py-1 text-[11px] transition",
              c.key === cat ? "border-teal/60 bg-teal/15 text-text" : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
            ].join(" ")}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-faint">
        {GRAPHIC_CATEGORIES.find((c) => c.key === cat)?.hint} — hover to preview, click to add
        {cat === "progress" ? " (fills over the whole video)" : " at the playhead"}. Everything stays editable below.
      </p>
      <div role="tabpanel" aria-label={`${cat} graphics`} className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
        {presets.map((def) => (
          <PresetTile key={def.key} def={def} disabled={busy} onAdd={() => insert(def)} />
        ))}
      </div>

      {group && (
        <GraphicInspector
          key={group.id}
          doc={doc}
          groupId={group.id}
          busy={busy}
          onApplyDoc={onApplyDoc}
          onSelectClip={onSelectClip}
        />
      )}
      {plainShape && <ShapeMotion doc={doc} clip={plainShape} busy={busy} onApplyDoc={onApplyDoc} />}

      {groups.length > 0 && (
        <Section title="Graphics on this video" hint="Pick one to edit it.">
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                aria-pressed={g.id === group?.id}
                onClick={() => {
                  onSelectClip?.(g.layers[0]!.clip.id);
                  onSeek?.(Math.min(g.end - 0.05, g.start + Math.min(1.5, (g.end - g.start) / 2)));
                }}
                className={[
                  "shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition",
                  g.id === group?.id ? "border-teal/60 bg-teal/15 text-text" : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
                ].join(" ")}
              >
                {describeGraphic(g)}
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ---- inspector: a selected graphic -------------------------------------------------------

function GraphicInspector({
  doc,
  groupId,
  busy,
  onApplyDoc,
  onSelectClip,
}: {
  doc: EditDoc;
  groupId: string;
  busy: boolean;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onSelectClip?: (id: string | null) => void;
}) {
  const group = findGraphicGroup(doc, groupId);
  if (!group) return null;
  const def = findGraphicPreset(group.preset)!;
  const p = graphicParams(group);
  const hero = group.layers.find((l) => l.clip.anim && l.clip.anim.style !== "none")?.clip.anim ?? group.layers.find((l) => l.clip.anim)?.clip.anim;

  const apply = (patch: EditGraphicPatch, key?: string) => {
    const next = editGraphic(doc, groupId, patch);
    onApplyDoc(next, key ? `${key}-${groupId}` : undefined);
    // Keep a layer of this graphic selected (a new count can rename layers).
    const g = findGraphicGroup(next, groupId);
    if (g && !g.layers.some((l) => l.clip.id === group.layers[0]!.clip.id)) onSelectClip?.(g.layers[0]!.clip.id);
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-teal/40 bg-panel p-3" aria-label="Selected graphic">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-text">{def.label}</p>
          <p className="text-[10px] text-faint">{def.blurb}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onApplyDoc(removeGraphic(doc, groupId));
            onSelectClip?.(null);
          }}
          className="shrink-0 rounded-full border border-line bg-elevated px-3 py-1 text-[11px] text-danger transition hover:border-danger/50 disabled:opacity-40"
        >
          Remove
        </button>
      </div>

      {(def.fields.text || def.fields.subtext || def.fields.amount) && (
        <Section title="Words">
          <div className="flex flex-wrap gap-2">
            {def.fields.text && (
              <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[11px] text-muted">
                {def.fields.text}
                <input
                  type="text"
                  value={p.text}
                  disabled={busy}
                  maxLength={80}
                  aria-label={def.fields.text}
                  onChange={(e) => apply({ text: e.target.value }, "gfx-text")}
                  className="rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-sm text-text"
                />
              </label>
            )}
            {def.fields.subtext && (
              <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[11px] text-muted">
                {def.fields.subtext}
                <input
                  type="text"
                  value={p.subtext}
                  disabled={busy}
                  maxLength={120}
                  aria-label={def.fields.subtext}
                  onChange={(e) => apply({ subtext: e.target.value }, "gfx-sub")}
                  className="rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-sm text-text"
                />
              </label>
            )}
            {def.fields.amount && (
              <label className="flex w-[140px] flex-col gap-1 text-[11px] text-muted">
                {def.fields.amount.label}
                <input
                  type="number"
                  value={p.amount}
                  min={def.fields.amount.min}
                  max={def.fields.amount.max}
                  step={def.fields.amount.step}
                  disabled={busy}
                  aria-label={def.fields.amount.label}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= def.fields.amount!.min && v <= def.fields.amount!.max) apply({ amount: v }, "gfx-amount");
                  }}
                  className="rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-sm tabular-nums text-text"
                />
              </label>
            )}
          </div>
        </Section>
      )}

      <Section title="Colors">
        <div className="flex flex-col gap-1.5">
          <ColorRow label="Main" value={p.color} disabled={busy} onChange={(c) => apply({ color: c }, "gfx-color")} />
          {def.paint.accent && <ColorRow label="Accent" value={p.accent} disabled={busy} onChange={(c) => apply({ accent: c }, "gfx-accent")} />}
        </div>
      </Section>

      <div className="flex flex-wrap gap-6">
        {!def.fixed && (
          <Section title="Position">
            <PositionGrid disabled={busy} onPick={(pos) => apply({ position: pos })} />
          </Section>
        )}
        <Section title="Size & timing">
          <div className="flex min-w-[240px] flex-col gap-1.5">
            {!def.fixed && <Range label="Size" value={round2(p.scale)} min={0.4} max={2.5} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} disabled={busy} onChange={(v) => apply({ scale: v }, "gfx-scale")} />}
            <Range label="Starts at" value={p.atSec} min={0} max={Math.max(10, round2(p.atSec + 10))} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} disabled={busy} onChange={(v) => apply({ atSec: v }, "gfx-at")} />
            <Range label="Duration" value={p.durationSec} min={1} max={Math.max(20, round2(p.durationSec + 5))} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} disabled={busy} onChange={(v) => apply({ durationSec: v }, "gfx-dur")} />
          </div>
        </Section>
      </div>

      {hero && (
        <Section title="Motion" hint="Applies to every animated layer.">
          <div className="flex flex-wrap items-center gap-3">
            <Select label="In" value={hero.style} options={SHAPE_INTRO_STYLES} disabled={busy} onChange={(v) => apply({ intro: v })} />
            <Select label="Loop" value={hero.loop.style} options={SHAPE_LOOP_STYLES} disabled={busy} onChange={(v) => apply({ loop: v })} />
            <Select label="Out" value={hero.exit.style} options={SHAPE_EXIT_STYLES} disabled={busy} onChange={(v) => apply({ exit: v })} />
          </div>
        </Section>
      )}
    </div>
  );
}

// ---- motion for any plain shape ----------------------------------------------------------

function ShapeMotion({ doc, clip, busy, onApplyDoc }: { doc: EditDoc; clip: ShapeClip; busy: boolean; onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void }) {
  const a = clip.anim;
  const set = (input: Parameters<typeof animateShape>[1], key?: string) =>
    onApplyDoc(animateShape(doc, { clipId: clip.id, ...input }).doc, key ? `${key}-${clip.id}` : undefined);
  const intro = (a?.style ?? "none") as ShapeIntroStyle;
  const loop = (a?.loop.style ?? "none") as ShapeLoopStyle;
  const exit = (a?.exit.style ?? "none") as ShapeExitStyle;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-teal/40 bg-panel p-3" aria-label="Shape motion">
      <div>
        <p className="text-xs font-semibold text-text">Animate this {clip.shape}</p>
        <p className="text-[10px] text-faint">Intro, loop and exit — previewed live, exported frame-for-frame.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select label="In" value={intro} options={SHAPE_INTRO_STYLES} disabled={busy} onChange={(v) => set({ style: v, durationSec: a?.durationSec ?? 0.5 })} />
        <Select label="Loop" value={loop} options={SHAPE_LOOP_STYLES} disabled={busy} onChange={(v) => set({ loop: v })} />
        <Select label="Out" value={exit} options={SHAPE_EXIT_STYLES} disabled={busy} onChange={(v) => set({ exit: v })} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Range label="In speed" value={a?.durationSec ?? 0.5} min={0.1} max={3} step={0.05} fmt={(v) => `${v.toFixed(2)}s`} disabled={busy || intro === "none"} onChange={(v) => set({ durationSec: v }, "shape-in")} />
        <Range label="Delay" value={a?.delaySec ?? 0} min={0} max={Math.max(0.1, round2(clip.duration - 0.1))} step={0.05} fmt={(v) => `${v.toFixed(2)}s`} disabled={busy || intro === "none"} onChange={(v) => set({ delaySec: v }, "shape-delay")} />
        <Range label="Loop amt" value={a?.loop.amount ?? 0.5} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} disabled={busy || loop === "none"} onChange={(v) => set({ loopAmount: v }, "shape-amt")} />
        <Range label="Loop rate" value={a?.loop.speed ?? 1} min={0.2} max={4} step={0.1} fmt={(v) => `${v.toFixed(1)}/s`} disabled={busy || loop === "none"} onChange={(v) => set({ loopSpeed: v }, "shape-rate")} />
      </div>
    </div>
  );
}
