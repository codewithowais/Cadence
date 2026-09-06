"use client";

import { useRef, useState } from "react";
import type { EditDoc, MediaAsset, TransitionType } from "@cadence/core";
import { addCallout, addCursor, buildDemo, typeText } from "@cadence/director";
import type { BeginPlacement } from "@/lib/placement";

// ---- small shared controls (match RoomPanel / TranscriptRoom tokens) --------

function Pill({
  onClick,
  disabled,
  active,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-[92px] shrink-0 text-[10px] uppercase tracking-wider text-faint">{label}</span>
      {children}
    </div>
  );
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

const TRANSITIONS: { value: TransitionType; label: string }[] = [
  { value: "crossfade", label: "Crossfade" },
  { value: "dissolve", label: "Dissolve" },
  { value: "slide", label: "Slide" },
  { value: "wipe", label: "Wipe" },
  { value: "zoom", label: "Zoom" },
  { value: "dip-to-black", label: "Dip to black" },
  { value: "smooth", label: "Smooth" },
];

interface DemoRoomProps {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  /** Current playhead time — annotations are seeded to land where the user looks. */
  timeSec: number;
  /** Undoable commit path (same pure-fn pattern as the other rooms). */
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  /** Add files (screenshots become image media). */
  onFiles: (files: File[]) => void;
  /** Reorder a screen (image media) earlier/later. */
  onReorderMedia: (mediaId: string, dir: "up" | "down") => void;
  /** Arm an on-preview placement gesture; resolves with composition fractions. */
  onBeginPlacement?: BeginPlacement;
}

/**
 * Walkthrough / Demo room — the manual surface for the interaction-demo engine
 * (`buildDemo` + `addCursor` / `typeText` / `addCallout`), which previously had no
 * UI and was reachable only by chat. Screens are the project's image media, in
 * order. The headline UX is VISUAL placement: because a screenshot carries no
 * field pixels, every annotation is positioned by clicking / dragging on the live
 * preview (via `onBeginPlacement`), then committed through a pure fn — undoable and
 * rendered everywhere the other clip kinds are.
 */
export function DemoRoom({
  doc,
  mediaList,
  busy,
  timeSec,
  onApplyDoc,
  onFiles,
  onReorderMedia,
  onBeginPlacement,
}: DemoRoomProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const screens = mediaList.filter((m) => m.kind === "image");

  const W = doc.meta.width;
  const H = doc.meta.height;

  // Build options.
  const [perScreenSec, setPerScreenSec] = useState(3.5);
  const [transition, setTransition] = useState<TransitionType>("crossfade");
  const [seedLogin, setSeedLogin] = useState(false);

  // Manual-primitive drafts.
  const [typeDraft, setTypeDraft] = useState("");
  const [maskText, setMaskText] = useState(false);
  const [calloutLabel, setCalloutLabel] = useState("");
  const [calloutDim, setCalloutDim] = useState(true);
  const [calloutZoom, setCalloutZoom] = useState(false);

  // Which gesture (if any) is currently armed, so we can disable the palette.
  const [placing, setPlacing] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const placementReady = !!onBeginPlacement;

  const openPicker = () => fileRef.current?.click();

  function build() {
    if (screens.length === 0) return;
    try {
      const next = buildDemo(screens, {
        perScreenSec,
        transition,
        transitionSec: 0.5,
        login: seedLogin,
      });
      onApplyDoc(next);
      setNote({
        tone: "ok",
        text: `Built a ${screens.length}-screen walkthrough${seedLogin ? " with a seeded login" : ""}. Now annotate a screen below — click / drag on the preview to place it. Undo any time.`,
      });
    } catch (err) {
      setNote({ tone: "warn", text: err instanceof Error ? err.message : "Couldn't build the walkthrough." });
    }
  }

  async function placeType() {
    if (!onBeginPlacement) return;
    const text = typeDraft.trim();
    if (!text) return;
    setPlacing("type");
    const res = await onBeginPlacement("point", "Click where the text should type");
    setPlacing(null);
    if (!res || res.points.length === 0) return;
    const shown = maskText ? "•".repeat([...text].length) : text;
    const p = res.points[0]!;
    onApplyDoc(
      typeText(doc, {
        text: shown,
        x: round(p.xFrac * W),
        y: round(p.yFrac * H),
        atSec: round(Math.max(0, timeSec)),
        background: "#12151ccc",
      }),
    );
    setTypeDraft("");
    setNote({ tone: "ok", text: "Added a typewriter line. Fine-tune its timing on the timeline. Undo any time." });
  }

  async function placeCursor() {
    if (!onBeginPlacement) return;
    setPlacing("cursor");
    const res = await onBeginPlacement("path", "Click cursor waypoints — the last one is the click");
    setPlacing(null);
    if (!res || res.points.length === 0) return;
    const start = round(Math.max(0, timeSec));
    const waypoints = res.points.map((pt, i) => ({
      x: round(pt.xFrac * W),
      y: round(pt.yFrac * H),
      atSec: round(start + i * 0.8),
    }));
    const clickAt = round(start + (res.points.length - 1) * 0.8 + 0.1);
    onApplyDoc(addCursor(doc, { waypoints, clicks: [clickAt], start }));
    setNote({ tone: "ok", text: `Added a cursor path (${waypoints.length} point${waypoints.length === 1 ? "" : "s"}) ending in a click. Undo any time.` });
  }

  async function placeCallout() {
    if (!onBeginPlacement) return;
    setPlacing("callout");
    const res = await onBeginPlacement("rect", "Drag a box over the UI element to highlight");
    setPlacing(null);
    if (!res || !res.rect) return;
    const r = res.rect;
    onApplyDoc(
      addCallout(doc, {
        x: round(r.xFrac * W),
        y: round(r.yFrac * H),
        w: round(r.wFrac * W),
        h: round(r.hFrac * H),
        label: calloutLabel.trim() || undefined,
        dim: calloutDim,
        zoom: calloutZoom ? 1.4 : undefined,
        atSec: round(Math.max(0, timeSec)),
      }),
    );
    setCalloutLabel("");
    setNote({ tone: "ok", text: "Drew a callout box. Toggle dim / zoom before drawing the next one. Undo any time." });
  }

  const hiddenInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      onChange={(e) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        if (files.length) onFiles(files);
        e.target.value = "";
      }}
    />
  );

  // ---- empty state ---------------------------------------------------------
  if (screens.length === 0) {
    return (
      <Wrap>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text">Add screenshots to build a walkthrough.</p>
          <p className="max-w-[640px] text-xs text-faint">
            Turn a set of app / UI screenshots into an animated interaction demo: each
            screenshot becomes a screen, screens are sequenced with a transition, and you
            place a moving cursor, typed text, and highlight callouts by clicking and
            dragging directly on the preview.
          </p>
          <div className="flex items-center gap-2">
            <Pill onClick={openPicker} disabled={busy}>+ Upload screenshots</Pill>
          </div>
        </div>
        {hiddenInput}
      </Wrap>
    );
  }

  return (
    <Wrap>
      {/* Screens (image media, in order) */}
      <Row label="screens">
        {screens.map((m, i) => (
          <span
            key={m.id}
            title={m.label ?? m.src}
            className="flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated py-1 pl-2 pr-1 text-xs text-muted"
          >
            <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-panel text-[9px] tabular-nums text-faint">{i + 1}</span>
            <span className="truncate">{m.label ?? m.src}</span>
            <span className="ml-0.5 flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => onReorderMedia(m.id, "up")}
                disabled={busy || i === 0}
                aria-label={`Move screen ${i + 1} earlier`}
                title="Move earlier"
                className="grid h-6 w-6 place-items-center rounded-md text-faint transition hover:bg-line hover:text-text disabled:opacity-30"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <button
                type="button"
                onClick={() => onReorderMedia(m.id, "down")}
                disabled={busy || i === screens.length - 1}
                aria-label={`Move screen ${i + 1} later`}
                title="Move later"
                className="grid h-6 w-6 place-items-center rounded-md text-faint transition hover:bg-line hover:text-text disabled:opacity-30"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </span>
          </span>
        ))}
        <Pill onClick={openPicker} disabled={busy}>+ Add screens</Pill>
      </Row>

      {/* Build controls */}
      <Row label="build">
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
          <span className="text-[10px] uppercase tracking-wider text-faint">Seconds / screen</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPerScreenSec((s) => Math.max(1, round(s - 0.5)))}
              disabled={busy || perScreenSec <= 1}
              aria-label="Fewer seconds per screen"
              className="grid h-6 w-6 place-items-center rounded-md border border-line bg-panel text-muted transition hover:text-text disabled:opacity-30"
            >
              −
            </button>
            <span className="w-10 text-center tabular-nums text-xs text-muted">{perScreenSec.toFixed(1)}s</span>
            <button
              type="button"
              onClick={() => setPerScreenSec((s) => Math.min(15, round(s + 0.5)))}
              disabled={busy || perScreenSec >= 15}
              aria-label="More seconds per screen"
              className="grid h-6 w-6 place-items-center rounded-md border border-line bg-panel text-muted transition hover:text-text disabled:opacity-30"
            >
              +
            </button>
          </span>
        </label>
        <label className="flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-faint">Transition</span>
          <select
            value={transition}
            disabled={busy}
            onChange={(e) => setTransition(e.target.value as TransitionType)}
            aria-label="Transition between screens"
            className="rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-text disabled:opacity-40"
          >
            {TRANSITIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <Pill onClick={() => setSeedLogin((v) => !v)} disabled={busy} active={seedLogin} title="Seed a typed email + password then a button click on screen 1">
          {seedLogin ? "Login interaction: on" : "Seed login interaction"}
        </Pill>
        <button
          type="button"
          onClick={build}
          disabled={busy || screens.length === 0}
          className="shrink-0 rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          Build walkthrough
        </button>
      </Row>
      <p className="text-[11px] text-faint">
        Build assembles the screens into the base walkthrough (this replaces the current timeline). Add cursor / text / callouts <em>after</em> building — those layer on top and survive.
      </p>

      {/* Manual primitives — each placed visually on the preview */}
      <div className="mt-1 flex flex-col gap-2 rounded-lg border border-line bg-panel/40 p-3">
        <span className="text-[10px] uppercase tracking-wider text-faint">Annotate — place on the preview</span>
        {!placementReady && (
          <p className="text-[11px] text-amber-bright">On-preview placement isn&apos;t available here.</p>
        )}

        {/* Type text */}
        <Row label="type text">
          <input
            type="text"
            value={typeDraft}
            onChange={(e) => setTypeDraft(e.target.value)}
            placeholder="Text to type into a field…"
            aria-label="Text to type"
            className="min-w-[180px] flex-1 rounded-lg border border-line bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-faint"
          />
          <Pill onClick={() => setMaskText((v) => !v)} disabled={busy} active={maskText} title="Show the text as password dots (•)">
            {maskText ? "Masked ••" : "Mask password"}
          </Pill>
          <Pill onClick={placeType} disabled={busy || !placementReady || !typeDraft.trim() || placing === "type"}>
            {placing === "type" ? "Click the preview…" : "+ Type here"}
          </Pill>
        </Row>

        {/* Cursor / click */}
        <Row label="cursor">
          <Pill onClick={placeCursor} disabled={busy || !placementReady || placing === "cursor"}>
            {placing === "cursor" ? "Click waypoints…" : "+ Cursor / click"}
          </Pill>
          <span className="text-[11px] text-faint">Click one or more points on the preview; the last point becomes the click.</span>
        </Row>

        {/* Callout */}
        <Row label="callout">
          <input
            type="text"
            value={calloutLabel}
            onChange={(e) => setCalloutLabel(e.target.value)}
            placeholder="Label (optional)…"
            aria-label="Callout label"
            className="min-w-[140px] flex-1 rounded-lg border border-line bg-elevated px-3 py-1.5 text-sm text-text placeholder:text-faint"
          />
          <Pill onClick={() => setCalloutDim((v) => !v)} disabled={busy} active={calloutDim}>Dim background</Pill>
          <Pill onClick={() => setCalloutZoom((v) => !v)} disabled={busy} active={calloutZoom}>Zoom to it</Pill>
          <Pill onClick={placeCallout} disabled={busy || !placementReady || placing === "callout"}>
            {placing === "callout" ? "Drag a box…" : "+ Callout"}
          </Pill>
        </Row>
      </div>

      {note && (
        <p className={note.tone === "ok" ? "text-[11px] text-teal" : "text-[11px] text-amber-bright"}>{note.text}</p>
      )}

      {hiddenInput}
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div aria-label="Demo" className="flex max-h-full flex-col gap-2 overflow-y-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      {children}
    </div>
  );
}
