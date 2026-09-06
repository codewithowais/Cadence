import { docDurationSec, parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import { captureMainSpans, reanchorOverlays } from "./edit-ops";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Track ids that carry overlays (titles, captions, PiP b-roll, fades, music,
 * voice-over) rather than the MAIN back-to-back footage. Reflow / reorder /
 * remove treat these differently — they are never re-laid as a sequence. Kept in
 * sync with @cadence/director's OVERLAY_TRACK_IDS (plus "voiceover").
 */
const OVERLAY_TRACK_IDS = new Set(["titles", "captions", "broll", "fades", "music", "voiceover"]);
const isMainVisualTrack = (id: string): boolean => !OVERLAY_TRACK_IDS.has(id);

/** An empty but valid project. */
export function emptyDoc(): EditDoc {
  return parseEditDoc({ version: 1, meta: { title: "Untitled", background: "#0a0d12" } });
}

/** A doc that plays the whole uploaded clip — the state right after ingest. */
export function fullClipDoc(media: MediaAsset): EditDoc {
  const width = media.width ?? 1920;
  const height = media.height ?? 1080;
  return parseEditDoc({
    version: 1,
    meta: { title: media.label ?? "Project", width, height, background: "#0a0d12", fps: 30 },
    media: [media],
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [
          {
            id: "src",
            kind: "video",
            start: 0,
            duration: media.durationSec ?? 10,
            mediaId: media.id,
            sourceIn: 0,
            transform: { x: width / 2, y: height / 2 },
          },
        ],
      },
    ],
  });
}

/**
 * Combine several video sources into ONE timeline: each media becomes a video
 * clip laid back-to-back (in upload order) on the main "video" track, each
 * spanning its full source duration. The composition size/title come from the
 * FIRST video. Produces a doc byte-for-byte identical to `fullClipDoc` when
 * given a single media (the first clip keeps id "src"), so single-video behavior
 * is unchanged. The renderer concatenates these clips (video + audio) on export.
 */
export function combinedVideoDoc(medias: MediaAsset[]): EditDoc {
  if (medias.length === 0) return emptyDoc();
  const first = medias[0]!;
  const width = first.width ?? 1920;
  const height = first.height ?? 1080;
  let pos = 0;
  const clips = medias.map((m, i) => {
    const duration = m.durationSec ?? 10;
    const clip = {
      id: i === 0 ? "src" : `src-${i}`,
      kind: "video" as const,
      start: round(pos),
      duration: round(duration),
      mediaId: m.id,
      sourceIn: 0,
      transform: { x: width / 2, y: height / 2 },
    };
    pos += duration;
    return clip;
  });
  return parseEditDoc({
    version: 1,
    meta: { title: first.label ?? "Project", width, height, background: "#0a0d12", fps: 30 },
    media: medias,
    tracks: [{ id: "video", kind: "visual", clips }],
  });
}

/**
 * Re-lay a track's video/image clips in array order with no gaps. Each clip's
 * incoming `transitionInSec` is honored as an OVERLAP with the previous clip, so
 * hard-cut videos (transitionInSec 0) land back-to-back while slideshow images
 * keep their crossfade overlap.
 */
function reflowSequential(track: { clips: EditDoc["tracks"][number]["clips"] }): void {
  let prevEnd = 0;
  let first = true;
  for (const clip of track.clips) {
    if (clip.kind !== "video" && clip.kind !== "image") continue;
    const start = first ? 0 : Math.max(0, prevEnd - clip.transitionInSec);
    clip.start = round(start);
    prevEnd = clip.start + clip.duration;
    first = false;
  }
}

/**
 * Append more video sources to the end of an existing project's main "video"
 * track, preserving every existing clip and its edits (looks, speed, punch-ins).
 * Falls back to `combinedVideoDoc` when there is no video track yet.
 */
