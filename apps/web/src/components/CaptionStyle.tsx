"use client";

/**
 * Caption style + position — the custom-subtitle-styling surface for the Words
 * room. Every control is a thin, PURE wrapper over the engine's caption ops:
 * `styleCaptions` (font / size / color / weight / italic / align / uppercase /
 * letter-spacing / outline / shadow / background panel) and `positionCaptions`
 * (top / center / bottom anchor + vertical offset). Free "place on preview" reuses
 * the shared on-preview placement gesture and writes the caption's free transform
 * (re-parsed through the schema, exactly like the text-preset inserts do).
 *
 * By default every change styles ALL captions on the "captions" track; when a
 * single caption clip is selected on the timeline the user can scope a change to
 * "this caption only" via the op's `clipId`. A small live preview chip mirrors the
 * current caption look so non-pros see the result before it lands. All edits route
 * through the undoable `onApplyDoc` (commit) path — continuous controls pass a
 * coalesce key so a whole slider drag collapses into one undo step.
 */

import { useMemo, useState } from "react";
import {
  parseEditDoc,
  CAPTION_FONTS,
  type EditDoc,
  type TextClip,
} from "@cadence/core";
import {
  styleCaptions,
  positionCaptions,
  setKaraoke,
  addCaptions,
  type CaptionStyleOpts,
  type CaptionPosition,
  type KaraokeStyle,
} from "@cadence/director";
import type { Transcript } from "@cadence/understanding";
import type { BeginPlacement } from "@/lib/placement";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// ---- small shared controls (match the room tokens) -------------------------

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-[92px] shrink-0 text-[10px] uppercase tracking-wider text-faint">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={[
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-50",
        active
          ? "border-teal/40 bg-teal/10 text-teal"
          : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
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
  disabled,
  onChange,
  format,
  width = "128px",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  width?: string;
}) {
  const shown = format ? format(value) : String(Math.round(value));
  return (
    <label className="flex shrink-0 flex-col gap-1" style={{ width }}>
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
        <span>{label}</span>
        <span className="tabular-nums text-muted">{shown}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={`${label}, ${shown}`}
        style={{ accentColor: "var(--color-teal)" }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

function Swatch({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex shrink-0 items-center gap-1.5" title={label}>
      <span className="text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <input
        type="color"
        value={toHex6(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-7 w-9 shrink-0 cursor-pointer rounded-md border border-line bg-elevated p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

// ---- helpers ---------------------------------------------------------------

/** Coerce any stored hex (may carry an alpha pair) to the #RRGGBB an <input type=color> needs. */
function toHex6(hex: string | undefined): string {
  if (!hex) return "#ffffff";
  const m = /^#([0-9a-fA-F]{6})/.exec(hex);
  return m ? `#${m[1]}` : "#ffffff";
}

/** #RRGGBB + 0..1 opacity → an rgba() string for the preview chip's panel. */
function rgba(hex: string, opacity: number): string {
  const h = toHex6(hex).slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(opacity, 0, 1)})`;
}

/** The caption text clips on the "captions" track (mirrors the engine's target set). */
function captionClips(doc: EditDoc): TextClip[] {
  const track = doc.tracks.find((t) => t.id === "captions");
  return (track?.clips.filter((c) => c.kind === "text") ?? []) as TextClip[];
}

/** The style state we read back off a caption clip (schema defaults filled in). */
interface CaptionState {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  align: "left" | "center" | "right";
  uppercase: boolean;
  letterSpacing: number;
  outlineColor: string;
  outlineWidth: number;
  shadowOn: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  boxStyle: "none" | "pill" | "box";
  boxColor: string;
  boxOpacity: number;
  boxRadius: number;
  boxPadX: number;
  boxPadY: number;
  position: CaptionPosition;
  offset: number;
  karaokeOn: boolean;
  karaokeHighlight: string;
  karaokeStyle: KaraokeStyle;
}

/** Read the caption look off a clip so the controls + preview reflect the doc. */
function readState(clip: TextClip | undefined, h: number): CaptionState {
  const c = clip as (TextClip & { positionOffset?: number }) | undefined;
  const box = c?.box;
  const legacyBg = c?.background;
  return {
    fontFamily: c?.fontFamily ?? "sans-serif",
    fontSize: c?.fontSize ?? Math.round(h * 0.05),
    bold: c?.fontWeight === "bold",
    italic: c?.italic ?? false,
    color: toHex6(c?.color ?? "#ffffff"),
    align: c?.align ?? "center",
    uppercase: c?.uppercase ?? false,
    letterSpacing: c?.letterSpacing ?? 0,
    outlineColor: toHex6(c?.outline?.color ?? "#000000"),
    outlineWidth: c?.outline?.width ?? 0,
    shadowOn: !!c?.shadow,
    shadowColor: toHex6(c?.shadow?.color ?? "#000000"),
    shadowBlur: c?.shadow?.blur ?? 8,
    shadowOffsetX: c?.shadow?.offsetX ?? 0,
    shadowOffsetY: c?.shadow?.offsetY ?? 2,
    boxStyle: box?.style ?? (legacyBg ? "pill" : "none"),
    boxColor: toHex6(box?.color ?? legacyBg ?? "#0a0d12"),
    boxOpacity: box?.opacity ?? (legacyBg ? 0.8 : 0.85),
    boxRadius: box?.radius ?? 8,
    boxPadX: box?.padX ?? Math.round((c?.fontSize ?? h * 0.05) * 0.5),
    boxPadY: box?.padY ?? Math.round((c?.fontSize ?? h * 0.05) * 0.28),
    position: c?.position ?? "bottom",
    offset: c?.positionOffset ?? 0,
    karaokeOn: !!c?.karaoke?.enabled,
    karaokeHighlight: toHex6(c?.karaoke?.highlight ?? "#ffd54a"),
    karaokeStyle: c?.karaoke?.style ?? "color",
  };
}

/**
 * Free placement: write the caption clip(s)' transform to the picked composition
 * fractions and flag them `position: "free"` (the transform becomes authoritative,
 * matching the engine's contract). Pure + re-parsed through the schema, so it is
 * undoable and previews identically — the one caption move the engine leaves to the
 * spatial gesture (styleCaptions/positionCaptions only own the vertical anchors).
 */
function placeCaptionsFree(doc: EditDoc, xFrac: number, yFrac: number, clipId?: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const W = clone.meta.width;
  const H = clone.meta.height;
  for (const track of clone.tracks) {
    // No clipId ⇒ every caption on the "captions" track; a clipId ⇒ search all
    // tracks for that one clip (a caption may be selected from any lane).
    if (!clipId && track.id !== "captions") continue;
    for (const clip of track.clips) {
      if (clip.kind !== "text") continue;
      if (clipId && clip.id !== clipId) continue;
      const c = clip as TextClip & { position?: CaptionPosition };
      c.position = "free";
      c.transform.x = round(clamp(xFrac, 0, 1) * W);
      c.transform.y = round(clamp(yFrac, 0, 1) * H);
    }
  }
  return parseEditDoc(clone);
}

/** A friendly short label for a CSS font stack ("Inter, sans-serif" → "Inter"). */
function fontLabel(stack: string): string {
  const first = stack.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
  return first === "sans-serif" ? "System sans" : first;
}

// ---- quick presets ---------------------------------------------------------

type Preset = { key: string; label: string; build: (h: number) => CaptionStyleOpts };

const PRESETS: Preset[] = [
  {
    key: "clean",
    label: "Clean",
    build: (h) => ({
      fontFamily: "Inter, sans-serif",
      fontWeight: "semibold",
      italic: false,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0,
      fontSize: Math.round(h * 0.05),
      outlineColor: "#000000",
      outlineWidth: 0,
      shadow: { color: "#000000", blur: 8, offsetX: 0, offsetY: 2 },
      background: null,
      box: { style: "none" },
      position: "bottom",
    }),
  },
  {
    key: "bold-pop",
    label: "Bold Pop",
    build: (h) => ({
      fontFamily: "Montserrat, sans-serif",
      fontWeight: "bold",
      italic: false,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 1,
      fontSize: Math.round(h * 0.065),
      outlineColor: "#000000",
      outlineWidth: Math.max(2, Math.round(h * 0.006)),
      shadow: { color: "#000000", blur: 6, offsetX: 0, offsetY: 3 },
      background: null,
      box: { style: "none" },
      position: "bottom",
    }),
  },
  {
    key: "youtube",
    label: "YouTube",
    build: (h) => ({
      fontFamily: "Roboto, sans-serif",
      fontWeight: "medium",
      italic: false,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0,
      fontSize: Math.round(h * 0.05),
      outlineColor: "#000000",
      outlineWidth: 0,
      shadow: null,
      background: null,
      box: { style: "box", color: "#000000", opacity: 0.75, radius: 6, padX: Math.round(h * 0.022), padY: Math.round(h * 0.012) },
      position: "bottom",
    }),
  },
  {
    key: "tiktok",
    label: "TikTok",
    build: (h) => ({
      fontFamily: "Helvetica, Arial, sans-serif",
      fontWeight: "bold",
      italic: false,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.5,
      fontSize: Math.round(h * 0.06),
      outlineColor: "#000000",
      outlineWidth: 0,
      shadow: null,
      background: null,
      box: { style: "pill", color: "#000000", opacity: 0.9, radius: Math.round(h * 0.04), padX: Math.round(h * 0.026), padY: Math.round(h * 0.014) },
      position: "center",
    }),
  },
  {
    key: "minimal",
    label: "Minimal",
    build: (h) => ({
      fontFamily: "sans-serif",
      fontWeight: "normal",
      italic: false,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0,
      fontSize: Math.round(h * 0.046),
      outlineColor: "#000000",
      outlineWidth: 0,
      shadow: { color: "#000000", blur: 4, offsetX: 0, offsetY: 1 },
      background: null,
      box: { style: "none" },
      position: "bottom",
    }),
  },
  {
    key: "boxed",
    label: "Boxed",
    build: (h) => ({
      fontFamily: "Georgia, serif",
      fontWeight: "semibold",
      italic: false,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0,
      fontSize: Math.round(h * 0.05),
      outlineColor: "#000000",
      outlineWidth: 0,
      shadow: null,
      background: null,
      box: { style: "box", color: "#0a0d12", opacity: 0.9, radius: 2, padX: Math.round(h * 0.024), padY: Math.round(h * 0.014) },
      position: "bottom",
    }),
  },
];

// ---- preview chip ----------------------------------------------------------

/** A small dark-footage chip that renders a sample caption in the current style. */
function PreviewChip({ s, h }: { s: CaptionState; h: number }) {
  // Map composition px onto the ~56px-tall chip so size/spacing changes are visible.
  const k = 320 / h; // preview px per composition px
  const fontPx = clamp(Math.round(s.fontSize * k), 11, 34);
  const stroke = Math.max(0, s.outlineWidth * k);
  const shadowCss = s.shadowOn
    ? `${(s.shadowOffsetX * k).toFixed(1)}px ${(s.shadowOffsetY * k).toFixed(1)}px ${Math.max(0, s.shadowBlur * k).toFixed(1)}px ${s.shadowColor}`
    : "none";
  const hasPanel = s.boxStyle !== "none";
  const justify = s.align === "left" ? "flex-start" : s.align === "right" ? "flex-end" : "center";

  // Karaoke preview: split the sample into words and emphasize one so the chosen
  // highlight color + style (color / fill / box) is visible before it lands.
  const words = ["Sample", "caption"];
  const activeIdx = 1;
  const renderText = () =>
    s.karaokeOn
      ? words.map((word, i) => {
          const active = i === activeIdx;
          const hi = s.karaokeHighlight;
          return (
            <span
              key={i}
              style={{
                color: active && s.karaokeStyle === "color" ? hi : s.color,
                background: active && s.karaokeStyle === "fill" ? hi : "transparent",
                border: active && s.karaokeStyle === "box" ? `1.5px solid ${hi}` : "1.5px solid transparent",
                borderRadius: active ? "4px" : undefined,
                padding: active && s.karaokeStyle !== "color" ? "0 3px" : "0 1px",
                marginRight: i < words.length - 1 ? "3px" : undefined,
                WebkitTextStroke: undefined,
              }}
            >
              {word}
            </span>
          );
        })
      : "Sample caption";

  return (
    <div
      aria-hidden
      className="flex h-14 w-full items-end overflow-hidden rounded-lg border border-line"
      style={{
        background: "linear-gradient(135deg,#243244 0%,#3f5570 45%,#6b7d92 100%)",
        justifyContent: justify,
        alignItems: s.position === "top" ? "flex-start" : s.position === "center" ? "center" : "flex-end",
        padding: "6px 8px",
      }}
    >
      <span
        style={{
          fontFamily: s.fontFamily,
          fontSize: `${fontPx}px`,
          fontWeight: s.bold ? 700 : 500,
          fontStyle: s.italic ? "italic" : "normal",
          color: s.color,
          letterSpacing: `${(s.letterSpacing * k).toFixed(2)}px`,
          textTransform: s.uppercase ? "uppercase" : "none",
          lineHeight: 1.1,
          textShadow: shadowCss,
          WebkitTextStroke: stroke > 0 ? `${stroke.toFixed(1)}px ${s.outlineColor}` : undefined,
          paintOrder: "stroke fill",
          background: hasPanel ? rgba(s.boxColor, s.boxOpacity) : "transparent",
          borderRadius: hasPanel ? (s.boxStyle === "pill" ? "999px" : `${Math.max(0, s.boxRadius * k)}px`) : undefined,
          padding: hasPanel ? `${Math.max(1, s.boxPadY * k).toFixed(0)}px ${Math.max(2, s.boxPadX * k).toFixed(0)}px` : undefined,
          whiteSpace: "nowrap",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {renderText()}
      </span>
    </div>
  );
}

// ---- the section ------------------------------------------------------------

const ALIGNS: { key: "left" | "center" | "right"; label: string; glyph: string }[] = [
  { key: "left", label: "Align left", glyph: "⇤" },
  { key: "center", label: "Align center", glyph: "≡" },
  { key: "right", label: "Align right", glyph: "⇥" },
];

const ANCHORS: { key: CaptionPosition; label: string }[] = [
  { key: "top", label: "Top" },
  { key: "center", label: "Center" },
  { key: "bottom", label: "Bottom" },
];

const KARAOKE_STYLES: { key: KaraokeStyle; label: string }[] = [
  { key: "color", label: "Color" },
  { key: "fill", label: "Fill" },
  { key: "box", label: "Box" },
];

export function CaptionStyleSection({
  doc,
  busy,
  onApplyDoc,
  onBeginPlacement,
  selectedClipId,
  canAddCaptions,
  onAddCaptions,
  transcript,
}: {
  doc: EditDoc;
  busy: boolean;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onBeginPlacement?: BeginPlacement;
  /** The clip selected on the timeline (enables "this caption only" when it's a caption). */
  selectedClipId?: string | null;
  /** True when a transcript exists so captions can be generated in one tap. */
  canAddCaptions?: boolean;
  /** Generate captions from the transcript (pure addCaptions → commit). */
  onAddCaptions?: () => void;
  /**
   * The transcript for the main clip, when loaded. Used to (re)build captions WITH
   * per-word timings so enabling karaoke "just works" even if captions were added
   * before word timings existed (or don't exist yet).
   */
  transcript?: Transcript;
}) {
  const H = doc.meta.height;
  const clips = useMemo(() => captionClips(doc), [doc]);
  const captionsExist = clips.length > 0;

  // "this caption only" is offered when the timeline selection IS a caption clip.
  const selectedCaption = selectedClipId ? clips.find((c) => c.id === selectedClipId) ?? null : null;
  const [thisOnly, setThisOnly] = useState(false);
  const scoped = thisOnly && !!selectedCaption;
  const clipId = scoped ? selectedCaption!.id : undefined;

  // Read the current look off the target clip (the scoped one, else the first).
  const sourceClip = scoped ? selectedCaption! : clips[0];
  const s = readState(sourceClip, H);

  // Karaoke needs per-word timings on the caption clips. addCaptions now always
  // populates `words`; a legacy caption (added before that) may lack them.
  const captionsHaveWords = useMemo(
    () => clips.some((c) => ((c as TextClip & { words?: unknown[] }).words?.length ?? 0) > 0),
    [clips],
  );

  const [placing, setPlacing] = useState(false);

  const apply = (opts: CaptionStyleOpts, coalesceKey?: string) => {
    if (!captionsExist) return;
    try {
      onApplyDoc(styleCaptions(doc, { ...opts, clipId }), coalesceKey);
    } catch {
      /* no captions to style — guarded above, ignore */
    }
  };

  const applyAnchor = (anchor: CaptionPosition, offset: number) => {
    if (!captionsExist) return;
    try {
      onApplyDoc(positionCaptions(doc, { anchor, offset, clipId }), "cap-position");
    } catch {
      /* ignore */
    }
  };

  const applyPreset = (p: Preset) => {
    if (!captionsExist) return;
    const built = p.build(H);
    const { position, ...styleOnly } = built;
    try {
      let next = styleCaptions(doc, { ...styleOnly, clipId });
      if (position) next = positionCaptions(next, { anchor: position, offset: 0, clipId });
      onApplyDoc(next);
    } catch {
      /* ignore */
    }
  };

  // ---- karaoke (word-by-word highlight) ------------------------------------
  // Enabling ENSURES word timings: if captions already carry `words` we just flip
  // the flag via setKaraoke; otherwise (legacy captions without words) we rebuild
  // them from the transcript with karaoke on, so it "just works". Color/style
  // changes always go through setKaraoke. All via the undoable commit path.
  const setKaraokeNow = (opts: { enabled?: boolean; highlight?: string; style?: KaraokeStyle }, coalesceKey?: string) => {
    if (!captionsExist) return;
    try {
      onApplyDoc(setKaraoke(doc, { ...opts, clipId }), coalesceKey);
    } catch {
      /* no captions — guarded above, ignore */
    }
  };

  const toggleKaraoke = () => {
    if (s.karaokeOn) {
      setKaraokeNow({ enabled: false });
      return;
    }
    if (captionsExist && captionsHaveWords) {
      setKaraokeNow({ enabled: true, highlight: s.karaokeHighlight, style: s.karaokeStyle });
    } else if (transcript) {
      // (Re)build captions WITH per-word timings + karaoke on in one undoable step.
      try {
        onApplyDoc(addCaptions(doc, transcript, { karaoke: true, highlight: s.karaokeHighlight, karaokeStyle: s.karaokeStyle }));
      } catch {
        /* ignore */
      }
    }
  };

  const placeOnPreview = async () => {
    if (!captionsExist || !onBeginPlacement) return;
    setPlacing(true);
    try {
      const res = await onBeginPlacement("point", "Click the preview where the caption should sit");
      if (!res || res.points.length === 0) return;
      const p = res.points[0]!;
      onApplyDoc(placeCaptionsFree(doc, p.xFrac, p.yFrac, clipId));
    } finally {
      setPlacing(false);
    }
  };

  return (
    <section
      aria-label="Caption style"
      className="flex flex-col gap-3 rounded-lg border border-line bg-panel/40 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Caption style</span>
          <span className="text-[11px] text-faint">
            {captionsExist
              ? scoped
                ? "Styling the selected caption only."
                : "Styling every caption."
              : "Add captions to style them."}
          </span>
        </div>
        {selectedCaption && captionsExist && (
          <Toggle onClick={() => setThisOnly((v) => !v)} active={scoped} disabled={busy} title="Scope changes to the selected caption clip">
            This caption only
          </Toggle>
        )}
      </div>

      {/* Live preview chip — always visible so the look is obvious. */}
      <PreviewChip s={s} h={H} />

      {!captionsExist ? (
        <div className="flex flex-wrap items-center gap-2">
          {canAddCaptions && onAddCaptions ? (
            <>
              <button
                type="button"
                onClick={onAddCaptions}
                disabled={busy}
                className="shrink-0 rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add captions
              </button>
              <span className="text-[11px] text-faint">Burn in captions from the transcript, then style them here.</span>
            </>
          ) : (
            <span className="text-[11px] text-faint">
              Load the transcript first — then add captions and every control below styles them live.
            </span>
          )}
        </div>
      ) : (
        <>
          {/* Quick presets */}
          <Row label="presets">
            {PRESETS.map((p) => (
              <Toggle key={p.key} onClick={() => applyPreset(p)} disabled={busy} title={`Apply the “${p.label}” caption style`}>
                {p.label}
              </Toggle>
            ))}
          </Row>

          {/* Text style */}
          <Row label="font">
            <label className="flex shrink-0 items-center gap-1.5">
              <span className="sr-only">Caption font</span>
              <select
                value={s.fontFamily}
                disabled={busy}
                onChange={(e) => apply({ fontFamily: e.target.value })}
                aria-label="Caption font"
                className="h-8 shrink-0 rounded-md border border-line bg-elevated px-2 text-xs text-text disabled:opacity-40"
              >
                {(CAPTION_FONTS.includes(s.fontFamily) ? CAPTION_FONTS : [s.fontFamily, ...CAPTION_FONTS]).map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>
                    {fontLabel(f)}
                  </option>
                ))}
              </select>
            </label>
            <Slider
              label="Size"
              value={s.fontSize}
              min={Math.round(H * 0.02)}
              max={Math.round(H * 0.12)}
              step={1}
              disabled={busy}
              onChange={(v) => apply({ fontSize: v }, "cap-size")}
              format={(v) => `${Math.round(v)}px`}
              width="120px"
            />
            <Swatch label="Color" value={s.color} disabled={busy} onChange={(v) => apply({ color: v })} />
          </Row>

          <Row label="weight">
            <Toggle onClick={() => apply({ fontWeight: s.bold ? "normal" : "bold" })} active={s.bold} disabled={busy} title="Bold">
              <span className="font-bold">B</span> Bold
            </Toggle>
            <Toggle onClick={() => apply({ italic: !s.italic })} active={s.italic} disabled={busy} title="Italic">
              <span className="italic">I</span> Italic
            </Toggle>
            <Toggle onClick={() => apply({ uppercase: !s.uppercase })} active={s.uppercase} disabled={busy} title="Uppercase">
              AA Uppercase
            </Toggle>
            <span className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden />
            {ALIGNS.map((a) => (
              <Toggle key={a.key} onClick={() => apply({ align: a.key })} active={s.align === a.key} disabled={busy} title={a.label}>
                <span aria-hidden>{a.glyph}</span>
                <span className="sr-only">{a.label}</span>
              </Toggle>
            ))}
            <Slider
              label="Letter spacing"
              value={s.letterSpacing}
              min={-5}
              max={40}
              step={1}
              disabled={busy}
              onChange={(v) => apply({ letterSpacing: v }, "cap-ls")}
              format={(v) => `${Math.round(v)}px`}
              width="130px"
            />
          </Row>

          {/* Outline & shadow */}
          <Row label="outline">
            <Swatch label="Color" value={s.outlineColor} disabled={busy} onChange={(v) => apply({ outlineColor: v }, "cap-outline")} />
            <Slider
              label="Width"
              value={s.outlineWidth}
              min={0}
              max={Math.max(4, Math.round(H * 0.012))}
              step={1}
              disabled={busy}
              onChange={(v) => apply({ outlineWidth: v }, "cap-outline")}
              format={(v) => `${Math.round(v)}px`}
              width="120px"
            />
          </Row>

          <Row label="shadow">
            <Toggle
              onClick={() => apply({ shadow: s.shadowOn ? null : { color: s.shadowColor, blur: s.shadowBlur, offsetX: s.shadowOffsetX, offsetY: s.shadowOffsetY } })}
              active={s.shadowOn}
              disabled={busy}
              title="Drop shadow on/off"
            >
              {s.shadowOn ? "Shadow on" : "Shadow off"}
            </Toggle>
            {s.shadowOn && (
              <>
                <Swatch label="Color" value={s.shadowColor} disabled={busy} onChange={(v) => apply({ shadow: { color: v } }, "cap-shadow")} />
                <Slider label="Blur" value={s.shadowBlur} min={0} max={40} step={1} disabled={busy} onChange={(v) => apply({ shadow: { blur: v } }, "cap-shadow")} format={(v) => `${Math.round(v)}px`} width="110px" />
                <Slider label="Offset X" value={s.shadowOffsetX} min={-20} max={20} step={1} disabled={busy} onChange={(v) => apply({ shadow: { offsetX: v } }, "cap-shadow")} format={(v) => `${Math.round(v)}px`} width="110px" />
                <Slider label="Offset Y" value={s.shadowOffsetY} min={-20} max={20} step={1} disabled={busy} onChange={(v) => apply({ shadow: { offsetY: v } }, "cap-shadow")} format={(v) => `${Math.round(v)}px`} width="110px" />
              </>
            )}
          </Row>

          {/* Background panel */}
          <Row label="background">
            {(["none", "pill", "box"] as const).map((style) => (
              <Toggle
                key={style}
                onClick={() =>
                  apply(
                    style === "none"
                      ? { box: { style: "none" }, background: null }
                      : { box: { style, color: s.boxColor, opacity: s.boxOpacity, radius: s.boxRadius, padX: s.boxPadX, padY: s.boxPadY }, background: null },
                  )
                }
                active={s.boxStyle === style}
                disabled={busy}
                title={`Background: ${style}`}
              >
                {style === "none" ? "None" : style === "pill" ? "Pill" : "Box"}
              </Toggle>
            ))}
            {s.boxStyle !== "none" && (
              <>
                <Swatch label="Color" value={s.boxColor} disabled={busy} onChange={(v) => apply({ box: { color: v } }, "cap-box")} />
                <Slider label="Opacity" value={s.boxOpacity} min={0} max={1} step={0.05} disabled={busy} onChange={(v) => apply({ box: { opacity: v } }, "cap-box")} format={(v) => `${Math.round(v * 100)}%`} width="110px" />
                {s.boxStyle === "box" && (
                  <Slider label="Radius" value={s.boxRadius} min={0} max={40} step={1} disabled={busy} onChange={(v) => apply({ box: { radius: v } }, "cap-box")} format={(v) => `${Math.round(v)}px`} width="110px" />
                )}
                <Slider label="Pad X" value={s.boxPadX} min={0} max={Math.round(H * 0.06)} step={1} disabled={busy} onChange={(v) => apply({ box: { padX: v } }, "cap-box")} format={(v) => `${Math.round(v)}px`} width="110px" />
                <Slider label="Pad Y" value={s.boxPadY} min={0} max={Math.round(H * 0.04)} step={1} disabled={busy} onChange={(v) => apply({ box: { padY: v } }, "cap-box")} format={(v) => `${Math.round(v)}px`} width="110px" />
              </>
            )}
          </Row>

          {/* Position */}
          <Row label="position">
            {ANCHORS.map((a) => (
              <Toggle key={a.key} onClick={() => applyAnchor(a.key, a.key === s.position ? s.offset : 0)} active={s.position === a.key} disabled={busy} title={`Anchor ${a.label.toLowerCase()}`}>
                {a.label}
              </Toggle>
            ))}
            <Slider
              label="Offset"
              value={s.offset}
              min={-Math.round(H * 0.35)}
              max={Math.round(H * 0.35)}
              step={2}
              disabled={busy || s.position === "free"}
              onChange={(v) => applyAnchor(s.position === "free" ? "bottom" : s.position, v)}
              format={(v) => `${Math.round(v)}px`}
              width="150px"
            />
            {onBeginPlacement && (
              <Toggle onClick={() => void placeOnPreview()} active={placing || s.position === "free"} disabled={busy || placing} title="Click the preview to place the caption freely">
                {placing ? "Click the preview…" : "Place on preview"}
              </Toggle>
            )}
          </Row>

          {/* Karaoke (word-by-word highlight) */}
          <Row label="karaoke">
            <Toggle
              onClick={toggleKaraoke}
              active={s.karaokeOn}
              disabled={busy || (!s.karaokeOn && !captionsHaveWords && !transcript)}
              title="Highlight each word as it's spoken"
            >
              {s.karaokeOn ? "Karaoke on" : "Karaoke off"}
            </Toggle>
            {s.karaokeOn ? (
              <>
                <Swatch
                  label="Highlight"
                  value={s.karaokeHighlight}
                  disabled={busy}
                  onChange={(v) => setKaraokeNow({ highlight: v }, "cap-karaoke")}
                />
                <span className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden />
                {KARAOKE_STYLES.map((k) => (
                  <Toggle
                    key={k.key}
                    onClick={() => setKaraokeNow({ style: k.key })}
                    active={s.karaokeStyle === k.key}
                    disabled={busy}
                    title={`Highlight style: ${k.label}`}
                  >
                    {k.label}
                  </Toggle>
                ))}
              </>
            ) : (
              <span className="text-[11px] text-faint">
                {captionsHaveWords || transcript
                  ? "Highlight each word as it's spoken."
                  : "Load or transcribe the video first — karaoke needs word timings."}
              </span>
            )}
          </Row>
        </>
      )}
    </section>
  );
}
