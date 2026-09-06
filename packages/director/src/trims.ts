/**
 * Pure roll / slip / slide trim ops — the three "advanced" trims CapCut/Premiere/
 * Resolve editors reach for, expressed (like every other Cadence edit) as
 * `(doc, …) => EditDoc` pure functions: `structuredClone` in, mutate the clone,
 * re-parse through the schema out, so the result is always a valid, fully-defaulted
 * doc. They are the shared spine behind both the Director tools (roll_edit /
 * slip_edit / slide_edit) and the timeline UI's modifier-key trim modes.
 *
 * They operate on the ADJACENT clips of a MAIN sequential visual track (the
 * magnetic, gap-closing footage/photo lane — `isMainVisualTrack`), never the
 * overlay lanes (titles/captions/b-roll/…). No schema change is needed: each op
 * only adjusts existing `start` / `duration` / `sourceIn` fields.
 *
 * SCHEMA NOTE — nothing here changes the schema; these are the same fields
 * `trimClip`/`splitClip` already move.
 *
 * SOURCE MAPPING — a video clip consumes `duration * speed` seconds of SOURCE from
 * `sourceIn` (see `sourceTimeAt`/`sourceSpanSec` in core). So a boundary shift of
 * `delta` TIMELINE seconds maps to `delta * speed` SOURCE seconds. Slip/roll/slide
 * respect `speed`. `reversed` clips keep the SAME source-window math (the window
 * stays within `[0, media.durationSec]`); the head/tail VISUAL meaning is mirrored
 * for a reversed clip — a documented limitation, since the ops move the source
 * WINDOW, not the playback direction. Images carry no source and are unbounded.
 */
import {
  parseEditDoc,
  type EditDoc,
  type ImageClip,
  type VideoClip,
} from "@cadence/core";
import { isMainVisualTrack } from "./edits";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Smallest timeline `duration` (seconds) any clip may be trimmed to — kept in sync
 * with the client `edit-ops`' `MIN_CLIP_SEC`. Exported so the web wave's roll/slip/
 * slide UI clamps to the exact same floor the engine does.
 */
export const MIN_CLIP_SEC = 0.05;

/** A clip that can sit on a main sequential VISUAL track (video or image). */
type SeqVisualClip = VideoClip | ImageClip;

/** A mutable clip reference inside a structuredClone (safe to mutate). */
type MutClip = {
  id: string;
  kind: string;
  start: number;
  duration: number;
  sourceIn?: number;
  speed?: number;
  reversed?: boolean;
  transitionInSec?: number;
  mediaId?: string;
};

/** Source duration (seconds) of the media a clip references, or `null` if unknown. */
function mediaDurationSec(doc: EditDoc, mediaId?: string): number | null {
  if (!mediaId) return null;
  const m = doc.media.find((x) => x.id === mediaId);
  return m?.durationSec != null ? m.durationSec : null;
}

/** Effective source-per-timeline-second rate for a clip (video honors `speed`). */
function srcRate(clip: MutClip): number {
  return clip.kind === "video" ? clip.speed ?? 1 : 1;
}

/**
 * Largest TIMELINE `duration` a clip may occupy given how much SOURCE remains after
 * its `sourceIn`. Video honors `speed`; audio is 1:1; images (and clips whose media
 * duration is unknown) are unbounded (`Infinity`).
 */
function maxTimelineDuration(doc: EditDoc, clip: MutClip): number {
  if (clip.kind !== "video") return Infinity; // images have no source cap here
  const md = mediaDurationSec(doc, clip.mediaId);
  if (md == null) return Infinity;
  return Math.max(MIN_CLIP_SEC, (md - (clip.sourceIn ?? 0)) / srcRate(clip));
}

/**
 * The lowest (most-negative) `delta` allowed by the INCOMING clip's head having to
 * stay at/after source 0. Video/audio: `-sourceIn / rate`; images carry no source,
 * so their head is unbounded (`-Infinity`).
 */
