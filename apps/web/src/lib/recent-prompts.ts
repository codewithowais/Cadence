/**
 * Recent Director prompts, persisted per browser. Every storage access is wrapped
 * in try/catch — private windows / blocked storage just mean no history.
 */
import { RECENT_MAX, pushRecent } from "./suggestions";

const KEY = "cadence:recentPrompts";

export function loadRecentPrompts(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Record a prompt (newest first, de-duped) and return the updated list. */
export function rememberPrompt(prompt: string): string[] {
  const next = pushRecent(loadRecentPrompts(), prompt);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — history is best-effort */
  }
  return next;
}
