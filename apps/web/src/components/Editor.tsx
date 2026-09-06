"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { docDurationSec, parseEditDoc, type EditDoc, type MediaAsset, type TrackKind } from "@cadence/core";
import { addTrack, removeTrack, setTrack, reorderTrack, moveClipToTrack } from "@cadence/director";
import type { TrackFlag } from "./CutsStrip";
import type { Transcript } from "@cadence/understanding";
import { RoomsRail, type RoomKey } from "./RoomsRail";
import { RoomPanel } from "./RoomPanel";
import { DirectorRail } from "./DirectorRail";
import { ResizeHandle } from "./ResizeHandle";
import { TopBar } from "./TopBar";
import { QuickActions } from "./QuickActions";
import { AppliedStatus } from "./AppliedStatus";
import { Stage } from "./Stage";
import { CutsStrip } from "./CutsStrip";
import { CodeDrawer } from "./CodeDrawer";
import { ShortcutsHelp } from "./ShortcutsHelp";
import {
  emptyDoc,
  combinedVideoDoc,
  appendVideos,
  moveMediaInDoc,
  removeMediaFromDoc,
  addVoiceover,
  addMusic,
  setTrackVolume,
} from "@/lib/doc";
import { UndoToast } from "./UndoToast";
import {
  findClip,
  isMainSequentialTrack,
  splitClip,
  trimClip,
  reorderClip,
  moveClip,
  rippleDeleteClip,
  deleteClip,
  duplicateClip,
  setClipVolume,
  type TrimEdge,
} from "@/lib/edit-ops";
import { askDirector, transcribe, uploadMedia, exportVideo } from "@/lib/api";
import { download, downloadBlob } from "@/lib/format";
import { useDocHistory } from "@/lib/history";
import { applyExportSettings, type ExportSettings } from "@/lib/export-presets";
import type { Message } from "@/lib/types";
import type { PlacementMode, PlacementRequest, PlacementResult } from "@/lib/placement";

