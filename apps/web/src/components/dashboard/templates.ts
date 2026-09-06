/**
 * Starter templates for "New project". Each template seeds the project's FIRST
 * edit-doc so a fresh project already renders something meaningful.
 *
 * Docs are built through `@cadence/core`'s `parseEditDoc` (pure + safe on client
 * and server) so every seed is fully validated and defaulted before it can be
 * saved. Templates deliberately use only `text` + `solid` clips — they reference
 * no media assets, because uploaded media isn't persisted server-side yet, so a
 * seeded doc must stand on its own.
 *
 * The metadata list (`TEMPLATES`) is safe to import into a client bundle; the
 * server route calls `buildTemplateDoc(id)` to construct the seed doc by id
 * (the client never sends a raw doc — it sends only a template id).
 */
import { parseEditDoc, type EditDoc } from "@cadence/core";

export type TemplateId = "blank" | "talking-head" | "slideshow";

export interface TemplateMeta {
  readonly id: TemplateId;
  readonly label: string;
  readonly description: string;
  /** A short aspect/format hint shown in the picker (derived from the seed meta). */
  readonly format: string;
}

/** Templates offered in the "New project" menu, in display order. */
export const TEMPLATES: readonly TemplateMeta[] = [
  {
    id: "blank",
    label: "Blank project",
    description: "An empty 1080p timeline — start from scratch.",
    format: "16:9 · 1080p",
  },
  {
    id: "talking-head",
    label: "Talking-head highlight",
    description: "Title card, kinetic intro, and a lower-third caption.",
    format: "16:9 · 1080p",
  },
  {
    id: "slideshow",
    label: "Photo slideshow",
    description: "Four cross-fading slides with captions and a title.",
    format: "16:9 · 1080p",
  },
];

export function isTemplateId(value: unknown): value is TemplateId {
  return value === "blank" || value === "talking-head" || value === "slideshow";
}

/**
 * Build the seed edit-doc for a template, or `null` for "blank" (a blank project
 * is created with no initial version, matching the plain "New project" flow).
 * Throws only if a template raw doc is malformed — a build-time bug, not user
 * input — so callers can treat a non-null return as guaranteed-valid.
 */
export function buildTemplateDoc(id: TemplateId): EditDoc | null {
  if (id === "blank") return null;
  if (id === "talking-head") return parseEditDoc(talkingHeadRaw());
  if (id === "slideshow") return parseEditDoc(slideshowRaw());
  return null;
}

// --- Raw docs (validated by parseEditDoc above) -----------------------------

function talkingHeadRaw() {
  return {
    version: 1,
    meta: { title: "Talking-head highlight", width: 1920, height: 1080, fps: 30, background: "#0b0b12" },
    media: [],
    tracks: [
      {
        id: "v1",
        kind: "visual",
        clips: [
          // Opening title card: solid backdrop for the first 3s…
          { id: "bg", kind: "solid", start: 0, duration: 3, color: "#0b0b12", transitionOutSec: 0.5 },
          // …with a kinetic title that slides + scales in over it.
          {
            id: "title",
            kind: "text",
            start: 0.2,
            duration: 2.6,
            text: "Your title here",
            fontSize: 104,
            color: "#ffffff",
            align: "center",
            transitionInSec: 0.3,
            transitionOutSec: 0.4,
            anim: { style: "kinetic", fromY: 60, fromScale: 0.82, durationSec: 0.6 },
          },
          // Lower-third name/role caption once the speaker is on screen.
          {
            id: "lower-third",
            kind: "text",
            start: 3.2,
            duration: 4,
            text: "Speaker name — Role",
            fontSize: 46,
            color: "#ffffff",
            align: "center",
            background: "#0b0b12cc",
            transitionInSec: 0.3,
            transitionOutSec: 0.3,
            anim: { style: "kinetic", fromX: -80, durationSec: 0.4 },
          },
        ],
      },
      { id: "a1", kind: "audio", clips: [] },
    ],
    quality: { preset: "standard" },
  };
}

function slideshowRaw() {
  const palette = ["#1f2937", "#3f2d54", "#154a45", "#5a3324"];
  const captions = ["First slide", "Second slide", "Third slide", "Fourth slide"];
  const slideDur = 3;
  const overlap = 0.6; // crossfade window between consecutive slides
  const step = slideDur - overlap;

  const slides = palette.map((color, i) => ({
    id: `slide-${i + 1}`,
    kind: "solid" as const,
    start: Number((i * step).toFixed(2)),
    duration: slideDur,
    color,
    transitionInSec: i === 0 ? 0.4 : overlap,
    transitionOutSec: overlap,
    transitionType: "crossfade" as const,
  }));

  const labels = captions.map((text, i) => ({
    id: `caption-${i + 1}`,
    kind: "text" as const,
    start: Number((i * step + 0.3).toFixed(2)),
    duration: slideDur - 0.6,
    text,
    fontSize: 64,
    color: "#ffffff",
    align: "center" as const,
    background: "#00000066",
    transitionInSec: 0.3,
    transitionOutSec: 0.3,
  }));

  return {
    version: 1,
    meta: { title: "Photo slideshow", width: 1920, height: 1080, fps: 30, background: "#000000" },
    media: [],
    tracks: [
      { id: "v1", kind: "visual", clips: [...slides, ...labels] },
      { id: "a1", kind: "audio", clips: [] },
    ],
    quality: { preset: "standard" },
  };
}
