/**
 * Canvas UI preferences — small, dependency-free stores shared by the Canvas panel,
 * the top-bar size chip, the Deliver room and the Stage.
 *
 *  - open/close: a window CustomEvent so any control can open the panel without
 *    threading props through Editor/TopBar/RoomPanel.
 *  - safe-zone mode (a Stage overlay): a tiny external store (useSyncExternalStore).
 *  - saved custom sizes + recents: localStorage ONLY inside try/catch (private mode,
 *    blocked storage, SSR) and always merged with the doc-embedded presets, so a
 *    project keeps its own sizes even where storage is unavailable.
 */
import type { CustomCanvasPreset, EditDoc, SafeZoneId } from "@cadence/core";

export const OPEN_CANVAS_EVENT = "cadence:open-canvas";

/** Open the Canvas panel (optionally on a tab). Safe to call from anywhere. */
export function openCanvasPanel(tab?: "size" | "magic"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_CANVAS_EVENT, { detail: { tab } }));
}

// ---- storage helpers -----------------------------------------------------------

const KEY_SAVED = "cadence:canvas:saved";
const KEY_RECENTS = "cadence:canvas:recents";
const KEY_SAFE = "cadence:canvas:safe";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the doc-embedded copy still persists */
  }
}

const validSize = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 64 && n <= 7680;

function cleanPresets(list: unknown): CustomCanvasPreset[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (p): p is CustomCanvasPreset =>
        !!p && typeof p.id === "string" && typeof p.name === "string" && validSize(p.width) && validSize(p.height),
    )
    .slice(0, 24);
}

/** Saved sizes: this browser's list merged with the ones embedded in the doc (doc wins ties). */
export function loadSavedSizes(doc: EditDoc): CustomCanvasPreset[] {
  const local = typeof window === "undefined" ? [] : cleanPresets(readJson<unknown>(KEY_SAVED, []));
  const embedded = doc.meta.canvas?.customPresets ?? [];
  const seen = new Set<string>();
  const out: CustomCanvasPreset[] = [];
  for (const p of [...embedded, ...local]) {
    const k = `${p.width}x${p.height}:${p.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.slice(0, 24);
}

export function storeSavedSizes(list: CustomCanvasPreset[]): void {
  if (typeof window === "undefined") return;
  writeJson(KEY_SAVED, list.slice(0, 24));
}

export interface RecentSize {
  width: number;
  height: number;
}

export function loadRecents(): RecentSize[] {
  if (typeof window === "undefined") return [];
  const raw = readJson<unknown>(KEY_RECENTS, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is RecentSize => !!r && validSize(r.width) && validSize(r.height)).slice(0, 6);
}

/** Push a size to the front of the recents (deduped, max 6). */
export function pushRecent(width: number, height: number): RecentSize[] {
  const next = [{ width, height }, ...loadRecents().filter((r) => r.width !== width || r.height !== height)].slice(0, 6);
  if (typeof window !== "undefined") writeJson(KEY_RECENTS, next);
  return next;
}

// ---- safe-zone overlay mode (external store) -------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let safeMode: SafeZoneId = "off";
let safeLoaded = false;

function loadSafe(): void {
  if (safeLoaded || typeof window === "undefined") return;
  safeLoaded = true;
  const v = readJson<unknown>(KEY_SAFE, "off");
  if (v === "title" || v === "tiktok" || v === "reels" || v === "shorts") safeMode = v;
}

export function getSafeZoneMode(): SafeZoneId {
  loadSafe();
  return safeMode;
}

export function setSafeZoneMode(mode: SafeZoneId): void {
  safeMode = mode;
  safeLoaded = true;
  writeJson(KEY_SAFE, mode);
  listeners.forEach((l) => l());
}

export function subscribeSafeZone(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