let msgSeq = 0;
// Collision-proof message id. MUST be generated OUTSIDE a setState updater —
// React dev (StrictMode) double-invokes updaters, so a counter bump inside one
// yields duplicate ids (and duplicate React keys). Prefer crypto.randomUUID.
const nextId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m${Date.now()}-${++msgSeq}`;

// Side-panel width bounds (px).
const RAIL_MIN = 300;
const RAIL_MAX = 620;
const CODE_MIN = 320;
const CODE_MAX = 760;
const TL_MIN = 90;
const TL_MAX = 460;
const clampPx = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;

function probeVideo(url: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve({ duration: v.duration || 0, width: v.videoWidth || 1920, height: v.videoHeight || 1080 });
    v.onerror = () => reject(new Error("Could not read that video file."));
    v.src = url;
  });
}

function probeImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 1920, height: img.naturalHeight || 1080 });
    img.onerror = () => reject(new Error("Could not read an image file."));
    img.src = url;
  });
}

function probeAudio(url: string): Promise<{ duration: number }> {
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve({ duration: a.duration || 0 });
    a.onerror = () => reject(new Error("Could not read that audio file."));
    a.src = url;
  });
}

export interface EditorProps {
  /** Seed the editor with a persisted edit-doc (e.g. a project's latest version). */
  initialDoc?: EditDoc;
  /** Title shown in the top bar (falls back to the doc's title). */
  projectName?: string;
  /**
   * If provided, a "Save" button appears in the top bar and calls this with the
   * current doc. Omit it (e.g. the scratch /editor) to keep the editor stateless.
   */
  onSave?: (doc: EditDoc) => Promise<void>;
  /** Optional link back (e.g. to /dashboard) shown in the top bar. */
  backHref?: string;
  /** A one-line banner (e.g. a graceful-degradation notice). */
  notice?: string | null;
}

export function Editor({ initialDoc, projectName, onSave, backHref, notice }: EditorProps = {}) {
  // When bound to a project we seed from its saved doc + media metadata. The
  // media binaries aren't persisted, so preview stays blank until re-added — the
  // doc still loads, edits still apply, and Save writes a new version.
  const [mediaList, setMediaList] = useState<MediaAsset[]>(() => initialDoc?.media ?? []);
  const [urls, setUrls] = useState<Record<string, string>>({});
  // Raw uploaded File objects, kept by media id so Export can POST them to the
  // server (object URLs alone can't be re-read server-side).
  const [files, setFiles] = useState<Record<string, File>>({});
  const [transcripts, setTranscripts] = useState<Record<string, Transcript>>({});
  // True when the last transcript came from the offline StubTranscriber (no
  // Whisper installed) — the Words room shows an "approximate" banner.
  const [transcriptApproximate, setTranscriptApproximate] = useState(false);
  // Media ids currently being transcribed on demand (Words room loading state).
  const [transcribing, setTranscribing] = useState<Record<string, boolean>>({});
  // The doc is the single source of truth; ALL mutations route through the
  // history helper's `commit`/`reset` so undo/redo stays consistent.
  const seedDoc = useMemo(() => initialDoc ?? emptyDoc(), [initialDoc]);
  const { doc, commit, reset, undo, redo, canUndo, canRedo } = useDocHistory(seedDoc);
  const [messages, setMessages] = useState<Message[]>([]);
  const [timeSec, setTimeSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  // A short verb describing what `busy` is doing ("Applying edit…", "Rendering…")
  // so the Director rail narrates progress instead of a generic spinner.
  const [busyLabel, setBusyLabel] = useState<string>("");
  // A transient "<summary> · Undo" toast shown after a Director edit lands.
  const [toast, setToast] = useState<{ id: string; text: string } | null>(null);
  // A request typed BEFORE media exists — queued here and fired once media loads.
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  // Abort controller for an in-flight export (upload + render), for a Cancel.
  const exportAbort = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Which room's contextual panel is showing (default "edit" = QuickActions).
  const [room, setRoom] = useState<RoomKey>("edit");
  // Preview source audio; default UNMUTED so users hear the video's own audio.
  const [muted, setMuted] = useState(false);
  // Keyboard-shortcuts help popover.
  const [helpOpen, setHelpOpen] = useState(false);
  // Directly-editable timeline: the selected clip + timeline markers. Markers
  // are editor-only (there is no schema field for them) — see the report.
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [markers, setMarkers] = useState<number[]>([]);
  // On-preview placement (Walkthrough room): the armed gesture + a resolver so the
  // Demo room can `await` the fractions the Stage overlay reports.
  const [placement, setPlacement] = useState<PlacementRequest | null>(null);
  const placementResolve = useRef<((r: PlacementResult | null) => void) | null>(null);
  // Resizable side panels (persisted per browser).
  const [railWidth, setRailWidth] = useState(380);
  const [codeWidth, setCodeWidth] = useState(440);
  const [timelineHeight, setTimelineHeight] = useState(150);

  const urlsRef = useRef(urls);
  urlsRef.current = urls;
  // Mirror `files` in a ref: the `handleFiles(files)` param shadows the state.
  const filesRef = useRef(files);
  filesRef.current = files;

  const durationSec = useMemo(() => docDurationSec(doc), [doc]);
  const visualClipCount = useMemo(
    () => doc.tracks.reduce((n, t) => n + t.clips.filter((c) => c.kind === "video" || c.kind === "image").length, 0),
    [doc],
  );
  const hasVideoClip = useMemo(
    () => doc.tracks.some((t) => t.clips.some((c) => c.kind === "video")),
    [doc],
  );
  // Source for the timeline audio waveform: the base (full-frame) video's own
  // audio — same media the Stage previews, so peaks line up with the cuts. We
  // deliberately prefer this over any separate music track. `null` when there's
  // no video (e.g. a photo slideshow) → the waveform simply isn't drawn.
  const waveformSource = useMemo(() => {
    let mediaId: string | null = null;
    // Prefer the base (full-frame) video's own audio.
    for (const track of doc.tracks) {
      if (track.id === "broll") continue;
      for (const c of track.clips) {
        if (c.kind === "video") { mediaId = c.mediaId; break; }
      }
      if (mediaId) break;
    }
    // Fallback: a voice-over / music-only project still gets a waveform.
    if (!mediaId) {
      for (const track of doc.tracks) {
        for (const c of track.clips) {
          if (c.kind === "audio") { mediaId = c.mediaId; break; }
        }
        if (mediaId) break;
      }
    }
    if (!mediaId) return null;
    return { mediaId, file: files[mediaId], url: urls[mediaId] };
  }, [doc, files, urls]);
  // The project's full media set = the registry (mediaList) plus anything the doc
  // references that isn't in it (e.g. media restored by undo after a remove). Used
  // for every "what's in the project" read so undo/redo stays consistent.
  const projectMedia = useMemo(() => {
    const ids = new Set(mediaList.map((m) => m.id));
    const extras = doc.media.filter((m) => !ids.has(m.id));
    return extras.length ? [...mediaList, ...extras] : mediaList;
  }, [mediaList, doc.media]);
  const hasMedia = projectMedia.length > 0;
  const mode: "video" | "images" | "none" = projectMedia.some((m) => m.kind === "video")
    ? "video"
    : projectMedia.some((m) => m.kind === "image")
      ? "images"
      : "none";

  const say = (role: Message["role"], text: string, tone?: Message["tone"]) => {
    const id = nextId(); // outside the updater → stable under StrictMode double-invoke
    setMessages((m) => [...m, { id, role, text, tone }]);
  };

  /** Show a transient "<summary> · Undo" confirmation for the last Director edit. */
  const showUndoToast = (text: string) => setToast({ id: nextId(), text });

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTimeSec((t) => {
        const nt = t + dt;
        if (nt >= durationSec) { setPlaying(false); return durationSec; }
        return nt;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationSec]);

  useEffect(() => () => { for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u); }, []);

  // Restore persisted panel widths once (client only; guard against blocked storage).
  useEffect(() => {
    try {
      const r = localStorage.getItem("cadence:railW");
      if (r) setRailWidth(clampPx(Number(r), RAIL_MIN, RAIL_MAX));
      const c = localStorage.getItem("cadence:codeW");
      if (c) setCodeWidth(clampPx(Number(c), CODE_MIN, CODE_MAX));
      const t = localStorage.getItem("cadence:tlH");
      if (t) setTimelineHeight(clampPx(Number(t), TL_MIN, TL_MAX));
    } catch {
      /* storage unavailable — keep defaults */
    }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("cadence:railW", String(railWidth)); } catch { /* noop */ }
  }, [railWidth]);
  useEffect(() => {
    try { localStorage.setItem("cadence:codeW", String(codeWidth)); } catch { /* noop */ }
  }, [codeWidth]);
  useEffect(() => {
    try { localStorage.setItem("cadence:tlH", String(timelineHeight)); } catch { /* noop */ }
  }, [timelineHeight]);

  async function handleFiles(files: File[]) {
    const videos = files.filter((f) => f.type.startsWith("video"));
    const imgs = files.filter((f) => f.type.startsWith("image"));
    const audios = files.filter((f) => f.type.startsWith("audio"));
    setBusy(true);
    setBusyLabel(
      videos.length > 0 ? "Loading video…" : imgs.length > 0 ? "Building slideshow…" : "Adding audio…",
    );
    setPlaying(false);
    try {
      if (videos.length > 0) {
        // Probe every selected video and register each as its own media asset.
        const newUrls: Record<string, string> = {};
        const newFiles: Record<string, File> = {};
        const added: MediaAsset[] = [];
        for (let i = 0; i < videos.length; i++) {
          const file = videos[i]!;
          const url = URL.createObjectURL(file);
          const meta = await probeVideo(url);
          const asset: MediaAsset = {
            id: `media-${Date.now()}-${i}`,
            kind: "video",
            src: file.name,
            durationSec: Math.round(meta.duration * 1000) / 1000,
            width: meta.width,
            height: meta.height,
            label: file.name,
          };
          newUrls[asset.id] = url;
          newFiles[asset.id] = file;
          added.push(asset);
        }

        const appending = hasVideoClip; // an existing video timeline → append, don't reset
        if (appending) {
          setUrls((u) => ({ ...u, ...newUrls }));
          setFiles((f) => ({ ...f, ...newFiles }));
          setMediaList((list) => [...list, ...added]);
          commit(appendVideos(doc, added)); // undoable append onto the combined timeline
        } else {
          // Fresh video project — replace whatever was loaded (revoke old blobs).
          for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
          setUrls(newUrls);
          setFiles(newFiles);
          setMediaList(added);
          setTranscripts({});
          reset(combinedVideoDoc(added)); // one combined doc + fresh history
        }
        setTimeSec(0);
        say("you", added.length === 1 ? `Added ${added[0]!.label}` : `Added ${added.length} videos`);

        // Transcribe each video (per media) so highlights & captions work per clip.
        const results = await Promise.all(
          added.map((a) =>
            transcribe(a)
              .then((r) => [a.id, r.transcript, r.approximate] as const)
              .catch(() => null),
          ),
        );
        const okResults = results.filter(
          (r): r is readonly [string, Transcript, boolean] => r !== null,
        );
        if (okResults.length > 0) {
          setTranscripts((prev) => {
            const next = { ...prev };
            for (const [id, tr] of okResults) next[id] = tr;
            return next;
          });
          // Any stubbed transcript in the batch → mark approximate (Whisper absent).
          if (okResults.some(([, , approx]) => approx)) setTranscriptApproximate(true);
        }

        if (added.length === 1) {
          const only = added[0]!;
          const tr = okResults.find(([id]) => id === only.id)?.[1];
          say(
            "director",
            `Loaded “${only.label}” — ${Math.round(only.durationSec ?? 0)}s, ${tr?.segments.length ?? 0} spoken segments. ` +
              `Tell me what you want, or tap a one-tap action above.`,
            "info",
          );
        } else {
          const totalSec = added.reduce((s, a) => s + (a.durationSec ?? 0), 0);
          const segs = okResults.reduce((s, [, tr]) => s + tr.segments.length, 0);
          say(
            "director",
            `${appending ? "Appended" : "Combined"} ${added.length} videos ${appending ? "onto" : "into"} one timeline — ` +
              `${Math.round(totalSec)}s total, transcribed each (${segs} spoken segments) so highlights & captions work per clip.`,
            "info",
          );
        }
      } else if (imgs.length > 0) {
        const nextUrls = { ...urlsRef.current };
        const nextFiles = { ...filesRef.current };
        const added: MediaAsset[] = [];
        for (let i = 0; i < imgs.length; i++) {
          const file = imgs[i]!;
          const url = URL.createObjectURL(file);
          const dim = await probeImage(url);
          const asset: MediaAsset = {
            id: `img-${Date.now()}-${i}`,
            kind: "image",
            src: file.name,
            width: dim.width,
            height: dim.height,
            label: file.name,
          };
          nextUrls[asset.id] = url;
          nextFiles[asset.id] = file;
          added.push(asset);
        }
        const allImages = [...mediaList.filter((m) => m.kind === "image"), ...added];
        setUrls(nextUrls);
        setFiles(nextFiles);
        setMediaList(allImages);
        say("you", `Added ${imgs.length} photo${imgs.length > 1 ? "s" : ""}`);
        const res = await askDirector({ request: "make a slideshow from my photos", media: allImages, transcripts: [], doc: emptyDoc() });
        reset(parseEditDoc(res.doc)); // photos loaded → fresh doc + fresh history
        setTimeSec(0);
        say("director", `${res.summary} Ask for “make it vertical”, “warm look”, or “make it 4K”.`, "edit");
      } else if (audios.length > 0) {
        // Add audio as a music source alongside existing footage (doc unchanged).
        const nextUrls = { ...urlsRef.current };
        const nextFiles = { ...filesRef.current };
        const added: MediaAsset[] = [];
        for (let i = 0; i < audios.length; i++) {
          const file = audios[i]!;
          const url = URL.createObjectURL(file);
          const meta = await probeAudio(url);
          const asset: MediaAsset = {
            id: `audio-${Date.now()}-${i}`,
            kind: "audio",
            src: file.name,
            durationSec: Math.round(meta.duration * 1000) / 1000,
            label: file.name,
          };
          nextUrls[asset.id] = url;
          nextFiles[asset.id] = file;
          added.push(asset);
        }
        setUrls(nextUrls);
        setFiles(nextFiles);
        setMediaList((list) => [...list, ...added]);
        say("you", `Added ${audios.length} audio file${audios.length > 1 ? "s" : ""}`);

        // Auto-attach the first audio as background music the moment it's added —
        // no second "add background music" step. Works for photo slideshows too
        // (P0-3). Voice-over recording stays a separate path (addVoiceoverFile).
        const hasVisual =
          mediaList.some((m) => m.kind === "video" || m.kind === "image") ||
          doc.tracks.some((t) => t.clips.some((c) => c.kind === "video" || c.kind === "image"));
        const music = added[0]!;
        if (hasVisual) {
          commit(addMusic(doc, music));
          const surface = mode === "images" ? "slideshow" : "video";
          const extra =
            added.length > 1
              ? ` (${added.length - 1} more audio file${added.length > 2 ? "s" : ""} added to your media — swap it in from the Audio room.)`
              : "";
          say(
            "director",
            `Laid “${music.label}” under your ${surface} as background music — you'll hear it in the preview now. Tune its volume in the Audio room.${extra}`,
            "edit",
          );
          showUndoToast("Background music added");
        } else {
          say(
            "director",
            `Loaded ${added.map((a) => `“${a.label}”`).join(", ")}. Add a video or photos and I'll lay it underneath as music.`,
            "info",
          );
        }
      }
    } catch (err) {
      say("director", err instanceof Error ? err.message : "Something went wrong loading that.", "error");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  /**
   * Run a Director request against the current media. When `echo` is false the
   * user's line has already been shown (a queued describe-first request), so we
   * don't repeat it. Commits the result (undoable) and shows an Undo toast.
   */
  async function runDirector(text: string, echo = true) {
    if (echo) say("you", text);
    setBusy(true);
    setBusyLabel("Applying your edit…");
    setPlaying(false);
    try {
      const res = await askDirector({ request: text, media: projectMedia, transcripts: Object.values(transcripts), doc });
      commit(parseEditDoc(res.doc)); // undoable Director edit
      setTimeSec(0);
      say("director", res.summary, "edit");
      showUndoToast(res.summary);
    } catch (err) {
      say("director", err instanceof Error ? err.message : "I couldn't make that edit.", "error");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  /**
   * Composer/QuickActions entry point. Describe-first: if there's no media yet,
   * queue the request and fire it automatically once footage loads instead of
   * dropping it — the composer is never a dead end.
   */
  function handleSend(text: string) {
    if (projectMedia.length === 0) {
      setPendingRequest(text);
      say("you", text);
      say("director", "Got it — add a video or photos and I'll do this the moment they load.", "info");
      return;
    }
    void runDirector(text);
  }

  // Fire a queued describe-first request once media is present and we're idle.
  useEffect(() => {
    if (!pendingRequest || !hasMedia || busy) return;
    const req = pendingRequest;
    setPendingRequest(null);
    say("director", `Running your request now: “${req}”`, "info");
    void runDirector(req, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRequest, hasMedia, busy]);

  function handleNudge(delta: number) {
    const clone: EditDoc = structuredClone(doc);
    let last: { start: number; duration: number } | null = null;
    for (const track of clone.tracks)
      for (const clip of track.clips)
        if (clip.kind === "video" || clip.kind === "image")
          if (!last || clip.start + clip.duration > last.start + last.duration) last = clip;
    if (!last) return;
    last.duration = Math.max(0.1, Math.round((last.duration + delta) * 1000) / 1000);
    commit(parseEditDoc(clone), { coalesce: "nudge" }); // merge repeated nudges into one step
  }

  function togglePlay() {
    if (!hasMedia) return;
    if (!playing && timeSec >= durationSec) setTimeSec(0);
    setPlaying((p) => !p);
  }

  /** Fallback: download the edit-doc as JSON (always available, no ffmpeg). */
  function exportJson(source: EditDoc = doc) {
    download(`${source.meta.title || "cadence"}.editdoc.json`, JSON.stringify(source, null, 2));
    say("director", "Exported the edit-doc (JSON) as a fallback.", "info");
  }

  /**
   * Real .mp4 export: upload each media File → build a doc whose media.src are the
   * returned server paths → POST to /api/export → download the mp4. If ffmpeg
   * isn't installed the route returns 501; we surface the install hint and fall
   * back to the JSON edit-doc export.
   */
  async function exportDoc(overrideDoc?: EditDoc) {
    if (!hasMedia || durationSec <= 0) return;
    // `overrideDoc` lets the export-options popover render freshly-applied
    // quality settings without waiting for a state re-render.
    const source = overrideDoc ?? doc;
    const controller = new AbortController();
    exportAbort.current = controller;
    setBusy(true);
    setExporting(true);
    setPlaying(false);
    try {
      // Upload every media file used by the doc; map id → server path. This is
      // the determinate phase — narrate it as "Uploading media (i/n)…".
      const srcById: Record<string, string> = {};
      const total = source.media.length;
      for (let i = 0; i < source.media.length; i++) {
        const media = source.media[i]!;
        const file = files[media.id];
        if (!file) throw new Error(`Missing the uploaded file for ${media.label ?? media.id}.`);
        setBusyLabel(total > 1 ? `Uploading media (${i + 1}/${total})…` : "Uploading media…");
        const { path } = await uploadMedia(file, controller.signal);
        srcById[media.id] = path;
      }
      const serverDoc: EditDoc = structuredClone(source);
      serverDoc.media = serverDoc.media.map((m) => ({ ...m, src: srcById[m.id] ?? m.src }));

      setBusyLabel("Rendering .mp4 with ffmpeg…");
      say("director", "Rendering your video with ffmpeg…", "info");
      const result = await exportVideo(serverDoc, controller.signal);
      if (result.ok) {
        downloadBlob(`${source.meta.title || "cadence"}.mp4`, result.blob);
        say("director", "Exported a real .mp4 (free ffmpeg path — faithful, no content changes).", "edit");
      } else if (result.unavailable) {
        say("director", `${result.message} Meanwhile, here's the edit-doc (JSON).`, "info");
        exportJson(source);
      } else {
        say("director", `Export failed: ${result.message}`, "error");
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        say("director", "Export cancelled.", "info");
      } else {
        say("director", err instanceof Error ? err.message : "Export failed.", "error");
      }
    } finally {
      exportAbort.current = null;
      setExporting(false);
      setBusy(false);
      setBusyLabel("");
    }
  }

  /** Cancel an in-flight export (upload or render), if one is running. */
  function cancelExport() {
    exportAbort.current?.abort();
  }

  /** Persist the current doc as a new version (project-bound editor only). */
  async function handleSave() {
    if (!onSave) return;
    setSaveState("saving");
    try {
      await onSave(doc);
      setSaveState("saved");
      say("director", "Saved a new version of this project.", "info");
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
    } catch (err) {
      setSaveState("error");
      say("director", err instanceof Error ? err.message : "Couldn't save.", "error");
    }
  }

  const seek = (t: number) => {
    setPlaying(false);
    setTimeSec(Math.max(0, Math.min(t, durationSec)));
  };

  /** Rename the project — writes doc.meta.title through the undoable commit path. */
  function renameProject(title: string) {
    commit((prev) => {
      const t = title.trim() || "Untitled";
      if (t === prev.meta.title) return prev;
      const clone: EditDoc = structuredClone(prev);
      clone.meta.title = t;
      return parseEditDoc(clone);
    });
  }

  /** Apply the export-options popover's settings to the doc, then export. */
  function exportWith(settings: ExportSettings) {
    const next = applyExportSettings(doc, settings);
    commit(next); // undoable + reflected in the Applied strip / Deliver room
    void exportDoc(next);
  }

  /** Clear the timeline and start a fresh, empty project (destructive → confirm). */
  function startOver() {
    if (hasMedia && typeof window !== "undefined" && !window.confirm("Start over? This clears the timeline and all loaded media.")) return;
    for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
    setUrls({});
    setFiles({});
    setMediaList([]);
    setTranscripts({});
    setPlaying(false);
    setTimeSec(0);
    setSelectedClipId(null);
    setMarkers([]);
    reset(emptyDoc());
    say("director", "Cleared the timeline — added media and edits are gone. Add a video or photos to begin again.", "info");
  }

  /** Download the current edit-doc as a portable JSON copy (a new project seed). */
  function duplicateProject() {
    const name = (doc.meta.title || "cadence").replace(/\s+/g, "-");
    download(`${name}-copy.editdoc.json`, JSON.stringify(doc, null, 2));
    say("director", "Downloaded a copy of this project's edit-doc (JSON).", "info");
  }

  // ---- Media room (clip manager) -------------------------------------------

  /** Move a media's clip earlier/later on the timeline (undoable, re-lays cuts). */
  function reorderMedia(mediaId: string, dir: "up" | "down") {
    setPlaying(false);
    commit(moveMediaInDoc(doc, mediaId, dir));
    setMediaList((list) => {
      const i = list.findIndex((m) => m.id === mediaId);
      const j = dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  /** Remove a media and its clips (undoable); keep its blob so undo can restore it. */
  function removeMedia(mediaId: string) {
    setPlaying(false);
    commit(removeMediaFromDoc(doc, mediaId));
    setMediaList((list) => list.filter((m) => m.id !== mediaId));
    setTimeSec(0);
  }

  // ---- Audio room -----------------------------------------------------------

  /** Register a recorded/added voice-over as an audio clip on the voiceover track. */
  async function addVoiceoverFile(file: File, durationSec: number) {
    const url = URL.createObjectURL(file);
    const asset: MediaAsset = {
      id: `voiceover-${Date.now()}`,
      kind: "audio",
      src: file.name,
      durationSec: Math.round(durationSec * 1000) / 1000,
      label: file.name.startsWith("voiceover-") ? "Voice-over" : file.name,
    };
    setUrls((u) => ({ ...u, [asset.id]: url }));
    setFiles((f) => ({ ...f, [asset.id]: file }));
    setMediaList((list) => [...list, asset]);
    commit(addVoiceover(doc, asset)); // undoable; renderer mixes it on export
    say("director", `Added a voice-over (${Math.round(asset.durationSec ?? 0)}s) on its own track. It plays over your video and mixes in on export.`, "edit");
  }

  /** Set the volume of every audio clip on a track (music / voiceover) — undoable. */
  function setAudioTrackVolume(trackId: string, volume: number) {
    commit(setTrackVolume(doc, trackId, volume), { coalesce: `vol-${trackId}` });
  }

  // ---- Words room (transcript) ---------------------------------------------

  /**
   * Ensure a media has a cached transcript, fetching it via /api/transcribe on
   * demand (e.g. a project seeded from a saved doc, or a failed auto-transcribe).
   * Transcription happens server-side — we never import @cadence/understanding
   * values into the client. No-op when already cached.
   */
  async function ensureTranscript(media: MediaAsset) {
    if (transcripts[media.id] || transcribing[media.id]) return;
    setTranscribing((t) => ({ ...t, [media.id]: true }));
    try {
      const { transcript, approximate } = await transcribe(media);
      setTranscripts((prev) => ({ ...prev, [media.id]: transcript }));
      if (approximate) setTranscriptApproximate(true);
    } catch (err) {
      say("director", err instanceof Error ? err.message : "Couldn't transcribe that clip.", "error");
    } finally {
      setTranscribing((t) => {
        const next = { ...t };
        delete next[media.id];
        return next;
      });
    }
  }

  /**
   * AI voice-over (money-gated TTS). Routes through the Director's
   * generate_voiceover tool via /api/director. TTS defaults to provider "none",
   * so this returns a graceful "no TTS provider configured" message — we surface
   * it verbatim and only commit when a track was actually added.
   */
  async function generateVoiceover(text: string): Promise<string> {
    const clean = text.trim();
    if (!clean) return "Type what you want the voice-over to say first.";
    setBusy(true);
    setBusyLabel("Generating voice-over…");
    try {
      const res = await askDirector({
        request: `voice this over: "${clean}"`,
        media: projectMedia,
        transcripts: Object.values(transcripts),
        doc,
      });
      // A successful TTS run reports a generate_voiceover tool call; the gated
      // path adds none, so we avoid an empty undo step and just return the note.
      const added = res.toolCalls.some((c) => c.name === "generate_voiceover");
      if (added) {
        commit(parseEditDoc(res.doc));
        showUndoToast(res.summary);
      }
      say("director", res.summary, added ? "edit" : "info");
      return res.summary;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't generate a voice-over.";
      say("director", msg, "error");
      return msg;
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  // ---- Direct timeline editing (all route through commit → undo/redo) -------

  /** The clip a split/delete should act on: the selection, else the active main clip. */
  function splitTargetId(): string | null {
    if (selectedClipId && findClip(doc, selectedClipId)) return selectedClipId;
    // Fall back to the main-track clip under the playhead.
    for (const track of doc.tracks) {
      if (!isMainSequentialTrack(track)) continue;
      for (const c of track.clips) {
        if ((c.kind === "video" || c.kind === "image") && timeSec >= c.start && timeSec < c.start + c.duration) return c.id;
      }
    }
    return null;
  }

  /** Drag-trim a clip edge; coalesced so a whole drag is one undo step. */
  function trimClipEdge(clipId: string, edge: TrimEdge, edgeTime: number, coalesceKey: string) {
    setPlaying(false);
    commit(trimClip(doc, clipId, edge, edgeTime), { coalesce: coalesceKey });
  }

  function splitClipAt(clipId: string, atSec: number) {
    setPlaying(false);
    commit(splitClip(doc, clipId, atSec));
  }

  function reorderClipTo(clipId: string, toSeqIndex: number) {
    setPlaying(false);
    commit(reorderClip(doc, clipId, toSeqIndex));
  }

  function moveClipDir(clipId: string, dir: "earlier" | "later") {
    setPlaying(false);
    commit(moveClip(doc, clipId, dir));
  }

  function duplicateSelectedClip(clipId: string) {
    setPlaying(false);
    commit(duplicateClip(doc, clipId));
  }

  function rippleDeleteSelectedClip(clipId: string) {
    setPlaying(false);
    commit(rippleDeleteClip(doc, clipId));
    if (clipId === selectedClipId) setSelectedClipId(null);
  }

  function deleteSelectedClip(clipId: string) {
    setPlaying(false);
    commit(deleteClip(doc, clipId));
    if (clipId === selectedClipId) setSelectedClipId(null);
  }

  /** Set a single clip's volume (or mute = 0); coalesced per clip. */
  function setSelectedClipVolume(clipId: string, volume: number, coalesceKey: string) {
    commit(setClipVolume(doc, clipId, volume), { coalesce: coalesceKey });
  }

  // ---- Track management (all pure @cadence/director fns → commit → undo) -----

  /** Add an empty visual/overlay or audio track (undoable). Visual layers are
   *  kept grouped above the base footage and below the audio tracks. */
  function addTrackOfKind(kind: TrackKind) {
    setPlaying(false);
    if (kind === "visual") {
      // Insert just above the topmost visual track so visuals stay contiguous.
      let lastVisual: string | undefined;
      for (const t of doc.tracks) if (t.kind === "visual") lastVisual = t.id;
      commit(addTrack(doc, { kind, afterTrackId: lastVisual }));
    } else {
      commit(addTrack(doc, { kind }));
    }
  }

  /** Remove a track and its clips (undoable); the header guards base/non-empty. */
  function removeTrackById(trackId: string) {
    setPlaying(false);
    try {
      commit(removeTrack(doc, trackId));
    } catch (err) {
      say("director", err instanceof Error ? err.message : "Couldn't remove that track.", "error");
    }
  }

  /** Rename a track (header label only) — undoable. */
  function renameTrack(trackId: string, name: string) {
    commit(setTrack(doc, trackId, { name }));
  }

  /** Toggle one of a track's boolean flags (hidden/locked/muted/solo) — undoable. */
  function setTrackFlag(trackId: string, flag: TrackFlag, value: boolean) {
    commit(setTrack(doc, trackId, { [flag]: value }));
  }

  /** Move a track to a new z-index in the doc's `tracks` array — undoable. */
  function reorderTrackTo(trackId: string, toIndex: number) {
    setPlaying(false);
    try {
      commit(reorderTrack(doc, trackId, toIndex));
    } catch (err) {
      say("director", err instanceof Error ? err.message : "Couldn't reorder that track.", "error");
    }
  }

  /** Move a clip onto another track at a (snapped) start — undoable. */
  function moveClipToTrackAt(clipId: string, toTrackId: string, toStartSec?: number) {
    setPlaying(false);
    try {
      commit(moveClipToTrack(doc, clipId, toTrackId, toStartSec));
    } catch (err) {
      say("director", err instanceof Error ? err.message : "Couldn't move that clip.", "error");
    }
  }

  // ---- On-preview placement (Walkthrough room) ------------------------------

  /**
   * Arm an on-preview placement gesture and return a promise that resolves with
   * the composition fractions the Stage overlay reports (or null if cancelled).
   * Arming a new gesture cancels any prior one; playback stops so the frame the
   * user annotates holds still.
   */
  function beginPlacement(mode: PlacementMode, hint: string): Promise<PlacementResult | null> {
    placementResolve.current?.(null); // cancel any pending gesture
    setPlaying(false);
    return new Promise((resolve) => {
      placementResolve.current = resolve;
      setPlacement({ mode, hint });
    });
  }

  /** Resolve the armed placement (from the Stage overlay) and tear it down. */
  function finishPlacement(result: PlacementResult | null) {
    const resolve = placementResolve.current;
    placementResolve.current = null;
    setPlacement(null);
    resolve?.(result);
  }

  /** Add/remove editor-only markers (jump targets) at the playhead. */
  function addMarker() {
    const t = Math.round(timeSec * 1000) / 1000;
    setMarkers((ms) => (ms.some((m) => Math.abs(m - t) < 0.02) ? ms : [...ms, t].sort((a, b) => a - b)));
  }
  function removeMarker(t: number) {
    setMarkers((ms) => ms.filter((m) => m !== t));
  }

  // Keep the selection valid: if the selected clip vanishes (ripple-delete, a
  // Director rewrite, start-over), clear it so the inspector never dangles.
  useEffect(() => {
    if (selectedClipId && !findClip(doc, selectedClipId)) setSelectedClipId(null);
  }, [doc, selectedClipId]);

  // Keyboard shortcuts. The ref always holds the latest closures, so we bind the
  // window listener exactly once. Shortcuts are ignored while typing in a field.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.isContentEditable ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        (target.tagName === "INPUT" &&
          !["range", "checkbox", "radio", "button", "submit", "color"].includes(
            (target as HTMLInputElement).type,
          )));
    const mod = e.metaKey || e.ctrlKey;

    // Undo / redo (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z, Ctrl+Y) — never while typing.
    if (mod && (e.key === "z" || e.key === "Z")) {
      if (typing) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      if (typing) return;
      e.preventDefault();
      redo();
      return;
    }
    if (typing || mod || e.altKey) return;

    if (e.key === "?") { e.preventDefault(); setHelpOpen((h) => !h); return; }
    if (!hasMedia) return;
    if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); togglePlay(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); seek(timeSec - (e.shiftKey ? 5 : 1)); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); seek(timeSec + (e.shiftKey ? 5 : 1)); return; }
    if (e.key === "Home") { e.preventDefault(); seek(0); return; }
    // Timeline editing.
    if (e.key === "s" || e.key === "S") {
      const id = splitTargetId();
      if (id) { e.preventDefault(); splitClipAt(id, timeSec); }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedClipId) {
      e.preventDefault();
      rippleDeleteSelectedClip(selectedClipId);
      return;
    }
    if (e.key === "m" || e.key === "M") { e.preventDefault(); addMarker(); return; }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <RoomsRail room={room} onRoomChange={setRoom} />
      <div
        className="h-full w-full shrink-0 md:w-[var(--rail-w)]"
        style={{ "--rail-w": `${railWidth}px` } as CSSProperties}
      >
        <DirectorRail
          messages={messages}
          busy={busy}
          busyLabel={busyLabel}
          hasMedia={hasMedia}
          onSend={handleSend}
          onFiles={handleFiles}
          onCancel={exporting ? cancelExport : undefined}
        />
      </div>
      <ResizeHandle
        className="hidden md:block"
        ariaLabel="Resize the chat panel"
        onDelta={(dx) => setRailWidth((w) => clampPx(w + dx, RAIL_MIN, RAIL_MAX))}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {notice && (
          <div className="border-b border-amber/25 bg-amber/10 px-4 py-2 text-xs text-amber-bright">
            {notice}
          </div>
        )}
        <TopBar
          title={doc.meta.title || projectName || "Untitled"}
          onRename={renameProject}
          mediaLabel={mode === "images" ? `${projectMedia.filter((m) => m.kind === "image").length} photos` : projectMedia.find((m) => m.kind === "video")?.label ?? projectMedia[0]?.label ?? null}
          durationSec={durationSec}
          cutCount={visualClipCount}
          codeOpen={codeOpen}
          onToggleCode={() => setCodeOpen((c) => !c)}
          doc={doc}
          onExport={exportWith}
          canExport={hasMedia && durationSec > 0}
          busy={busy}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          onStartOver={startOver}
          onDuplicate={duplicateProject}
          onShowShortcuts={() => setHelpOpen(true)}
          backHref={backHref}
          onSave={onSave ? handleSave : undefined}
          saveState={saveState}
        />
        <AppliedStatus doc={doc} hasMedia={hasMedia} />
        {room === "edit" ? (
          <QuickActions mode={hasMedia ? mode : "none"} busy={busy} onAction={handleSend} />
        ) : (
          <RoomPanel
            room={room}
            doc={doc}
            mediaList={projectMedia}
            urls={urls}
            busy={busy}
            onAction={handleSend}
            onApplyDoc={(d, coalesceKey) => commit(d, coalesceKey ? { coalesce: coalesceKey } : undefined)}
            onFiles={handleFiles}
            onExport={exportDoc}
            canExport={hasMedia && durationSec > 0}
            timeSec={timeSec}
            muted={muted}
            onToggleMute={() => setMuted((m) => !m)}
            onReorderMedia={reorderMedia}
            onRemoveMedia={removeMedia}
            onRecordVoiceover={addVoiceoverFile}
            onSetTrackVolume={setAudioTrackVolume}
            transcripts={transcripts}
            transcriptApproximate={transcriptApproximate}
            transcribing={transcribing}
            onEnsureTranscript={ensureTranscript}
            onGenerateVoiceover={generateVoiceover}
            onBeginPlacement={beginPlacement}
          />
        )}
        <Stage
          urls={urls}
          hasMedia={hasMedia}
          doc={doc}
          timeSec={timeSec}
          durationSec={durationSec}
          playing={playing}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onNudge={handleNudge}
          canNudge={hasVideoClip}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
          placement={placement}
          onFinishPlacement={finishPlacement}
        />
        <ResizeHandle
          orientation="horizontal"
          className="hidden md:block"
          ariaLabel="Resize the timeline"
          onDelta={(dy) => setTimelineHeight((h) => clampPx(h - dy, TL_MIN, TL_MAX))}
        />
        <div
          className="shrink-0 overflow-y-auto md:h-[var(--tl-h)]"
          style={{ "--tl-h": `${timelineHeight}px` } as CSSProperties}
        >
          <CutsStrip
            doc={doc}
            timeSec={timeSec}
            durationSec={durationSec}
            onSeek={seek}
            waveform={waveformSource}
            edit={{
              selectedClipId,
              onSelectClip: setSelectedClipId,
              onTrim: trimClipEdge,
              onReorder: reorderClipTo,
              onSplitAt: splitClipAt,
              onDuplicate: duplicateSelectedClip,
              onRippleDelete: rippleDeleteSelectedClip,
              onDelete: deleteSelectedClip,
              onSetClipVolume: setSelectedClipVolume,
              onMove: moveClipDir,
              markers,
              onAddMarker: addMarker,
              onRemoveMarker: removeMarker,
              onAddTrack: addTrackOfKind,
              onRemoveTrack: removeTrackById,
              onRenameTrack: renameTrack,
              onSetTrackFlag: setTrackFlag,
              onReorderTrack: reorderTrackTo,
              onMoveClipToTrack: moveClipToTrackAt,
            }}
          />
        </div>
      </main>
      {codeOpen && (
        <>
          <ResizeHandle
            className="hidden md:block"
            ariaLabel="Resize the code panel"
            onDelta={(dx) => setCodeWidth((w) => clampPx(w - dx, CODE_MIN, CODE_MAX))}
          />
          <div
            className="h-full w-full shrink-0 md:w-[var(--code-w)]"
            style={{ "--code-w": `${codeWidth}px` } as CSSProperties}
          >
            <CodeDrawer doc={doc} onClose={() => setCodeOpen(false)} />
          </div>
        </>
      )}
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <UndoToast toast={toast} onUndo={undo} onDismiss={() => setToast(null)} />
    </div>
  );
}
