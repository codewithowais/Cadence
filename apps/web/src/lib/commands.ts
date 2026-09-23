/**
 * The ⌘K command palette's catalogue + ranking — PURE (no React, no `@/` imports).
 *
 * `buildCommands` lists everything a creator can do right now: suggested next
 * steps, recent prompts, project actions (export, undo, redo, play, panels,
 * shortcuts), every room, and the whole prompt library. `rankCommands` fuzzy-ranks
 * them for a query and always offers "Ask the Director: …" so free text is never a
 * dead end. Every command is a CommandAction the Editor maps to an EXISTING path.
 */
import type { EditDoc } from "@cadence/core";
import {
  GOALS,
  PROMPT_LIBRARY,
  fuzzyScore,
  ideaAction,
  isAvailable,
  needsLabel,
  nextSteps,
  type CommandAction,
  type EditorMode,
  type RoomTarget,
} from "./suggestions";

export type CommandGroup = "Suggested" | "Recent" | "Project" | "Rooms" | "Edits" | "Ask";

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** Secondary line (a goal name, a room hint, "needs a video"…). */
  hint?: string;
  keywords?: string[];
  /** Displayed key caps, e.g. ["⌘", "Z"]. */
  shortcut?: string[];
  action: CommandAction;
  /** Shown but not runnable (e.g. Undo with nothing to undo). */
  disabled?: boolean;
}

export interface CommandContext {
  doc: EditDoc;
  mode: EditorMode;
  hasContent: boolean;
  hasAudio: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Newest-first recent prompts. */
  recents: readonly string[];
  /** Tools the last Director edit called. */
  lastTools: readonly string[];
  /** Platform modifier glyph for shortcut hints ("⌘" on Mac, "Ctrl" elsewhere). */
  mod?: string;
}

export const ROOM_COMMANDS: { room: RoomTarget; label: string; hint: string; keywords: string[] }[] = [
  { room: "media", label: "Media", hint: "Your footage, photos and audio", keywords: ["upload", "files", "library", "footage", "import"] },
  { room: "text", label: "Text", hint: "Text videos, titles & type", keywords: ["type", "font", "scenes", "script", "typography"] },
  { room: "edit", label: "Edit", hint: "One-tap edits", keywords: ["cut", "arrange", "quick", "one-tap"] },
  { room: "design", label: "Design", hint: "Looks, color, backgrounds, overlays", keywords: ["look", "color", "filter", "grade", "fx", "overlay", "sticker", "shape"] },
  { room: "words", label: "Words", hint: "Edit by transcript, captions", keywords: ["transcript", "captions", "subtitles", "karaoke"] },
  { room: "demo", label: "Demo", hint: "Walkthroughs from screenshots", keywords: ["walkthrough", "tutorial", "screenshot", "cursor", "click"] },
  { room: "audio", label: "Audio", hint: "Music, voice-over, mix", keywords: ["music", "sound", "voice", "volume", "mix", "noise"] },
  { room: "deliver", label: "Deliver", hint: "Quality & export", keywords: ["export", "download", "render", "quality", "mp4"] },
];

