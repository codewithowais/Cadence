"use client";

/**
 * "Divide into scenes" — turns an already-built (finished) video that sits on the
 * timeline as ONE long clip into separate, labelled, editable clips.
 *
 *  - <SceneOfferBanner/>  dismissible offer shown right after a long single video loads.
 *  - <SceneSplit/>        the Media-room section: method (scene changes · sentences ·
 *                         silences · beats · every N seconds), sensitivity + min-shot
 *                         sliders, a live preview of the cut points (as markers on the
 *                         timeline AND a mini strip here), thumbnails per shot, Apply / Undo.
 *
 * Detection runs in the browser with nothing to install (lib/scene-detect.ts);
 * the pure scoring + the split op are unit-tested in tests/scene-split.test.ts.
 * Nothing touches the doc until Apply, and Apply is one undoable edit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditDoc, MediaAsset, VideoClip } from "@cadence/core";
import { splitIntoScenes, timelineTimeAtSource } from "@cadence/director";
import { planSourceSplit, SPLIT_METHODS, SplitPlanError, type SplitMethod, type SplitPlan } from "@cadence/understanding/scenes";
import type { Transcript } from "@cadence/understanding";
import { detectBeats } from "@/lib/beats";
import { uploadMedia } from "@/lib/api";
import {
  captureThumbs,
  clearSceneScan,
  cutsFromScan,
  detectScenesServer,
  getCachedScan,
  refineCuts,
  scanVideoScenes,
  serverSceneSupport,
} from "@/lib/scene-detect";

/** Shown when a single video is at least this long (seconds). */
export const SCENE_OFFER_MIN_SEC = 10;

/** What the Editor hands the section (kept as ONE prop so RoomPanel's change is a single line). */
export interface SceneSplitBridge {
  files: Record<string, File>;
  /** Bumped by the banner: the Media room auto-starts a scene scan when it grows. */
  autoStartToken: number;
  /** Commit the divided doc (one undo step) and narrate it. */
  onApply: (doc: EditDoc, summary: string) => void;
  /** Show these timeline times as markers on the timeline strip (replaces the previous set). */
  onPreview: (times: number[]) => void;
  onUndo: () => void;
  canUndo: boolean;
}

const METHOD_LABEL: Record<SplitMethod, string> = {
  scenes: "Scene changes",
  sentences: "Sentences",
  silence: "Silences",
  beats: "Beats",
  interval: "Every N seconds",
};
const METHOD_HELP: Record<SplitMethod, string> = {
  scenes: "Finds where the picture changes (free, runs in your browser).",
  sentences: "One clip per spoken sentence, labelled with its first words.",
  silence: "Cuts in the middle of every pause in the speech.",
  beats: "Cuts on the music's beat (every Nth beat).",
  interval: "Even chunks — e.g. a clip every 5 seconds.",
};

const fmt = (t: number): string => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

