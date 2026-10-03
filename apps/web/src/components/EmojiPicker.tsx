"use client";

/**
 * EMOJI — the full Unicode emoji picker (3,000+ with skin tones) plus animated
 * reaction packs, and an inspector that keeps every inserted emoji editable.
 *
 *  - category tabs (Recent · Favorites · 9 Unicode groups), search by name/keyword,
 *    skin tones, recents + favorites (persisted, try/catch localStorage)
 *  - a VIRTUALIZED grid: only the rows in view are mounted (≈100 cells of 3,000+),
 *    sprites load lazily from /emoji/<hex>.svg — the same Twemoji art the preview,
 *    the node renderer and the export draw, so what you pick is what exports
 *  - click adds at the playhead; drag onto the Stage (or any drop target that reads
 *    `application/x-cadence-emoji`, see docs/agents/emoji-cycle-j.md)
 *  - "Reaction packs" mode: 🔥 burst, ❤️ float-up, 👏 clap spam, 😂 shake, confetti,
 *    sparkles, hearts pop — with any emoji you choose
 * Every insert is a PURE op from @cadence/director applied through the editor's
 * undoable commit, so the Director (`add_emoji` / `add_reaction`) and the UI edit alike.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  EMOJI_CATALOG,
  EMOJI_DRAG_MIME,
  EMOJI_GROUPS,
  SKIN_TONES,
  emojiSpriteName,
  emojiTotal,
  emojiWithTone,
  encodeEmojiDrag,
  findEmojiEntry,
  pushRecent,
  searchEmoji,
  toggleFavorite,
  type EditDoc,
  type EmojiEntry,
  type SkinTone,
} from "@cadence/core";
import {
  EMOJI_EXITS,
  EMOJI_INTROS,
  EMOJI_LOOPS,
  EMOJI_POSITIONS,
  REACTION_PACKS,
  editEmoji,
  emojiGroups,
  findEmojiGroup,
  type EditEmojiPatch,
  type EmojiPosition,
} from "@cadence/director";
import { insertEmojiPayload } from "@/lib/emoji-insert";
import { preloadEmoji } from "@/lib/emoji-assets";

const CELL = 40;
const HEAD_H = 28;
const GROUP_ICONS = ["😀", "👋", "🐻", "🍔", "🌍", "⚽", "💡", "🔣", "🏁"];
const LS = { recents: "cadence:emoji:recents", favs: "cadence:emoji:favorites", tone: "cadence:emoji:tone", mode: "cadence:emoji:mode" } as const;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const titleCase = (s: string): string => s.replace(/(^|[\s-])(\w)/g, (_m, p, c) => `${p}${c.toUpperCase()}`);

// ---- persistence (never throws) -------------------------------------------------------

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private window / blocked) */
  }
}
function usePersisted<T>(key: string, initial: T, valid?: (v: unknown) => boolean): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    const saved = readLS<unknown>(key, initial);
    if (!valid || valid(saved)) setV(saved as T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T | ((p: T) => T)) => {
      setV((prev) => {
        const nv = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        writeLS(key, nv);
        return nv;
      });
    },
    [key],
  );
  return [v, set];
}

// ---- sprite ----------------------------------------------------------------------------

