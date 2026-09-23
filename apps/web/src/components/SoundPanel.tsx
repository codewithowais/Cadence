"use client";

/**
 * "Sound made easy" — the Audio room's one-click sound tools. Every control runs
 * a PURE @cadence/director op through the undoable commit path (onApplyDoc), so
 * the Director and these buttons produce the same edit-doc:
 *
 *  - Music     → generateMusic (royalty-free, synthesized locally, fitted to the video)
 *  - Sound FX  → addSfx at the playhead · autoSfx (subtle / punchy) · clearSfx
 *  - Smart duck→ autoDuck (keyframed, only under speech; depth in dB)
 *  - Voice     → setVoiceEnhance (export chain)
 *  - Beat sync → beatSync (scenes/photos land on the beat or the bar)
 *  - Levels    → live per-bus + master meters at the playhead
 */
import { useEffect, useMemo, useState } from "react";
import type { EditDoc } from "@cadence/core";
import {
  addSfx,
  autoDuck,
  autoSfx,
  beatSync,
  clearSfx,
  generatedMusicOf,
  generateMusic,
  MOOD_DEFS,
  MUSIC_MOODS,
  programDurationSec,
  setVoiceEnhance,
  SFX_DEFS,
  SFX_KINDS,
  SFX_TRACK_ID,
  speechRegions,
  suggestMood,
  type MusicMood,
  type SfxKind,
} from "@cadence/director";
import { loadEnvelope, mixLevelsAt, toDbfs, type LevelEnvelope, type MeterReading } from "@/lib/audio-mix";

interface SoundPanelProps {
  doc: EditDoc;
  busy: boolean;
  timeSec: number;
  /** Object URLs by media id (decoded for the level meters). */
  urls: Record<string, string>;
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
}

type Note = { tone: "ok" | "error"; text: string } | null;

const MOOD_ICON: Record<MusicMood, string> = {
  lofi: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  upbeat: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  cinematic: "M4 4h16v16H4zM4 9h16M4 15h16M9 4v5M15 4v5M9 15v5M15 15v5",
  corporate: "M3 17l6-6 4 4 8-8M14 7h7v7",
  ambient: "M3 12c3-6 6 6 9 0s6 6 9 0",
};

const SFX_ICON: Record<SfxKind, string> = {
  whoosh: "M3 8h11a3 3 0 1 0-3-3M3 16h15a3 3 0 1 1-3 3M3 12h18",
  pop: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  click: "M9 3l10 10-4 1 3 6-2 1-3-6-4 3z",
  ding: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  riser: "M3 20 21 4M21 4v7M21 4h-7",
  boom: "M12 2l2.4 6.5L21 9l-5 4.5L17.5 21 12 17l-5.5 4L8 13.5 3 9l6.6-.5z",
};

