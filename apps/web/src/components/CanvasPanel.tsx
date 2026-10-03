"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CANVAS_MAX,
  CANVAS_MIN,
  SAFE_ZONES,
  SOCIAL_MAGIC_SET,
  groupedPresets,
  parseRatio,
  ratioLabel,
  validateCanvasSize,
  type CanvasPreset,
  type CustomCanvasPreset,
  type EditDoc,
  type SafeZoneId,
} from "@cadence/core";
import { magicResize, magicTargets, resolveCanvasSize, setCanvasFit, setCanvasSize, withCanvasSettings, type MagicVariant } from "@cadence/director";
import {
  OPEN_CANVAS_EVENT,
  loadRecents,
  loadSavedSizes,
  pushRecent,
  setSafeZoneMode,
  storeSavedSizes,
  type RecentSize,
} from "@/lib/canvas-prefs";
import { useSafeZoneMode } from "./CanvasFit";

/**
 * The Canvas / Size panel (Canva "custom size" · CapCut "ratio" · Premiere sequence
 * settings). A non-modal side sheet so the preview stays visible while you size it:
 *
 *   Size   — type W×H or a ratio (21:9, 3:2, 1.91:1) with link-lock + rotate and live
 *            validation (even, 64–7680); how the picture adapts (Fill / Fit + blurred or
 *            solid bars); a platform preset list with live ratio thumbnails; saved custom
 *            sizes (browser + embedded in the project) and recents; safe-zone guides.
 *   Magic  — duplicate the project into many sizes → sibling projects (or files without a
 *            database) and export them all.
 *
 * Every change is a pure Director op (`setCanvasSize` / `setCanvasFit`) committed through
 * the editor's undoable history — the same code path the `set_canvas_size` tool runs.
 */

export interface CanvasPanelProps {
  doc: EditDoc;
  /** Commit a new doc through the editor's undoable history. */
  onApply: (doc: EditDoc) => void;
  /** Render + download one doc (Magic resize → export all). Resolves when finished. */
  onExportDoc?: (doc: EditDoc) => Promise<void>;
  /** Abort the export in flight (Stop). */
  onCancelExport?: () => void;
  canExport?: boolean;
}

type Tab = "size" | "magic";

// ---- small pieces -------------------------------------------------------------------

