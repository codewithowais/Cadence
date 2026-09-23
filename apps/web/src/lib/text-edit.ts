/**
 * Pure, client-side text clip edits for the Text room + inspector. Each returns a
 * re-parsed (always valid) doc for the editor's undoable `commit`.
 */
import { parseEditDoc, type EditDoc, type TextClip } from "@cadence/core";
import { insertTextOverlay } from "./text-presets";

type Patch = Omit<Partial<TextClip>, "anim" | "transform"> & {
  anim?: Partial<Omit<TextClip["anim"], "exit" | "loop">> & {
    exit?: Partial<TextClip["anim"]["exit"]>;
    loop?: Partial<TextClip["anim"]["loop"]>;
  };
  transform?: Partial<TextClip["transform"]>;
};

/** Find a text clip by id. */
export function findText(doc: EditDoc, id: string | null | undefined): TextClip | null {
  if (!id) return null;
  for (const t of doc.tracks) for (const c of t.clips) if (c.id === id && c.kind === "text") return c;
  return null;
}

/** Every text clip, in timeline order. */
export function allTexts(doc: EditDoc): TextClip[] {
  return doc.tracks
    .flatMap((t) => t.clips)
    .filter((c): c is TextClip => c.kind === "text")
    .sort((a, b) => a.start - b.start);
}

/**
 * Patch one text clip. Nested `anim` (incl. exit/loop) and `transform` merge;
 * `null` for an optional object field (effect / fillGradient / box / outline /
 * shadow / maxWidth) removes it.
 */
export function patchText(doc: EditDoc, id: string, patch: Patch & Record<string, unknown>): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  for (const t of clone.tracks) {
    for (const c of t.clips) {
      if (c.id !== id || c.kind !== "text") continue;
      const rec = c as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (k === "anim" && v) {
          const a = v as NonNullable<Patch["anim"]>;
          const { exit, loop, ...rest } = a;
          Object.assign(c.anim, rest);
          if (exit) Object.assign(c.anim.exit, exit);
          if (loop) Object.assign(c.anim.loop, loop);
        } else if (k === "transform" && v) {
          Object.assign(c.transform, v);
        } else if (v === null) {
          delete rec[k];
        } else if (v !== undefined) {
          rec[k] = v;
        }
      }
    }
  }
  return parseEditDoc(clone);
}

/** Canva-style quick adds: a heading, subheading, or body text at the playhead. */
export type QuickTextKind = "heading" | "subheading" | "body";

export function addQuickText(doc: EditDoc, kind: QuickTextKind, startSec: number, fontFamily?: string): EditDoc {
  const h = doc.meta.height;
  const short = Math.min(doc.meta.width, h);
  const spec = {
    heading: { text: "Add a heading", size: 0.11, weight: "bold" as const, y: 0.42 },
    subheading: { text: "Add a subheading", size: 0.065, weight: "semibold" as const, y: 0.55 },
    body: { text: "Add a little bit of body text", size: 0.045, weight: "normal" as const, y: 0.64 },
  }[kind];
  const next = insertTextOverlay(doc, {
    text: spec.text,
    startSec,
    durationSec: 4,
    fontSize: Math.round(short * spec.size),
    fontWeight: spec.weight,
    fontFamily: fontFamily ?? "'Inter', sans-serif",
    color: "#ffffff",
    background: null,
    yFrac: spec.y,
  });
  // Give the new clip a clean modern entrance + wrapping width.
  const titles = next.tracks.find((t) => t.id === "titles");
  const clip = titles?.clips[titles.clips.length - 1];
  if (!clip || clip.kind !== "text") return next;
  return patchText(next, clip.id, {
    maxWidth: Math.round(doc.meta.width * 0.82),
    transitionInSec: 0,
    transitionOutSec: 0,
    anim: { style: kind === "heading" ? "rise" : "fade", unit: kind === "body" ? "line" : "word", durationSec: 0.7, fromX: 0, fromY: 0, fromScale: 1, exit: { style: "fade", durationSec: 0.4 } },
  });
}

/** The id of the text clip most recently added to the titles track (for auto-select). */
export function lastTitleId(doc: EditDoc): string | null {
  const titles = doc.tracks.find((t) => t.id === "titles");
  const c = titles?.clips[titles.clips.length - 1];
  return c && c.kind === "text" ? c.id : null;
}
