"use client";

/**
 * Live-preview support for 3D LUTs. CSS/SVG filters can't express an arbitrary 3D
 * table, so the preview fits a colour matrix + per-channel tone curve to the LUT
 * (core `lutApprox`) and applies it as an SVG `<filter>` referenced from the CSS
 * `filter` of the preview media. The EXPORT is exact (ffmpeg `lut3d`); the UI says
 * "approximate" for this preview.
 *
 *  - `bundled:<key>` looks are generated on demand (no file, always available).
 *  - Uploaded `.cube` files are parsed in the browser at import time
 *    (`registerCubeText`) and their fitted params persisted to localStorage, so the
 *    preview survives a reload (the server path is not readable from the browser).
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  bundledLut,
  cssFilter,
  isBundledLut,
  lutApprox,
  parseCube,
  type ColorGrade,
  type EditDoc,
  type LutApprox,
} from "@cadence/core";

const STORAGE_KEY = "cadence.lut.approx.v1";
const registry = new Map<string, LutApprox>();
let loadedFromStorage = false;

/** Stable, CSS-id-safe filter id for a LUT id/path. */
export function lutFilterId(lutId: string): string {
  let h = 5381;
  for (let i = 0; i < lutId.length; i++) h = ((h * 33) ^ lutId.charCodeAt(i)) >>> 0;
  return `cadence-lut-${h.toString(36)}`;
}

function loadStored(): void {
  if (loadedFromStorage) return;
  loadedFromStorage = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, LutApprox>;
    for (const [k, v] of Object.entries(obj)) if (v?.matrix?.length === 12 && v.tables?.length === 3) registry.set(k, v);
  } catch {
    /* storage unavailable / corrupt — the preview just skips the LUT */
  }
}

function persist(): void {
  try {
    const out: Record<string, LutApprox> = {};
    for (const [k, v] of registry) if (!isBundledLut(k)) out[k] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    /* ignore */
  }
}

/** The fitted preview params for a LUT id (bundled: computed once; uploaded: if registered). */
export function lutApproxFor(lutId: string | undefined | null): LutApprox | null {
  if (!lutId) return null;
  const hit = registry.get(lutId);
  if (hit) return hit;
  if (isBundledLut(lutId)) {
    const lut = bundledLut(lutId);
    if (!lut) return null;
    const a = lutApprox(lut);
    registry.set(lutId, a);
    return a;
  }
  if (typeof window !== "undefined") {
    loadStored();
    return registry.get(lutId) ?? null;
  }
  return null;
}

/**
 * Parse an imported `.cube` in the browser and register its preview approximation
 * under the stored `lutId`. Throws a readable error for a malformed/1-D file (so the
 * import UI can reject it before uploading). Returns the fit's mean error (0..1).
 */
export function registerCubeText(lutId: string, text: string): number {
  const lut = parseCube(text);
  const a = lutApprox(lut);
  registry.set(lutId, a);
  persist();
  return a.meanError;
}

/** `cssFilter(look)` plus the LUT's SVG filter reference (when the preview has one). */
export function previewFilter(look: ColorGrade): string {
  const base = cssFilter(look);
  if (!look.lut || !lutApproxFor(look.lut)) return base;
  const ref = `url(#${lutFilterId(look.lut)})`;
  return base === "none" ? ref : `${base} ${ref}`;
}

/**
 * The CSS filter for the adjustment layers active at `timeSec` (their grades + LUTs,
 * stacked in track order), or "none". Applied to a wrapper around the preview media.
 */
export function adjustmentPreviewFilter(doc: EditDoc, timeSec: number): string {
  const parts: string[] = [];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const c of track.clips) {
      if (c.kind !== "adjustment") continue;
      if (timeSec < c.start || timeSec >= c.start + c.duration) continue;
      const f = previewFilter(c.grade);
      if (f !== "none") parts.push(f);
    }
  }
  return parts.length ? parts.join(" ") : "none";
}

/** Every LUT id the doc references (clip looks + adjustment grades). */
function docLutIds(doc: EditDoc): string[] {
  const out = new Set<string>();
  for (const t of doc.tracks)
    for (const c of t.clips) {
      if ((c.kind === "video" || c.kind === "image") && c.look.lut) out.add(c.look.lut);
      if (c.kind === "adjustment" && c.grade.lut) out.add(c.grade.lut);
    }
  return [...out];
}

/**
 * Hidden `<svg>` holding one `<filter>` per LUT the doc uses. Render once next to
 * the preview media; the media's CSS `filter: url(#id)` resolves against it.
 */
export function LutDefs({ doc }: { doc: EditDoc }): ReactElement | null {
  // Uploaded LUTs' params come from localStorage — available only after mount.
  const [, setTick] = useState(0);
  useEffect(() => {
    loadStored();
    setTick((n) => n + 1);
  }, []);
  const ids = useMemo(() => docLutIds(doc), [doc]);
  const filters = ids.flatMap((id) => {
    const a = lutApproxFor(id);
    return a ? [{ id: lutFilterId(id), a }] : [];
  });
  if (filters.length === 0) return null;
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute", pointerEvents: "none" }}>
      <defs>
        {filters.map(({ id, a }) => {
          const m = a.matrix;
          const row = (i: number): string => `${m[i * 4]} ${m[i * 4 + 1]} ${m[i * 4 + 2]} 0 ${m[i * 4 + 3]}`;
          return (
            <filter key={id} id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
              <feColorMatrix type="matrix" values={`${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0`} />
              <feComponentTransfer>
                <feFuncR type="table" tableValues={a.tables[0].join(" ")} />
                <feFuncG type="table" tableValues={a.tables[1].join(" ")} />
                <feFuncB type="table" tableValues={a.tables[2].join(" ")} />
              </feComponentTransfer>
            </filter>
          );
        })}
      </defs>
    </svg>
  );
}