export function appendVideos(doc: EditDoc, medias: MediaAsset[]): EditDoc {
  if (medias.length === 0) return doc;
  const clone: EditDoc = structuredClone(doc);
  const width = clone.meta.width;
  const height = clone.meta.height;
  const track = clone.tracks.find((t) => t.id === "video");
  if (!track) {
    const existing = clone.media.filter((m) => m.kind === "video");
    return combinedVideoDoc([...existing, ...medias]);
  }
  // Start appending after the last main video/image clip on the track.
  let pos = 0;
  for (const clip of track.clips) {
    if (clip.kind === "video" || clip.kind === "image") pos = Math.max(pos, clip.start + clip.duration);
  }
  medias.forEach((m, i) => {
    const duration = m.durationSec ?? 10;
    track.clips.push({
      id: `src-${Date.now()}-${i}`,
      kind: "video",
      start: round(pos),
      duration: round(duration),
      mediaId: m.id,
      sourceIn: 0,
      speed: 1,
      volume: 1,
      transform: { x: width / 2, y: height / 2, scale: 1, rotation: 0, opacity: 1 },
      look: { brightness: 1, contrast: 1, saturation: 1, warmth: 0 },
      transitionInSec: 0,
      transitionOutSec: 0,
      transitionType: "crossfade",
      reversed: false,
    });
    pos += duration;
    if (!clone.media.some((x) => x.id === m.id)) clone.media.push(m);
  });
  return parseEditDoc(clone);
}

/**
 * Move a media's clip one slot earlier ("up") or later ("down") on its main
 * sequential visual track, then re-lay the track back-to-back. Also mirrors the
 * order in `doc.media`. No-op for overlay/audio-only media (nothing to reorder).
 */
export function moveMediaInDoc(doc: EditDoc, mediaId: string, dir: "up" | "down"): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const track = clone.tracks.find(
    (t) =>
      t.kind === "visual" &&
      isMainVisualTrack(t.id) &&
      t.clips.some((c) => (c.kind === "video" || c.kind === "image") && c.mediaId === mediaId),
  );
  const before = captureMainSpans(clone); // for overlay ripple after the reorder
  if (track) {
    const seqIdx: number[] = [];
    track.clips.forEach((c, i) => {
      if (c.kind === "video" || c.kind === "image") seqIdx.push(i);
    });
    const at = seqIdx.findIndex((i) => {
      const c = track.clips[i]!;
      return (c.kind === "video" || c.kind === "image") && c.mediaId === mediaId;
    });
    const swapWith = dir === "up" ? at - 1 : at + 1;
    if (at >= 0 && swapWith >= 0 && swapWith < seqIdx.length) {
      const a = seqIdx[at]!;
      const b = seqIdx[swapWith]!;
      const tmp = track.clips[a]!;
      track.clips[a] = track.clips[b]!;
      track.clips[b] = tmp;
      reflowSequential(track);
      reanchorOverlays(clone, before); // captions/titles/b-roll follow their clip
    }
  }
  // Mirror the reorder in doc.media so persisted/displayed order agrees.
  const mi = clone.media.findIndex((m) => m.id === mediaId);
  const mj = dir === "up" ? mi - 1 : mi + 1;
  if (mi >= 0 && mj >= 0 && mj < clone.media.length) {
    const tmp = clone.media[mi]!;
    clone.media[mi] = clone.media[mj]!;
    clone.media[mj] = tmp;
  }
  return parseEditDoc(clone);
}

/**
 * Remove a media and every clip that references it (across all tracks), drop any
 * now-empty tracks, and re-lay the main sequential visual tracks back-to-back so
 * there is no gap. Returns an empty project when the last media is removed.
 */