/** The main-lane video clips of a doc, in timeline order (what scene splitting targets). */
function mainVideoClips(doc: EditDoc): VideoClip[] {
  const out: VideoClip[] = [];
  for (const t of doc.tracks) {
    if (t.kind !== "visual" || t.id === "broll" || t.locked) continue;
    for (const c of t.clips) if (c.kind === "video") out.push(c);
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- banner ----------------------------------------------------------------------

/** Dismissible "Divide into scenes?" offer — only while the doc is one long, undivided video. */
export function SceneOfferBanner({
  doc,
  offerMediaId,
  onAccept,
  onDismiss,
}: {
  doc: EditDoc;
  offerMediaId: string | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  if (!offerMediaId) return null;
  const clips = mainVideoClips(doc);
  const only = clips.length === 1 ? clips[0]! : null;
  if (!only || only.mediaId !== offerMediaId || only.duration < SCENE_OFFER_MIN_SEC) return null;
  return (
    <div
      role="status"
      data-testid="scene-offer"
      className="flex flex-wrap items-center gap-3 border-b border-teal/25 bg-teal/10 px-4 py-2 text-xs text-text"
    >
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-teal">Looks like a finished video.</span>{" "}
        <span className="text-muted">Divide it into scenes so every part becomes its own clip you can rearrange, trim or restyle?</span>
      </span>
      <button
        type="button"
        onClick={onAccept}
        className="shrink-0 rounded-full bg-amber px-3 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright"
      >
        Divide into scenes
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss the divide-into-scenes offer"
        className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs text-muted transition hover:text-text"
      >
        Not now
      </button>
    </div>
  );
}

// ---- section ---------------------------------------------------------------------

type ScanState =
  | { phase: "idle" }
  | { phase: "scanning"; done: number; total: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };

/** The Editor bumps `autoStartToken`; each bump auto-runs exactly once, even across remounts. */
let consumedToken = 0;

export function SceneSplit({
  doc,
  mediaList,
  urls,
  transcripts,
  busy,
  timeSec,
  onSeek,
  bridge,
}: {
  doc: EditDoc;
  mediaList: MediaAsset[];
  urls: Record<string, string>;
  transcripts: Record<string, Transcript>;
  busy: boolean;
  timeSec: number;
  onSeek: (t: number) => void;
  bridge: SceneSplitBridge;
}) {
  const clips = useMemo(() => mainVideoClips(doc), [doc]);
  const videoIds = useMemo(() => [...new Set(clips.map((c) => c.mediaId))], [clips]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const mediaId = pickedId && videoIds.includes(pickedId) ? pickedId : videoIds[0] ?? null;
  const media = mediaId ? mediaList.find((m) => m.id === mediaId) : undefined;
  const target = mediaId ? clips.find((c) => c.mediaId === mediaId) ?? null : null;
  const url = mediaId ? urls[mediaId] : undefined;
  // MediaRecorder-made files can report an unknown (Infinity) length at upload: fall back to what the clip plays.
  const durationSec =
    media?.durationSec != null && Number.isFinite(media.durationSec)
      ? media.durationSec
      : target
        ? target.sourceIn + target.duration * (target.speed ?? 1)
        : 0;

  const [method, setMethod] = useState<SplitMethod>("scenes");
  const [sensitivity, setSensitivity] = useState(0.5);
  const [minShot, setMinShot] = useState(1);
  const [every, setEvery] = useState(5);
  const [beatEvery, setBeatEvery] = useState(4);
  const [scan, setScan] = useState<ScanState>({ phase: "idle" });
  const [scanVersion, setScanVersion] = useState(0); // bumps when a scan/beat/server result lands
  const [beatTimes, setBeatTimes] = useState<number[] | null>(null);
  const [beatNote, setBeatNote] = useState<string | null>(null);
  const [plan, setPlan] = useState<SplitPlan | null>(null);
  const [planNote, setPlanNote] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [applied, setApplied] = useState<{ count: number; label: string } | null>(null);
  const [serverOk, setServerOk] = useState(false);
  const [useServer, setUseServer] = useState(false);
  const serverCuts = useRef<Record<string, number[]>>({});
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    void serverSceneSupport().then((ok) => live && setServerOk(ok));
    return () => {
      live = false;
    };
  }, []);

  // A different (or reloaded) video invalidates everything computed for the old one.
  useEffect(() => {
    setPlan(null);
    setThumbs([]);
    setApplied(null);
    setScan(getCachedScan(mediaId ?? "") ? { phase: "ready" } : { phase: "idle" });
    setBeatTimes(null);
  }, [mediaId]);

  // ---- detection (the long-running part) ----
  const detect = useCallback(async () => {
    if (!mediaId || !media || !url) return;
    setApplied(null);
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      if (method === "beats") {
        setBeatNote("Listening for the beat…");
        const res = await detectBeats(mediaId, bridge.files[mediaId] ?? url, durationSec || undefined);
        setBeatNote(res && res.times.length > 1 ? `Found ${res.times.length} beats${res.bpm ? ` (~${res.bpm} BPM)` : ""}.` : "No clear beat in this video's audio.");
        setBeatTimes(res?.times ?? []);
        return;
      }
      if (method !== "scenes") return;
      if (useServer && serverOk && bridge.files[mediaId]) {
        setScan({ phase: "scanning", done: 0, total: 1 });
        const up = await uploadMedia(bridge.files[mediaId]!, ctl.signal);
        const cuts = await detectScenesServer(up.path, sensitivity);
        if (cuts) {
          serverCuts.current[mediaId] = cuts;
          setScan({ phase: "ready" });
          setScanVersion((v) => v + 1);
          return;
        }
        setUseServer(false); // fall through to the in-browser scan
      }
      setScan({ phase: "scanning", done: 0, total: 1 });
      await scanVideoScenes(mediaId, url, durationSec, {
        signal: ctl.signal,
        onProgress: (done, total) => setScan({ phase: "scanning", done, total }),
      });
      setScan({ phase: "ready" });
      setScanVersion((v) => v + 1);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        setScan({ phase: "idle" });
        return;
      }
      setScan({ phase: "error", message: err instanceof Error ? err.message : "Scene detection failed." });
    }
  }, [mediaId, media, url, method, durationSec, bridge.files, useServer, serverOk, sensitivity]);

  // The banner asks for an immediate scan.
  useEffect(() => {
    if (bridge.autoStartToken > consumedToken && mediaId && url && durationSec > 0) {
      consumedToken = bridge.autoStartToken;
      setMethod("scenes");
      void detect();
    }
  }, [bridge.autoStartToken, mediaId, url, durationSec, detect]);

  useEffect(() => () => abort.current?.abort(), []);

  // ---- plan (cheap; re-runs as sliders move) ----
  const transcript = mediaId ? transcripts[mediaId] : undefined;
  useEffect(() => {
    if (!mediaId || durationSec <= 0) {
      setPlan(null);
      return;
    }
    let live = true;
    setPlanNote(null);
    const base = { method, durationSec, sensitivity, minShotSec: minShot } as const;
    const finish = (p: SplitPlan) => live && setPlan(p);
    try {
      if (method === "scenes") {
        const scanned = getCachedScan(mediaId);
        const server = serverCuts.current[mediaId];
        if (!scanned && !server) {
          setPlan(null);
          return;
        }
        if (useServer && server) {
          finish(planSourceSplit({ ...base, sceneCuts: server }));
          return;
        }
        const coarse = cutsFromScan(scanned!, sensitivity, minShot);
        finish(planSourceSplit({ ...base, sceneCuts: coarse.map((c) => c.t) })); // instant preview…
        if (coarse.length > 0 && url) {
          void refineCuts(scanned!, url, coarse) // …then pinned to the exact frames
            .then((refined) => live && finish(planSourceSplit({ ...base, sceneCuts: refined })))
            .catch(() => undefined);
        }
      } else if (method === "sentences" || method === "silence") {
        if (!transcript) {
          setPlan(null);
          setPlanNote("The transcript isn't ready yet — give it a moment.");
          return;
        }
        finish(planSourceSplit({ ...base, transcript }));
      } else if (method === "beats") {
        if (!beatTimes) {
          setPlan(null);
          return;
        }
        finish(planSourceSplit({ ...base, beats: beatTimes, every: beatEvery }));
      } else {
        finish(planSourceSplit({ ...base, every }));
      }
    } catch (err) {
      setPlan(null);
      if (err instanceof SplitPlanError) setPlanNote(err.message);
    }
    return () => {
      live = false;
    };
    // scanVersion: a finished scan/beat/server result must re-plan.
  }, [mediaId, method, sensitivity, minShot, every, beatEvery, durationSec, transcript, beatTimes, useServer, url, scanVersion]);

  // ---- thumbnails (best-effort, debounced) ----
  const planKey = plan ? plan.cuts.join(",") : "";
  useEffect(() => {
    setThumbs([]);
    if (!plan || !url || plan.shots.length < 2) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      const mids = plan.shots.slice(0, 24).map((s) => s.start + Math.min(0.6, (s.end - s.start) / 2));
      void captureThumbs(url, mids, ctl.signal).then(setThumbs).catch(() => undefined);
    }, 350);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, url]);

  // ---- live preview markers on the real timeline ----
  const previewTimes = useMemo(() => {
    if (!plan || !target) return [];
    const out: number[] = [];
    for (const c of plan.cuts) {
      const t = timelineTimeAtSource(target, c);
      if (t !== null) out.push(t);
    }
    return out;
  }, [plan, target]);
  const onPreview = bridge.onPreview;
  useEffect(() => {
    onPreview(previewTimes);
  }, [previewTimes, onPreview]);
  useEffect(() => () => onPreview([]), [onPreview]);

  if (!mediaId || !media || !target) return null;

  const scanning = scan.phase === "scanning";
  const needsDetect = method === "scenes" || method === "beats";
  const canApply = !!plan && plan.cuts.length > 0 && !busy && !scanning;
  const progressPct = scan.phase === "scanning" ? Math.round((scan.done / Math.max(1, scan.total)) * 100) : 0;

  function apply() {
    if (!plan || !target) return;
    const coversWhole = target.sourceIn < 0.05 && Math.abs(target.duration * (target.speed ?? 1) - durationSec) < 0.5;
    const res = splitIntoScenes(doc, {
      mediaId: mediaId ?? undefined,
      sourceCuts: plan.cuts,
      // Labels line up with the plan only when the clip still plays the WHOLE source.
      labels: coversWhole ? plan.shots.map((s) => s.label) : undefined,
      labelPrefix: method === "sentences" ? "Sentence" : method === "scenes" ? "Scene" : "Part",
    });
    if (res.pieces === 0) {
      setPlanNote("Nothing to cut at these settings.");
      return;
    }
    const name = media?.label ?? "your video";
    const summary = `Divided “${name}” into ${res.pieces} clips by ${METHOD_LABEL[method].toLowerCase()} — each is its own clip now; rearrange, trim, delete or restyle any part.`;
    setApplied({ count: res.pieces, label: METHOD_LABEL[method] });
    bridge.onApply(res.doc, summary);
    onPreview([]);
  }

  return (
    <section
      aria-label="Divide into scenes"
      data-testid="scene-split"
      className="border-b border-line-soft bg-panel/30 px-4 py-3"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">divide into clips</span>
        {videoIds.length > 1 && (
          <select
            value={mediaId}
            onChange={(e) => setPickedId(e.target.value)}
            aria-label="Which video to divide"
            className="max-w-[220px] rounded-md border border-line bg-elevated px-2 py-1 text-xs text-text"
          >
            {videoIds.map((id) => (
              <option key={id} value={id}>
                {mediaList.find((m) => m.id === id)?.label ?? id}
              </option>
            ))}
          </select>
        )}
      </div>

      <div role="radiogroup" aria-label="How to divide" className="mb-2 flex flex-wrap gap-1.5">
        {SPLIT_METHODS.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={method === m}
            data-testid={`scene-method-${m}`}
            onClick={() => {
              setMethod(m);
              setApplied(null);
            }}
            className={[
              "rounded-full border px-3 py-1 text-xs transition",
              method === m ? "border-teal/40 bg-teal/10 text-teal" : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
            ].join(" ")}
          >
            {METHOD_LABEL[m]}
          </button>
        ))}
      </div>
      <p className="mb-2 text-[11px] text-faint">{METHOD_HELP[method]}</p>

      <div className="mb-2 grid grid-cols-1 gap-y-1.5">
        {(method === "scenes" || method === "silence") && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Sensitivity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
              aria-label={`Sensitivity: ${Math.round(sensitivity * 100)}%`}
              data-testid="scene-sensitivity"
              style={{ accentColor: "var(--color-teal)" }}
              className="h-1.5 flex-1 cursor-pointer"
            />
            <span className="w-9 text-right tabular-nums text-faint">{Math.round(sensitivity * 100)}%</span>
          </label>
        )}
        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="w-24 shrink-0">Shortest clip</span>
          <input
            type="range"
            min={0.5}
            max={10}
            step={0.5}
            value={minShot}
            onChange={(e) => setMinShot(Number(e.target.value))}
            aria-label={`Shortest clip: ${minShot} seconds`}
            style={{ accentColor: "var(--color-teal)" }}
            className="h-1.5 flex-1 cursor-pointer"
          />
          <span className="w-9 text-right tabular-nums text-faint">{minShot}s</span>
        </label>
        {method === "interval" && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Every</span>
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={every}
              onChange={(e) => setEvery(Math.max(0.5, Number(e.target.value) || 5))}
              aria-label="Seconds between cuts"
              data-testid="scene-every"
              className="w-20 rounded-md border border-line bg-elevated px-2 py-1 text-xs text-text"
            />
            <span className="text-faint">seconds</span>
          </label>
        )}
        {method === "beats" && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Every</span>
            <select
              value={beatEvery}
              onChange={(e) => setBeatEvery(Number(e.target.value))}
              aria-label="Cut on every Nth beat"
              className="rounded-md border border-line bg-elevated px-2 py-1 text-xs text-text"
            >
              {[1, 2, 4, 8].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "beat" : `${n}th beat`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {needsDetect && !scanning && (
          <button
            type="button"
            onClick={() => {
              if (method === "scenes") clearSceneScan(mediaId);
              void detect();
            }}
            disabled={busy || !url}
            data-testid="scene-detect"
            className="rounded-full bg-amber px-3.5 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:opacity-50"
          >
            {method === "scenes" ? (scan.phase === "ready" ? "Re-scan" : "Detect scenes") : "Detect beats"}
          </button>
        )}
        {scanning && (
          <>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPct}
              aria-label="Scanning the video for scene changes"
              className="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-full bg-line"
            >
              <div className="h-full bg-amber transition-[width]" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="text-[11px] tabular-nums text-faint">
              {scan.phase === "scanning" && scan.total > 1 ? `Scanning frames ${scan.done}/${scan.total}` : "Working…"}
            </span>
            <button
              type="button"
              onClick={() => abort.current?.abort()}
              className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted hover:text-text"
            >
              Cancel
            </button>
          </>
        )}
        {method === "scenes" && serverOk && !scanning && (
          <label className="flex items-center gap-1.5 text-[11px] text-faint">
            <input type="checkbox" checked={useServer} onChange={(e) => setUseServer(e.target.checked)} />
            Use server ffmpeg (more precise)
          </label>
        )}
        {method === "beats" && beatNote && <span className="text-[11px] text-faint">{beatNote}</span>}
      </div>

      {scan.phase === "error" && (
        <p role="alert" className="mb-2 text-xs text-danger">
          {scan.message}
        </p>
      )}
      {planNote && <p className="mb-2 text-xs text-faint">{planNote}</p>}

      {plan && (
        <div data-testid="scene-preview">
          <MiniStrip plan={plan} durationSec={durationSec} playheadSrc={playheadSource(target, timeSec)} onSeekSource={(s) => {
            const t = timelineTimeAtSource(target, Math.min(Math.max(s, target.sourceIn + 0.001), target.sourceIn + target.duration * (target.speed ?? 1) - 0.001));
            if (t !== null) onSeek(t);
          }} />
          <p className="mb-1.5 mt-1 text-xs text-muted" data-testid="scene-count">
            {plan.cuts.length === 0
              ? method === "scenes"
                ? "No scene changes at this sensitivity — raise it, or try “Every N seconds”."
                : "Nothing to cut with these settings."
              : `${plan.shots.length} clips · ${plan.cuts.length} cut${plan.cuts.length === 1 ? "" : "s"}`}
          </p>
          {plan.cuts.length > 0 && (
            <ol className="mb-2 grid max-h-40 grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1.5 overflow-y-auto pr-0.5">
              {plan.shots.map((s, i) => (
                <li key={`${s.start}-${i}`}>
                  <button
                    type="button"
                    onClick={() => {
                      const t = timelineTimeAtSource(target, s.start + 0.01);
                      onSeek(t ?? (s.start === 0 ? target.start : target.start));
                    }}
                    title={`${s.label} · ${fmt(s.start)}–${fmt(s.end)}`}
                    className="w-full overflow-hidden rounded-md border border-line bg-elevated text-left transition hover:border-amber/40"
                  >
                    <span className="block aspect-video w-full bg-panel">
                      {thumbs[i] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbs[i]} alt="" className="h-full w-full object-cover" />
                      ) : null}
                    </span>
                    <span className="block truncate px-1.5 pt-1 text-[11px] text-text">{s.label}</span>
                    <span className="block px-1.5 pb-1 text-[10px] tabular-nums text-faint">
                      {fmt(s.start)} · {(s.end - s.start).toFixed(1)}s
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={!canApply}
          data-testid="scene-apply"
          className="rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:opacity-40"
        >
          {plan && plan.cuts.length > 0 ? `Divide into ${plan.shots.length} clips` : "Divide into clips"}
        </button>
        {applied && (
          <>
            <span className="text-xs text-teal" data-testid="scene-applied">
              Done — {applied.count} clips.
            </span>
            <button
              type="button"
              onClick={() => {
                bridge.onUndo();
                setApplied(null);
              }}
              disabled={!bridge.canUndo}
              data-testid="scene-undo"
              className="rounded-full border border-line px-3 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40"
            >
              Undo
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** Source second shown at timeline `t` by the clip (for the mini strip's playhead). */
function playheadSource(clip: VideoClip, t: number): number | null {
  if (t < clip.start || t > clip.start + clip.duration) return null;
  return clip.sourceIn + (t - clip.start) * (clip.speed ?? 1);
}

/** A thin strip of the whole video with each cut as a tick — click to jump. */
function MiniStrip({
  plan,
  durationSec,
  playheadSrc,
  onSeekSource,
}: {
  plan: SplitPlan;
  durationSec: number;
  playheadSrc: number | null;
  onSeekSource: (sourceSec: number) => void;
}) {
  const total = Math.max(0.001, durationSec);
  return (
    <div
      role="list"
      aria-label="Detected cut points"
      className="relative h-7 w-full cursor-pointer overflow-hidden rounded-md border border-line bg-elevated"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeekSource(((e.clientX - r.left) / Math.max(1, r.width)) * total);
      }}
    >
      {plan.shots.map((s, i) => (
        <span
          key={i}
          className={i % 2 ? "bg-teal/10" : "bg-teal/20"}
          style={{ position: "absolute", top: 0, bottom: 0, left: `${(s.start / total) * 100}%`, width: `${((s.end - s.start) / total) * 100}%` }}
        />
      ))}
      {plan.cuts.map((c) => (
        <span
          key={c}
          role="listitem"
          aria-label={`Cut at ${fmt(c)}`}
          data-testid="scene-cut"
          className="absolute top-0 h-full w-0.5 bg-amber"
          style={{ left: `${(c / total) * 100}%` }}
        />
      ))}
      {playheadSrc !== null && (
        <span className="pointer-events-none absolute top-0 h-full w-px bg-text/70" style={{ left: `${(playheadSrc / total) * 100}%` }} />
      )}
    </div>
  );
}