function incomingSourceFloor(clip: MutClip): number {
  if (clip.kind === "image") return -Infinity;
  return -((clip.sourceIn ?? 0) / srcRate(clip));
}

/**
 * Re-lay a track's video/image clips gaplessly in array order, honoring each clip's
 * `transitionInSec` as an OVERLAP with the previous clip (hard cuts land back-to-
 * back; crossfades keep their overlap). The FIRST sequential clip keeps its current
 * start (the track's outer-left anchor — never forced to 0), and every later clip
 * chains off it. Mutates the clips in place. This is the exact overlap geometry the
 * rest of the editor uses, so preview↔canvas↔export stay in agreement.
 */
function relayGapless(clips: MutClip[]): void {
  let prev: MutClip | null = null;
  for (const clip of clips) {
    if (clip.kind !== "video" && clip.kind !== "image") continue;
    if (prev) {
      const overlap = clip.transitionInSec && clip.transitionInSec > 0 ? clip.transitionInSec : 0;
      clip.start = round(Math.max(0, prev.start + prev.duration - overlap));
    }
    prev = clip;
  }
}

/** The main sequential visual track carrying `clipId`, its clips, and the index. */
interface Located {
  clone: EditDoc;
  seq: MutClip[]; // the video/image clips on the track, in array order
  index: number; // position of clipId within `seq`
}

/**
 * Locate `clipId` on a MAIN sequential VISUAL track (video/image) and return the
 * ordered sequential clips + the clip's index. Returns null when the clip does not
 * exist, is not video/image, or is on an overlay / audio / locked track — the caller
 * turns that into a safe no-op (the doc unchanged).
 */
function locate(doc: EditDoc, clipId: string): Located | null {
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) {
    if (track.kind !== "visual" || !isMainVisualTrack(track.id) || track.locked) continue;
    const seq = (track.clips as unknown as MutClip[]).filter(
      (c) => c.kind === "video" || c.kind === "image",
    );
    const index = seq.findIndex((c) => c.id === clipId);
    if (index >= 0) return { clone, seq, index };
  }
  return null;
}

/**
 * ROLL the cut between `clipId` and its NEXT neighbour on the main track: shift the
 * shared boundary by `deltaSec`. The OUTGOING clip (`clipId`) grows/shrinks by
 * `+delta` (its out-point moves — it shows more/less of its tail, `sourceIn`
 * unchanged); the INCOMING neighbour shrinks/grows by `-delta` and its head moves
 * (`sourceIn += delta * speed`, so the media it now begins with is continuous with
 * what its head previously showed). Both neighbours' OUTER edges and the TOTAL
 * timeline length stay fixed.
 *
 * `deltaSec` is clamped so neither side drops below `MIN_CLIP_SEC` and so neither
 * side overruns its source (the outgoing tail must fit the media; the incoming head
 * must stay at/after source 0). No next neighbour ⇒ a safe no-op (doc unchanged).
 * Positive `delta` moves the cut LATER (outgoing grows); negative moves it EARLIER.
 * The track is re-laid gaplessly afterwards. Pure + re-parsed through the schema.
 */
export function rollEdit(doc: EditDoc, clipId: string, deltaSec: number): EditDoc {
  const found = locate(doc, clipId);
  if (!found) return parseEditDoc(structuredClone(doc));
  const { clone, seq, index } = found;
  const A = seq[index]!; // outgoing
  const B = seq[index + 1]; // incoming (next)
  if (!B) return parseEditDoc(clone); // last clip has no next neighbour → no-op

  const lo = Math.max(MIN_CLIP_SEC - A.duration, incomingSourceFloor(B));
  const hi = Math.min(B.duration - MIN_CLIP_SEC, maxTimelineDuration(clone, A) - A.duration);
  if (hi < lo) return parseEditDoc(clone); // no room to roll
  const delta = clamp(round(deltaSec), lo, hi);

  A.duration = round(A.duration + delta); // outgoing: out-point moves, sourceIn fixed
  B.duration = round(B.duration - delta); // incoming: shorter/longer
  if (B.kind === "video" || B.kind === "audio") {
    B.sourceIn = round(Math.max(0, (B.sourceIn ?? 0) + delta * srcRate(B))); // head moves
  }

  relayGapless(seq);
  return parseEditDoc(clone);
}