function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Section({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-[92px] shrink-0 text-[10px] uppercase tracking-wider text-faint" title={hint}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  onClick,
  active,
  disabled,
  title,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={title}
      className={[
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50",
        active ? "border-teal/40 bg-teal/10 text-teal" : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Primary({ onClick, disabled, label, children }: { onClick: () => void; disabled?: boolean; label?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber px-3.5 py-1.5 text-xs font-medium text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 overflow-hidden rounded-full border border-line bg-elevated">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={[
            "px-2.5 py-1 text-[11px] transition disabled:opacity-50",
            value === o.value ? "bg-teal/10 text-teal" : "text-muted hover:text-text",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const shown = format(value);
  return (
    <label className="flex w-[124px] shrink-0 flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
        <span>{label}</span>
        <span className="tabular-nums text-muted">{shown}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={`${label}, ${shown}`}
        style={{ accentColor: "var(--color-teal)" }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

// ---- level meters -------------------------------------------------------------------

const FLOOR_DB = -60;

function Meter({ label, reading }: { label: string; reading: MeterReading }) {
  const rmsDb = Math.max(FLOOR_DB, toDbfs(reading.rms));
  const peakDb = Math.max(FLOOR_DB, toDbfs(reading.peak));
  const pct = (db: number): number => ((db - FLOOR_DB) / -FLOOR_DB) * 100;
  const over = peakDb > -1;
  const hot = peakDb > -6;
  const shown = reading.peak > 0 ? `${peakDb.toFixed(0)} dB` : "—";
  return (
    <div className="flex w-[150px] shrink-0 flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
        <span>{label}</span>
        <span className={["tabular-nums", over ? "text-danger" : "text-muted"].join(" ")}>{over ? "Clip!" : shown}</span>
      </span>
      <div
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={Math.round(peakDb)}
        aria-valuetext={reading.peak > 0 ? `${label}: peak ${peakDb.toFixed(0)} dBFS, average ${rmsDb.toFixed(0)} dBFS` : `${label}: silent`}
        className="relative h-2 w-full overflow-hidden rounded-full bg-line"
      >
        <div
          className={["absolute inset-y-0 left-0 rounded-full", over ? "bg-danger" : hot ? "bg-amber" : "bg-teal"].join(" ")}
          style={{ width: `${pct(rmsDb)}%` }}
        />
        {reading.peak > 0 && (
          <div className={["absolute inset-y-0 w-0.5", over ? "bg-danger" : "bg-text/60"].join(" ")} style={{ left: `calc(${pct(peakDb)}% - 1px)` }} />
        )}
        {/* −6 / −1 dBFS guides */}
        <div className="absolute inset-y-0 w-px bg-elevated/80" style={{ left: `${pct(-6)}%` }} aria-hidden />
        <div className="absolute inset-y-0 w-px bg-elevated/80" style={{ left: `${pct(-1)}%` }} aria-hidden />
      </div>
    </div>
  );
}

function LevelMeters({ doc, urls, timeSec }: { doc: EditDoc; urls: Record<string, string>; timeSec: number }) {
  const [envs, setEnvs] = useState<Record<string, LevelEnvelope | null>>({});
  // Every source that can make sound: audio clips + the footage's own audio.
  const ids = useMemo(() => {
    const s = new Set<string>();
    for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "audio" || c.kind === "video") s.add(c.mediaId);
    return [...s];
  }, [doc]);
  useEffect(() => {
    let live = true;
    for (const id of ids) {
      const url = urls[id];
      if (!url || id in envs) continue;
      void loadEnvelope(id, url).then((env) => {
        if (live) setEnvs((e) => (id in e ? e : { ...e, [id]: env }));
      });
    }
    return () => {
      live = false;
    };
  }, [ids, urls, envs]);
  const levels = useMemo(() => mixLevelsAt(doc, envs, timeSec), [doc, envs, timeSec]);
  return (
    <>
      <Meter label="Voice" reading={levels.buses.voice} />
      <Meter label="Music" reading={levels.buses.music} />
      <Meter label="SFX" reading={levels.buses.sfx} />
      <Meter label="Mix" reading={levels.master} />
    </>
  );
}

// ---- the panel ------------------------------------------------------------------------

export function SoundPanel({ doc, busy, timeSec, urls, onApplyDoc }: SoundPanelProps) {
  const gen = useMemo(() => generatedMusicOf(doc), [doc]);
  const [mood, setMood] = useState<MusicMood>(() => gen?.recipe.mood ?? suggestMood(doc));
  const [bpm, setBpm] = useState<number>(() => Math.round(gen?.arrangement.bpm ?? MOOD_DEFS[mood].bpm));
  const [seed, setSeed] = useState<number>(() => gen?.recipe.seed ?? 1);
  const [sfxStyle, setSfxStyle] = useState<"subtle" | "punchy">("subtle");
  const [duckDb, setDuckDb] = useState(-12);
  const [every, setEvery] = useState<"beat" | "bar">("beat");
  const [note, setNote] = useState<Note>(null);

  const program = programDurationSec(doc);
  const hasContent = program > 0;
  const sfxCount = doc.tracks.find((t) => t.id === SFX_TRACK_ID)?.clips.length ?? 0;
  const voiceOn = doc.voiceEnhance === true;
  const musicClip = doc.tracks.find((t) => t.id === "music")?.clips.find((c) => c.kind === "audio");
  const ducked = !!musicClip && musicClip.kind === "audio" && (musicClip.keyframes ?? []).some((k) => k.prop === "volume");
  const speechCount = useMemo(() => speechRegions(doc).length, [doc]);
  const composing = !!gen && !!musicClip && musicClip.kind === "audio" && !urls[musicClip.mediaId];
  const canBeatSync =
    !!gen || (doc.markers?.length ?? 0) > 1;

  const run = (label: string, fn: () => EditDoc, ok: string | ((d: EditDoc) => string)): void => {
    try {
      const next = fn();
      onApplyDoc(next);
      setNote({ tone: "ok", text: typeof ok === "string" ? ok : ok(next) });
    } catch (err) {
      setNote({ tone: "error", text: err instanceof Error ? err.message : `${label} failed.` });
    }
  };

  const pickMood = (m: MusicMood): void => {
    setMood(m);
    setBpm(MOOD_DEFS[m].bpm);
  };

  const compose = (nextSeed = seed): void => {
    setSeed(nextSeed);
    run("Compose", () => generateMusic(doc, { mood, bpm, seed: nextSeed }), (d) => {
      const g = generatedMusicOf(d);
      return g
        ? `Composed ${MOOD_DEFS[mood].label.toLowerCase()} · ${Math.round(g.arrangement.bpm)} BPM · ${g.arrangement.bars} bars, ending with your video.`
        : "Composed.";
    });
  };

  const range = MOOD_DEFS[mood].bpmRange;

  return (
    <div aria-label="Sound made easy" className="flex flex-col gap-2 rounded-xl border border-line-soft bg-panel/60 px-3 py-2">
      {/* Music generator */}
      <Section label="music" hint="Royalty-free — composed on your machine">
        <div role="radiogroup" aria-label="Music mood" className="flex flex-wrap gap-1.5">
          {MUSIC_MOODS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mood === m}
              title={MOOD_DEFS[m].blurb}
              disabled={busy}
              onClick={() => pickMood(m)}
              className={[
                "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-50",
                mood === m ? "border-teal/40 bg-teal/10 text-teal" : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
              ].join(" ")}
            >
              <Icon d={MOOD_ICON[m]} />
              {MOOD_DEFS[m].label}
            </button>
          ))}
        </div>
        <Slider
          label="Tempo"
          value={Math.min(range[1], Math.max(range[0], bpm))}
          min={range[0]}
          max={range[1]}
          step={1}
          format={(v) => `${v} BPM`}
          disabled={busy}
          onChange={setBpm}
        />
        <Primary onClick={() => compose(seed)} disabled={busy || composing} label="Compose music">
          <Icon d={MOOD_ICON[mood]} />
          {gen ? "Re-compose" : "Compose music"}
        </Primary>
        {gen && (
          <Chip onClick={() => compose(seed + 1)} disabled={busy || composing} title="Same mood, a different take">
            New take
          </Chip>
        )}
        <span className="text-[11px] text-faint" aria-live="polite">
          {composing ? (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber motion-reduce:animate-none" aria-hidden />
              Composing…
            </span>
          ) : gen ? (
            `${MOOD_DEFS[gen.recipe.mood].label} · ${Math.round(gen.arrangement.bpm)} BPM · ${gen.arrangement.bars} bars · ${gen.recipe.durationSec.toFixed(1)}s — royalty-free`
          ) : hasContent ? (
            `Fitted to your ${program.toFixed(1)}s video — royalty-free, no licence needed.`
          ) : (
            "Royalty-free beds, composed on your machine."
          )}
        </span>
      </Section>

      {/* Sound effects */}
      <Section label="sound fx" hint="Placed so the hit lands on the moment">
        {SFX_KINDS.map((k) => (
          <Chip
            key={k}
            onClick={() => run("Add SFX", () => addSfx(doc, { kind: k, atSec: timeSec }), `Added a ${SFX_DEFS[k].label.toLowerCase()} at ${timeSec.toFixed(1)}s.`)}
            disabled={busy || !hasContent}
            label={`Add ${SFX_DEFS[k].label.toLowerCase()} at playhead`}
            title={`Add a ${SFX_DEFS[k].label.toLowerCase()} at the playhead`}
          >
            <Icon d={SFX_ICON[k]} />
            {SFX_DEFS[k].label}
          </Chip>
        ))}
        <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />
        <Segmented
          label="Auto-SFX style"
          value={sfxStyle}
          onChange={setSfxStyle}
          disabled={busy}
          options={[
            { value: "subtle", label: "Subtle" },
            { value: "punchy", label: "Punchy" },
          ]}
        />
        <Primary
          onClick={() =>
            run("Auto-SFX", () => autoSfx(doc, { style: sfxStyle }).doc, (d) => {
              const n = d.tracks.find((t) => t.id === SFX_TRACK_ID)?.clips.length ?? 0;
              return n ? `Added ${n} sound effect${n === 1 ? "" : "s"} on your transitions and text.` : "No transitions or text pop-ins to sound-design yet.";
            })
          }
          disabled={busy || !hasContent}
          label="Auto sound effects"
        >
          Auto-SFX
        </Primary>
        {sfxCount > 0 && (
          <Chip onClick={() => run("Clear SFX", () => clearSfx(doc), "Removed all sound effects.")} disabled={busy} label="Clear all sound effects">
            Clear {sfxCount} SFX
          </Chip>
        )}
      </Section>

      {/* Smart duck + voice + beat sync */}
      <Section label="mix" hint="Music dips only while someone talks">
        <Slider label="Duck depth" value={duckDb} min={-24} max={-6} step={1} format={(v) => `${v} dB`} disabled={busy} onChange={setDuckDb} />
        <Chip
          onClick={() =>
            run("Smart duck", () => autoDuck(doc, { depthDb: duckDb }).doc, () =>
              speechCount > 0
                ? `Music dips ${duckDb} dB under ${speechCount} spoken passage${speechCount === 1 ? "" : "s"} and swells back between.`
                : `Music ducked ${duckDb} dB under the speech.`,
            )
          }
          disabled={busy || !musicClip}
          active={ducked}
          label="Smart duck"
        >
          {ducked ? "Smart duck: on" : "Smart duck"}
        </Chip>
        <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />
        <Chip
          onClick={() => run("Voice enhance", () => setVoiceEnhance(doc, !voiceOn), voiceOn ? "Voice enhance off." : "Voice enhance on — applied when you export.")}
          disabled={busy}
          active={voiceOn}
          title="High-pass · compressor · presence EQ · de-esser · limiter — on the voice only"
          label={voiceOn ? "Enhance voice: on" : "Enhance voice"}
        >
          {voiceOn ? "Enhance voice: on" : "Enhance voice"}
        </Chip>
        <span className="mx-1 h-7 w-px shrink-0 bg-line" aria-hidden />
        <Segmented
          label="Beat sync grid"
          value={every}
          onChange={setEvery}
          disabled={busy}
          options={[
            { value: "beat", label: "Every beat" },
            { value: "bar", label: "Every bar" },
          ]}
        />
        <Chip
          onClick={() =>
            run("Beat sync", () => beatSync(doc, { every }).doc, () => `Every scene change now lands on the ${every}.`)
          }
          disabled={busy || !canBeatSync}
          title={canBeatSync ? "Re-time photos / text scenes so cuts land on the music" : "Compose music or detect beats first"}
          label="Cut to the beat"
        >
          Cut to the beat
        </Chip>
      </Section>

      {/* Meters */}
      <Section label="levels" hint="Estimated mix at the playhead (dBFS)">
        <LevelMeters doc={doc} urls={urls} timeSec={timeSec} />
      </Section>

      <p
        role="status"
        aria-live="polite"
        className={["min-h-[16px] text-[11px]", note?.tone === "error" ? "text-danger" : "text-muted"].join(" ")}
      >
        {note?.text ?? (voiceOn ? "Voice enhance is applied on export — the preview plays the untreated voice." : "")}
      </p>
    </div>
  );
}