function Sprite({ emoji, size, className }: { emoji: string; size: number; className?: string }) {
  const names = useMemo(() => emojiSpriteName(emoji), [emoji]);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [emoji]);
  if (i >= names.length) {
    return (
      <span aria-hidden="true" style={{ fontSize: size * 0.85, lineHeight: 1 }} className={className}>
        {emoji}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/emoji/${names[i]}.svg`}
      width={size}
      height={size}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => setI((n) => n + 1)}
      className={className}
    />
  );
}

// ---- virtual rows -----------------------------------------------------------------------

type Row =
  | { k: "head"; label: string; tab: string; top: number; h: number }
  | { k: "cells"; items: EmojiEntry[]; start: number; top: number; h: number }
  | { k: "note"; text: string; top: number; h: number };

interface View {
  rows: Row[];
  total: number;
  flat: EmojiEntry[];
  tabTops: Record<string, number>;
}

function buildView(opts: { cols: number; query: string; recents: string[]; favs: string[] }): View {
  const { cols, query, recents, favs } = opts;
  const rows: Row[] = [];
  const flat: EmojiEntry[] = [];
  const tabTops: Record<string, number> = {};
  let top = 0;
  const head = (label: string, tab: string): void => {
    if (!(tab in tabTops)) tabTops[tab] = top;
    rows.push({ k: "head", label, tab, top, h: HEAD_H });
    top += HEAD_H;
  };
  const cells = (items: EmojiEntry[]): void => {
    for (let i = 0; i < items.length; i += cols) {
      const slice = items.slice(i, i + cols);
      rows.push({ k: "cells", items: slice, start: flat.length, top, h: CELL });
      flat.push(...slice);
      top += CELL;
    }
  };
  if (query.trim()) {
    const hits = searchEmoji(query, 240);
    if (hits.length === 0) {
      rows.push({ k: "note", text: `No emoji match “${query.trim()}”. Try “heart”, “fire” or “party”.`, top, h: 48 });
      top += 48;
    } else {
      head(`${hits.length} result${hits.length === 1 ? "" : "s"}`, "search");
      cells(hits);
    }
    return { rows, total: top, flat, tabTops };
  }
  const resolve = (list: string[]): EmojiEntry[] => list.map((e) => findEmojiEntry(e)).filter((e): e is EmojiEntry => !!e);
  const rec = resolve(recents);
  const fav = resolve(favs);
  if (rec.length) {
    head("Recently used", "recent");
    cells(rec);
  }
  if (fav.length) {
    head("Favorites", "fav");
    cells(fav);
  }
  let lastSub = "";
  let lastGroup = -1;
  const byGroup: EmojiEntry[][] = EMOJI_GROUPS.map(() => []);
  for (const e of EMOJI_CATALOG) byGroup[e.group]!.push(e);
  byGroup.forEach((list, g) => {
    // Subgroup headings inside each group (group tab jumps to the first one).
    let run: EmojiEntry[] = [];
    const flush = (): void => {
      if (!run.length) return;
      const first = run[0]!;
      const tab = lastGroup !== g ? `g${g}` : `g${g}.${first.subgroup}`;
      head(titleCase(first.subgroup.replace(/-/g, " ")), tab);
      lastGroup = g;
      cells(run);
      run = [];
    };
    for (const e of list) {
      if (e.subgroup !== lastSub) flush();
      lastSub = e.subgroup;
      run.push(e);
    }
    flush();
  });
  return { rows, total: top, flat, tabTops };
}

/** Index of the first row whose bottom is below `y` (binary search over cumulative tops). */
function firstRowAt(rows: Row[], y: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.top + rows[mid]!.h <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---- the picker --------------------------------------------------------------------------

export interface EmojiPickerProps {
  doc: EditDoc;
  busy: boolean;
  timeSec: number;
  selectedClipId?: string | null;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  onSelectClip?: (id: string | null) => void;
  onSeek?: (t: number) => void;
  /** A shorter grid (used inside the Text room's style gallery). */
  compact?: boolean;
}

type Mode = "single" | "reaction";

export function EmojiPicker(props: EmojiPickerProps) {
  const { doc, busy, timeSec, selectedClipId, onApplyDoc, onSelectClip, onSeek, compact } = props;
  const [query, setQuery] = useState("");
  const [tone, setTone] = usePersisted<SkinTone>(LS.tone, 0, (v) => typeof v === "number" && v >= 0 && v <= 5);
  const [mode, setMode] = usePersisted<Mode>(LS.mode, "single", (v) => v === "single" || v === "reaction");
  const [recents, setRecents] = usePersisted<string[]>(LS.recents, [], Array.isArray);
  const [favs, setFavs] = usePersisted<string[]>(LS.favs, [], Array.isArray);
  const [packEmoji, setPackEmoji] = useState<string | null>(null);
  const [hover, setHover] = useState<EmojiEntry | null>(null);
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const gridH = compact ? 220 : 320;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor(Math.max(0, size.w - 8) / CELL));
  const view = useMemo(() => buildView({ cols, query, recents, favs }), [cols, query, recents, favs]);

  // Visible window (+ a row of overscan each side).
  const first = Math.max(0, firstRowAt(view.rows, scrollTop) - 1);
  const visible: Row[] = [];
  for (let i = first; i < view.rows.length; i++) {
    const r = view.rows[i]!;
    if (r.top > scrollTop + (size.h || gridH) + CELL) break;
    visible.push(r);
  }

  // Warm the sprites for the cells in view (decoded off-thread, drawn lazily).
  useEffect(() => {
    for (const r of visible) if (r.k === "cells") for (const e of r.items) preloadEmoji(emojiSpriteName(emojiWithTone(e, tone)), 64);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, view, tone, size.h]);

  useEffect(() => {
    setActive(0);
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [query]);

  const startSec = round2(Math.max(0, timeSec));
  const disabled = busy;

  const remember = (emoji: string) => setRecents((r) => pushRecent(r, emoji));

  const insert = (emoji: string, pack?: string) => {
    if (disabled) return;
    const { doc: next, clipId } = insertEmojiPayload(doc, { emoji, pack }, { atSec: startSec });
    onApplyDoc(next);
    onSelectClip?.(clipId);
    onSeek?.(startSec);
  };

  const choose = (entry: EmojiEntry) => {
    const emoji = emojiWithTone(entry, tone);
    remember(emoji);
    if (mode === "reaction") setPackEmoji(emoji);
    else insert(emoji);
  };

  const onDragStart = (e: DragEvent, emoji: string, pack?: string) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(EMOJI_DRAG_MIME, encodeEmojiDrag({ emoji, ...(pack ? { pack } : {}) }));
    e.dataTransfer.setData("text/plain", emoji);
    const img = (e.currentTarget as HTMLElement).querySelector("img");
    if (img) e.dataTransfer.setDragImage(img, 16, 16);
    remember(emoji);
  };

  const scrollToTab = (tab: string) => {
    const y = view.tabTops[tab];
    if (y === undefined || !scroller.current) return;
    scroller.current.scrollTop = y;
    setScrollTop(y);
  };

  const scrollIntoViewIndex = (idx: number) => {
    const r = view.rows.find((x) => x.k === "cells" && idx >= x.start && idx < x.start + x.items.length);
    const el = scroller.current;
    if (!r || !el) return;
    if (r.top < el.scrollTop) el.scrollTop = r.top;
    else if (r.top + r.h > el.scrollTop + el.clientHeight) el.scrollTop = r.top + r.h - el.clientHeight;
    setScrollTop(el.scrollTop);
  };

  const onKey = (e: KeyboardEvent) => {
    const n = view.flat.length;
    if (n === 0) return;
    let next = active;
    if (e.key === "ArrowRight") next = Math.min(n - 1, active + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, active - 1);
    else if (e.key === "ArrowDown") next = Math.min(n - 1, active + cols);
    else if (e.key === "ArrowUp") next = Math.max(0, active - cols);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    pendingFocus.current = true;
    setActive(next);
    scrollIntoViewIndex(next);
  };

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    scroller.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.focus();
  });

  // Tab highlight follows the scroll position.
  const activeTab = useMemo(() => {
    let cur = "";
    for (const [tab, y] of Object.entries(view.tabTops)) if (y <= scrollTop + 2) cur = tab;
    return cur.split(".")[0]!;
  }, [view, scrollTop]);

  const info = hover ?? view.flat[active] ?? null;
  const infoEmoji = info ? emojiWithTone(info, tone) : null;
  const isFav = !!infoEmoji && favs.includes(infoEmoji);
  const total = emojiTotal();

  const tabs: { key: string; label: string; icon: ReactNode; show: boolean }[] = [
    { key: "recent", label: "Recently used", icon: <span aria-hidden="true">🕘</span>, show: recents.length > 0 },
    { key: "fav", label: "Favorites", icon: <span aria-hidden="true">⭐</span>, show: favs.length > 0 },
    ...EMOJI_GROUPS.map((g, i) => ({ key: `g${i}`, label: g.label, icon: <Sprite emoji={GROUP_ICONS[i] ?? "🙂"} size={16} />, show: true })),
  ];

  return (
    <div className="flex flex-col gap-2.5" data-testid="emoji-picker">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="What a click adds" className="flex overflow-hidden rounded-full border border-line text-[11px]">
          {(["single", "reaction"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 transition ${mode === m ? "bg-amber/15 text-amber" : "text-muted hover:text-text"}`}
            >
              {m === "single" ? "Single emoji" : "Reaction packs"}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${total.toLocaleString()} emoji`}
          aria-label="Search emoji"
          className="min-w-[140px] flex-1 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs text-text placeholder:text-faint"
        />
        <label className="flex items-center gap-1 text-[11px] text-muted">
          <span className="sr-only">Skin tone</span>
          <select
            value={tone}
            onChange={(e) => setTone(Number(e.target.value) as SkinTone)}
            aria-label="Skin tone"
            className="rounded-full border border-line bg-elevated px-2 py-1.5 text-xs text-text"
          >
            {SKIN_TONES.map((t) => (
              <option key={t.tone} value={t.tone}>
                {t.tone === 0 ? "Skin tone" : t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {mode === "reaction" && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-elevated/50 p-2" data-testid="reaction-packs">
          <p className="text-[11px] text-faint">
            Pick a pack. It uses its own emoji
            {packEmoji ? (
              <>
                {" "}
                or <span className="inline-flex translate-y-[3px] items-center gap-1 rounded-full border border-teal/40 px-1.5 text-text"><Sprite emoji={packEmoji} size={14} /> your pick</span>{" "}
                <button type="button" className="underline hover:text-text" onClick={() => setPackEmoji(null)}>
                  reset
                </button>
              </>
            ) : (
              " — tap any emoji below to swap it in."
            )}
          </p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
            {REACTION_PACKS.map((p) => {
              const shown = packEmoji ?? p.emoji[0]!;
              return (
                <button
                  key={p.key}
                  type="button"
                  disabled={disabled}
                  draggable={!disabled}
                  onDragStart={(e) => onDragStart(e, packEmoji ?? p.emoji[0]!, p.key)}
                  onClick={() => insert(packEmoji ?? p.emoji[0]!, p.key)}
                  aria-label={`Add ${p.label} reaction`}
                  title={p.blurb}
                  className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5 text-left transition hover:border-amber/50 disabled:opacity-40"
                >
                  <Sprite emoji={shown} size={24} />
                  <span className="truncate text-[11px] text-muted">{p.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div role="tablist" aria-label="Emoji categories" className="flex flex-wrap gap-0.5">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={!query && activeTab === t.key}
              aria-label={t.label}
              title={t.label}
              onClick={() => {
                setQuery("");
                requestAnimationFrame(() => scrollToTab(t.key));
              }}
              className={`grid h-7 w-8 place-items-center rounded-md border text-sm transition ${!query && activeTab === t.key ? "border-teal/60 bg-teal/10" : "border-transparent hover:bg-elevated"}`}
            >
              {t.icon}
            </button>
          ))}
      </div>

      <div
        ref={scroller}
        onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
        onKeyDown={onKey}
        role="group"
        aria-label="Emoji"
        data-testid="emoji-grid"
        className="relative overflow-y-auto rounded-lg border border-line bg-[#0d1017]"
        style={{ height: gridH }}
      >
        <div style={{ height: view.total, position: "relative" } as CSSProperties}>
          {visible.map((r) =>
            r.k === "head" ? (
              <div key={`h-${r.top}`} className="absolute left-0 right-0 truncate px-2 pt-2 text-[10px] uppercase tracking-wider text-faint" style={{ top: r.top, height: r.h }}>
                {r.label}
              </div>
            ) : r.k === "note" ? (
              <div key={`n-${r.top}`} role="status" className="absolute left-0 right-0 px-3 py-3 text-xs text-muted" style={{ top: r.top }}>
                {r.text}
              </div>
            ) : (
              <div key={`c-${r.top}`} className="absolute left-1 flex" style={{ top: r.top, height: r.h }}>
                {r.items.map((e, i) => {
                  const idx = r.start + i;
                  const emoji = emojiWithTone(e, tone);
                  return (
                    <button
                      key={e.emoji}
                      type="button"
                      data-idx={idx}
                      tabIndex={idx === active ? 0 : -1}
                      draggable={!disabled}
                      disabled={disabled && mode === "single"}
                      aria-label={e.name}
                      title={e.name}
                      onClick={() => {
                        setActive(idx);
                        choose(e);
                      }}
                      onFocus={() => setActive(idx)}
                      onMouseEnter={() => setHover(e)}
                      onMouseLeave={() => setHover(null)}
                      onDragStart={(ev) => onDragStart(ev, emoji)}
                      className={`grid place-items-center rounded-md transition hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal ${favs.includes(emoji) ? "bg-amber/5" : ""}`}
                      style={{ width: CELL, height: CELL }}
                    >
                      <Sprite emoji={emoji} size={26} />
                    </button>
                  );
                })}
              </div>
            ),
          )}
        </div>
      </div>

      <div className="flex min-h-[34px] items-center gap-2 text-xs" aria-live="polite">
        {info && infoEmoji ? (
          <>
            <Sprite emoji={infoEmoji} size={28} />
            <span className="min-w-0 flex-1 truncate text-muted">{titleCase(info.name)}</span>
            <button
              type="button"
              aria-pressed={isFav}
              onClick={() => setFavs((f) => toggleFavorite(f, infoEmoji))}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition ${isFav ? "border-amber/60 text-amber" : "border-line text-muted hover:text-text"}`}
            >
              {isFav ? "★ Favorite" : "☆ Favorite"}
            </button>
          </>
        ) : (
          <span className="text-faint">Hover an emoji for its name. Click to add at the playhead — or drag it onto the preview.</span>
        )}
      </div>

      {!compact && (
        <EmojiInspector doc={doc} busy={busy} selectedClipId={selectedClipId} onApplyDoc={onApplyDoc} onSelectClip={onSelectClip} onSeek={onSeek} />
      )}
    </div>
  );
}