/**
 * SLIP `clipId`: shift WHAT THE CLIP SHOWS by `deltaSec` (source seconds) while its
 * timeline `start` and `duration` stay fixed — only `sourceIn` changes. Neighbours
 * are untouched (no reflow needed). `sourceIn` is clamped so the clip's source
 * window `[sourceIn, sourceIn + duration*speed]` stays inside `[0, media.duration]`.
 * A positive `delta` reveals LATER source (slips the window forward); negative
 * reveals earlier source. Images / text / solids carry no source ⇒ a safe no-op.
 * Pure + re-parsed through the schema.
 */
export function slipEdit(doc: EditDoc, clipId: string, deltaSec: number): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  let target: MutClip | null = null;
  for (const track of clone.tracks) {
    if (track.kind !== "visual" || !isMainVisualTrack(track.id) || track.locked) continue;
    for (const clip of track.clips as unknown as MutClip[]) {
      if (clip.id === clipId && clip.kind === "video") target = clip;
    }
  }
  if (!target) return parseEditDoc(clone); // no source to slip → no-op

  const span = target.duration * srcRate(target); // source seconds the window covers
  const md = mediaDurationSec(clone, target.mediaId);
  const hiSourceIn = md == null ? Infinity : Math.max(0, md - span);
  target.sourceIn = round(clamp((target.sourceIn ?? 0) + deltaSec, 0, hiSourceIn));
  return parseEditDoc(clone);
}

/**
 * SLIDE `clipId` along the timeline by `deltaSec`: the clip keeps its own `duration`
 * and content (its `sourceIn` is untouched — the same frames slide to a new time);
 * the PREVIOUS neighbour absorbs the move by growing/shrinking its tail
 * (`duration += delta`, `sourceIn` fixed) and the NEXT neighbour absorbs it by
 * moving its head (`duration -= delta`, `sourceIn += delta * speed`). The clip's own
 * duration and the TOTAL timeline length stay fixed.
 *
 * `deltaSec` is clamped so neither neighbour drops below `MIN_CLIP_SEC` and neither
 * overruns its source (the previous tail must fit the media; the next head must stay
 * at/after source 0). A missing previous OR next neighbour ⇒ a safe no-op (there is
 * nothing to absorb the slide). Positive `delta` slides LATER; negative slides
 * EARLIER. The track is re-laid gaplessly afterwards. Pure + re-parsed.
 */
export function slideEdit(doc: EditDoc, clipId: string, deltaSec: number): EditDoc {
  const found = locate(doc, clipId);
  if (!found) return parseEditDoc(structuredClone(doc));
  const { clone, seq, index } = found;
  const P = seq[index - 1]; // previous neighbour
  const N = seq[index + 1]; // next neighbour
  if (!P || !N) return parseEditDoc(clone); // need a neighbour on BOTH sides → no-op

  const lo = Math.max(MIN_CLIP_SEC - P.duration, incomingSourceFloor(N));
  const hi = Math.min(N.duration - MIN_CLIP_SEC, maxTimelineDuration(clone, P) - P.duration);
  if (hi < lo) return parseEditDoc(clone); // no room to slide
  const delta = clamp(round(deltaSec), lo, hi);

  P.duration = round(P.duration + delta); // previous: tail extends/retracts, sourceIn fixed
  N.duration = round(N.duration - delta); // next: shorter/longer
  if (N.kind === "video" || N.kind === "audio") {
    N.sourceIn = round(Math.max(0, (N.sourceIn ?? 0) + delta * srcRate(N))); // head moves
  }
  // The middle clip (`clipId`) is untouched; relayGapless slides its start by delta.
  relayGapless(seq);
  return parseEditDoc(clone);
}

/** A convenience type export for the web wave's roll/slip/slide UI. */
export type { SeqVisualClip };
