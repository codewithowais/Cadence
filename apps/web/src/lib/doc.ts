import { parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";

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