// ---- inspector ---------------------------------------------------------------------------

function EmojiInspector({
  doc,
  busy,
  selectedClipId,
  onApplyDoc,
  onSelectClip,
  onSeek,
}: Pick<EmojiPickerProps, "doc" | "busy" | "selectedClipId" | "onApplyDoc" | "onSelectClip" | "onSeek">) {
  const groups = emojiGroups(doc);
  const owner = selectedClipId ? /^(emo-\d+)-/.exec(selectedClipId)?.[1] : undefined;
  const group = (owner && findEmojiGroup(doc, owner)) || null;
  if (groups.length === 0) return null;
  const apply = (patch: EditEmojiPatch, key?: string) => {
    if (!group) return;
    onApplyDoc(editEmoji(doc, group.id, patch), key ? `emoji:${group.id}:${key}` : undefined);
  };
  const first = group?.clips[0];
  return (
    <section className="flex flex-col gap-2" data-testid="emoji-inspector">
      <h3 className="text-[10px] uppercase tracking-wider text-faint">On the timeline</h3>
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => {
              onSelectClip?.(g.clips[0]?.id ?? null);
              onSeek?.(g.start);
            }}
            aria-pressed={group?.id === g.id}
            aria-label={`Select ${g.pack === "sticker" ? g.clips[0]?.text : g.pack} emoji group`}
            className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition ${group?.id === g.id ? "border-teal/60 bg-teal/10 text-text" : "border-line text-muted hover:text-text"}`}
          >
            <Sprite emoji={g.clips[0]?.text ?? "🙂"} size={16} />
            {g.pack === "sticker" ? "Sticker" : titleCase(g.pack.replace(/-/g, " "))}
          </button>
        ))}
      </div>
      {group && first && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-line bg-elevated/40 p-2.5 text-[11px] text-muted">
          <div className="flex flex-col gap-1">
            Size
            <div className="flex gap-1">
              {([["Smaller", 0.8], ["Bigger", 1.25]] as const).map(([l, k]) => (
                <button
                  key={l}
                  type="button"
                  disabled={busy}
                  onClick={() => apply({ scale: k })}
                  aria-label={`Make the emoji ${l.toLowerCase()}`}
                  className="rounded-md border border-line px-2.5 py-1 text-text transition hover:border-amber/60 disabled:opacity-40"
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            Starts at (s)
            <input
              type="number"
              min={0}
              step={0.1}
              value={round2(group.start)}
              disabled={busy}
              aria-label="Emoji start time"
              onChange={(e) => apply({ atSec: Math.max(0, Number(e.target.value) || 0) }, "start")}
              className="rounded-md border border-line bg-elevated px-2 py-1 text-text"
            />
          </label>
          {group.pack === "sticker" && (
            <div className="col-span-2 flex flex-col gap-1">
              Position
              <div className="grid w-[96px] grid-cols-3 gap-0.5" role="group" aria-label="Emoji position">
                {EMOJI_POSITIONS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={busy}
                    aria-label={`Move to ${p.replace("-", " ")}`}
                    onClick={() => apply({ position: p as EmojiPosition })}
                    className="h-5 rounded-sm border border-line hover:border-amber/60"
                  />
                ))}
              </div>
            </div>
          )}
          <MotionSelect label="Intro" value={first.anim.style} options={EMOJI_INTROS} disabled={busy} onChange={(v) => apply({ intro: v as never })} />
          <MotionSelect label="Loop" value={first.anim.loop.style} options={EMOJI_LOOPS} disabled={busy} onChange={(v) => apply({ loop: v as never })} />
          <MotionSelect label="Exit" value={first.anim.exit.style} options={EMOJI_EXITS} disabled={busy} onChange={(v) => apply({ exit: v as never })} />
          <div className="col-span-2 flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                apply({ remove: true });
                onSelectClip?.(null);
              }}
              className="rounded-full border border-line px-3 py-1 text-[11px] text-muted transition hover:border-red-400/60 hover:text-red-300"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function MotionSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: readonly string[]; disabled: boolean; onChange: (v: string) => void }) {
  const opts = options.includes(value) ? options : [value, ...options];
  return (
    <label className="flex flex-col gap-1">
      {label}
      <select
        value={value}
        disabled={disabled}
        aria-label={`Emoji ${label.toLowerCase()} motion`}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line bg-elevated px-2 py-1 text-text"
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {titleCase(o.replace(/-/g, " "))}
          </option>
        ))}
      </select>
    </label>
  );
}
