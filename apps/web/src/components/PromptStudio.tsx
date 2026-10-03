"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EditDoc, MediaAsset } from "@cadence/core";
import {
  GENRE_LABELS,
  LANGUAGES,
  LANGUAGE_LABELS,
  MOODS,
  MUSIC_MOODS,
  PALETTES,
  PALETTE_NAMES,
  PLATFORMS,
  PLATFORM_LABELS,
  ProjectState,
  TEXT_VIDEO_THEMES,
  TEXT_VIDEO_THEME_DEFS,
  moveScene,
  planVideo,
  realiseStoryboard,
  refineStoryboard,
  regenerateScene,
  removeScene,
  setStoryboardStyle,
  storyboardDuration,
  updateScene,
  type Language,
  type Mood,
  type PlanOverrides,
  type Platform,
  type RefineKind,
  type Storyboard,
  type StoryboardScene,
} from "@cadence/director";
import { STUDIO_EXAMPLES } from "@/lib/prompt-studio-bus";
import { Overlay } from "./Overlay";

export interface StudioCreateResult {
  doc: EditDoc;
  summary: string;
  storyboard: Storyboard;
  warnings: string[];
}

interface PromptStudioProps {
  open: boolean;
  onClose: () => void;
  /** Photos / clips / audio already in the project. */
  media: MediaAsset[];
  /** Object URLs by media id (thumbnails). */
  urls: Record<string, string>;
  /** Pre-fill the prompt box. */
  initialPrompt?: string;
  /** Open on the review screen for this storyboard (the video already in the project). */
  initialStoryboard?: Storyboard | null;
  /** Register picked files as project media WITHOUT touching the timeline; resolves to the new assets. */
  onAttach: (files: File[]) => Promise<MediaAsset[]>;
  /** The finished video — the editor commits it as one undoable step. */
  onCreate: (result: StudioCreateResult) => void;
}

const LENGTHS = [15, 30, 45, 60, 90] as const;
const PLATFORM_CHIPS: Platform[] = ["instagram", "tiktok", "youtube", "shorts", "whatsapp", "facebook", "linkedin"];
const MOOD_LABELS: Record<Mood, string> = {
  warm: "Warm",
  upbeat: "Upbeat",
  energetic: "Energetic",
  calm: "Calm",
  elegant: "Elegant",
  bold: "Bold",
  playful: "Playful",
  cinematic: "Cinematic",
  emotional: "Emotional",
  professional: "Professional",
  minimal: "Minimal",
  luxury: "Luxury",
};
const MUSIC_LABELS: Record<string, string> = { lofi: "Lo-fi", upbeat: "Upbeat", cinematic: "Cinematic", corporate: "Corporate", ambient: "Ambient", none: "No music" };
const STORAGE_KEY = "cadence:studioPrompt";

type Phase = "compose" | "review";

