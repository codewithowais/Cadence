import type { EditDoc, MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

export interface DirectorResponse {
  doc: EditDoc;
  summary: string;
  toolCalls: { name: string; input: unknown }[];
  durationSec: number;
}

export async function transcribe(media: MediaAsset): Promise<Transcript> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ media }),
  });
  if (!res.ok) throw new Error(`transcribe failed: ${res.status}`);
  const data = (await res.json()) as { transcript: Transcript };
  return data.transcript;
}

export async function askDirector(input: {
  request: string;
  media: MediaAsset[];
  transcripts: Transcript[];
  doc: EditDoc;
}): Promise<DirectorResponse> {
  const res = await fetch("/api/director", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`director failed: ${res.status}`);
  return (await res.json()) as DirectorResponse;
}

/** Upload one media File to the server; returns its server-side path + id. */
export async function uploadMedia(file: File): Promise<{ id: string; path: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: `upload failed: ${res.status}` }));
    throw new Error(msg.error ?? `upload failed: ${res.status}`);
  }
  return (await res.json()) as { id: string; path: string };
}

/**
 * Result of a real .mp4 export. `ok` → a downloadable video blob; `unavailable`
 * → ffmpeg isn't installed (HTTP 501) and the caller should fall back to the
 * JSON edit-doc export and surface `message`.
 */
export type ExportResult =
  | { ok: true; blob: Blob }
  | { ok: false; unavailable: boolean; message: string };

/** Render the doc to a real .mp4 via the ffmpeg export route. */
export async function exportVideo(doc: EditDoc): Promise<ExportResult> {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc }),
  });
  if (res.ok) return { ok: true, blob: await res.blob() };
  const data = await res.json().catch(() => ({ error: `export failed: ${res.status}` }));
  return { ok: false, unavailable: res.status === 501, message: data.error ?? `export failed: ${res.status}` };
}

/** Server-rendered frame (canvas engine) as an object URL. Used for poster/export-frame. */
export async function renderFrame(doc: EditDoc, timeSec: number): Promise<string> {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc, timeSec }),
  });
  if (!res.ok) throw new Error(`render failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
