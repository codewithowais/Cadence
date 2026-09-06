"use client";

import { useMemo } from "react";
import type { EditDoc } from "@cadence/core";
import { describeDoc } from "@/lib/status";

interface AppliedStatusProps {
  doc: EditDoc;
  /** Hidden until there's media to describe. */
  hasMedia: boolean;
}

interface Chip {
  label: string;
  value: string;
  /** amber = quality/action highlight, teal = applied edit, muted = neutral. */
  tone: "amber" | "teal" | "muted";
}

/**
 * A live, read-only strip that reflects the current edit-doc so actions
 * visibly register: aspect, active look, quality target, captions, music, and
 * the cut count. Reads only what already exists in the doc.
 */
export function AppliedStatus({ doc, hasMedia }: AppliedStatusProps) {
  const chips = useMemo<Chip[]>(() => {
    const s = describeDoc(doc);
    const out: Chip[] = [{ label: "Aspect", value: s.aspect, tone: "muted" }];
    if (s.cuts > 0) out.push({ label: "Cuts", value: String(s.cuts), tone: "muted" });
    if (s.look) out.push({ label: "Look", value: s.look, tone: "teal" });
    if (s.quality) out.push({ label: "Quality", value: s.quality, tone: "amber" });
    if (s.captions) out.push({ label: "Captions", value: "on", tone: "teal" });
    if (s.music) out.push({ label: "Music", value: "on", tone: "teal" });
    return out;
  }, [doc]);

  if (!hasMedia) return null;

  return (
    <div
      aria-label="Applied edits"
      className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-panel/20 px-4 py-1.5"
    >
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-faint">applied</span>
      {chips.map((c) => (
        <span
          key={c.label}
          className={[
            "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
            c.tone === "amber"
              ? "border-amber/40 bg-amber/10 text-amber-bright"
              : c.tone === "teal"
                ? "border-teal/30 bg-teal/10 text-teal"
                : "border-line bg-elevated text-muted",
          ].join(" ")}
        >
          <span className="text-faint">{c.label}</span>
          <span className="tabular-nums">{c.value}</span>
        </span>
      ))}
    </div>
  );
}
