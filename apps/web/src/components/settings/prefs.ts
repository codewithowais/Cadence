/**
 * Editor preferences — a small, per-browser bundle of defaults the editor can
 * read when it opens a project (e.g. seed the aspect/look/quality pickers and
 * whether preview starts unmuted).
 *
 * PERSISTENCE: localStorage under the `cadence:prefs` key. These are per-device
 * conveniences, not account data — they never leave the browser and are not
 * tenant-scoped. Every read/write is guarded (SSR-safe: `window` may be absent;
 * storage may throw in private mode) and falls back to DEFAULT_PREFS.
 *
 * HOW THE EDITOR CAN READ THESE LATER:
 *   import { loadPrefs, PREFS_KEY } from "@/components/settings/prefs";
 *   const prefs = loadPrefs(); // -> EditorPrefs, always populated
 * or listen for cross-tab changes via the `storage` event on PREFS_KEY.
 */

export const PREFS_KEY = "cadence:prefs";

export const ASPECT_OPTIONS = [
  { key: "16:9", label: "16:9 — Landscape" },
  { key: "9:16", label: "9:16 — Portrait" },
  { key: "1:1", label: "1:1 — Square" },
  { key: "4:5", label: "4:5 — Feed" },
] as const;
export type AspectKey = (typeof ASPECT_OPTIONS)[number]["key"];

export const LOOK_OPTIONS = [
  { key: "none", label: "None" },
  { key: "warm", label: "Warm" },
  { key: "cool", label: "Cool" },
  { key: "vivid", label: "Vivid" },
  { key: "cinematic", label: "Cinematic" },
  { key: "vintage", label: "Vintage" },
  { key: "noir", label: "Noir" },
  { key: "vibrant", label: "Vibrant" },
  { key: "bw", label: "B & W" },
] as const;
export type LookKey = (typeof LOOK_OPTIONS)[number]["key"];

export const QUALITY_OPTIONS = [
  { key: "standard", label: "Standard — 1080p" },
  { key: "high", label: "High — 1440p" },
  { key: "ultra", label: "Ultra — 4K" },
] as const;
export type QualityKey = (typeof QUALITY_OPTIONS)[number]["key"];

/** The shape stored under `cadence:prefs`. Bump-tolerant: unknown values are
 *  coerced back to defaults by `normalize` so an older/newer blob never breaks. */
export interface EditorPrefs {
  defaultAspect: AspectKey;
  defaultLook: LookKey;
  defaultQuality: QualityKey;
  /** Start preview playback unmuted (default false — browsers prefer muted). */
  startUnmuted: boolean;
}

export const DEFAULT_PREFS: EditorPrefs = {
  defaultAspect: "16:9",
  defaultLook: "none",
  defaultQuality: "standard",
  startUnmuted: false,
};

const has = <T extends readonly { key: string }[]>(opts: T, v: unknown): v is T[number]["key"] =>
  typeof v === "string" && opts.some((o) => o.key === v);

/** Coerce an unknown parsed blob into a valid, fully-populated EditorPrefs. */
export function normalize(raw: unknown): EditorPrefs {
  const r = (raw ?? {}) as Partial<Record<keyof EditorPrefs, unknown>>;
  return {
    defaultAspect: has(ASPECT_OPTIONS, r.defaultAspect) ? r.defaultAspect : DEFAULT_PREFS.defaultAspect,
    defaultLook: has(LOOK_OPTIONS, r.defaultLook) ? r.defaultLook : DEFAULT_PREFS.defaultLook,
    defaultQuality: has(QUALITY_OPTIONS, r.defaultQuality) ? r.defaultQuality : DEFAULT_PREFS.defaultQuality,
    startUnmuted: typeof r.startUnmuted === "boolean" ? r.startUnmuted : DEFAULT_PREFS.startUnmuted,
  };
}

/** Read prefs from localStorage. SSR-safe and never throws; returns defaults. */
export function loadPrefs(): EditorPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return normalize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist prefs to localStorage. SSR-safe and never throws. Returns success. */
export function savePrefs(prefs: EditorPrefs): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}
