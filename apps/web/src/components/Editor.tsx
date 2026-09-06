"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { docDurationSec, parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
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
import { emptyDoc, fullClipDoc } from "@/lib/doc";
import { askDirector, transcribe, uploadMedia, exportVideo } from "@/lib/api";
import { download, downloadBlob } from "@/lib/format";
import { useDocHistory } from "@/lib/history";
import { applyExportSettings, type ExportSettings } from "@/lib/export-presets";
import type { Message } from "@/lib/types";

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
  // The doc is the single source of truth; ALL mutations route through the
  // history helper's `commit`/`reset` so undo/redo stays consistent.
  const seedDoc = useMemo(() => initialDoc ?? emptyDoc(), [initialDoc]);
  const { doc, commit, reset, undo, redo, canUndo, canRedo } = useDocHistory(seedDoc);
  const [messages, setMessages] = useState<Message[]>([]);
  const [timeSec, setTimeSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Which room's contextual panel is showing (default "edit" = QuickActions).
  const [room, setRoom] = useState<RoomKey>("edit");
  // Preview source audio; default UNMUTED so users hear the video's own audio.
  const [muted, setMuted] = useState(false);
  // Keyboard-shortcuts help popover.
  const [helpOpen, setHelpOpen] = useState(false);
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
    for (const track of doc.tracks) {
      if (track.id === "broll") continue;
      for (const c of track.clips) {
        if (c.kind === "video") { mediaId = c.mediaId; break; }
      }
      if (mediaId) break;
    }
    if (!mediaId) return null;
    return { mediaId, file: files[mediaId], url: urls[mediaId] };
  }, [doc, files, urls]);
  const mode: "video" | "images" | "none" = mediaList.some((m) => m.kind === "video")
    ? "video"
    : mediaList.some((m) => m.kind === "image")
      ? "images"
      : "none";

  const say = (role: Message["role"], text: string, tone?: Message["tone"]) => {
    const id = nextId(); // outside the updater → stable under StrictMode double-invoke
    setMessages((m) => [...m, { id, role, text, tone }]);
  };

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
    setPlaying(false);
    try {
      if (videos.length > 0) {
        const file = videos[0]!;
        const url = URL.createObjectURL(file);
        const meta = await probeVideo(url);
        const asset: MediaAsset = {
          id: `media-${Date.now()}`,
          kind: "video",
          src: file.name,
          durationSec: Math.round(meta.duration * 1000) / 1000,
          width: meta.width,
          height: meta.height,
          label: file.name,
        };
        for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
        setUrls({ [asset.id]: url });
        setFiles({ [asset.id]: file });
        setMediaList([asset]);
        setTranscripts({});
        reset(fullClipDoc(asset)); // new media → fresh doc + fresh history
        setTimeSec(0);
        say("you", `Added ${file.name}`);
        const tr = await transcribe(asset);
        setTranscripts({ [asset.id]: tr });
        say(
          "director",
          `Loaded “${file.name}” — ${Math.round(asset.durationSec ?? 0)}s, ${tr.segments.length} spoken segments. ` +
            `Tell me what you want, or tap a one-tap action above.`,
          "info",
        );
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
        say("director", `Loaded ${added.map((a) => `“${a.label}”`).join(", ")}. Say “add background music” to lay it under your video.`, "info");
      }
    } catch (err) {
      say("director", err instanceof Error ? err.message : "Something went wrong loading that.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleSend(text: string) {
    if (mediaList.length === 0) return;
    say("you", text);
    setBusy(true);
    setPlaying(false);
    try {
      const res = await askDirector({ request: text, media: mediaList, transcripts: Object.values(transcripts), doc });
      commit(parseEditDoc(res.doc)); // undoable Director edit
      setTimeSec(0);
      say("director", res.summary, "edit");
    } catch (err) {
      say("director", err instanceof Error ? err.message : "I couldn't make that edit.", "error");
    } finally {
      setBusy(false);
    }
  }

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
    if (mediaList.length === 0) return;
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
    if (mediaList.length === 0 || durationSec <= 0) return;
    // `overrideDoc` lets the export-options popover render freshly-applied
    // quality settings without waiting for a state re-render.
    const source = overrideDoc ?? doc;
    setBusy(true);
    setPlaying(false);
    say("director", "Rendering your video with ffmpeg…", "info");
    try {
      // Upload every media file used by the doc; map id → server path.
      const srcById: Record<string, string> = {};
      for (const media of mediaList) {
        const file = files[media.id];
        if (!file) throw new Error(`Missing the uploaded file for ${media.label ?? media.id}.`);
        const { path } = await uploadMedia(file);
        srcById[media.id] = path;
      }
      const serverDoc: EditDoc = structuredClone(source);
      serverDoc.media = serverDoc.media.map((m) => ({ ...m, src: srcById[m.id] ?? m.src }));

      const result = await exportVideo(serverDoc);
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
      say("director", err instanceof Error ? err.message : "Export failed.", "error");
    } finally {
      setBusy(false);
    }
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
    if (mediaList.length > 0 && typeof window !== "undefined" && !window.confirm("Start over? This clears the timeline and all loaded media.")) return;
    for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
    setUrls({});
    setFiles({});
    setMediaList([]);
    setTranscripts({});
    setPlaying(false);
    setTimeSec(0);
    reset(emptyDoc());
    say("director", "Cleared the timeline — added media and edits are gone. Add a video or photos to begin again.", "info");
  }

  /** Download the current edit-doc as a portable JSON copy (a new project seed). */
  function duplicateProject() {
    const name = (doc.meta.title || "cadence").replace(/\s+/g, "-");
    download(`${name}-copy.editdoc.json`, JSON.stringify(doc, null, 2));
    say("director", "Downloaded a copy of this project's edit-doc (JSON).", "info");
  }

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
    if (mediaList.length === 0) return;
    if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); togglePlay(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); seek(timeSec - (e.shiftKey ? 5 : 1)); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); seek(timeSec + (e.shiftKey ? 5 : 1)); return; }
    if (e.key === "Home") { e.preventDefault(); seek(0); return; }
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
        <DirectorRail messages={messages} busy={busy} hasMedia={mediaList.length > 0} onSend={handleSend} onFiles={handleFiles} />
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
          mediaLabel={mode === "images" ? `${mediaList.length} photos` : mediaList[0]?.label ?? null}
          durationSec={durationSec}
          cutCount={visualClipCount}
          codeOpen={codeOpen}
          onToggleCode={() => setCodeOpen((c) => !c)}
          doc={doc}
          onExport={exportWith}
          canExport={mediaList.length > 0 && durationSec > 0}
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
        <AppliedStatus doc={doc} hasMedia={mediaList.length > 0} />
        {room === "edit" ? (
          <QuickActions mode={mediaList.length === 0 ? "none" : mode} busy={busy} onAction={handleSend} />
        ) : (
          <RoomPanel
            room={room}
            doc={doc}
            mediaList={mediaList}
            busy={busy}
            onAction={handleSend}
            onApplyDoc={(d) => commit(d, { coalesce: "color" })}
            onFiles={handleFiles}
            onExport={exportDoc}
            canExport={mediaList.length > 0 && durationSec > 0}
            muted={muted}
            onToggleMute={() => setMuted((m) => !m)}
          />
        )}
        <Stage
          urls={urls}
          hasMedia={mediaList.length > 0}
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
          <CutsStrip doc={doc} timeSec={timeSec} durationSec={durationSec} onSeek={seek} waveform={waveformSource} />
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
    </div>
  );
}
