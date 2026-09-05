"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { docDurationSec, parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";
import { RoomsRail } from "./RoomsRail";
import { DirectorRail } from "./DirectorRail";
import { TopBar } from "./TopBar";
import { Stage } from "./Stage";
import { CutsStrip } from "./CutsStrip";
import { CodeDrawer } from "./CodeDrawer";
import { emptyDoc, fullClipDoc } from "@/lib/doc";
import { askDirector, transcribe } from "@/lib/api";
import { download } from "@/lib/format";
import type { Message } from "@/lib/types";

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

function probeVideo(file: File): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    const url = URL.createObjectURL(file);
    v.onloadedmetadata = () => {
      resolve({ duration: v.duration || 0, width: v.videoWidth || 1920, height: v.videoHeight || 1080 });
      URL.revokeObjectURL(url);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that video file."));
    };
    v.src = url;
  });
}

export function Editor() {
  const [media, setMedia] = useState<MediaAsset | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [doc, setDoc] = useState<EditDoc>(() => emptyDoc());
  const [messages, setMessages] = useState<Message[]>([]);
  const [timeSec, setTimeSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);

  const durationSec = useMemo(() => docDurationSec(doc), [doc]);
  const cutCount = useMemo(
    () => doc.tracks.reduce((n, t) => n + t.clips.filter((c) => c.kind === "video").length, 0),
    [doc],
  );

  const say = (role: Message["role"], text: string, tone?: Message["tone"]) =>
    setMessages((m) => [...m, { id: nextId(), role, text, tone }]);

  // Playback clock.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTimeSec((t) => {
        const nt = t + dt;
        if (nt >= durationSec) {
          setPlaying(false);
          return durationSec;
        }
        return nt;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationSec]);

  // Revoke object URLs on unmount.
  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl); }, [mediaUrl]);

  async function handleFile(file: File) {
    setBusy(true);
    setPlaying(false);
    try {
      const meta = await probeVideo(file);
      const asset: MediaAsset = {
        id: `media-${Date.now()}`,
        kind: "video",
        src: file.name,
        durationSec: Math.round(meta.duration * 1000) / 1000,
        width: meta.width,
        height: meta.height,
        label: file.name,
      };
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      const url = URL.createObjectURL(file);
      setMediaUrl(url);
      setMedia(asset);
      setDoc(fullClipDoc(asset));
      setTimeSec(0);
      say("you", `Added ${file.name}`);

      const tr = await transcribe(asset);
      setTranscript(tr);
      say(
        "director",
        `Loaded “${file.name}” — ${Math.round(asset.durationSec ?? 0)}s, ${tr.segments.length} spoken segments. ` +
          `Tell me what you want, e.g. “cut a 60-second highlight.”`,
        "info",
      );
    } catch (err) {
      say("director", err instanceof Error ? err.message : "Something went wrong loading that file.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleSend(text: string) {
    if (!media || !transcript) return;
    say("you", text);
    setBusy(true);
    setPlaying(false);
    try {
      const res = await askDirector({ request: text, media: [media], transcripts: [transcript], doc });
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
    // Trim/extend the last video clip — the manual control for the ending.
    const clone: EditDoc = structuredClone(doc);
    let last: { start: number; duration: number } | null = null;
    for (const track of clone.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === "video") {
          if (!last || clip.start + clip.duration > last.start + last.duration) last = clip;
        }
      }
    }
    if (!last) return;
    last.duration = Math.max(0.1, Math.round((last.duration + delta) * 1000) / 1000);
    setDoc(parseEditDoc(clone));
  }

  function togglePlay() {
    if (!mediaUrl) return;
    if (!playing && timeSec >= durationSec) setTimeSec(0);
    setPlaying((p) => !p);
  }

  function exportDoc() {
    download(`${doc.meta.title || "cadence"}.editdoc.json`, JSON.stringify(doc, null, 2));
    say("director", "Exported the edit-doc (JSON). Real video export lands with the ffmpeg worker.", "info");
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <RoomsRail />
      <DirectorRail
        messages={messages}
        busy={busy}
        hasMedia={!!media}
        onSend={handleSend}
        onFile={handleFile}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar
          projectTitle={doc.meta.title || "Untitled"}
          mediaLabel={media?.label ?? null}
          durationSec={durationSec}
          cutCount={cutCount}
          codeOpen={codeOpen}
          onToggleCode={() => setCodeOpen((c) => !c)}
          onExport={exportDoc}
          canExport={!!media && durationSec > 0}
        />
        <Stage
          mediaUrl={mediaUrl}
          doc={doc}
          timeSec={timeSec}
          durationSec={durationSec}
          playing={playing}
          onTogglePlay={togglePlay}
          onSeek={(t) => { setPlaying(false); setTimeSec(t); }}
          onNudge={handleNudge}
          canNudge={cutCount > 0}
        />
        <CutsStrip doc={doc} timeSec={timeSec} durationSec={durationSec} onSeek={(t) => { setPlaying(false); setTimeSec(t); }} />
      </main>
      {codeOpen && <CodeDrawer doc={doc} onClose={() => setCodeOpen(false)} />}
    </div>
  );
}
