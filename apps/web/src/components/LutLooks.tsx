"use client";

/**
 * LutLooks — a gallery of the BUNDLED free 3D-LUT looks (teal & orange, warm/cool
 * film, bleach, noir, faded film). Each chip previews itself on a skin/sky/foliage
 * test gradient through the same fitted SVG filter the live preview uses; clicking
 * applies `bundled:<key>` via the pure `applyLut` (undoable; the Director's
 * `apply_lut` tool does the same). Export is exact (ffmpeg lut3d); the preview is a
 * fitted approximation, and the chip says so. Additive: rendered inside LutControls.
 */
import { BUNDLED_LUTS, type EditDoc } from "@cadence/core";
import { applyLut } from "@cadence/director";
import { lutApproxFor, lutFilterId } from "@/lib/lut-preview";

const SAMPLE =
  "linear-gradient(90deg,#1b2a4a 0%,#2f6f9f 22%,#5aa469 42%,#d9b383 62%,#e8e2d0 82%,#ffffff 100%)";

export function LutLooks({
  doc,
  disabled,
  activeLut,
  onApplyDoc,
}: {
  doc: EditDoc;
  disabled?: boolean;
  activeLut?: string;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
}) {
  const filters = BUNDLED_LUTS.flatMap((l) => {
    const id = `bundled:${l.key}`;
    const a = lutApproxFor(id);
    return a ? [{ key: l.key, id, fid: lutFilterId(id), a }] : [];
  });
  return (
    <div className="flex flex-col gap-1.5" data-testid="lut-looks">
      <span className="text-[10px] uppercase tracking-wider text-faint">Free looks (built-in)</span>
      {/* Filters for the chip previews (the editor's own LutDefs only carries LUTs the doc uses). */}
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute", pointerEvents: "none" }}>
        <defs>
          {filters.map(({ fid, a }) => {
            const m = a.matrix;
            const row = (i: number): string => `${m[i * 4]} ${m[i * 4 + 1]} ${m[i * 4 + 2]} 0 ${m[i * 4 + 3]}`;
            return (
              <filter key={fid} id={`lk-${fid}`} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
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
      <div className="flex flex-wrap gap-2">
        {BUNDLED_LUTS.map((l) => {
          const id = `bundled:${l.key}`;
          const on = activeLut === id;
          return (
            <button
              key={l.key}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              title={`${l.label} — ${l.hint} (preview is approximate; export is exact)`}
              onClick={() => {
                try {
                  onApplyDoc(applyLut(doc, { lut: on ? "" : id }));
                } catch {
                  /* no visual clip — the section already explains this */
                }
              }}
              className={[
                "flex w-[104px] flex-col gap-1 rounded-lg border p-1.5 text-left transition disabled:opacity-40",
                on ? "border-amber bg-amber/10" : "border-line bg-elevated hover:border-amber/40",
              ].join(" ")}
            >
              <span
                aria-hidden
                className="block h-6 w-full rounded"
                style={{ background: SAMPLE, filter: `url(#lk-${lutFilterId(id)})` }}
              />
              <span className={["text-[11px] leading-tight", on ? "text-amber" : "text-muted"].join(" ")}>{l.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
