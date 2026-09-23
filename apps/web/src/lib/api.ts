import type { EditDoc, MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";
import {
  EXPORT_PROGRESS_HEADER,
  EXPORT_STREAM_HEADER,
  ExportStreamDecoder,
  type ExportStreamPhase,
} from "./export-stream";

export interface DirectorResponse {
  doc: EditDoc;
  summary: string;
  toolCalls: { name: string; input: unknown }[];
  durationSec: number;
}

/**
 * A transcript plus whether it came from the deterministic offline
 * StubTranscriber (`approximate: true`, no Whisper installed) rather than real
 * word-accurate Whisper — the Words room surfaces this honestly.
 */
export interface TranscribeResult {
  transcript: Transcript;
  approximate: boolean;
}

export async function transcribe(media: MediaAsset): Promise<TranscribeResult> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ media }),
  });
  if (!res.ok) throw new Error(`transcribe failed: ${res.status}`);
  const data = (await res.json()) as { transcript: Transcript; approximate?: boolean };
  return { transcript: data.transcript, approximate: data.approximate ?? false };
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

/**
 * Upload one media File to the server; returns its server-side path + id. With
 * `onProgress`, the upload goes through XMLHttpRequest (fetch has no upload
 * progress events) and reports the fraction of bytes sent, 0..1.
 */
export async function uploadMedia(
  file: File,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<{ id: string; path: string }> {
  const form = new FormData();
  form.append("file", file);
  if (onProgress && typeof XMLHttpRequest !== "undefined") return uploadViaXhr(form, signal, onProgress);
  const res = await fetch("/api/upload", { method: "POST", body: form, signal });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: `upload failed: ${res.status}` }));
    throw new Error(msg.error ?? `upload failed: ${res.status}`);
  }
  return (await res.json()) as { id: string; path: string };
}

function uploadViaXhr(
  form: FormData,
  signal: AbortSignal | undefined,
  onProgress: (fraction: number) => void,
): Promise<{ id: string; path: string }> {
  return new Promise((resolve, reject) => {
    const abortError = (): DOMException => new DOMException("The upload was aborted.", "AbortError");
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = (): void => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => signal?.removeEventListener("abort", onAbort);
    xhr.open("POST", "/api/upload");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        try {
          onProgress(Math.min(1, e.loaded / e.total));
        } catch {
          /* listener errors never break the upload */
        }
      }
    };
    xhr.onload = () => {
      done();
      const data = (xhr.response ?? {}) as { id?: string; path?: string; error?: string };
      if (xhr.status >= 200 && xhr.status < 300 && data.id && data.path) resolve({ id: data.id, path: data.path });
      else reject(new Error(data.error ?? `upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => {
      done();
      reject(new Error("Upload failed — check your connection and try again."));
    };
    xhr.onabort = () => {
      done();
      reject(abortError());
    };
    xhr.send(form);
  });
}

/**
 * Result of a real .mp4 export. `ok` → a downloadable video blob; `unavailable`
 * → ffmpeg isn't installed (HTTP 501) and the caller should fall back to the
 * JSON edit-doc export and surface `message`.
 */
export type ExportResult =
  | { ok: true; blob: Blob }
  | { ok: false; unavailable: boolean; message: string };

/** A live update from a streamed export (see lib/export-stream.ts). */
export type ExportProgressUpdate =
  | { kind: "phase"; phase: ExportStreamPhase }
  | { kind: "progress"; fraction: number; etaSec: number | null }
  /** The encode finished; `fraction` of the file's bytes have been downloaded. */
  | { kind: "download"; fraction: number };

export interface ExportVideoOptions {
  /**
   * Opt into the progress stream: the server reports phases + encode progress and
   * the client can cancel mid-encode (aborting `signal` kills ffmpeg server-side).
   */
  onProgress?: (u: ExportProgressUpdate) => void;
}

/** Render the doc to a real .mp4 via the ffmpeg export route. */
export async function exportVideo(doc: EditDoc, signal?: AbortSignal, opts: ExportVideoOptions = {}): Promise<ExportResult> {
  const streamed = !!opts.onProgress;
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json", ...(streamed ? { [EXPORT_PROGRESS_HEADER]: "1" } : {}) },
    body: JSON.stringify({ doc }),
    signal,
  });
  if (res.ok && res.headers.get(EXPORT_STREAM_HEADER) === "1" && res.body) {
    return readExportStream(res.body, opts.onProgress);
  }
  if (res.ok) return { ok: true, blob: await res.blob() };
  const data = await res.json().catch(() => ({ error: `export failed: ${res.status}` }));
  return { ok: false, unavailable: res.status === 501, message: data.error ?? `export failed: ${res.status}` };
}

/** Consume a progress stream to its terminal event. Aborts surface as AbortError. */
async function readExportStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (u: ExportProgressUpdate) => void,
): Promise<ExportResult> {
  const reader = body.getReader();
  const decoder = new ExportStreamDecoder();
  const emit = (u: ExportProgressUpdate): void => {
    try {
      onProgress?.(u);
    } catch {
      /* UI listener errors never break the download */
    }
  };
  let lastDl = -1;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        for (const ev of decoder.push(value)) {
          if (ev.type === "phase") emit({ kind: "phase", phase: ev.phase });
          else if (ev.type === "progress") emit({ kind: "progress", fraction: ev.fraction, etaSec: ev.etaSec });
          else if (ev.type === "error") {
            void reader.cancel().catch(() => {});
            return { ok: false, unavailable: ev.code === "FFMPEG_NOT_FOUND", message: ev.error };
          }
        }
        if (decoder.corrupt) {
          void reader.cancel().catch(() => {});
          return { ok: false, unavailable: false, message: `Export failed: ${decoder.corrupt}.` };
        }
        if (decoder.file && decoder.file.size > 0) {
          const f = decoder.fileBytes / decoder.file.size;
          if (f - lastDl >= 0.02 || f >= 1) {
            lastDl = f;
            emit({ kind: "download", fraction: f });
          }
        }
        if (decoder.complete) break;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!decoder.file || !decoder.complete) {
    return { ok: false, unavailable: false, message: "The export connection closed before the video arrived — please try again." };
  }
  return { ok: true, blob: new Blob(decoder.fileParts as BlobPart[], { type: decoder.file.contentType }) };
}

/** Server-rendered frame (canvas engine) as a PNG Blob. Used for poster/thumbnail. */
export async function renderFrameBlob(doc: EditDoc, timeSec: number): Promise<Blob> {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc, timeSec }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `render failed: ${res.status}`);
  }
  return res.blob();
}

/** Server-rendered frame (canvas engine) as an object URL. Used for poster/export-frame. */
export async function renderFrame(doc: EditDoc, timeSec: number): Promise<string> {
  return URL.createObjectURL(await renderFrameBlob(doc, timeSec));
}
