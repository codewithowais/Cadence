/**
 * The export progress stream protocol — ONE module shared by the server route
 * (encoder) and the browser client (decoder), so both sides can't drift. PURE: no
 * DOM, no Node APIs beyond TextEncoder/TextDecoder (present in both runtimes).
 *
 * Wire format (a single HTTP response body, opted into by the client with the
 * `x-cadence-progress: 1` request header):
 *
 *   {"type":"phase","phase":"preparing"}\n
 *   {"type":"progress","fraction":0.42,"etaSec":12.3}\n
 *   …
 *   {"type":"file","size":123456,"filename":"My-video.mp4","contentType":"video/mp4"}\n
 *   <exactly `size` raw bytes of the mp4>
 *
 * or, on failure, a terminal `{"type":"error",...}\n` line. The raw bytes after
 * the `file` header avoid base64 bloat and keep the whole export ONE request, so it
 * works on a single container (Render/Docker) and on serverless alike.
 */

/** Stages the UI narrates. `queued` = waiting for a free render slot. */
export type ExportStreamPhase = "queued" | "preparing" | "encoding" | "finishing";

export type ExportStreamEvent =
  | { type: "phase"; phase: ExportStreamPhase }
  | { type: "progress"; fraction: number; etaSec: number | null }
  | { type: "error"; error: string; code?: string }
  | { type: "file"; size: number; filename: string; contentType: string };

/** Request header the client sends to opt into the stream. */
export const EXPORT_PROGRESS_HEADER = "x-cadence-progress";
/** Response header marking a progress stream (vs the legacy raw mp4 body). */
export const EXPORT_STREAM_HEADER = "x-cadence-export-stream";

/** Longest JSON line we accept before declaring the stream corrupt. */
const MAX_LINE_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** Serialize one event as a newline-terminated JSON line. */
export function encodeExportEvent(e: ExportStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(e)}\n`);
}

/** Validate a parsed JSON value as an event (defensive: never trust the wire). */
export function asExportEvent(v: unknown): ExportStreamEvent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  switch (o.type) {
    case "phase":
      return o.phase === "queued" || o.phase === "preparing" || o.phase === "encoding" || o.phase === "finishing"
        ? { type: "phase", phase: o.phase }
        : null;
    case "progress": {
      const f = Number(o.fraction);
      if (!Number.isFinite(f)) return null;
      const eta = o.etaSec === null || o.etaSec === undefined ? null : Number(o.etaSec);
      return { type: "progress", fraction: Math.max(0, Math.min(1, f)), etaSec: eta !== null && Number.isFinite(eta) && eta >= 0 ? eta : null };
    }
    case "error":
      return { type: "error", error: typeof o.error === "string" ? o.error : "export failed", ...(typeof o.code === "string" ? { code: o.code } : {}) };
    case "file": {
      const size = Number(o.size);
      if (!Number.isInteger(size) || size < 0) return null;
      return {
        type: "file",
        size,
        filename: typeof o.filename === "string" ? o.filename : "cadence.mp4",
        contentType: typeof o.contentType === "string" ? o.contentType : "video/mp4",
      };
    }
    default:
      return null;
  }
}

/**
 * Incremental decoder. Feed it response-body chunks in order; it returns the
 * events each chunk completes and, after the `file` header, collects exactly
 * `size` body bytes into `fileParts`. Byte-exact: binary is never decoded as text.
 */
export class ExportStreamDecoder {
  private pending: Uint8Array = new Uint8Array(0);
  private readonly textDecoder = new TextDecoder();
  /** The `file` header, once seen. */
  file: Extract<ExportStreamEvent, { type: "file" }> | null = null;
  /** Collected mp4 bytes (only after the `file` header). */
  readonly fileParts: Uint8Array[] = [];
  /** Number of mp4 bytes collected so far. */
  fileBytes = 0;
  /** Set when the stream is malformed (oversized/invalid header line). */
  corrupt: string | null = null;

  /** True once the whole file has arrived. */
  get complete(): boolean {
    return this.file !== null && this.fileBytes >= this.file.size;
  }

  push(chunk: Uint8Array): ExportStreamEvent[] {
    const events: ExportStreamEvent[] = [];
    if (this.corrupt || chunk.byteLength === 0) return events;
    if (this.file) {
      this.takeBody(chunk);
      return events;
    }
    let buf = concatBytes(this.pending, chunk);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.byteLength > MAX_LINE_BYTES) {
          this.corrupt = "export stream header line too long";
          buf = new Uint8Array(0);
        }
        break;
      }
      const line = this.textDecoder.decode(buf.subarray(0, nl)).trim();
      buf = buf.subarray(nl + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.corrupt = "export stream sent an unreadable line";
        buf = new Uint8Array(0);
        break;
      }
      const ev = asExportEvent(parsed);
      if (!ev) continue; // unknown event types are ignored (forward-compatible)
      events.push(ev);
      if (ev.type === "file") {
        this.file = ev;
        // Everything after the header newline is mp4 bytes.
        if (buf.byteLength) this.takeBody(buf);
        buf = new Uint8Array(0);
        break;
      }
    }
    // Copy so we never retain a view into the caller's (possibly reused) buffer.
    this.pending = buf.byteLength ? buf.slice() : new Uint8Array(0);
    return events;
  }

  private takeBody(bytes: Uint8Array): void {
    if (!this.file) return;
    const room = this.file.size - this.fileBytes;
    if (room <= 0) return;
    const part = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
    this.fileParts.push(part.slice());
    this.fileBytes += part.byteLength;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** "~12s left" / "~3 min left" / "" — compact, honest ETA copy for the bar. */
export function formatEta(etaSec: number | null): string {
  if (etaSec === null || !Number.isFinite(etaSec) || etaSec < 0) return "";
  if (etaSec < 1.5) return "almost done";
  if (etaSec < 60) return `~${Math.round(etaSec)}s left`;
  const min = Math.round(etaSec / 60);
  return min >= 60 ? `~${Math.floor(min / 60)}h ${min % 60}m left` : `~${min} min left`;
}
