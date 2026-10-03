/**
 * Bridges the chat Director to the in-browser scene detector. The Director runs
 * server-side and can't see frames, so when a request is "divide this into
 * scenes" (see `parseSceneSplit`) we scan the video HERE first and ship the
 * detected cut points along with the request (`sceneCuts`, source seconds).
 */
import type { EditDoc, MediaAsset } from "@cadence/core";
import { parseSceneSplit } from "@cadence/director";
import { cutsFromScan, getCachedScan, refineCuts, scanVideoScenes } from "./scene-detect";

/** Media id the Director's `split_into_scenes` will target by default: the first video clip's. */
function firstVideoMediaId(doc: EditDoc): string | null {
  for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "video") return c.mediaId;
  return null;
}

/**
 * Detect scene cuts for the request's target video. `undefined` when the request
 * doesn't need frame analysis or the video can't be scanned (the Director then
 * answers with its own friendly "open the Media room" message).
 */
export async function collectSceneCuts(
  request: string,
  doc: EditDoc,
  mediaList: MediaAsset[],
  urls: Record<string, string>,
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, number[]> | undefined> {
  const intent = parseSceneSplit(request);
  if (intent?.input.method !== "scenes") return undefined;
  const mediaId = firstVideoMediaId(doc);
  const media = mediaId ? mediaList.find((m) => m.id === mediaId) : undefined;
  const url = mediaId ? urls[mediaId] : undefined;
  if (!mediaId || !media?.durationSec || !url) return undefined;
  try {
    const scan = getCachedScan(mediaId) ?? (await scanVideoScenes(mediaId, url, media.durationSec, { onProgress }));
    const coarse = cutsFromScan(scan, intent.input.sensitivity ?? 0.5, intent.input.minShotSec ?? 1);
    const refined = await refineCuts(scan, url, coarse);
    return { [mediaId]: refined };
  } catch {
    return undefined;
  }
}
