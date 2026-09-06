"use client";

import { useMemo, useRef, useState } from "react";
import type { EditDoc, MediaAsset } from "@cadence/core";
import type { Transcript, TranscriptSegment } from "@cadence/understanding";
import {
  addCaptions,
  editByTranscript,
  removeSilence,
  fillerCut,
  autoReframe,
  type AspectKey,
  type TranscriptEditMode,
  type TranscriptEditUnit,
} from "@cadence/director";
import { describeDoc } from "@/lib/status";
import { fmtTime } from "@/lib/format";
import { VoiceOverRecorder } from "./VoiceOverRecorder";
import { CaptionStyleSection } from "./CaptionStyle";
import type { BeginPlacement } from "@/lib/placement";

// ---- small shared controls (match RoomPanel's tokens) ----------------------

function Pill({
  onClick,
  disabled,
  active,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={[
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-50",
        active
          ? "border-teal/40 bg-teal/10 text-teal"
          : "border-line bg-elevated text-muted hover:border-amber/40 hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-[92px] shrink-0 text-[10px] uppercase tracking-wider text-faint">{label}</span>
      {children}
    </div>
  );
}

// Aspect targets for auto-reframe, in the order the roadmap asks for.
const REFRAME_ASPECTS: { key: AspectKey; label: string }[] = [
  { key: "9:16", label: "9:16" },
  { key: "1:1", label: "1:1" },
  { key: "4:5", label: "4:5" },
  { key: "16:9", label: "16:9" },
];

interface TranscriptRoomProps {
  doc: EditDoc;
  mediaList: MediaAsset[];
  busy: boolean;
  /** Cached transcripts by media id (fetched server-side via /api/transcribe). */
  transcripts: Record<string, Transcript>;
  /** True when transcripts came from the offline stub (no Whisper installed). */
  approximate: boolean;
  /** Media ids currently being transcribed on demand. */
  transcribing: Record<string, boolean>;
  /** Fetch + cache a transcript for a media (server-side). */
  onEnsureTranscript: (media: MediaAsset) => void;
  /** Apply a fully-formed edit-doc through the undoable commit path. */
  onApplyDoc: (doc: EditDoc, coalesceKey?: string) => void;
  /** Generate an AI (TTS) voice-over; resolves to the message to surface. */
  onGenerateVoiceover: (text: string) => Promise<string>;
  /** Record a manual mic voice-over (the free path). */
  onRecordVoiceover: (file: File, durationSec: number) => void;
  /** Arm an on-preview placement gesture (used by the caption free-placement). */
  onBeginPlacement?: BeginPlacement;
  /** The clip selected on the timeline — enables "this caption only" styling. */
  selectedClipId?: string | null;
}

type Selection =
  | { kind: "segment"; segId: string }
  | { kind: "words"; anchor: number; focus: number }
  | null;

export function TranscriptRoom({
  doc,
  mediaList,
  busy,
  transcripts,
  approximate,
  transcribing,
  onEnsureTranscript,
  onApplyDoc,
  onGenerateVoiceover,
  onRecordVoiceover,
  onBeginPlacement,
  selectedClipId,
}: TranscriptRoomProps) {
  // Transcript editing acts on the primary (first) video clip — the talking-head
  // source. Its edits rebuild the timeline from that clip (like the Director's
  // edit_by_transcript tool), so we scope to one media and say so.
  const videos = mediaList.filter((m) => m.kind === "video");
  const mainMedia = videos[0] ?? null;
  const transcript = mainMedia ? transcripts[mainMedia.id] : undefined;
  const isTranscribing = mainMedia ? !!transcribing[mainMedia.id] : false;

  const [sel, setSel] = useState<Selection>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const dragging = useRef(false);

  // A flat, render-ordered word list so selection ranges are simple indices.
  const flatWords = useMemo(() => {
    if (!transcript) return [] as { text: string; segId: string }[];
    const out: { text: string; segId: string }[] = [];
    for (const seg of transcript.segments) for (const w of seg.words) out.push({ text: w.text, segId: seg.id });
    return out;
  }, [transcript]);

  const wordRange = sel?.kind === "words" ? [Math.min(sel.anchor, sel.focus), Math.max(sel.anchor, sel.focus)] as const : null;

  const selectedPhrase = (): { phrase: string; unit: TranscriptEditUnit } | null => {
    if (!sel) return null;
    if (sel.kind === "segment") {
      const seg = transcript?.segments.find((s) => s.id === sel.segId);
      return seg ? { phrase: seg.text, unit: "segment" } : null;
    }
    if (!wordRange) return null;
    const phrase = flatWords.slice(wordRange[0], wordRange[1] + 1).map((w) => w.text).join(" ");
    return phrase.trim() ? { phrase, unit: "word" } : null;
  };

  const currentAspect = describeDoc(doc).aspect;

  // --- actions --------------------------------------------------------------

  const runTranscriptEdit = (mode: TranscriptEditMode) => {
    if (!mainMedia || !transcript) return;
    const picked = selectedPhrase();
    if (!picked) return;
    const res = editByTranscript(mainMedia, transcript, {
      phrase: picked.phrase,
      mode,
      unit: picked.unit,
      width: doc.meta.width,
      height: doc.meta.height,
      fps: doc.meta.fps,
      title: doc.meta.title,
    });
    if (!res.matched) {
      setStatus({ tone: "warn", text: `Couldn't find “${picked.phrase.slice(0, 40)}” in the transcript.` });
      return;
    }
    onApplyDoc(res.doc);
    setSel(null);
    setStatus({
      tone: "ok",
      text:
        mode === "remove"
          ? `Removed ${res.removed} ${picked.unit === "word" ? "match(es)" : "sentence(s)"} — ${fmtTime(res.removedSec)} shorter. Undo any time.`
          : `Kept only ${res.kept} span(s) — trimmed ${fmtTime(res.removedSec)}. Undo any time.`,
    });
  };

  const removeFiller = () => {
    if (!mainMedia || !transcript) return;
    const res = fillerCut(mainMedia, transcript);
    if (res.kept === 0) {
      setStatus({ tone: "warn", text: "That would remove everything — no filler-light sentences left. Skipped." });
      return;
    }
    onApplyDoc(res.doc);
    setSel(null);
    setStatus({ tone: "ok", text: `Removed filler — dropped ${res.dropped} filler-heavy sentence(s), kept ${res.kept}. Undo any time.` });
  };

  const tightenPauses = () => {
    if (!mainMedia || !transcript) return;
    const res = removeSilence(mainMedia, transcript, {
      width: doc.meta.width,
      height: doc.meta.height,
      fps: doc.meta.fps,
      title: doc.meta.title,
    });
    if (res.gapsDropped === 0) {
      setStatus({ tone: "warn", text: "No long pauses to tighten — the pacing is already tight." });
      return;
    }
    onApplyDoc(res.doc);
    setSel(null);
    setStatus({ tone: "ok", text: `Tightened pauses — dropped ${res.gapsDropped} gap(s), removed ${fmtTime(res.removedSec)} of dead air. Undo any time.` });
  };

  const reframeTo = (aspect: AspectKey) => {
    onApplyDoc(autoReframe(doc, { aspect, pan: true }));
    setStatus({ tone: "ok", text: `Reframed to ${aspect} and centered the frame (free). Undo any time.` });
  };

  const addCaptionsNow = () => {
    if (!transcript) return;
    onApplyDoc(addCaptions(doc, transcript));
    setStatus({ tone: "ok", text: "Captions added from the transcript — style them below. Undo any time." });
  };

  // --- empty / loading states ----------------------------------------------

  if (mediaList.length === 0) {
    return (
      <Wrap>
        <p className="text-xs text-faint">
          Add a video and I’ll transcribe it — then you can edit the footage by editing the words: click a sentence, or drag across words, and choose Remove or Keep only.
        </p>
      </Wrap>
    );
  }

  if (!mainMedia) {
    return (
      <Wrap>
        <p className="text-xs text-faint">Transcript editing needs a video clip. Add one to edit it by its words.</p>
      </Wrap>
    );
  }

  if (!transcript) {
    return (
      <Wrap>
        <Row label="transcript">
          <Pill onClick={() => onEnsureTranscript(mainMedia)} disabled={busy || isTranscribing}>
            {isTranscribing ? "Transcribing…" : "Load transcript"}
          </Pill>
          <span className="text-[11px] text-faint">
            {isTranscribing ? "Reading the audio…" : `Transcribe “${mainMedia.label ?? mainMedia.src}” to edit it by its words.`}
          </span>
        </Row>
      </Wrap>
    );
  }

  const hasSelection = !!selectedPhrase();

  return (
    <Wrap>
      {approximate && (
        <div className="rounded-lg border border-amber/25 bg-amber/10 px-3 py-1.5 text-[11px] text-amber-bright">
          Transcript is approximate — install Whisper (and ffmpeg) for word-accurate editing. Sentence-level edits still work.
        </div>
      )}

      {/* One-tap cleanups */}
      <Row label="clean up">
        <Pill onClick={removeFiller} disabled={busy} title="Drop sentences dominated by um / uh / like / you know…">
          Remove filler words
        </Pill>
        <Pill onClick={tightenPauses} disabled={busy} title="Keep every word, drop the dead air between sentences">
          Tighten pauses
        </Pill>
        {videos.length > 1 && (
          <span className="text-[11px] text-faint">Edits apply to “{mainMedia.label ?? mainMedia.src}”.</span>
        )}
      </Row>

      {/* Selection actions */}
      <Row label="selection">
        <Pill onClick={() => runTranscriptEdit("remove")} disabled={busy || !hasSelection} title="Cut the selected words/sentence out of the video">
          Remove
        </Pill>
        <Pill onClick={() => runTranscriptEdit("keep")} disabled={busy || !hasSelection} title="Keep only the selected words/sentence">
          Keep only this
        </Pill>
        <Pill onClick={() => setSel(null)} disabled={!sel}>Clear</Pill>
        <span className="text-[11px] text-faint">
          {hasSelection
            ? sel?.kind === "segment"
              ? "Whole sentence selected — Remove/Keep every sentence with this text."
              : "Phrase selected — Remove/Keep every occurrence of it."
            : "Click a sentence, or drag across words, to select."}
        </span>
      </Row>

      {status && (
        <p className={status.tone === "ok" ? "text-[11px] text-teal" : "text-[11px] text-amber-bright"}>{status.text}</p>
      )}

      {/* The transcript itself — click a sentence, drag across words */}
      <div
        role="group"
        aria-label="Transcript — click a sentence or drag across words to select"
        className="max-h-[26vh] select-none space-y-2 overflow-y-auto rounded-lg border border-line bg-panel/50 p-3 leading-relaxed"
        onPointerUp={() => (dragging.current = false)}
        onPointerLeave={() => (dragging.current = false)}
      >
        {transcript.segments.map((seg) => (
          <SegmentRow
            key={seg.id}
            seg={seg}
            flatWords={flatWords}
            sel={sel}
            wordRange={wordRange}
            dragging={dragging}
            onSelectSegment={(id) => setSel({ kind: "segment", segId: id })}
            onWordDown={(gi) => {
              dragging.current = true;
              setSel({ kind: "words", anchor: gi, focus: gi });
            }}
            onWordEnter={(gi) => {
              if (dragging.current) setSel((s) => (s && s.kind === "words" ? { ...s, focus: gi } : s));
            }}
          />
        ))}
      </div>

      {/* Auto-reframe */}
      <Row label="reframe">
        {REFRAME_ASPECTS.map((a) => (
          <Pill key={a.key} onClick={() => reframeTo(a.key)} disabled={busy} active={currentAspect === a.key}>
            {a.label}
          </Pill>
        ))}
        <Pill
          onClick={() => {}}
          disabled
          title="Subject tracking is a paid upgrade — free reframe centers the frame"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 018 0v4" />
          </svg>
          Keep subject centered (tracking) · Upgrade
        </Pill>
        <span className="text-[11px] text-faint">Free reframe centers the frame with a gentle settle-pan.</span>
      </Row>

      {/* Caption styling + position (custom subtitle look) */}
      <CaptionStyleSection
        doc={doc}
        busy={busy}
        onApplyDoc={onApplyDoc}
        onBeginPlacement={onBeginPlacement}
        selectedClipId={selectedClipId}
        canAddCaptions={!!transcript}
        onAddCaptions={addCaptionsNow}
        transcript={transcript}
      />

      {/* AI voice-over (money-gated) + free mic path */}
      <VoiceOverComposer
        busy={busy}
        onGenerate={onGenerateVoiceover}
        onRecord={onRecordVoiceover}
      />
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div aria-label="Words" className="flex max-h-full flex-col gap-2 overflow-y-auto border-b border-line-soft bg-panel/30 px-4 py-2">
      {children}
    </div>
  );
}

// A transcript sentence: a clickable header dot + its words. Word indices are
// the flat render index so a drag builds a phrase selection across the sentence.
function SegmentRow({
  seg,
  flatWords,
  sel,
  wordRange,
  dragging,
  onSelectSegment,
  onWordDown,
  onWordEnter,
}: {
  seg: TranscriptSegment;
  flatWords: { text: string; segId: string }[];
  sel: Selection;
  wordRange: readonly [number, number] | null;
  dragging: React.MutableRefObject<boolean>;
  onSelectSegment: (id: string) => void;
  onWordDown: (gi: number) => void;
  onWordEnter: (gi: number) => void;
}) {
  // Global index of this segment's first word in the flat list.
  const base = useMemo(() => flatWords.findIndex((w) => w.segId === seg.id), [flatWords, seg.id]);
  const segActive = sel?.kind === "segment" && sel.segId === seg.id;

  return (
    <p className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
      <button
        type="button"
        onClick={() => onSelectSegment(seg.id)}
        aria-pressed={segActive}
        aria-label={`Select the whole sentence starting “${seg.text.slice(0, 30)}”`}
        title="Select this whole sentence"
        className={[
          "mr-1 mt-0.5 h-3.5 w-3.5 shrink-0 self-center rounded-full border transition",
          segActive ? "border-teal bg-teal/40" : "border-line bg-elevated hover:border-amber/60",
        ].join(" ")}
      />
      {seg.words.map((w, i) => {
        const gi = base >= 0 ? base + i : -1;
        const inWordSel = !!wordRange && gi >= wordRange[0] && gi <= wordRange[1];
        const highlighted = segActive || inWordSel;
        return (
          <span
            key={`${seg.id}:${i}`}
            role="button"
            tabIndex={0}
            aria-pressed={highlighted}
            onPointerDown={(e) => {
              e.preventDefault();
              if (gi >= 0) onWordDown(gi);
            }}
            onPointerEnter={() => {
              if (gi >= 0) onWordEnter(gi);
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && gi >= 0) {
                e.preventDefault();
                dragging.current = false;
                onWordDown(gi);
              }
            }}
            className={[
              "cursor-text rounded px-0.5 text-sm transition",
              highlighted ? "bg-teal/25 text-text" : "text-muted hover:bg-line/60 hover:text-text",
            ].join(" ")}
          >
            {w.text}
          </span>
        );
      })}
    </p>
  );
}

// AI voice-over composer + the free mic path, cross-linked.
function VoiceOverComposer({
  busy,
  onGenerate,
  onRecord,
}: {
  busy: boolean;
  onGenerate: (text: string) => Promise<string>;
  onRecord: (file: File, durationSec: number) => void;
}) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const generate = async () => {
    if (!text.trim() || working) return;
    setWorking(true);
    setNote(null);
    try {
      const msg = await onGenerate(text);
      setNote(msg);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-faint">AI voice-over</span>
        <VoiceOverRecorder disabled={busy} onRecorded={onRecord} />
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="Type a script to narrate — e.g. “In this video, I’ll show you three quick edits.”"
        aria-label="Voice-over script"
        className="w-full resize-y rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-text placeholder:text-faint"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={busy || working || !text.trim()}
          className="shrink-0 rounded-full bg-amber px-4 py-1.5 text-xs font-semibold text-onaccent transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {working ? "Generating…" : "Generate voice-over"}
        </button>
        <span className="text-[11px] text-faint">
          AI TTS is a paid upgrade — no charge until it’s configured. Prefer your own voice? Record a free one (top-right).
        </span>
      </div>
      {note && <p className="text-[11px] text-amber-bright">{note}</p>}
    </div>
  );
}
