"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { docDurationSec, parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";
import { RoomsRail } from "./RoomsRail";
import { DirectorRail } from "./DirectorRail";
import { TopBar } from "./TopBar";
import { QuickActions } from "./QuickActions";
import { Stage } from "./Stage";
import { CutsStrip } from "./CutsStrip";
import { CodeDrawer } from "./CodeDrawer";
import { emptyDoc, fullClipDoc } from "@/lib/doc";
import { askDirector, transcribe } from "@/lib/api";
import { download } from "@/lib/format";
import type { Message } from "@/lib/types";

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

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

export function Editor() {
  const [mediaList, setMediaList] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [transcripts, setTranscripts] = useState<Record<string, Transcript>>({});
  const [doc, setDoc] = useState<EditDoc>(() => emptyDoc());
  const [messages, setMessages] = useState<Message[]>([]);
  const [timeSec, setTimeSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);

  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  const durationSec = useMemo(() => docDurationSec(doc), [doc]);
  const visualClipCount = useMemo(
    () => doc.tracks.reduce((n, t) => n + t.clips.filter((c) => c.kind === "video" || c.kind === "image").length, 0),
    [doc],
  );
  const hasVideoClip = useMemo(
    () => doc.tracks.some((t) => t.clips.some((c) => c.kind === "video")),
    [doc],
  );
  const mode: "video" | "images" | "none" = mediaList.some((m) => m.kind === "video")
    ? "video"
    : mediaList.some((m) => m.kind === "image")
      ? "images"
      : "none";

  const say = (role: Message["role"], text: string, tone?: Message["tone"]) =>
    setMessages((m) => [...m, { id: nextId(), role, text, tone }]);

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

  async function handleFiles(files: File[]) {
    const videos = files.filter((f) => f.type.startsWith("video"));
    const imgs = files.filter((f) => f.type.startsWith("image"));
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
        setMediaList([asset]);
        setTranscripts({});
        setDoc(fullClipDoc(asset));
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
          added.push(asset);
        }
        const allImages = [...mediaList.filter((m) => m.kind === "image"), ...added];
        setUrls(nextUrls);
        setMediaList(allImages);
        say("you", `Added ${imgs.length} photo${imgs.length > 1 ? "s" : ""}`);
        const res = await askDirector({ request: "make a slideshow from my photos", media: allImages, transcripts: [], doc: emptyDoc() });
        setDoc(parseEditDoc(res.doc));
        setTimeSec(0);
        say("director", `${res.summary} Ask for “make it vertical”, “warm look”, or “make it 4K”.`, "edit");
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
      setDoc(parseEditDoc(res.doc));
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
    setDoc(parseEditDoc(clone));
  }

  function togglePlay() {
    if (mediaList.length === 0) return;
    if (!playing && timeSec >= durationSec) setTimeSec(0);
    setPlaying((p) => !p);
  }

  function exportDoc() {
    download(`${doc.meta.title || "cadence"}.editdoc.json`, JSON.stringify(doc, null, 2));
    say("director", "Exported the edit-doc (JSON). Real video export lands with the ffmpeg worker.", "info");
  }

  const seek = (t: number) => { setPlaying(false); setTimeSec(t); };

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <RoomsRail />
      <DirectorRail messages={messages} busy={busy} hasMedia={mediaList.length > 0} onSend={handleSend} onFiles={handleFiles} />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar
          projectTitle={doc.meta.title || "Untitled"}
          mediaLabel={mode === "images" ? `${mediaList.length} photos` : mediaList[0]?.label ?? null}
          durationSec={durationSec}
          cutCount={visualClipCount}
          codeOpen={codeOpen}
          onToggleCode={() => setCodeOpen((c) => !c)}
          onExport={exportDoc}
          canExport={mediaList.length > 0 && durationSec > 0}
        />
        <QuickActions mode={mediaList.length === 0 ? "none" : mode} busy={busy} onAction={handleSend} />
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
        />
        <CutsStrip doc={doc} timeSec={timeSec} durationSec={durationSec} onSeek={seek} />
      </main>
      {codeOpen && <CodeDrawer doc={doc} onClose={() => setCodeOpen(false)} />}
    </div>
  );
}