/** Everything runnable right now, in the palette's default (no-query) order. */
export function buildCommands(ctx: CommandContext): Command[] {
  const mod = ctx.mod ?? "⌘";
  const out: Command[] = [];

  // Suggested next steps (the same pure function the chat chips use).
  for (const s of nextSteps({ doc: ctx.doc, mode: ctx.mode, lastTools: [...ctx.lastTools], hasAudio: ctx.hasAudio })) {
    out.push({ id: `next:${s.id}`, title: s.label, group: "Suggested", hint: "Suggested next step", action: s.action });
  }

  // Recent prompts.
  for (const [i, p] of ctx.recents.slice(0, 8).entries()) {
    out.push({ id: `recent:${i}`, title: p, group: "Recent", hint: "Run again", keywords: ["again", "history", "recent"], action: { type: "prompt", prompt: p } });
  }

  // Project actions.
  out.push(
    { id: "ui:export", title: "Export video (.mp4)", group: "Project", hint: ctx.hasContent ? "Render and download" : "Add something to export first", keywords: ["download", "render", "save", "mp4", "deliver", "finish"], action: { type: "ui", command: "export" }, disabled: !ctx.hasContent },
    { id: "ui:play", title: "Play / pause preview", group: "Project", keywords: ["watch", "preview", "play", "pause"], shortcut: ["Space"], action: { type: "ui", command: "play" }, disabled: !ctx.hasContent },
    { id: "ui:undo", title: "Undo", group: "Project", keywords: ["back", "revert", "oops"], shortcut: [mod, "Z"], action: { type: "ui", command: "undo" }, disabled: !ctx.canUndo },
    { id: "ui:redo", title: "Redo", group: "Project", keywords: ["again", "forward"], shortcut: [mod, "Shift", "Z"], action: { type: "ui", command: "redo" }, disabled: !ctx.canRedo },
    { id: "ui:addMedia", title: "Upload video, photos or audio", group: "Project", keywords: ["add", "import", "file", "footage", "song", "music", "media"], action: { type: "ui", command: "addMedia" } },
    { id: "ui:library", title: "Browse prompt ideas", group: "Project", hint: "What can I say?", keywords: ["help", "examples", "ideas", "prompts", "what"], action: { type: "ui", command: "library" } },
    { id: "ui:toggleChat", title: "Show / hide chat panel", group: "Project", keywords: ["director", "rail", "sidebar", "panel", "chat"], shortcut: ["["], action: { type: "ui", command: "toggleChat" } },
    { id: "ui:toggleCode", title: "Show / hide edit-doc code", group: "Project", keywords: ["json", "code", "developer", "doc"], shortcut: ["]"], action: { type: "ui", command: "toggleCode" } },
    { id: "ui:focusMode", title: "Focus mode", group: "Project", hint: "Hide both side panels", keywords: ["fullscreen", "distraction", "canvas", "focus"], shortcut: ["\\"], action: { type: "ui", command: "focusMode" } },
    { id: "ui:shortcuts", title: "Keyboard shortcuts", group: "Project", keywords: ["keys", "hotkeys", "help", "keyboard"], shortcut: ["?"], action: { type: "ui", command: "shortcuts" } },
  );

  // Rooms.
  for (const r of ROOM_COMMANDS) {
    out.push({ id: `room:${r.room}`, title: `Go to ${r.label}`, group: "Rooms", hint: r.hint, keywords: [...r.keywords, "room", r.label.toLowerCase()], action: { type: "room", room: r.room } });
  }

  // The whole prompt library — available ones runnable, the rest labelled.
  const goalLabel = new Map(GOALS.map((g) => [g.key, g.label]));
  for (const idea of PROMPT_LIBRARY) {
    const ok = isAvailable(idea.needs, ctx.mode, ctx.hasAudio);
    const where = idea.room ? `Opens ${ROOM_COMMANDS.find((r) => r.room === idea.room)?.label ?? idea.room}` : undefined;
    out.push({
      id: `idea:${idea.id}`,
      title: idea.label,
      group: "Edits",
      hint: ok ? [goalLabel.get(idea.goal), where].filter(Boolean).join(" · ") : `${goalLabel.get(idea.goal)} · ${needsLabel(idea.needs)}`,
      keywords: [...(idea.keywords ?? []), goalLabel.get(idea.goal) ?? "", idea.prompt ?? ""],
      action: ideaAction(idea),
      disabled: !ok,
    });
  }
  return out;
}

const actionKey = (a: CommandAction): string =>
  a.type === "prompt" ? `p:${a.prompt.trim().toLowerCase()}` : a.type === "room" ? `r:${a.room}` : `u:${a.command}`;

const GROUP_ORDER: CommandGroup[] = ["Suggested", "Recent", "Project", "Rooms", "Edits", "Ask"];

/**
 * Rank commands for a query. Empty query → the default order (disabled rows
 * dropped so the list stays about what you can do now). With a query → fuzzy
 * score on the title (weighted) + hint + keywords; enabled beats disabled; ties
 * keep catalogue order; Suggested duplicates are dropped. The "Ask the Director" row is always offered: first when
 * nothing matches well, last otherwise.
 */
export function rankCommands(commands: readonly Command[], query: string, limit = 60): Command[] {
  const q = query.trim();
  if (!q) {
    // Default view: what you can do now, each thing once (a suggested step also
    // lives in Edits — keep the suggested copy, drop the duplicate).
    const seen = new Set<string>();
    const byGroup = [...commands]
      .filter((c) => !c.disabled)
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
      .filter((c) => {
        const key = actionKey(c.action);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return byGroup.slice(0, limit);
  }
  // Suggested rows duplicate an Edit/Project row; with a query, rank the originals.
  const scored = commands
    .filter((c) => c.group !== "Suggested")
    .map((c, index) => {
      const title = fuzzyScore(q, c.title) * 2;
      const rest = fuzzyScore(q, `${c.title} ${c.hint ?? ""}`, c.keywords ?? []);
      const raw = Math.max(title, rest);
      return { c, score: raw - (c.disabled ? 4 : 0), raw, index };
    })
    .filter((s) => s.raw > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const ask: Command = { id: "ask", title: `Ask the Director: “${q}”`, group: "Ask", hint: "Describe any edit in your own words", action: { type: "prompt", prompt: q } };
  // A strong hit = at least a keyword-exact / word-prefix match on every token.
  const strong = scored.length > 0 && scored[0]!.raw >= 7 * q.split(/\s+/).length;
  const hits = scored.slice(0, limit - 1).map((s) => s.c);
  return strong ? [...hits, ask] : [ask, ...hits];
}