export function PromptStudio({ open, onClose, media, urls, initialPrompt, initialStoryboard, onAttach, onCreate }: PromptStudioProps) {
  const [phase, setPhase] = useState<Phase>("compose");
  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [length, setLength] = useState<number | null>(null);
  const [mood, setMood] = useState<Mood | null>(null);
  const [language, setLanguage] = useState<Language | null>(null);
  const [music, setMusic] = useState<string | null>(null);
  const [voiceover, setVoiceover] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sb, setSb] = useState<Storyboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const seenMedia = useRef<Set<string>>(new Set());

  const visualMedia = useMemo(() => media.filter((m) => m.kind === "image" || m.kind === "video"), [media]);
  const chosen = useMemo(() => visualMedia.filter((m) => picked.has(m.id)), [visualMedia, picked]);

  // Open / close: reset to a clean slate (or straight to review for an existing video).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setCreating(false);
    if (initialStoryboard) {
      setSb(initialStoryboard);
      setPrompt(initialStoryboard.prompt);
      setPhase("review");
    } else {
      setSb(null);
      setPhase("compose");
      let saved = "";
      try {
        saved = localStorage.getItem(STORAGE_KEY) ?? "";
      } catch {
        /* storage unavailable */
      }
      setPrompt(initialPrompt ?? saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Newly added photos / clips are selected by default.
  useEffect(() => {
    // (Computed outside the state updater: React StrictMode runs updaters twice.)
    const fresh = visualMedia.filter((m) => !seenMedia.current.has(m.id));
    if (fresh.length === 0) return;
    for (const m of fresh) seenMedia.current.add(m.id);
    setPicked((prev) => new Set([...prev, ...fresh.map((m) => m.id)]));
  }, [visualMedia]);

  const overrides = useMemo<PlanOverrides>(
    () => ({
      ...(platform ? { platform } : {}),
      ...(length ? { targetSec: length } : {}),
      ...(mood ? { mood } : {}),
      ...(language ? { language } : {}),
      ...(music ? { music: music as NonNullable<PlanOverrides["music"]> } : {}),
      ...(voiceover ? { voiceover: true } : {}),
    }),
    [platform, length, mood, language, music, voiceover],
  );

  const plan = () => {
    setError(null);
    try {
      const board = planVideo({ prompt, media: chosen, overrides });
      try {
        localStorage.setItem(STORAGE_KEY, prompt);
      } catch {
        /* storage unavailable */
      }
      setSb(board);
      setPhase("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "I couldn't plan that. Try describing it a little differently.");
    }
  };

  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    setAttaching(true);
    setError(null);
    try {
      await onAttach(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add those files.");
    } finally {
      setAttaching(false);
    }
  };

  const create = async () => {
    if (!sb) return;
    // A scene whose words were cleared is dropped rather than built empty.
    const board: Storyboard = { ...sb, scenes: sb.scenes.filter((s) => s.heading.trim().length > 0).map((s, i) => ({ ...s, id: `sc${i + 1}` })) };
    if (board.scenes.length === 0) {
      setError("Every scene is empty. Add some words to at least one scene.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const project = new ProjectState({ media });
      const r = await realiseStoryboard(project, board);
      const dur = Math.round(storyboardDuration(board));
      onCreate({
        doc: r.doc,
        storyboard: board,
        warnings: r.warnings,
        summary: `Made your ${GENRE_LABELS[board.genre].toLowerCase()}: ${board.scenes.length} scenes, about ${dur}s (${r.steps.join(", ")}). Edit any scene in the Text room, or tap a refinement below.${r.warnings.length ? ` Note: ${r.warnings.join(" ")}` : ""}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "I couldn't build that video.");
    } finally {
      setCreating(false);
    }
  };

  const refine = (kind: RefineKind) => {
    if (!sb) return;
    setError(null);
    try {
      setSb(refineStoryboard(sb, kind, chosen));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't refine that.");
    }
  };

  const total = sb ? storyboardDuration(sb) : 0;

  return (
    <Overlay open={open} onClose={onClose} label="Describe your video" panelClassName="max-w-5xl h-[min(780px,94vh)]">
      <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 pb-3 pt-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-text">
            {phase === "compose" ? "Describe your video" : "Review the storyboard"}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {phase === "compose"
              ? "One sentence is enough. I'll plan the scenes and write the copy, and you check it before anything is built."
              : "Edit any words, reorder, or roll a fresh take on a scene. Nothing is built until you press Create video."}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the studio"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-elevated text-muted transition hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {phase === "compose" && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label htmlFor="studio-prompt" className="text-xs font-medium text-text">
              What should the video be?
            </label>
            <textarea
              id="studio-prompt"
              data-testid="studio-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) {
                  e.preventDefault();
                  plan();
                }
              }}
              rows={3}
              placeholder="30s Instagram promo for my coffee shop, warm vibe, upbeat music"
              className="voice mt-1.5 w-full resize-y rounded-xl border border-line bg-elevated px-3.5 py-3 text-base text-text placeholder:text-faint focus:border-amber/50"
            />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-faint">Try:</span>
              {STUDIO_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => setPrompt(ex.prompt)}
                  className="rounded-full border border-line bg-elevated px-2.5 py-1 text-[11px] text-muted transition hover:border-amber/40 hover:text-text"
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ChipGroup label="Platform" value={platform} onChange={setPlatform} options={PLATFORM_CHIPS.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }))} />
            <ChipGroup label="Length" value={length} onChange={setLength} options={LENGTHS.map((n) => ({ value: n, label: `${n}s` }))} />
            <ChipGroup label="Vibe" value={mood} onChange={setMood} options={MOODS.map((m) => ({ value: m, label: MOOD_LABELS[m] }))} />
            <ChipGroup label="Language" value={language} onChange={setLanguage} options={LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))} />
            <ChipGroup label="Music" value={music} onChange={setMusic} options={[...MUSIC_MOODS, "none"].map((m) => ({ value: m, label: MUSIC_LABELS[m] ?? m }))} />
            <fieldset className="min-w-0">
              <legend className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Voice-over</legend>
              <label className="flex items-start gap-2 text-xs text-muted">
                <input type="checkbox" checked={voiceover} onChange={(e) => setVoiceover(e.target.checked)} className="mt-0.5 accent-[var(--color-amber)]" />
                <span>
                  Narrate the scenes. Needs a text-to-speech provider, which is a paid service, so it stays off until one is set up. Everything else is built either way.
                </span>
              </label>
            </fieldset>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-faint">Your photos &amp; clips (optional)</span>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={attaching}
                className="rounded-lg border border-line bg-elevated px-3 py-1 text-xs font-medium text-text transition hover:border-amber/40 disabled:opacity-50"
              >
                {attaching ? "Adding…" : "Add photos or clips"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                data-testid="studio-file"
                onChange={(e) => {
                  const files = e.target.files ? Array.from(e.target.files) : [];
                  e.target.value = "";
                  void attach(files);
                }}
              />
            </div>
            {visualMedia.length === 0 ? (
              <p className="mt-1.5 text-xs text-faint">No media needed. Without any, scenes get designed gradient backgrounds. With photos, they appear behind the words.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2" aria-label="Media to use">
                {visualMedia.map((m) => {
                  const on = picked.has(m.id);
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={`${on ? "Leave out" : "Use"} ${m.label ?? m.src}`}
                        onClick={() =>
                          setPicked((p) => {
                            const n = new Set(p);
                            if (n.has(m.id)) n.delete(m.id);
                            else n.add(m.id);
                            return n;
                          })
                        }
                        className={`relative h-14 w-14 overflow-hidden rounded-lg border-2 transition ${on ? "border-amber" : "border-line opacity-50"}`}
                      >
                        <Thumb media={m} url={urls[m.id]} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {error && (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      )}

      {phase === "review" && sb && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-3 md:flex-row">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
              <Tag>{GENRE_LABELS[sb.genre]}</Tag>
              <Tag>{PLATFORM_LABELS[sb.platform]}</Tag>
              <Tag>{sb.aspect}</Tag>
              <Tag>{LANGUAGE_LABELS[sb.language]}</Tag>
              <Tag testId="studio-total">{total.toFixed(0)}s · {sb.scenes.length} scenes</Tag>
            </div>
            {sb.notes.length > 0 && (
              <ul className="mb-3 space-y-1 rounded-xl border border-amber/25 bg-amber/5 px-3 py-2 text-xs text-muted" aria-label="Notes">
                {sb.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <ol className="space-y-2" aria-label="Storyboard scenes">
              {sb.scenes.map((scene, i) => (
                <SceneCard
                  key={`${scene.id}-${scene.beat ?? ""}-${scene.variant}`}
                  sb={sb}
                  scene={scene}
                  index={i}
                  media={visualMedia}
                  urls={urls}
                  onChange={(next) => setSb(next)}
                />
              ))}
            </ol>
          </div>

          <aside className="shrink-0 space-y-3 overflow-y-auto md:w-60" aria-label="Look and sound">
            <div>
              <span className="text-[11px] font-medium uppercase tracking-wider text-faint">Make it…</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(
                  [
                    ["regenerate", "Regenerate"],
                    ["punchier", "Punchier"],
                    ["shorter", "Shorter"],
                    ["longer", "Longer"],
                    ["different-style", "Different style"],
                  ] as [RefineKind, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    data-testid={`refine-${k}`}
                    onClick={() => refine(k)}
                    className="rounded-full border border-line bg-elevated px-2.5 py-1 text-[11px] text-muted transition hover:border-amber/40 hover:text-text"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] leading-snug text-faint">Regenerate, Shorter and Longer re-write from your sentence; Punchier and Different style keep your edits.</p>
            </div>

            <label className="block text-xs text-muted">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-faint">Theme</span>
              <select
                value={sb.theme}
                onChange={(e) => setSb(setStoryboardStyle(sb, { theme: e.target.value as Storyboard["theme"] }))}
                className="w-full rounded-lg border border-line bg-elevated px-2 py-1.5 text-xs text-text"
              >
                {TEXT_VIDEO_THEMES.map((t) => (
                  <option key={t} value={t}>
                    {TEXT_VIDEO_THEME_DEFS[t].label}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-faint">Colors</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Palette">
                {PALETTE_NAMES.map((name) => {
                  const p = PALETTES[name]!;
                  const on = sb.palette.name === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      aria-label={`${name} palette`}
                      title={name}
                      onClick={() => setSb(setStoryboardStyle(sb, { palette: name }))}
                      className={`h-7 w-7 rounded-full border-2 transition ${on ? "border-amber" : "border-line"}`}
                      style={{ background: `linear-gradient(135deg, ${p.colors[0]}, ${p.colors[1]})` }}
                    />
                  );
                })}
              </div>
            </div>

            <label className="block text-xs text-muted">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-faint">Music</span>
              <select
                value={sb.music.mood}
                onChange={(e) => setSb(setStoryboardStyle(sb, { music: e.target.value as Storyboard["music"]["mood"] }))}
                className="w-full rounded-lg border border-line bg-elevated px-2 py-1.5 text-xs text-text"
              >
                {[...MUSIC_MOODS, "none"].map((m) => (
                  <option key={m} value={m}>
                    {MUSIC_LABELS[m] ?? m}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={sb.sfx} onChange={(e) => setSb(setStoryboardStyle(sb, { sfx: e.target.checked }))} className="accent-[var(--color-amber)]" />
              Sound effects on cuts &amp; text
            </label>
            <label className="flex items-start gap-2 text-xs text-muted">
              <input type="checkbox" checked={sb.voiceover} onChange={(e) => setSb(setStoryboardStyle(sb, { voiceover: e.target.checked }))} className="mt-0.5 accent-[var(--color-amber)]" />
              <span>Voice-over (needs a paid TTS provider; stays off until set up)</span>
            </label>
            <div>
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-faint">Shape</span>
              <div className="flex gap-1.5" role="group" aria-label="Aspect ratio">
                {(["9:16", "1:1", "4:5", "16:9"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    aria-pressed={sb.aspect === a}
                    onClick={() => setSb(setStoryboardStyle(sb, { aspect: a }))}
                    className={`rounded-lg border px-2 py-1 text-[11px] transition ${sb.aspect === a ? "border-teal bg-teal/10 text-teal" : "border-line bg-elevated text-muted hover:text-text"}`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line-soft px-5 py-3">
        {phase === "review" ? (
          <button type="button" onClick={() => setPhase("compose")} className="rounded-lg border border-line bg-elevated px-3 py-1.5 text-xs font-medium text-muted transition hover:text-text">
            ← Change the description
          </button>
        ) : (
          <span className="text-[11px] text-faint">Free and offline: planning uses the built-in writer. ⌘↵ plans.</span>
        )}
        <div className="flex items-center gap-2">
          {phase === "review" && error && (
            <span role="alert" className="max-w-[18rem] truncate text-xs text-danger" title={error}>
              {error}
            </span>
          )}
          {phase === "compose" ? (
            <button
              type="button"
              data-testid="studio-plan"
              onClick={plan}
              disabled={!prompt.trim()}
              className="rounded-xl bg-amber px-4 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              Plan my video
            </button>
          ) : (
            <button
              type="button"
              data-testid="studio-create"
              onClick={create}
              disabled={creating || !sb}
              className="rounded-xl bg-amber px-4 py-2 text-sm font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creating ? "Building…" : "Create video"}
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

// ---- pieces -----------------------------------------------------------------------------------

function Tag({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className="rounded-full border border-line-soft bg-elevated px-2 py-0.5 text-muted">
      {children}
    </span>
  );
}

function Thumb({ media, url }: { media: MediaAsset; url?: string }) {
  if (!url) return <span className="grid h-full w-full place-items-center bg-elevated text-[9px] text-faint">{media.kind}</span>;
  if (media.kind === "video") return <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" aria-hidden="true" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="h-full w-full object-cover" />;
}

function ChipGroup<T extends string | number>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T | null;
  onChange: (v: T | null) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">{label}</legend>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        <button
          type="button"
          aria-pressed={value === null}
          onClick={() => onChange(null)}
          className={`rounded-full border px-2.5 py-1 text-[11px] transition ${value === null ? "border-teal bg-teal/10 font-semibold text-teal" : "border-line bg-elevated text-muted hover:text-text"}`}
        >
          Auto
        </button>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(value === o.value ? null : o.value)}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition ${value === o.value ? "border-teal bg-teal/10 font-semibold text-teal" : "border-line bg-elevated text-muted hover:text-text"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function SceneCard({
  sb,
  scene,
  index,
  media,
  urls,
  onChange,
}: {
  sb: Storyboard;
  scene: StoryboardScene;
  index: number;
  media: MediaAsset[];
  urls: Record<string, string>;
  onChange: (next: Storyboard) => void;
}) {
  const n = index + 1;
  const bg = scene.background?.colors ?? sb.palette.colors;
  const last = index === sb.scenes.length - 1;
  const btn = "grid h-7 w-7 place-items-center rounded-lg border border-line bg-elevated text-muted transition hover:border-amber/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-30";
  return (
    <li data-testid="sb-scene" className="rounded-xl border border-line bg-elevated p-3">
      <div className="flex gap-3">
        <div
          aria-hidden="true"
          className="relative hidden h-[76px] w-[56px] shrink-0 overflow-hidden rounded-lg border border-line-soft sm:block"
          style={{ background: `linear-gradient(${scene.background?.angle ?? 135}deg, ${bg[0]}, ${bg[1] ?? bg[0]})` }}
        >
          <span className="absolute inset-x-1 top-1/2 -translate-y-1/2 text-center text-[8px] font-bold leading-tight" style={{ color: sb.palette.text }}>
            {scene.heading.length > 26 ? `${scene.heading.slice(0, 24)}…` : scene.heading}
          </span>
          {scene.mediaId && urls[scene.mediaId] && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={urls[scene.mediaId]} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider text-faint">
            <span className="font-semibold text-muted">
              Scene {n} · {scene.role}
            </span>
            {scene.emoji && <span aria-hidden="true">{scene.emoji}</span>}
            {scene.graphic && <span className="rounded-full border border-line-soft px-1.5 py-px normal-case">{scene.graphic.preset}</span>}
            {scene.needsEdit && <span className="rounded-full border border-amber/40 bg-amber/10 px-1.5 py-px normal-case text-amber-deep">needs your detail</span>}
          </div>
          <input
            aria-label={`Scene ${n} heading`}
            data-testid="sb-heading"
            value={scene.heading}
            onChange={(e) => onChange(updateScene(sb, index, { heading: e.target.value }))}
            className="voice w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm text-text focus:border-amber/50"
          />
          <textarea
            aria-label={`Scene ${n} supporting line`}
            value={scene.body ?? ""}
            rows={1}
            placeholder="Supporting line (optional)"
            onChange={(e) => onChange(updateScene(sb, index, { body: e.target.value }))}
            className="w-full resize-y rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-muted placeholder:text-faint focus:border-amber/50"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <label className="flex items-center gap-1">
              <span className="text-[11px] text-faint">Seconds</span>
              <input
                type="number"
                min={1}
                max={30}
                step={0.5}
                aria-label={`Scene ${n} duration in seconds`}
                value={scene.durationSec}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 1 && v <= 30) onChange(updateScene(sb, index, { durationSec: Math.round(v * 10) / 10 }));
                }}
                className="w-16 rounded-lg border border-line bg-panel px-2 py-1 text-xs text-text"
              />
            </label>
            {media.length > 0 && (
              <label className="flex items-center gap-1">
                <span className="text-[11px] text-faint">Media</span>
                <select
                  aria-label={`Scene ${n} media`}
                  value={scene.mediaId ?? ""}
                  onChange={(e) => onChange(updateScene(sb, index, { mediaId: e.target.value || undefined }))}
                  className="max-w-[9rem] rounded-lg border border-line bg-panel px-1.5 py-1 text-xs text-text"
                >
                  <option value="">None</option>
                  {media.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label ?? m.src}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="ml-auto flex items-center gap-1">
              <button type="button" aria-label={`Move scene ${n} up`} disabled={index === 0} onClick={() => onChange(moveScene(sb, index, index - 1))} className={btn}>
                ↑
              </button>
              <button type="button" aria-label={`Move scene ${n} down`} disabled={last} onClick={() => onChange(moveScene(sb, index, index + 1))} className={btn}>
                ↓
              </button>
              <button
                type="button"
                aria-label={`Regenerate scene ${n}`}
                title="Write this scene again"
                data-testid="sb-regen"
                onClick={() => {
                  const fresh = regenerateScene(sb, index);
                  onChange({ ...sb, scenes: sb.scenes.map((s, i) => (i === index ? fresh : s)) });
                }}
                className={btn}
              >
                ↻
              </button>
              <button type="button" aria-label={`Delete scene ${n}`} disabled={sb.scenes.length <= 1} onClick={() => onChange(removeScene(sb, index))} className={btn}>
                ×
              </button>
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}