export function removeMediaFromDoc(doc: EditDoc, mediaId: string): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  const before = captureMainSpans(clone); // for overlay ripple after removal
  clone.media = clone.media.filter((m) => m.id !== mediaId);
  if (clone.media.length === 0) return emptyDoc();
  for (const track of clone.tracks) {
    track.clips = track.clips.filter((c) => !("mediaId" in c) || c.mediaId !== mediaId);
  }
  clone.tracks = clone.tracks.filter((t) => t.clips.length > 0);
  for (const track of clone.tracks) {
    if (track.kind === "visual" && isMainVisualTrack(track.id)) reflowSequential(track);
  }
  reanchorOverlays(clone, before); // trailing captions/titles close the gap too
  return parseEditDoc(clone);
}

/**
 * Add a recorded/added voice-over as an audio clip on a dedicated "voiceover"
 * track at full volume, sequenced after any existing voice-over. The renderer
 * mixes any audio track (delayed by clip.start, scaled by volume) under the
 * video, so this is honored on export. Registers the asset in doc.media.
 */
export function addVoiceover(doc: EditDoc, asset: MediaAsset): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  if (!clone.media.some((m) => m.id === asset.id)) clone.media.push(asset);
  const dur = asset.durationSec ?? 5;
  let vo = clone.tracks.find((t) => t.id === "voiceover");
  if (!vo) {
    vo = { id: "voiceover", kind: "audio", clips: [] };
    clone.tracks.push(vo);
  }
  let startPos = 0;
  for (const c of vo.clips) if (c.kind === "audio") startPos = Math.max(startPos, c.start + c.duration);
  vo.clips.push({
    id: `vo-${Date.now()}`,
    kind: "audio",
    start: round(startPos),
    duration: round(dur),
    mediaId: asset.id,
    sourceIn: 0,
    volume: 1,
  } as never);
  return parseEditDoc(clone);
}

/**
 * Lay an audio asset under the project as BACKGROUND MUSIC on a dedicated "music"
 * track, replacing any existing music. Client-side mirror of the director's
 * `add_music` so uploading audio can attach it immediately (no server round-trip)
 * — the review's P0-3. The clip is fit to the SHORTER of the song and the
 * timeline (so a long song is trimmed to the cut and a short song isn't padded
 * with silence past its end), starts at `startSec` (default 0), and plays at a
 * low default 0.28 volume so it sits under speech. Registers the asset in
 * doc.media so preview + export can find it. The renderer (and the Stage preview)
 * mix any audio clip in, delayed by clip.start and scaled by volume.
 */
export function addMusic(
  doc: EditDoc,
  asset: MediaAsset,
  opts: { volume?: number; startSec?: number } = {},
): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  if (!clone.media.some((m) => m.id === asset.id)) clone.media.push(asset);
  clone.tracks = clone.tracks.filter((t) => t.id !== "music");

  const timeline = docDurationSec(clone);
  const assetDur = asset.durationSec ?? 0;
  // Fit to the shorter of song/timeline; fall back to the song (or 30s) when the
  // project has no visual duration yet.
  const duration =
    timeline > 0
      ? assetDur > 0
        ? Math.min(assetDur, timeline)
        : timeline
      : assetDur > 0
        ? assetDur
        : 30;

  const clip = {
    id: `music-${Date.now()}`,
    kind: "audio" as const,
    start: Math.max(0, round(opts.startSec ?? 0)),
    duration: round(duration),
    mediaId: asset.id,
    sourceIn: 0,
    volume: clamp(opts.volume ?? 0.28, 0, 1),
  };
  clone.tracks.push({ id: "music", kind: "audio", clips: [clip as never] });
  return parseEditDoc(clone);
}

/** Set the volume (0..1) of every audio clip on a track (e.g. "music", "voiceover"). */
export function setTrackVolume(doc: EditDoc, trackId: string, volume: number): EditDoc {
  const v = clamp(round(volume), 0, 1);
  const clone: EditDoc = structuredClone(doc);
  for (const track of clone.tracks) {
    if (track.id !== trackId) continue;
    for (const clip of track.clips) if (clip.kind === "audio") clip.volume = v;
  }
  return parseEditDoc(clone);
}
