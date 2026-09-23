"use client";

/**
 * The TEXT room — everything type, Canva-style, in one place:
 *  - Create:     paste a script → a themed, animated text video (no footage).
 *  - Scenes:     edit / retime / reorder / add / delete scenes; switch theme.
 *  - Text:       quick heading / subheading / body adds + the selected clip's
 *                words, position (9-point), and timing.
 *  - Style:      font library, size, weight, case, spacing, color, gradient
 *                fill, effects, outline, panel.
 *  - Animate:    intro (21 styles, live hover previews) by whole/line/word/letter,
 *                speed, delay, exit, loop.
 *  - Background: solid, gradient, animated (drift/spin/pulse/aurora), patterns.
 * Every control applies a PURE doc op through the editor's undoable commit, and
 * every preview tile is drawn by the same canvas code as the Stage and export.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FONT_LIBRARY,
  TEXT_ANIM_STYLES,
  TEXT_EFFECT_STYLES,
  TEXT_EXIT_STYLES,
  TEXT_LOOP_STYLES,
  fontStack,
  findFont,
  type EditDoc,
  type TextAnimStyle,
  type TextAnimUnit,
  type TextClip,
  type TextEffectStyle,
  type TextExitStyle,
  type TextLoopStyle,
} from "@cadence/core";
import {
  TEXT_VIDEO_THEME_LIST,
  animateText,
  buildTextVideo,
  detectTextVideoFormat,
  isTextVideo,
  restyleTextVideo,
  setBackground,
  setSceneText,
  setTextVideoScenes,
  styleText,
  textVideoScenes,
  type TextScene,
  type TextTarget,
  type TextVideoAspect,
  type TextVideoFormat,
  type TextVideoPace,
  type TextVideoTheme,
} from "@cadence/director";
import { BackgroundSwatch, TextSwatch, sampleText } from "./TextSwatch";
import { addQuickText, allTexts, findText, lastTitleId, patchText, type QuickTextKind } from "@/lib/text-edit";
import { PRO_TEXT_PRESETS, insertProPreset, presetPreviewClip } from "@/lib/text-presets-pro";

type Cat = "create" | "scenes" | "text" | "style" | "animate" | "background";
const CAT_KEY = "cadence:textCat";

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- small UI atoms ----------------------------------------------------------

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

function Pill({ active, onClick, disabled, children, label }: { active?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      className={[
        "shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition disabled:opacity-40",
        active ? "border-teal/60 bg-teal/15 text-text" : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-[180px] flex-1 items-center gap-2 text-[11px] text-muted">
      <span className="w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--color-amber)]"
        aria-label={label}
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-faint">{fmt ? fmt(value) : value}</span>
    </label>
  );
}

function ColorField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (hex: string) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted">
      <input
        type="color"
        value={value.slice(0, 7)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-7 w-9 cursor-pointer rounded border border-line bg-elevated p-0.5 disabled:opacity-40"
      />
      {label}
    </label>
  );
}

/** A tile with a live canvas preview that animates while hovered or focused. */
function PreviewTile({
  label,
  active,
  onClick,
  disabled,
  render,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  render: (hover: boolean) => ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className={[
        "group flex flex-col overflow-hidden rounded-lg border text-left transition disabled:opacity-40",
        active ? "border-teal/60 ring-1 ring-teal/40" : "border-line hover:border-amber/50",
      ].join(" ")}
    >
      <span className="block aspect-[2/1] w-full">{render(hover)}</span>
      <span className="truncate px-1.5 py-1 text-[11px] text-muted group-hover:text-text">{label}</span>
    </button>
  );
}

const titleCase = (s: string): string => s.replace(/(^|-)(\w)/g, (_m, p, c) => `${p === "-" ? " " : ""}${c.toUpperCase()}`);

// ---- the room -------------------------------------------------------------------

export interface TextRoomProps {
  doc: EditDoc;
  busy: boolean;
  timeSec: number;
  hasVisualMedia: boolean;
  selectedClipId: string | null;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onAction: (prompt: string) => void;
  onSelectClip?: (id: string | null) => void;
  onSeek?: (t: number) => void;
}