/** A live ratio thumbnail: the frame's true aspect, drawn inside a fixed square. */
export function RatioThumb({ width, height, box = 30, active }: { width: number; height: number; box?: number; active?: boolean }) {
  const k = Math.min(box / width, box / height);
  const w = Math.max(4, Math.round(width * k));
  const h = Math.max(4, Math.round(height * k));
  return (
    <span className="grid shrink-0 place-items-center" style={{ width: box, height: box }} aria-hidden="true">
      <span
        className={["block rounded-[3px] border", active ? "border-amber bg-amber/20" : "border-line bg-line-soft"].join(" ")}
        style={{ width: w, height: h }}
      />
    </span>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-lg border border-line bg-elevated p-1">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          onClick={() => onChange(o.key)}
          className={[
            "flex-1 rounded-md px-2 py-1 text-xs font-medium transition",
            o.key === value ? "bg-teal/15 text-teal" : "text-muted hover:text-text",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A mini diagram of how a 16:9 picture sits in a tall frame for each adaptation. */
function FitCard({
  kind,
  active,
  onClick,
  title,
  hint,
  tall,
}: {
  kind: "fill" | "blur" | "solid";
  active: boolean;
  onClick: () => void;
  title: string;
  hint: string;
  tall: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "flex flex-1 flex-col items-center gap-1.5 rounded-xl border p-2 text-center transition",
        active ? "border-amber/60 bg-amber/10" : "border-line bg-elevated hover:border-amber/30",
      ].join(" ")}
    >
      <span
        className="relative block overflow-hidden rounded-md border border-line bg-[#2a3236]"
        style={{ width: tall ? 30 : 46, height: tall ? 46 : 30 }}
        aria-hidden="true"
      >
        {kind === "blur" && <span className="absolute inset-0 bg-gradient-to-br from-teal/50 to-amber/40 blur-[3px]" />}
        {kind === "solid" && <span className="absolute inset-0 bg-black" />}
        <span
          className="absolute left-0 right-0 top-1/2 -translate-y-1/2 bg-gradient-to-r from-teal to-amber"
          style={kind === "fill" ? { top: 0, bottom: 0, transform: "none" } : { height: tall ? "36%" : "70%" }}
        />
      </span>
      <span className="text-[11px] font-semibold text-text">{title}</span>
      <span className="text-[10px] leading-tight text-faint">{hint}</span>
    </button>
  );
}

const inputCls =
  "w-full rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-sm tabular-nums text-text focus:border-amber/60 focus:outline-none";

// ---- the panel ----------------------------------------------------------------------

export function CanvasPanel({ doc, onApply, onExportDoc, onCancelExport, canExport }: CanvasPanelProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("size");
  const [wTxt, setWTxt] = useState(String(doc.meta.width));
  const [hTxt, setHTxt] = useState(String(doc.meta.height));
  const [ratioTxt, setRatioTxt] = useState("");
  const [linked, setLinked] = useState(doc.meta.canvas?.linked ?? true);
  const [relayout, setRelayout] = useState(true);
  const [query, setQuery] = useState("");
  const [saveName, setSaveName] = useState("");
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [saved, setSaved] = useState<CustomCanvasPreset[]>(() => loadSavedSizes(doc));
  const [recents, setRecents] = useState<RecentSize[]>([]);
  const lockRatio = useRef(doc.meta.width / doc.meta.height);
  const firstInput = useRef<HTMLInputElement>(null);
  const safeMode = useSafeZoneMode();

  const cv = doc.meta.canvas;
  const fit = cv?.fit === "fit" ? "fit" : "fill";
  const fill = cv?.fill ?? "blur";
  const fillColor = cv?.fillColor ?? "#000000";
  const blur = cv?.blur ?? 0.6;
  const W = doc.meta.width;
  const H = doc.meta.height;

  // Open from anywhere (top-bar chip, Deliver room, Director's magic_resize).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const t = (e as CustomEvent<{ tab?: Tab }>).detail?.tab;
      setTab(t === "magic" ? "magic" : "size");
      setOpen(true);
    };
    window.addEventListener(OPEN_CANVAS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CANVAS_EVENT, onOpen);
  }, []);

  // Seed the inputs from the live doc each time the panel opens or the size changes.
  useEffect(() => {
    setWTxt(String(W));
    setHTxt(String(H));
    lockRatio.current = W / H;
  }, [W, H, open]);

  useEffect(() => {
    if (!open) return;
    setSaved(loadSavedSizes(doc));
    setRecents(loadRecents());
    setMessage(null);
    const t = window.setTimeout(() => firstInput.current?.focus(), 30);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /** Apply a size change with the CURRENT adaptation choice (a per-change decision). */
  const apply = useCallback(
    (o: { width?: number; height?: number; ratio?: string; presetId?: string }) => {
      try {
        const r = setCanvasSize(doc, { ...o, fit, fill, fillColor, blur, relayout });
        onApply(r.doc);
        setRecents(pushRecent(r.width, r.height));
        setMessage({
          tone: "info",
          text: `Canvas set to ${r.width}×${r.height} (${ratioLabel(r.width, r.height)}).${r.notes.length ? " " + r.notes.join(" ") : ""}`,
        });
      } catch (err) {
        setMessage({ tone: "error", text: err instanceof Error ? err.message : "Couldn't set that size." });
      }
    },
    [doc, fit, fill, fillColor, blur, relayout, onApply],
  );

  const wNum = Number(wTxt);
  const hNum = Number(hTxt);
  const check = useMemo(() => validateCanvasSize(wNum, hNum), [wNum, hNum]);
  const dirty = check.ok && (check.width !== W || check.height !== H);
  const typed = wTxt.trim() !== "" && hTxt.trim() !== "";
  const wBad = typed && (!Number.isFinite(wNum) || wNum <= 0);
  const hBad = typed && (!Number.isFinite(hNum) || hNum <= 0);

  const onW = (v: string) => {
    const clean = v.replace(/[^\d]/g, "");
    setWTxt(clean);
    const n = Number(clean);
    if (linked && n > 0) setHTxt(String(Math.round(n / lockRatio.current)));
  };
  const onH = (v: string) => {
    const clean = v.replace(/[^\d]/g, "");
    setHTxt(clean);
    const n = Number(clean);
    if (linked && n > 0) setWTxt(String(Math.round(n * lockRatio.current)));
  };

  const ratioParsed = ratioTxt.trim() ? parseRatio(ratioTxt) : null;
  const ratioSize = useMemo(() => {
    if (!ratioParsed) return null;
    try {
      const r = resolveCanvasSize(doc, { ratio: ratioTxt.trim() });
      return { width: r.width, height: r.height };
    } catch {
      return null;
    }
  }, [doc, ratioParsed, ratioTxt]);

  const toggleLink = () => {
    const next = !linked;
    setLinked(next);
    if (next && wNum > 0 && hNum > 0) lockRatio.current = wNum / hNum;
    onApply(withCanvasSettings(doc, { linked: next }));
  };

  const rotate = () => apply({ width: H, height: W });

  const saveCurrent = () => {
    const name = saveName.trim() || `${W}×${H}`;
    const entry: CustomCanvasPreset = { id: `c${Date.now().toString(36)}`, name: name.slice(0, 60), width: W, height: H };
    const next = [entry, ...saved.filter((s) => !(s.width === W && s.height === H && s.name === entry.name))].slice(0, 24);
    setSaved(next);
    storeSavedSizes(next);
    onApply(withCanvasSettings(doc, { customPresets: next }));
    setSaveName("");
    setMessage({ tone: "info", text: `Saved “${entry.name}” (${W}×${H}) — kept in this browser and inside the project.` });
  };

  const removeSaved = (id: string) => {
    const next = saved.filter((s) => s.id !== id);
    setSaved(next);
    storeSavedSizes(next);
    if (doc.meta.canvas?.customPresets?.some((s) => s.id === id)) onApply(withCanvasSettings(doc, { customPresets: next }));
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupedPresets()
      .map((g) => ({
        ...g,
        presets: g.presets.filter(
          (p) => !q || `${g.platform} ${p.name} ${p.width}x${p.height} ${ratioLabel(p.width, p.height)}`.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.presets.length > 0);
  }, [query]);

  // ---- Magic resize -----------------------------------------------------------------

  const [picked, setPicked] = useState<Set<string>>(() => new Set(cv?.magicTargets ?? SOCIAL_MAGIC_SET));
  const [variants, setVariants] = useState<MagicVariant[]>([]);
  const [status, setStatus] = useState<Record<string, "pending" | "working" | "done" | "error">>({});
  const [busy, setBusy] = useState<null | "create" | "export">(null);
  const stop = useRef(false);

  // The Director's `magic_resize` queues ids on the doc — pick them up.
  useEffect(() => {
    if (cv?.magicTargets?.length) setPicked(new Set(cv.magicTargets));
  }, [cv?.magicTargets]);

  const togglePicked = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const build = (): MagicVariant[] => {
    const v = magicResize(doc, magicTargets([...picked]), { fit, fill });
    setVariants(v);
    setStatus(Object.fromEntries(v.map((x) => [x.id, "pending" as const])));
    return v;
  };

  const downloadJson = (v: MagicVariant) => {
    const blob = new Blob([JSON.stringify(v.doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(v.doc.meta.title || "cadence").replace(/[^\w.-]+/g, "-")}.editdoc.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  /** Sibling projects through the existing project APIs; falls back to .json files. */
  const createCopies = async () => {
    if (picked.size === 0) return;
    setBusy("create");
    const list = build();
    let made = 0;
    let dbDown = false;
    for (const v of list) {
      setStatus((s) => ({ ...s, [v.id]: "working" }));
      try {
        if (dbDown) throw new Error("db");
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: v.doc.meta.title.slice(0, 120) }),
        });
        const created = (await res.json().catch(() => null)) as { id?: string } | null;
        if (!res.ok || !created?.id) throw new Error("db");
        const saveRes = await fetch(`/api/projects/${created.id}/doc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: v.doc }),
        });
        if (!saveRes.ok) throw new Error("db");
        made++;
        setStatus((s) => ({ ...s, [v.id]: "done" }));
      } catch {
        dbDown = true;
        downloadJson(v);
        setStatus((s) => ({ ...s, [v.id]: "done" }));
      }
    }
    setBusy(null);
    setMessage({
      tone: "info",
      text: dbDown
        ? `No project database is connected, so ${list.length - made} ${list.length - made === 1 ? "copy was" : "copies were"} downloaded as .editdoc.json files (open them with ••• → Open project file).${made ? ` ${made} saved as projects.` : ""}`
        : `Created ${made} sibling projects — find them on your dashboard.`,
    });
  };

  const exportAll = async () => {
    if (!onExportDoc || picked.size === 0) return;
    setBusy("export");
    stop.current = false;
    const list = build();
    for (const v of list) {
      if (stop.current) break;
      setStatus((s) => ({ ...s, [v.id]: "working" }));
      try {
        await onExportDoc(v.doc);
        setStatus((s) => ({ ...s, [v.id]: stop.current ? "error" : "done" }));
      } catch {
        setStatus((s) => ({ ...s, [v.id]: "error" }));
      }
    }
    setBusy(null);
    setMessage({ tone: "info", text: stop.current ? "Stopped — the remaining sizes were skipped." : `Exported ${list.length} sizes.` });
  };

  if (!open) return null;

  const tall = H > W;
  const matchesPreset = (p: { width: number; height: number }) => p.width === W && p.height === H;

  const presetButton = (p: CanvasPreset) => (
    <li key={p.id}>
      <button
        type="button"
        onClick={() => apply({ presetId: p.id })}
        aria-current={matchesPreset(p) ? "true" : undefined}
        className={[
          "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition",
          matchesPreset(p) ? "bg-amber/10 ring-1 ring-amber/40" : "hover:bg-elevated",
        ].join(" ")}
      >
        <RatioThumb width={p.width} height={p.height} active={matchesPreset(p)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-text">{p.name}</span>
          <span className="block text-[10px] tabular-nums text-faint">
            {p.width}×{p.height} · {ratioLabel(p.width, p.height)}
            {p.note ? ` · ${p.note}` : ""}
          </span>
        </span>
      </button>
    </li>
  );

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="Canvas and size"
      data-testid="canvas-panel"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l border-line bg-panel shadow-[-16px_0_44px_-24px_rgba(24,34,38,0.32)]"
    >
      <header className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
        <RatioThumb width={W} height={H} box={34} active />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text">Canvas &amp; size</h2>
          <p className="text-[11px] tabular-nums text-muted" data-testid="canvas-current">
            {W}×{H} · {cv?.ratio ?? ratioLabel(W, H)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close canvas panel"
          className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>

      <div className="px-4 pt-3">
        <Segmented
          label="Canvas section"
          value={tab}
          options={[
            { key: "size", label: "Size" },
            { key: "magic", label: "Magic resize" },
          ]}
          onChange={setTab}
        />
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {message && (
          <p
            role={message.tone === "error" ? "alert" : "status"}
            className={[
              "rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug",
              message.tone === "error" ? "border-danger/30 bg-danger/5 text-danger" : "border-amber/30 bg-amber/5 text-amber-deep",
            ].join(" ")}
          >
            {message.text}
          </p>
        )}

        {tab === "size" ? (
          <>
            {/* ---- Custom size ---- */}
            <section aria-label="Custom size">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">Custom size</h3>
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (check.ok) apply({ width: check.width, height: check.height });
                }}
              >
                <label className="min-w-0 flex-1 text-[10px] text-faint">
                  Width (px)
                  <input
                    ref={firstInput}
                    value={wTxt}
                    onChange={(e) => onW(e.target.value)}
                    inputMode="numeric"
                    aria-label="Canvas width in pixels"
                    aria-invalid={wBad}
                    className={`${inputCls} mt-1`}
                  />
                </label>
                <button
                  type="button"
                  onClick={toggleLink}
                  aria-pressed={linked}
                  aria-label={linked ? "Ratio locked — click to unlock" : "Ratio unlocked — click to lock"}
                  title={linked ? "Ratio locked" : "Ratio unlocked"}
                  className={[
                    "mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition",
                    linked ? "border-amber/50 bg-amber/10 text-amber" : "border-line bg-elevated text-faint hover:text-text",
                  ].join(" ")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {linked ? <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /> : <path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h2M14 12h2" />}
                  </svg>
                </button>
                <label className="min-w-0 flex-1 text-[10px] text-faint">
                  Height (px)
                  <input
                    value={hTxt}
                    onChange={(e) => onH(e.target.value)}
                    inputMode="numeric"
                    aria-label="Canvas height in pixels"
                    aria-invalid={hBad}
                    className={`${inputCls} mt-1`}
                  />
                </label>
                <button
                  type="button"
                  onClick={rotate}
                  aria-label="Rotate — swap portrait and landscape"
                  title="Rotate (swap width and height)"
                  className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-elevated text-muted transition hover:text-text"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg>
                </button>
                <button
                  type="submit"
                  disabled={!check.ok || !dirty}
                  className="mb-0.5 h-8 shrink-0 rounded-lg bg-amber px-3 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Apply
                </button>
              </form>
              <p className="mt-1.5 min-h-[16px] text-[10px] leading-snug text-faint" aria-live="polite" data-testid="canvas-hint">
                {!typed
                  ? `Even sizes, ${CANVAS_MIN}–${CANVAS_MAX}px.`
                  : !check.ok
                    ? "Enter positive numbers for both sides."
                    : check.issues.length > 0
                      ? `${check.issues.join(" ")} → ${check.width}×${check.height} (${ratioLabel(check.width, check.height)})`
                      : `${check.width}×${check.height} · ${ratioLabel(check.width, check.height)}`}
              </p>

              <form
                className="mt-3 flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (ratioParsed) {
                    apply({ ratio: ratioTxt.trim() });
                    setRatioTxt("");
                  }
                }}
              >
                <label className="min-w-0 flex-1 text-[10px] text-faint">
                  …or a ratio (21:9 · 3:2 · 7:5 · 1.91:1)
                  <input
                    value={ratioTxt}
                    onChange={(e) => setRatioTxt(e.target.value)}
                    placeholder="e.g. 21:9"
                    aria-label="Canvas ratio"
                    aria-invalid={!!ratioTxt.trim() && !ratioParsed}
                    className={`${inputCls} mt-1`}
                  />
                </label>
                <button
                  type="submit"
                  disabled={!ratioParsed}
                  className="mb-0.5 h-8 shrink-0 rounded-lg border border-line bg-elevated px-3 text-xs font-semibold text-text transition hover:border-amber/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {ratioSize ? `Set ${ratioSize.width}×${ratioSize.height}` : "Set ratio"}
                </button>
              </form>
              {ratioTxt.trim() && !ratioParsed && (
                <p className="mt-1 text-[10px] text-danger" role="alert">Not a usable ratio — try 21:9, 3:2 or 1.91:1.</p>
              )}

              <div className="mt-3 flex items-center gap-2">
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder={`Name this size (${W}×${H})`}
                  aria-label="Name for saved size"
                  maxLength={60}
                  className={`${inputCls} flex-1`}
                />
                <button
                  type="button"
                  onClick={saveCurrent}
                  className="h-8 shrink-0 rounded-lg border border-line bg-elevated px-3 text-xs font-semibold text-text transition hover:border-amber/40"
                >
                  Save size
                </button>
              </div>
            </section>

            {/* ---- Adaptation ---- */}
            <section aria-label="How the picture fits">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">When the ratio changes</h3>
              <div className="flex gap-2">
                <FitCard kind="fill" tall={tall} active={fit === "fill"} title="Fill" hint="Crop to cover" onClick={() => onApply(setCanvasFit(doc, { fit: "fill" }))} />
                <FitCard kind="blur" tall={tall} active={fit === "fit" && fill === "blur"} title="Fit · blur" hint="Whole picture, blurred bars" onClick={() => onApply(setCanvasFit(doc, { fit: "fit", fill: "blur" }))} />
                <FitCard kind="solid" tall={tall} active={fit === "fit" && fill === "solid"} title="Fit · color" hint="Whole picture, solid bars" onClick={() => onApply(setCanvasFit(doc, { fit: "fit", fill: "solid" }))} />
              </div>
              <p className="mt-1.5 text-[10px] leading-snug text-faint">Never stretched — pictures keep their shape. Applies to your footage and photos, in the preview and the export.</p>
              {fit === "fit" && fill === "solid" && (
                <label className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                  Bar color
                  <input
                    type="color"
                    value={fillColor}
                    onChange={(e) => onApply(setCanvasFit(doc, { fit: "fit", fill: "solid", fillColor: e.target.value }))}
                    aria-label="Bar color"
                    className="h-7 w-10 cursor-pointer rounded border border-line bg-elevated"
                  />
                  <span className="tabular-nums text-faint">{fillColor}</span>
                </label>
              )}
              {fit === "fit" && fill === "blur" && (
                <label className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                  Blur
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={blur}
                    onChange={(e) => onApply(setCanvasFit(doc, { fit: "fit", fill: "blur", blur: Number(e.target.value) }))}
                    aria-label="Background blur strength"
                    className="scrubber flex-1"
                  />
                </label>
              )}
              <label className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                <input type="checkbox" checked={relayout} onChange={(e) => setRelayout(e.target.checked)} className="accent-[var(--color-amber)]" />
                Re-layout text &amp; overlays to the new frame
              </label>
            </section>

            {/* ---- Safe zones ---- */}
            <section aria-label="Safe zones">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">Safe-zone guides</h3>
              <Segmented<SafeZoneId>
                label="Safe-zone guide"
                value={safeMode}
                options={[{ key: "off", label: "Off" }, ...SAFE_ZONES.map((z) => ({ key: z.id, label: z.label.replace(" UI", "").replace(" (90%)", "") }))]}
                onChange={setSafeZoneMode}
              />
              <p className="mt-1.5 text-[10px] leading-snug text-faint">
                {SAFE_ZONES.find((z) => z.id === safeMode)?.note ?? "Overlay on the preview showing where platform buttons and captions cover the picture. Never exported."}
              </p>
            </section>

            {/* ---- Saved + recents ---- */}
            {(saved.length > 0 || recents.length > 0) && (
              <section aria-label="Saved and recent sizes">
                {saved.length > 0 && (
                  <>
                    <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Your sizes</h3>
                    <ul className="mb-3 space-y-0.5">
                      {saved.map((s) => (
                        <li key={s.id} className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => apply({ width: s.width, height: s.height })}
                            className={["flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition", matchesPreset(s) ? "bg-amber/10 ring-1 ring-amber/40" : "hover:bg-elevated"].join(" ")}
                          >
                            <RatioThumb width={s.width} height={s.height} active={matchesPreset(s)} />
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-medium text-text">{s.name}</span>
                              <span className="block text-[10px] tabular-nums text-faint">{s.width}×{s.height} · {ratioLabel(s.width, s.height)}</span>
                            </span>
                          </button>
                          <button type="button" onClick={() => removeSaved(s.id)} aria-label={`Delete saved size ${s.name}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-faint transition hover:bg-danger/10 hover:text-danger">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {recents.length > 0 && (
                  <>
                    <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Recent</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {recents.map((r) => (
                        <button
                          key={`${r.width}x${r.height}`}
                          type="button"
                          onClick={() => apply({ width: r.width, height: r.height })}
                          className="flex items-center gap-1.5 rounded-full border border-line bg-elevated px-2 py-1 text-[11px] tabular-nums text-muted transition hover:border-amber/40 hover:text-text"
                        >
                          <RatioThumb width={r.width} height={r.height} box={14} />
                          {r.width}×{r.height}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </section>
            )}

            {/* ---- Presets ---- */}
            <section aria-label="Presets">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-faint">Presets</h3>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search — tiktok, 4:5, a4…"
                  aria-label="Search size presets"
                  className="ml-auto w-44 rounded-lg border border-line bg-elevated px-2 py-1 text-xs text-text focus:border-amber/60 focus:outline-none"
                />
              </div>
              {groups.length === 0 && <p className="text-xs text-faint">No preset matches “{query}”.</p>}
              {groups.map((g) => (
                <div key={g.platform} className="mb-2">
                  <h4 className="px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">{g.platform}</h4>
                  <ul>{g.presets.map(presetButton)}</ul>
                </div>
              ))}
            </section>
          </>
        ) : (
          <section aria-label="Magic resize">
            <p className="mb-3 text-[11px] leading-snug text-muted">
              Duplicate this project into several sizes at once. Each copy keeps your edit and re-lays text for its frame, using the
              current fit ({fit === "fit" ? `Fit · ${fill === "blur" ? "blurred bars" : "solid bars"}` : "Fill"}).
            </p>
            <div className="mb-2 flex items-center gap-2 text-[11px]">
              <button type="button" onClick={() => setPicked(new Set(SOCIAL_MAGIC_SET))} className="rounded-full border border-line bg-elevated px-2.5 py-1 text-muted transition hover:text-text">Social set</button>
              <button type="button" onClick={() => setPicked(new Set())} className="rounded-full border border-line bg-elevated px-2.5 py-1 text-muted transition hover:text-text">Clear</button>
              <span className="ml-auto tabular-nums text-faint" data-testid="magic-count">{picked.size} selected</span>
            </div>
            {groupedPresets().map((g) => (
              <div key={g.platform} className="mb-1.5">
                <h4 className="px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">{g.platform}</h4>
                <ul>
                  {g.presets.map((p) => (
                    <li key={p.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 transition hover:bg-elevated">
                        <input type="checkbox" checked={picked.has(p.id)} onChange={() => togglePicked(p.id)} className="accent-[var(--color-amber)]" />
                        <RatioThumb width={p.width} height={p.height} box={22} active={picked.has(p.id)} />
                        <span className="min-w-0 flex-1 truncate text-xs text-text">{p.name}</span>
                        <span className="text-[10px] tabular-nums text-faint">{p.width}×{p.height}</span>
                        {status[p.id] && (
                          <span className="text-[10px] text-amber-bright" data-testid={`magic-status-${p.id}`}>
                            {status[p.id] === "working" ? "…" : status[p.id] === "done" ? "✓" : status[p.id] === "error" ? "!" : "·"}
                          </span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="sticky bottom-0 -mx-4 mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft bg-panel px-4 py-3">
              <button
                type="button"
                onClick={() => void createCopies()}
                disabled={picked.size === 0 || busy !== null}
                className="rounded-lg border border-line bg-elevated px-3 py-1.5 text-xs font-semibold text-text transition hover:border-amber/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "create" ? "Creating…" : `Create ${picked.size} copies`}
              </button>
              <button
                type="button"
                onClick={() => void exportAll()}
                disabled={picked.size === 0 || busy !== null || !onExportDoc || !canExport}
                className="rounded-lg bg-amber px-3 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "export" ? "Exporting…" : `Export all ${picked.size}`}
              </button>
              {busy === "export" && (
                <button
                  type="button"
                  onClick={() => {
                    stop.current = true;
                    onCancelExport?.();
                  }}
                  className="rounded-lg border border-danger/30 px-3 py-1.5 text-xs font-semibold text-danger transition hover:bg-danger/10"
                >
                  Stop
                </button>
              )}
              {variants.length > 0 && busy === null && (
                <button type="button" onClick={() => variants.forEach(downloadJson)} className="text-[11px] text-muted underline-offset-2 hover:text-text hover:underline">
                  Download as files
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