export function TextRoom(props: TextRoomProps) {
  const { doc } = props;
  const tv = isTextVideo(doc);
  const [cat, setCat] = useState<Cat>(tv ? "scenes" : "create");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(CAT_KEY) as Cat | null;
      if (saved && (saved !== "scenes" || tv)) setCat(saved);
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A freshly-made text video opens on its scenes.
  const prevTv = useRef(tv);
  useEffect(() => {
    if (tv && !prevTv.current) setCat("scenes");
    if (!tv) setCat((c) => (c === "scenes" ? "create" : c));
    prevTv.current = tv;
  }, [tv]);
  const choose = (c: Cat) => {
    setCat(c);
    try {
      localStorage.setItem(CAT_KEY, c);
    } catch {
      /* ignore */
    }
  };

  const cats: { key: Cat; label: string; hint: string }[] = [
    { key: "create", label: "Create", hint: "Script → video" },
    ...(tv ? [{ key: "scenes" as Cat, label: "Scenes", hint: "Edit & reorder" }] : []),
    { key: "text", label: "Text", hint: "Add & edit" },
    { key: "style", label: "Style", hint: "Fonts & effects" },
    { key: "animate", label: "Animate", hint: "In · loop · out" },
    { key: "background", label: "Background", hint: "Gradients & motion" },
  ];

  return (
    <div aria-label="Text" className="flex max-h-full gap-0 overflow-hidden border-b border-line-soft bg-panel/30">
      <nav aria-label="Text categories" className="flex w-[132px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line-soft bg-panel/40 p-2">
        {cats.map((c) => {
          const active = c.key === cat;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => choose(c.key)}
              aria-current={active ? "true" : undefined}
              className={[
                "flex flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition",
                active ? "bg-amber/10 text-amber" : "text-muted hover:bg-elevated hover:text-text",
              ].join(" ")}
            >
              <span className="text-xs font-medium">{c.label}</span>
              <span className="text-[10px] leading-tight text-faint">{c.hint}</span>
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
        {cat === "create" && <CreatePane {...props} onCreated={() => choose("scenes")} />}
        {cat === "scenes" && tv && <ScenesPane {...props} />}
        {cat === "text" && <TextPane {...props} />}
        {cat === "style" && <StylePane {...props} />}
        {cat === "animate" && <AnimatePane {...props} />}
        {cat === "background" && <BackgroundPane {...props} />}
      </div>
    </div>
  );
}

// ---- Create ---------------------------------------------------------------------

const EXAMPLES: { label: string; script: string; theme: TextVideoTheme; format?: TextVideoFormat; aspect: TextVideoAspect }[] = [
  { label: "Launch", script: "Big news.\nWe just launched Cadence.\nEdit videos just by typing.\nTry it free today.", theme: "bold", aspect: "16:9" },
  { label: "Quote", script: "“The best way to predict the future is to create it.” — Peter Drucker", theme: "elegant", aspect: "1:1" },
  { label: "Tips", script: "3 tips for better sleep\n1. No screens after 10pm\n2. Keep the room cool\n3. Same bedtime every night\nFollow for more", theme: "playful", aspect: "9:16" },
  { label: "Event", script: "You're invited.\nAyesha & Omar\nSaturday, 12 October · 7pm\nRSVP by Friday", theme: "elegant", format: "announcement", aspect: "9:16" },
  { label: "Promo", script: "Tonight only.\nLive music.\nDoors open at 9.", theme: "neon", aspect: "9:16" },
];

function CreatePane({ doc, busy, hasVisualMedia, onApplyDoc, onCreated }: TextRoomProps & { onCreated: () => void }) {
  const [script, setScript] = useState("");
  const [theme, setTheme] = useState<TextVideoTheme>((doc.textVideo?.theme as TextVideoTheme) ?? "bold");
  const [format, setFormat] = useState<TextVideoFormat | "auto">("auto");
  const [aspect, setAspect] = useState<TextVideoAspect>("16:9");
  const [pace, setPace] = useState<TextVideoPace>("normal");
  const [error, setError] = useState<string | null>(null);
  const detected = script.trim() ? detectTextVideoFormat(script) : null;

  const create = () => {
    setError(null);
    try {
      const next = buildTextVideo(doc, { script, theme, aspect, pace, ...(format === "auto" ? {} : { format }) });
      onApplyDoc(next);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't build that video.");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Section title="Your words" hint="One idea per line works best — or paste a paragraph.">
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={4}
          placeholder={"Big news.\nWe just launched.\nTry it free today."}
          aria-label="Script for the text video"
          className="w-full resize-y rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-text placeholder:text-faint"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-faint">Examples:</span>
          {EXAMPLES.map((ex) => (
            <Pill
              key={ex.label}
              onClick={() => {
                setScript(ex.script);
                setTheme(ex.theme);
                setAspect(ex.aspect);
                setFormat(ex.format ?? "auto");
              }}
            >
              {ex.label}
            </Pill>
          ))}
        </div>
      </Section>

      <Section title="Theme">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
          {TEXT_VIDEO_THEME_LIST.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTheme(t.key)}
              aria-pressed={theme === t.key}
              title={t.description}
              className={[
                "flex flex-col overflow-hidden rounded-lg border text-left transition",
                theme === t.key ? "border-teal/60 ring-1 ring-teal/40" : "border-line hover:border-amber/50",
              ].join(" ")}
            >
              <span
                className="grid h-12 place-items-center px-1 text-base leading-none"
                style={{
                  background: t.swatch.length > 1 ? `linear-gradient(135deg, ${t.swatch.join(", ")})` : t.swatch[0],
                  color: t.text.slice(0, 7),
                  fontFamily: t.family,
                }}
              >
                Aa Bb
              </span>
              <span className="truncate px-1.5 py-1 text-[11px] text-muted">{t.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Section title="Format" hint={format === "auto" && detected ? `auto → ${detected}` : undefined}>
          <div className="flex flex-wrap gap-1.5">
            {(["auto", "story", "quote", "list", "announcement", "lyrics"] as const).map((f) => (
              <Pill key={f} active={format === f} onClick={() => setFormat(f)}>
                {titleCase(f)}
              </Pill>
            ))}
          </div>
        </Section>
        <Section title="Size">
          <div className="flex flex-wrap gap-1.5">
            {(["16:9", "9:16", "1:1", "4:5"] as const).map((a) => (
              <Pill key={a} active={aspect === a} onClick={() => setAspect(a)}>
                {a}
              </Pill>
            ))}
          </div>
        </Section>
        <Section title="Pace">
          <div className="flex flex-wrap gap-1.5">
            {(["slow", "normal", "fast"] as const).map((p) => (
              <Pill key={p} active={pace === p} onClick={() => setPace(p)}>
                {titleCase(p)}
              </Pill>
            ))}
          </div>
        </Section>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={create}
          disabled={busy || !script.trim()}
          className="rounded-full bg-amber px-5 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright disabled:opacity-40"
        >
          Create text video
        </button>
        <span className="text-[11px] text-faint">
          {hasVisualMedia
            ? "Replaces the current visuals with text scenes (your music is kept). Undo anytime."
            : "No footage needed. Every scene stays editable, and exports exactly like the preview."}
        </span>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

// ---- Scenes ---------------------------------------------------------------------

function sceneStart(doc: EditDoc, i: number): number {
  for (const t of doc.tracks) for (const c of t.clips) if (c.id === `tv-s${i}-bg`) return c.start;
  return 0;
}

function ScenesPane({ doc, busy, timeSec, onApplyDoc, onSeek }: TextRoomProps) {
  const scenes = useMemo(() => textVideoScenes(doc), [doc]);
  const current = doc.textVideo?.theme as TextVideoTheme | undefined;
  const activeIndex = useMemo(() => {
    let idx = 0;
    scenes.forEach((_, i) => {
      if (timeSec >= sceneStart(doc, i) - 1e-3) idx = i;
    });
    return idx;
  }, [scenes, doc, timeSec]);

  const rebuild = (next: TextScene[]) => onApplyDoc(setTextVideoScenes(doc, next));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= scenes.length) return;
    const next = [...scenes];
    [next[i], next[j]] = [next[j]!, next[i]!];
    rebuild(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <Section title="Theme" hint="Switch the whole video's look — words and timing stay.">
        <div className="flex flex-wrap gap-1.5">
          {TEXT_VIDEO_THEME_LIST.map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={busy}
              onClick={() => t.key !== current && onApplyDoc(restyleTextVideo(doc, t.key))}
              aria-pressed={t.key === current}
              title={t.description}
              className={[
                "flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition disabled:opacity-40",
                t.key === current ? "border-teal/60 bg-teal/15 text-text" : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
              ].join(" ")}
            >
              <span
                className="h-3.5 w-3.5 rounded-full border border-white/20"
                style={{ background: t.swatch.length > 1 ? `linear-gradient(135deg, ${t.swatch.join(", ")})` : t.swatch[0] }}
              />
              {t.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title={`Scenes · ${scenes.length}`} hint="Click a scene to jump to it. Changes apply instantly (undo with ⌘Z).">
        <ol className="flex flex-col gap-1.5">
          {scenes.map((s, i) => (
            <li
              key={`${i}-${s.kind}`}
              className={[
                "flex flex-wrap items-start gap-2 rounded-lg border p-2",
                i === activeIndex ? "border-amber/40 bg-amber/5" : "border-line bg-elevated/50",
              ].join(" ")}
            >
              <button
                type="button"
                onClick={() => onSeek?.(sceneStart(doc, i) + 0.05)}
                className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-panel text-[11px] font-semibold tabular-nums text-muted hover:text-text"
                aria-label={`Jump to scene ${i + 1}`}
                title="Jump to this scene"
              >
                {i + 1}
              </button>
              <div className="flex min-w-[180px] flex-1 flex-col gap-1">
                <textarea
                  key={`h-${i}-${s.head}`}
                  defaultValue={s.head}
                  rows={Math.min(3, Math.max(1, Math.ceil(s.head.length / 48)))}
                  disabled={busy}
                  aria-label={`Scene ${i + 1} text`}
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v.trim() && v !== s.head) onApplyDoc(setSceneText(doc, i, "head", v));
                  }}
                  className="w-full resize-y rounded-md border border-line bg-panel px-2 py-1 text-sm text-text"
                />
                <input
                  key={`s-${i}-${s.sub ?? ""}`}
                  defaultValue={s.sub ?? ""}
                  placeholder="Add a second line (optional)"
                  disabled={busy}
                  aria-label={`Scene ${i + 1} second line`}
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v !== (s.sub ?? "")) {
                      if (!v.trim()) rebuild(scenes.map((x, k) => (k === i ? { ...x, sub: undefined } : x)));
                      else onApplyDoc(setSceneText(doc, i, "sub", v));
                    }
                  }}
                  className="w-full rounded-md border border-line bg-panel px-2 py-1 text-xs text-muted placeholder:text-faint"
                />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <div className="flex items-center gap-1 text-[11px] text-muted">
                  <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">{s.kind}</span>
                  <button type="button" disabled={busy} onClick={() => rebuild(scenes.map((x, k) => (k === i ? { ...x, durationSec: round2(Math.max(1, (x.durationSec ?? 3) - 0.5)) } : x)))} className="rounded border border-line px-1.5 hover:text-text" aria-label={`Shorten scene ${i + 1}`}>
                    −
                  </button>
                  <span className="w-10 text-center tabular-nums">{(s.durationSec ?? 0).toFixed(1)}s</span>
                  <button type="button" disabled={busy} onClick={() => rebuild(scenes.map((x, k) => (k === i ? { ...x, durationSec: round2(Math.min(12, (x.durationSec ?? 3) + 0.5)) } : x)))} className="rounded border border-line px-1.5 hover:text-text" aria-label={`Lengthen scene ${i + 1}`}>
                    +
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} className="rounded border border-line px-1.5 text-[11px] text-muted hover:text-text disabled:opacity-30" aria-label={`Move scene ${i + 1} up`}>
                    ↑
                  </button>
                  <button type="button" disabled={busy || i === scenes.length - 1} onClick={() => move(i, 1)} className="rounded border border-line px-1.5 text-[11px] text-muted hover:text-text disabled:opacity-30" aria-label={`Move scene ${i + 1} down`}>
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => rebuild([...scenes.slice(0, i + 1), { kind: "body", head: "New scene" }, ...scenes.slice(i + 1)])}
                    className="rounded border border-line px-1.5 text-[11px] text-muted hover:text-text"
                    aria-label={`Add a scene after scene ${i + 1}`}
                    title="Add a scene after this one"
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    disabled={busy || scenes.length <= 1}
                    onClick={() => rebuild(scenes.filter((_, k) => k !== i))}
                    className="rounded border border-line px-1.5 text-[11px] text-muted hover:border-danger/40 hover:text-danger disabled:opacity-30"
                    aria-label={`Delete scene ${i + 1}`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

// ---- shared target logic ------------------------------------------------------------

function useTarget(doc: EditDoc, selectedClipId: string | null) {
  const selected = findText(doc, selectedClipId);
  const texts = allTexts(doc);
  const [scope, setScope] = useState<"selected" | "all">(selected ? "selected" : "all");
  useEffect(() => {
    setScope(selected ? "selected" : "all");
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const target: TextTarget = scope === "selected" && selected ? { clipId: selected.id } : "all";
  const ref: TextClip | undefined = (scope === "selected" && selected) || texts.find((t) => t.anim.style !== "typewriter") || texts[0];
  return { selected, texts, scope, setScope, target, ref };
}

function ScopeBar({ selected, scope, setScope, count }: { selected: TextClip | null; scope: "selected" | "all"; setScope: (s: "selected" | "all") => void; count: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
      <span>Applies to</span>
      <Pill active={scope === "selected"} disabled={!selected} onClick={() => setScope("selected")}>
        {selected ? `Selected: “${selected.text.slice(0, 18)}${selected.text.length > 18 ? "…" : ""}”` : "Selected text (pick one on the timeline)"}
      </Pill>
      <Pill active={scope === "all"} onClick={() => setScope("all")}>
        All text ({count})
      </Pill>
    </div>
  );
}

function NoText({ onAction }: { onAction: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-muted">
      No text yet.{" "}
      <button type="button" onClick={onAction} className="text-amber underline-offset-2 hover:underline">
        Add a heading
      </button>{" "}
      or create a text video.
    </div>
  );
}

// ---- Text (add + selected clip) -----------------------------------------------------

const POSITIONS: { key: string; x: number; y: number; label: string }[] = [
  { key: "tl", x: 0.2, y: 0.18, label: "Top left" },
  { key: "tc", x: 0.5, y: 0.18, label: "Top" },
  { key: "tr", x: 0.8, y: 0.18, label: "Top right" },
  { key: "ml", x: 0.2, y: 0.5, label: "Left" },
  { key: "mc", x: 0.5, y: 0.5, label: "Center" },
  { key: "mr", x: 0.8, y: 0.5, label: "Right" },
  { key: "bl", x: 0.2, y: 0.82, label: "Bottom left" },
  { key: "bc", x: 0.5, y: 0.82, label: "Bottom" },
  { key: "br", x: 0.8, y: 0.82, label: "Bottom right" },
];

function TextPane({ doc, busy, timeSec, selectedClipId, onApplyDoc, onSelectClip }: TextRoomProps) {
  const selected = findText(doc, selectedClipId);
  const texts = allTexts(doc);
  const add = (kind: QuickTextKind) => {
    const next = addQuickText(doc, kind, round2(Math.max(0, timeSec)));
    onApplyDoc(next);
    const id = lastTitleId(next);
    if (id) onSelectClip?.(id);
  };
  const W = doc.meta.width;
  const H = doc.meta.height;

  return (
    <div className="flex flex-col gap-3">
      <Section title="Add text" hint="Lands at the playhead — then style & animate it.">
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => add("heading")} className="rounded-lg border border-line bg-elevated px-4 py-2 text-left text-lg font-bold text-text transition hover:border-amber/50 disabled:opacity-40">
            Add a heading
          </button>
          <button type="button" disabled={busy} onClick={() => add("subheading")} className="rounded-lg border border-line bg-elevated px-4 py-2 text-left text-sm font-semibold text-text transition hover:border-amber/50 disabled:opacity-40">
            Add a subheading
          </button>
          <button type="button" disabled={busy} onClick={() => add("body")} className="rounded-lg border border-line bg-elevated px-4 py-2 text-left text-xs text-muted transition hover:border-amber/50 disabled:opacity-40">
            Add a little bit of body text
          </button>
        </div>
      </Section>

      <Section title="Text styles" hint="Animated, ready-made looks — hover to preview, click to add at the playhead.">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
          {PRO_TEXT_PRESETS.map((p) => (
            <PreviewTile
              key={p.key}
              label={p.label}
              disabled={busy}
              onClick={() => {
                const { doc: next, id } = insertProPreset(doc, p, round2(Math.max(0, timeSec)));
                onApplyDoc(next);
                if (id) onSelectClip?.(id);
              }}
              render={(hover) => <PresetTile presetKey={p.key} hover={hover} />}
            />
          ))}
        </div>
      </Section>

      {texts.length > 0 && (
        <Section title="Text on the timeline" hint="Pick one to edit it here, in Style, and in Animate.">
          <div className="flex flex-wrap gap-1.5">
            {texts.slice(0, 30).map((t) => (
              <Pill key={t.id} active={t.id === selected?.id} onClick={() => onSelectClip?.(t.id)}>
                {t.text.replace(/\s+/g, " ").slice(0, 22) || "(empty)"} · {t.start.toFixed(1)}s
              </Pill>
            ))}
          </div>
        </Section>
      )}

      {selected ? (
        <>
          <Section title="Words">
            <textarea
              key={selected.id + selected.text}
              defaultValue={selected.text}
              rows={Math.min(4, Math.max(2, selected.text.split("\n").length))}
              disabled={busy}
              aria-label="Selected text content"
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== selected.text) onApplyDoc(patchText(doc, selected.id, { text: v }));
              }}
              className="w-full resize-y rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-text"
            />
          </Section>
          <div className="flex flex-wrap gap-6">
            <Section title="Position">
              <div className="grid w-[108px] grid-cols-3 gap-1" role="group" aria-label="Text position">
                {POSITIONS.map((p) => {
                  const px = p.x < 0.35 ? W * 0.08 : p.x > 0.65 ? W * 0.92 : W / 2;
                  const active = Math.abs(selected.transform.x - px) < W * 0.05 && Math.abs(selected.transform.y - p.y * H) < H * 0.05;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      disabled={busy}
                      title={p.label}
                      aria-label={p.label}
                      aria-pressed={active}
                      onClick={() => {
                        // Left/right anchor at the title-safe edge with matching alignment.
                        const align = p.x < 0.35 ? "left" : p.x > 0.65 ? "right" : "center";
                        const x = align === "left" ? W * 0.08 : align === "right" ? W * 0.92 : W / 2;
                        onApplyDoc(patchText(doc, selected.id, { align, transform: { x: Math.round(x), y: Math.round(p.y * H) } }));
                      }}
                      className={["h-8 rounded border transition", active ? "border-teal/60 bg-teal/20" : "border-line bg-elevated hover:border-amber/50"].join(" ")}
                    >
                      <span className="mx-auto block h-1.5 w-1.5 rounded-full bg-current opacity-60" />
                    </button>
                  );
                })}
              </div>
            </Section>
            <Section title="Timing">
              <div className="flex flex-col gap-1.5">
                <Slider label="Starts at" value={round2(selected.start)} min={0} max={Math.max(10, round2(selected.start + selected.duration + 5))} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} disabled={busy} onChange={(v) => onApplyDoc(patchText(doc, selected.id, { start: v }), `ts-${selected.id}`)} />
                <Slider label="Duration" value={round2(selected.duration)} min={0.5} max={20} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} disabled={busy} onChange={(v) => onApplyDoc(patchText(doc, selected.id, { duration: v }), `td-${selected.id}`)} />
              </div>
            </Section>
          </div>
        </>
      ) : (
        texts.length > 0 && <p className="text-[11px] text-faint">Select a text clip (above or on the timeline) to edit its words, position, and timing.</p>
      )}
    </div>
  );
}

/** A pro preset's live tile (memoized clip; animates while hovered). */
function PresetTile({ presetKey, hover }: { presetKey: string; hover: boolean }) {
  const clip = useMemo(() => presetPreviewClip(PRO_TEXT_PRESETS.find((p) => p.key === presetKey)!), [presetKey]);
  return <TextSwatch clip={clip} animate={hover} restTime={2} />;
}

// ---- Style ------------------------------------------------------------------------

const TEXT_GRADIENTS: { key: string; label: string; stops: string[]; angle: number }[] = [
  { key: "sunset", label: "Sunset", stops: ["#ff7a18", "#af002d"], angle: 0 },
  { key: "ocean", label: "Ocean", stops: ["#00c6ff", "#0072ff"], angle: 0 },
  { key: "candy", label: "Candy", stops: ["#f953c6", "#b91d73"], angle: 0 },
  { key: "gold", label: "Gold", stops: ["#f9d423", "#e65c00"], angle: 90 },
  { key: "mint", label: "Mint", stops: ["#a8ff78", "#78ffd6"], angle: 0 },
  { key: "rainbow", label: "Rainbow", stops: ["#ff5f6d", "#ffc371", "#47e891", "#4facfe"], angle: 0 },
  { key: "chrome", label: "Chrome", stops: ["#ffffff", "#9aa5b1", "#ffffff"], angle: 90 },
  { key: "fire", label: "Fire", stops: ["#fff200", "#ff4e00", "#c20000"], angle: 90 },
];

const SWATCHES = ["#ffffff", "#111111", "#ffd54a", "#ff4d4d", "#ff6fb5", "#a855f7", "#4db4ff", "#22d3ee", "#4dff88", "#ff9f40", "#e8c77a", "#f6f1e3"];

function StylePane({ doc, busy, selectedClipId, onApplyDoc, onSelectClip }: TextRoomProps) {
  const { selected, texts, scope, setScope, target, ref } = useTarget(doc, selectedClipId);
  const [fontCat, setFontCat] = useState<string>("all");
  if (!ref) return <NoText onAction={() => { const n = addQuickText(doc, "heading", 0); onApplyDoc(n); const id = lastTitleId(n); if (id) onSelectClip?.(id); }} />;
  const apply = (input: Parameters<typeof styleText>[1], key?: string) => onApplyDoc(styleText(doc, { ...input, target }).doc, key);
  const patchAll = (patch: Record<string, unknown>, key?: string) => {
    let next = doc;
    const ids = typeof target === "object" ? [target.clipId] : texts.map((t) => t.id);
    for (const id of ids) next = patchText(next, id, patch);
    onApplyDoc(next, key);
  };
  const currentFont = findFont(ref.fontFamily);
  const categories = ["all", "sans", "display", "serif", "script", "handwriting", "mono"];
  const fonts = FONT_LIBRARY.filter((f) => fontCat === "all" || f.category === fontCat);
  const effect = ref.effect?.style ?? "none";

  return (
    <div className="flex flex-col gap-3">
      <ScopeBar selected={selected} scope={scope} setScope={setScope} count={texts.length} />

      <Section title="Font" hint={currentFont ? currentFont.family : ref.fontFamily.split(",")[0]}>
        <div className="flex flex-wrap gap-1">
          {categories.map((c) => (
            <Pill key={c} active={fontCat === c} onClick={() => setFontCat(c)}>
              {titleCase(c)}
            </Pill>
          ))}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-1.5">
          {fonts.map((f) => {
            const stack = fontStack(f);
            const active = currentFont?.id === f.id;
            return (
              <button
                key={f.id}
                type="button"
                disabled={busy}
                onClick={() => apply({ fontFamily: stack, ...(f.weights.includes(700) || f.weights.includes(800) ? {} : { fontWeight: "normal" as const }) })}
                aria-pressed={active}
                className={[
                  "flex flex-col items-start rounded-lg border px-2 py-1.5 text-left transition disabled:opacity-40",
                  active ? "border-teal/60 bg-teal/10" : "border-line bg-elevated hover:border-amber/50",
                ].join(" ")}
              >
                <span className="w-full truncate text-base leading-tight text-text" style={{ fontFamily: stack, fontWeight: Math.max(...f.weights) >= 700 ? 700 : 400 }}>
                  {f.sample}
                </span>
                <span className="text-[10px] text-faint">{f.family}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Slider label="Size" value={ref.fontSize} min={12} max={Math.round(Math.min(doc.meta.width, doc.meta.height) * 0.35)} step={1} fmt={(v) => `${v}px`} disabled={busy} onChange={(v) => patchAll({ fontSize: v }, "tx-size")} />
        <Slider label="Letter space" value={ref.letterSpacing} min={-6} max={40} step={1} disabled={busy} onChange={(v) => patchAll({ letterSpacing: v }, "tx-ls")} />
        <Slider label="Line height" value={ref.lineHeight} min={0.8} max={2} step={0.05} fmt={(v) => v.toFixed(2)} disabled={busy} onChange={(v) => patchAll({ lineHeight: v }, "tx-lh")} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {(["normal", "medium", "semibold", "bold"] as const).map((w) => (
          <Pill key={w} active={ref.fontWeight === w} disabled={busy} onClick={() => apply({ fontWeight: w })}>
            {titleCase(w)}
          </Pill>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        <Pill active={ref.italic} disabled={busy} onClick={() => apply({ italic: !ref.italic })}>
          <em>Italic</em>
        </Pill>
        <Pill active={ref.uppercase} disabled={busy} onClick={() => apply({ uppercase: !ref.uppercase })}>
          AA Caps
        </Pill>
        <span className="mx-1 h-4 w-px bg-line" />
        {(["left", "center", "right"] as const).map((a) => (
          <Pill key={a} active={ref.align === a} disabled={busy} onClick={() => apply({ align: a })}>
            {titleCase(a)}
          </Pill>
        ))}
      </div>

      <Section title="Color">
        <div className="flex flex-wrap items-center gap-1.5">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              disabled={busy}
              aria-label={`Text color ${c}`}
              onClick={() => apply({ color: c })}
              className={["h-6 w-6 rounded-full border transition", !ref.fillGradient && ref.color.slice(0, 7) === c ? "border-teal ring-2 ring-teal/40" : "border-white/20 hover:scale-110"].join(" ")}
              style={{ background: c }}
            />
          ))}
          <ColorField label="Custom" value={ref.color} disabled={busy} onChange={(hex) => apply({ color: hex }, "tx-color")} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-faint">Gradient:</span>
          {TEXT_GRADIENTS.map((g) => (
            <button
              key={g.key}
              type="button"
              disabled={busy}
              title={g.label}
              aria-label={`Gradient text ${g.label}`}
              onClick={() => apply({ fillGradient: { stops: g.stops, angle: g.angle } })}
              className={["h-6 w-10 rounded-md border transition", ref.fillGradient?.stops.join() === g.stops.join() ? "border-teal ring-2 ring-teal/40" : "border-white/20 hover:scale-105"].join(" ")}
              style={{ background: `linear-gradient(${g.angle === 90 ? "180deg" : "90deg"}, ${g.stops.join(", ")})` }}
            />
          ))}
          {ref.fillGradient && (
            <Pill onClick={() => apply({ fillGradient: null })} disabled={busy}>
              No gradient
            </Pill>
          )}
        </div>
      </Section>

      <Section title="Effect" hint="Canva-style text effects — exported exactly as shown.">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {TEXT_EFFECT_STYLES.map((e) => (
            <PreviewTile
              key={e}
              label={e === "none" ? "None" : titleCase(e)}
              active={effect === e}
              disabled={busy}
              onClick={() => apply({ effect: e === "none" ? null : { style: e as TextEffectStyle, intensity: 0.55, offset: 0.5, direction: -45, ...(ref.effect?.color ? { color: ref.effect.color } : {}) } })}
              render={() => (
                <TextSwatch clip={sampleText("Aa", { fontFamily: ref.fontFamily, fontSize: 52, color: e === "neon" ? "#ff3df2" : "#ffffff", ...(e !== "none" ? { effect: { style: e } } : {}) })} background={e === "highlight" ? "#1b2030" : "#2a3350"} />
              )}
            />
          ))}
        </div>
        {effect !== "none" && ref.effect && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Slider label="Intensity" value={ref.effect.intensity} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} disabled={busy} onChange={(v) => patchAll({ effect: { ...ref.effect!, intensity: v } }, "tx-eff-i")} />
            {(effect === "echo" || effect === "splice" || effect === "glitch" || effect === "highlight") && (
              <Slider label={effect === "highlight" ? "Roundness" : "Offset"} value={ref.effect.offset} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} disabled={busy} onChange={(v) => patchAll({ effect: { ...ref.effect!, offset: v } }, "tx-eff-o")} />
            )}
            {effect !== "hollow" && effect !== "lift" && (
              <ColorField label="Effect color" value={ref.effect.color ?? (effect === "highlight" ? "#ffd54a" : ref.color)} disabled={busy} onChange={(hex) => patchAll({ effect: { ...ref.effect!, color: hex } }, "tx-eff-c")} />
            )}
          </div>
        )}
      </Section>

      <Section title="Outline & panel">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Slider label="Outline" value={ref.outline?.width ?? 0} min={0} max={16} step={1} fmt={(v) => `${v}px`} disabled={busy} onChange={(v) => patchAll({ outline: v > 0 ? { color: ref.outline?.color ?? "#000000", width: v } : null }, "tx-out")} />
          <ColorField label="Outline color" value={ref.outline?.color ?? "#000000"} disabled={busy} onChange={(hex) => patchAll({ outline: { color: hex, width: Math.max(2, ref.outline?.width ?? 4) } }, "tx-outc")} />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-faint">Panel:</span>
            {(["none", "pill", "box"] as const).map((b) => (
              <Pill
                key={b}
                active={(ref.box?.style ?? (ref.background ? "pill" : "none")) === b}
                disabled={busy}
                onClick={() => patchAll(b === "none" ? { box: null, background: null } : { box: { style: b, color: ref.box?.color ?? "#000000", opacity: ref.box?.opacity ?? 0.6 } })}
              >
                {titleCase(b)}
              </Pill>
            ))}
            {ref.box && ref.box.style !== "none" && (
              <ColorField label="Panel color" value={ref.box.color ?? "#000000"} disabled={busy} onChange={(hex) => patchAll({ box: { ...ref.box!, color: hex } }, "tx-box")} />
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

// ---- Animate --------------------------------------------------------------------

const ANIM_LABELS: Partial<Record<TextAnimStyle, string>> = { none: "None", kinetic: "Kinetic", "zoom-in": "Zoom in", "blur-in": "Blur in", "slide-left": "Slide left", "slide-right": "Slide right" };

function AnimatePane({ doc, busy, selectedClipId, onApplyDoc, onSelectClip }: TextRoomProps) {
  const { selected, texts, scope, setScope, target, ref } = useTarget(doc, selectedClipId);
  if (!ref) return <NoText onAction={() => { const n = addQuickText(doc, "heading", 0); onApplyDoc(n); const id = lastTitleId(n); if (id) onSelectClip?.(id); }} />;
  const a = ref.anim;
  const unit = a.unit;
  const apply = (input: Parameters<typeof animateText>[1], key?: string) => onApplyDoc(animateText(doc, { ...input, target }).doc, key);
  const previewUnit: TextAnimUnit = unit;

  return (
    <div className="flex flex-col gap-3">
      <ScopeBar selected={selected} scope={scope} setScope={setScope} count={texts.length} />

      <Section title="Animate by">
        <div className="flex flex-wrap gap-1.5">
          {(["whole", "line", "word", "letter"] as const).map((u) => (
            <Pill key={u} active={unit === u} disabled={busy} onClick={() => apply({ unit: u })}>
              {u === "whole" ? "Whole block" : `${titleCase(u)} by ${u}`}
            </Pill>
          ))}
        </div>
      </Section>

      <Section title="Intro" hint="Hover a tile to preview it.">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {TEXT_ANIM_STYLES.map((st) => (
            <PreviewTile
              key={st}
              label={ANIM_LABELS[st] ?? titleCase(st)}
              active={a.style === st}
              disabled={busy}
              onClick={() => apply({ style: st, ...(st === "none" ? {} : { durationSec: a.durationSec > 0 ? a.durationSec : undefined }) })}
              render={(hover) => (
                <TextSwatch
                  animate={hover}
                  restTime={st === "none" ? 1 : 0.35}
                  clip={sampleText(previewUnit === "letter" || previewUnit === "word" ? "Hello there" : "Hello", {
                    fontFamily: ref.fontFamily,
                    fontSize: 34,
                    anim: { style: st, unit: previewUnit, durationSec: st === "none" ? 0 : 0.9, fromY: 30, fromScale: 0.6 },
                  })}
                />
              )}
            />
          ))}
        </div>
        {a.style !== "none" && (
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Slider label="Speed" value={a.durationSec} min={0.2} max={Math.max(2.5, Math.min(ref.duration, 4))} step={0.05} fmt={(v) => `${v.toFixed(2)}s`} disabled={busy} onChange={(v) => apply({ durationSec: v }, "an-dur")} />
            <Slider label="Delay" value={a.delaySec} min={0} max={Math.max(0.5, Math.min(3, ref.duration * 0.6))} step={0.05} fmt={(v) => `${v.toFixed(2)}s`} disabled={busy} onChange={(v) => apply({ delaySec: v }, "an-delay")} />
          </div>
        )}
      </Section>

      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Section title="Loop while on screen">
          <div className="flex flex-wrap gap-1.5">
            {TEXT_LOOP_STYLES.map((l) => (
              <Pill key={l} active={a.loop.style === l} disabled={busy} onClick={() => apply({ loop: l as TextLoopStyle, ...(l !== "none" && a.loop.amount === 0 ? { loopAmount: 0.5 } : {}) })}>
                {titleCase(l)}
              </Pill>
            ))}
          </div>
          {a.loop.style !== "none" && (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Slider label="Amount" value={a.loop.amount} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} disabled={busy} onChange={(v) => apply({ loopAmount: v }, "an-lamt")} />
              <Slider label="Tempo" value={a.loop.speed} min={0.1} max={3} step={0.05} fmt={(v) => `${v.toFixed(2)}/s`} disabled={busy} onChange={(v) => apply({ loopSpeed: v }, "an-lspd")} />
            </div>
          )}
        </Section>
        <Section title="Exit">
          <div className="flex flex-wrap gap-1.5">
            {TEXT_EXIT_STYLES.map((x) => (
              <Pill key={x} active={a.exit.style === x} disabled={busy} onClick={() => apply({ exit: x as TextExitStyle })}>
                {titleCase(x)}
              </Pill>
            ))}
          </div>
          {a.exit.style !== "none" && (
            <Slider label="Exit length" value={a.exit.durationSec} min={0.1} max={Math.max(0.5, Math.min(2, ref.duration * 0.4))} step={0.05} fmt={(v) => `${v.toFixed(2)}s`} disabled={busy} onChange={(v) => apply({ exitSec: v }, "an-exit")} />
          )}
        </Section>
      </div>
    </div>
  );
}

// ---- Background --------------------------------------------------------------------

const BG_PRESETS: { key: string; label: string; spec: Record<string, unknown> }[] = [
  { key: "sunset", label: "Sunset", spec: { color: "#ff512f", gradient: { stops: ["#ff512f", "#dd2476"], angle: 135 } } },
  { key: "violet", label: "Violet", spec: { color: "#4776e6", gradient: { stops: ["#4776e6", "#8e54e9"], angle: 135 } } },
  { key: "lagoon", label: "Lagoon", spec: { color: "#11998e", gradient: { stops: ["#11998e", "#38ef7d"], angle: 135 } } },
  { key: "peach", label: "Peach", spec: { color: "#ffd1dc", gradient: { stops: ["#ffd1dc", "#ffe8a3"], angle: 120 } } },
  { key: "midnight", label: "Midnight", spec: { color: "#0f2027", gradient: { stops: ["#0f2027", "#203a43", "#2c5364"], angle: 160 } } },
  { key: "spotlight", label: "Spotlight", spec: { color: "#000000", gradient: { kind: "radial", stops: ["#2b2b35", "#000000"] } } },
  { key: "aurora", label: "Aurora ✦", spec: { color: "#070b1d", gradient: { stops: ["#1a1446", "#7b2ff7", "#00c2ff", "#ff5edb"], motion: "aurora", speed: 1 } } },
  { key: "tropic", label: "Tropic ✦", spec: { color: "#06121a", gradient: { stops: ["#0b2a3a", "#00c9a7", "#845ec2", "#ffc75f"], motion: "aurora", speed: 1 } } },
  { key: "drift", label: "Drift ✦", spec: { color: "#ff9a9e", gradient: { stops: ["#ff9a9e", "#fad0c4", "#a18cd1"], motion: "drift", speed: 1.4 } } },
  { key: "spin", label: "Spin ✦", spec: { color: "#f7971e", gradient: { stops: ["#f7971e", "#ffd200", "#f7971e"], motion: "spin", speed: 1 } } },
  { key: "pulse", label: "Pulse ✦", spec: { color: "#0b3d2e", gradient: { kind: "radial", stops: ["#43e97b", "#0b3d2e"], motion: "pulse", speed: 1 } } },
  { key: "neon-grid", label: "Neon grid", spec: { color: "#07060f", pattern: { kind: "grid", color: "#7b2ff7", opacity: 0.18, scale: 1.4 } } },
  { key: "dots", label: "Sunny dots", spec: { color: "#ffcc4d", pattern: { kind: "dots", color: "#7a2e0e", opacity: 0.14, scale: 0.9 } } },
  { key: "paper", label: "Lined paper", spec: { color: "#fbf6ea", pattern: { kind: "lines", color: "#5b8bd9", opacity: 0.2, scale: 1.2 } } },
  { key: "navy", label: "Navy stripes", spec: { color: "#0b2545", gradient: { stops: ["#0b2545", "#13315c"], angle: 160 }, pattern: { kind: "diagonal", color: "#ffffff", opacity: 0.05, scale: 1 } } },
  { key: "ink", label: "Ink", spec: { color: "#111111" } },
  { key: "paper-white", label: "Paper", spec: { color: "#f6f4ef" } },
];

export function BackgroundPane({ doc, busy, onApplyDoc }: Pick<TextRoomProps, "doc" | "busy" | "onApplyDoc">) {
  const solids = doc.tracks.flatMap((t) => (t.id === "fades" ? [] : t.clips)).filter((c) => c.kind === "solid" && c.id !== "fade-in" && c.id !== "fade-out");
  const first = solids[0] as { color: string; gradient?: { motion: string; speed: number }; pattern?: { kind: string; opacity: number } } | undefined;
  const applySpec = (spec: Record<string, unknown>) =>
    onApplyDoc(
      setBackground(doc, {
        color: spec.color as string,
        gradient: spec.gradient ? ({ kind: "linear", angle: 135, motion: "none", speed: 1, ...(spec.gradient as object) } as never) : null,
        pattern: spec.pattern ? ({ color: "#ffffff", opacity: 0.08, scale: 1, ...(spec.pattern as object) } as never) : null,
      }).doc,
    );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-faint">
        {solids.length > 0
          ? `Applies to every background scene (${solids.length}). ✦ = animated. Hover to preview motion.`
          : "Adds a full-length background layer (shows behind text, and in letterbox areas under footage)."}
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
        {BG_PRESETS.map((p) => (
          <PreviewTile
            key={p.key}
            label={p.label}
            disabled={busy}
            onClick={() => applySpec(p.spec)}
            render={(hover) => <BackgroundSwatch spec={{ ...p.spec, ...(p.spec.gradient ? { gradient: { ...(p.spec.gradient as object), speed: 4 } } : {}) }} animate={hover} />}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <ColorField label="Solid color" value={first?.color ?? doc.meta.background} disabled={busy} onChange={(hex) => onApplyDoc(setBackground(doc, { color: hex, gradient: null }).doc, "bg-color")} />
        {first?.gradient && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-faint">Motion:</span>
            {(["none", "drift", "spin", "pulse", "aurora"] as const).map((m) => (
              <Pill
                key={m}
                active={first.gradient!.motion === m}
                disabled={busy}
                onClick={() => {
                  const g = (solids[0] as unknown as { gradient: Record<string, unknown> }).gradient;
                  onApplyDoc(setBackground(doc, { gradient: { ...(g as object), motion: m } as never }).doc);
                }}
              >
                {titleCase(m)}
              </Pill>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-faint">Pattern:</span>
          {(["none", "dots", "grid", "lines", "diagonal"] as const).map((k) => (
            <Pill
              key={k}
              active={(first?.pattern?.kind ?? "none") === k}
              disabled={busy}
              onClick={() => onApplyDoc(setBackground(doc, { pattern: k === "none" ? null : { kind: k, color: "#ffffff", opacity: 0.12, scale: 1 } }).doc)}
            >
              {titleCase(k)}
            </Pill>
          ))}
        </div>
      </div>
    </div>
  );
}
