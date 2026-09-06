/**
 * WhisperTranscriber — real, local, FREE speech-to-text behind the same
 * `Transcriber` interface as the StubTranscriber. It shells out to a locally
 * installed Whisper CLI (no heavy npm dep), mirroring the pluggable/graceful
 * pattern of @cadence/enhance's CLI provider:
 *
 *   - Configure a command template via `WHISPER_CMD` (tokens {input} {model}
 *     {output_dir} {output}), OR let it auto-detect a `whisper` / `whisper-cpp`
 *     / `faster-whisper` CLI on PATH.
 *   - Model comes from `WHISPER_MODEL` (default "base").
 *   - Audio is first extracted to a temp 16 kHz mono wav via ffmpeg, reusing the
 *     `FFMPEG_PATH` convention from @cadence/render-ffmpeg's detect.
 *   - If ffmpeg OR a Whisper CLI is missing, `isAvailable()` returns false and
 *     the factory (`pickTranscriber`) falls back to the StubTranscriber — the
 *     pipeline never crashes when Whisper is absent.
 *
 * `parseWhisperJson` is a PURE function (no process, no fs) so the JSON→Transcript
 * mapping is unit-testable without running a model.
 */
import type { MediaAsset } from "@cadence/core";
import type { Transcriber, Transcript, TranscriptSegment, Word } from "./transcript";

// ALL Node built-ins are imported LAZILY (inside the functions that use them)
// rather than at module top level, so this module is import-safe for the browser
// bundle. The @cadence/understanding barrel is re-exported through
// @cadence/director, and a client component (RoomPanel) imports that barrel; a
// static `import … from "node:*"` here would leak into the client graph and break
// the Turbopack build ("the chunking context does not support external modules").
// tts.ts follows the same pattern. Every function below only ever runs
// server-side (detection / ffmpeg / whisper), so lazy imports cost nothing.
async function nodeSpawn(): Promise<typeof import("node:child_process").spawn> {
  return (await import("node:child_process")).spawn;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// SECURITY — client-supplied media path guard (SSRF / arbitrary-file-read).
//
// `WhisperTranscriber` hands `media.src` to ffmpeg as an INPUT path. Without a
// guard, a crafted src ("/etc/passwd", "http://…", "concat:…", "subfile:…",
// "-flag") would be an arbitrary-file-read / SSRF / flag-smuggle. This mirrors
// the export route's `resolveUploadPath` (apps/web/src/lib/uploads.ts): reject
// protocol/pseudo-path/flag shapes, realpath to collapse symlinks + "..", and
// require containment inside the uploads dir when one is resolvable.
// ---------------------------------------------------------------------------

/**
 * The directory Whisper is allowed to read media from. Matches the web app's
 * UPLOAD_DIR (`<os.tmpdir()>/cadence-uploads`) so both share one trust root, and
 * can be overridden via `CADENCE_MEDIA_DIR`.
 */
export async function mediaBaseDir(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const configured = env.CADENCE_MEDIA_DIR?.trim();
  if (configured) return configured;
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return join(tmpdir(), "cadence-uploads");
}

/**
 * ffmpeg protocol / pseudo-path input prefixes that must never be treated as a
 * local file (would enable SSRF, arbitrary read, or protocol smuggling).
 */
const FFMPEG_PROTOCOL_PREFIXES: readonly string[] = [
  "concat:", "subfile:", "file:", "http:", "https:", "pipe:", "data:",
  "crypto:", "hls:", "tcp:", "udp:", "rtp:", "rtmp:", "rtsp:", "ftp:",
  "ftps:", "gopher:", "srtp:", "tls:", "unix:", "async:", "cache:", "md5:",
];

/**
 * Validate a client-supplied media path and return its provably-safe realpath —
 * or throw. PURE-ish: no spawning; only fs.realpath/stat (needed to collapse
 * symlinks/".." and to prove it is a regular file). Exported so it is unit-testable.
 *
 * Rules (defense-in-depth):
 *  1. Reject empty, `-`-leading (flag smuggling), `://`, or any ffmpeg
 *     protocol/pseudo-path prefix (concat:, subfile:, file:, http:, …).
 *  2. `realpath` it — reject if it does not resolve / does not exist.
 *  3. Reject if it is not a regular file.
 *  4. If a media base dir is resolvable (`CADENCE_MEDIA_DIR` or the OS tmp
 *     `cadence-uploads` dir), require the realpath to stay inside it. If no base
 *     is resolvable, the protocol/flag/regular-file checks above still apply.
 */
export async function assertLocalMediaPath(
  src: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (typeof src !== "string" || src.trim() === "") {
    throw new Error("invalid media path: empty");
  }
  if (src.startsWith("-")) {
    throw new Error("invalid media path: refusing flag-like path");
  }
  if (src.includes("://")) {
    throw new Error("invalid media path: remote URLs are not allowed");
  }
  const lower = src.toLowerCase();
  for (const prefix of FFMPEG_PROTOCOL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      throw new Error(`invalid media path: protocol prefix "${prefix}" is not allowed`);
    }
  }
  // Catch any other `scheme:` pseudo-protocol (>=2 char scheme so Windows drive
  // letters like `C:` are not flagged) that ffmpeg might interpret.
  if (/^[a-z][a-z0-9+.\-]+:/i.test(src)) {
    throw new Error("invalid media path: protocol-style prefix is not allowed");
  }

  const { realpath, stat } = await import("node:fs/promises");
  const { sep } = await import("node:path");

  let real: string;
  try {
    real = await realpath(src);
  } catch {
    throw new Error("invalid media path: does not resolve to an existing file");
  }

  let info;
  try {
    info = await stat(real);
  } catch {
    throw new Error("invalid media path: does not resolve to an existing file");
  }
  if (!info.isFile()) {
    throw new Error("invalid media path: not a regular file");
  }

  // Containment: only enforced when a base dir is itself resolvable.
  let base: string | null = null;
  try {
    base = await realpath(await mediaBaseDir(env));
  } catch {
    base = null; // no configured/existing base → rely on the checks above.
  }
  if (base !== null && real !== base && !real.startsWith(base + sep)) {
    throw new Error("invalid media path: outside the allowed media directory");
  }

  return real;
}

// ---------------------------------------------------------------------------
// PURE parsing — Whisper JSON → Transcript. No I/O; fully unit-testable.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Whisper special/marker tokens we never treat as words (e.g. `[_BEG_]`, `<|...|>`). */
function isSpecialToken(t: string): boolean {
  return /^\[.*\]$/.test(t) || t.startsWith("[_") || t.startsWith("<|");
}

/** Seconds for a segment: OpenAI `start/end` (sec) or whisper.cpp `offsets` (ms). */
function segmentTimes(seg: Record<string, unknown>): { start: number; end: number } {
  const s = num(seg.start);
  const e = num(seg.end);
  if (s !== undefined && e !== undefined) return { start: s, end: e };
  const off = asRecord(seg.offsets);
  const from = num(off.from);
  const to = num(off.to);
  if (from !== undefined && to !== undefined) return { start: from / 1000, end: to / 1000 };
  return { start: NaN, end: NaN };
}

/** Words for a segment: OpenAI `words[]` (sec) or whisper.cpp full `tokens[]` (ms). */
function parseWords(seg: Record<string, unknown>): Word[] {
  const raw = Array.isArray(seg.words)
    ? seg.words
    : Array.isArray(seg.tokens)
      ? seg.tokens
      : [];
  const out: Word[] = [];
  for (const rw of raw) {
    const w = asRecord(rw);
    const text = (str(w.word) ?? str(w.text) ?? "").trim();
    if (!text || isSpecialToken(text)) continue;

    let start = num(w.start);
    let end = num(w.end);
    if (start === undefined || end === undefined) {
      const off = asRecord(w.offsets);
      const from = num(off.from);
      const to = num(off.to);
      if (from !== undefined && to !== undefined) {
        start = from / 1000;
        end = to / 1000;
      }
    }
    if (start === undefined || end === undefined) continue;
    const s = Math.max(0, round(start));
    out.push({ text, start: s, end: Math.max(s, round(end)) });
  }
  return out;
}

/** 0..1 confidence: mean word probability, else exp(avg_logprob). Undefined if neither. */
function segmentScore(seg: Record<string, unknown>): number | undefined {
  const probs: number[] = [];
  if (Array.isArray(seg.words)) {
    for (const rw of seg.words) {
      const p = num(asRecord(rw).probability);
      if (p !== undefined) probs.push(p);
    }
  }
  if (probs.length > 0) {
    return round(probs.reduce((a, b) => a + b, 0) / probs.length);
  }
  const lp = num(seg.avg_logprob);
  if (lp !== undefined) return round(Math.min(1, Math.max(0, Math.exp(lp))));
  return undefined;
}

/**
 * Map a Whisper JSON payload into the Cadence `Transcript`. Supports the two
 * common shapes:
 *   - OpenAI whisper / faster-whisper (whisper-ctranslate2): `{ segments:[{ start,end,text,
 *     words:[{ word,start,end,probability }] }], language, duration }` — seconds.
 *   - whisper.cpp full JSON: `{ transcription:[{ offsets:{from,to}, text, tokens:[...] }],
 *     result:{ language } }` — millisecond offsets.
 * Times are clamped non-negative and end>=start; ordering from Whisper is preserved.
 */
export function parseWhisperJson(json: unknown, mediaId: string): Transcript {
  const root = asRecord(json);

  const language =
    str(root.language) ?? str(asRecord(root.result).language) ?? "en";

  const rawSegments = Array.isArray(root.segments)
    ? root.segments
    : Array.isArray(root.transcription)
      ? root.transcription
      : [];

  const segments: TranscriptSegment[] = [];
  const words: Word[] = [];
  let segIdx = 0;

  for (const rs of rawSegments) {
    const seg = asRecord(rs);
    const { start, end } = segmentTimes(seg);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const segWords = parseWords(seg);
    const s = Math.max(0, round(start));
    const e = Math.max(s, round(end));
    const text = (str(seg.text)?.trim()) || segWords.map((w) => w.text).join(" ");

    const idNum = num(seg.id);
    const segment: TranscriptSegment = {
      id: idNum !== undefined ? `seg${idNum}` : `seg${segIdx}`,
      text,
      start: s,
      end: e,
      words: segWords,
    };
    const score = segmentScore(seg);
    if (score !== undefined) segment.score = score;

    segments.push(segment);
    words.push(...segWords);
    segIdx++;
  }

  let durationSec = num(root.duration) ?? 0;
  for (const seg of segments) durationSec = Math.max(durationSec, seg.end);
  for (const w of words) durationSec = Math.max(durationSec, w.end);

  return { mediaId, durationSec: round(durationSec), language, segments, words };
}

// ---------------------------------------------------------------------------
// Detection (never throws) — which Whisper CLI, which model.
// ---------------------------------------------------------------------------

export type WhisperKind =
  | "template"
  | "whisper"
  | "whisper-cpp"
  | "faster-whisper"
  | "none";

export interface WhisperDetection {
  /** True when a Whisper CLI is resolvable (does NOT include the ffmpeg check). */
  available: boolean;
  kind: WhisperKind;
  /** Resolved binary name for auto-detected CLIs. */
  bin?: string;
  /** The `WHISPER_CMD` command template when configured. */
  cmdTemplate?: string;
  /** Model name (whisper/faster-whisper) or model path (whisper.cpp). Default "base". */
  model: string;
}

/** `which <bin>` — resolves true/false, never throws. */
async function which(bin: string): Promise<boolean> {
  const spawn = await nodeSpawn();
  return new Promise((resolve) => {
    try {
      const p = spawn(process.platform === "win32" ? "where" : "which", [bin], {
        stdio: "ignore",
      });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Candidate CLIs in priority order → the detection kind they map to. */
const WHISPER_CANDIDATES: ReadonlyArray<{ bin: string; kind: WhisperKind }> = [
  { bin: "whisper", kind: "whisper" },
  { bin: "whisper-ctranslate2", kind: "faster-whisper" },
  { bin: "faster-whisper", kind: "faster-whisper" },
  { bin: "whisper-cpp", kind: "whisper-cpp" },
  { bin: "whisper-cli", kind: "whisper-cpp" },
];

/**
 * Detect a local Whisper. Prefers `WHISPER_CMD` (a command template), else the
 * first CLI on PATH. Never throws.
 */
export async function detectWhisper(
  env: Record<string, string | undefined> = process.env,
): Promise<WhisperDetection> {
  const model = env.WHISPER_MODEL?.trim() || "base";

  const template = env.WHISPER_CMD?.trim();
  if (template) {
    return { available: true, kind: "template", cmdTemplate: template, model };
  }

  for (const cand of WHISPER_CANDIDATES) {
    if (await which(cand.bin)) {
      return { available: true, kind: cand.kind, bin: cand.bin, model };
    }
  }
  return { available: false, kind: "none", model };
}

// ---------------------------------------------------------------------------
// ffmpeg availability — reuses the FFMPEG_PATH convention (see @cadence/render-ffmpeg).
// ---------------------------------------------------------------------------

/** Probe `ffmpeg -version`. Resolves availability; never throws. */
async function ffmpegAvailable(bin = process.env.FFMPEG_PATH || "ffmpeg"): Promise<boolean> {
  const spawn = await nodeSpawn();
  return new Promise((resolve) => {
    try {
      const p = spawn(bin, ["-version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Command building + I/O helpers.
// ---------------------------------------------------------------------------

/** Split a command template into argv, substituting {token}s. Quotes-aware. Pure. */
export function templateToArgv(
  template: string,
  vars: Record<string, string>,
): string[] {
  const tokens = template.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return tokens.map((raw) => {
    const unq = raw.replace(/^["']|["']$/g, "");
    return unq.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  });
}

/** Build the concrete `{ bin, args }` to invoke Whisper for the given wav. */
async function buildWhisperCommand(
  det: WhisperDetection,
  wavPath: string,
  outDir: string,
): Promise<{ bin: string; args: string[] }> {
  const { join } = await import("node:path");
  const jsonOut = join(outDir, "transcript.json");
  switch (det.kind) {
    case "template": {
      const argv = templateToArgv(det.cmdTemplate ?? "", {
        input: wavPath,
        model: det.model,
        output_dir: outDir,
        output: jsonOut,
      });
      const bin = argv.shift();
      if (!bin) throw new Error("WHISPER_CMD template is empty.");
      return { bin, args: argv };
    }
    case "whisper":
      // OpenAI whisper CLI: JSON with word timestamps into --output_dir.
      return {
        bin: det.bin ?? "whisper",
        args: [
          wavPath,
          "--model", det.model,
          "--output_format", "json",
          "--output_dir", outDir,
          "--word_timestamps", "True",
          "--fp16", "False",
          "--verbose", "False",
        ],
      };
    case "faster-whisper":
      // whisper-ctranslate2 / faster-whisper CLI: OpenAI-compatible flags (no --fp16).
      return {
        bin: det.bin ?? "whisper-ctranslate2",
        args: [
          wavPath,
          "--model", det.model,
          "--output_format", "json",
          "--output_dir", outDir,
          "--word_timestamps", "True",
          "--verbose", "False",
        ],
      };
    case "whisper-cpp":
      // whisper.cpp: model is a ggml .bin PATH; -ojf writes full JSON to <of>.json.
      return {
        bin: det.bin ?? "whisper-cli",
        args: ["-m", det.model, "-f", wavPath, "-ojf", "-of", join(outDir, "transcript")],
      };
    case "none":
    default:
      throw new Error("No local Whisper CLI available.");
  }
}

/** Run a process; capture stdout, inherit stderr. Rejects on non-zero exit. */
async function run(bin: string, args: string[]): Promise<string> {
  const spawn = await nodeSpawn();
  return new Promise((resolve, reject) => {
    let out = "";
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"] });
    p.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}`)),
    );
  });
}

/** Locate the Whisper JSON: stdout if it printed JSON, else a *.json in outDir. */
async function loadWhisperJson(stdout: string, outDir: string): Promise<unknown> {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to the file scan
    }
  }
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const files = await readdir(outDir);
  const jsonFile = files.find((f) => f.toLowerCase().endsWith(".json"));
  if (!jsonFile) throw new Error("Whisper produced no JSON output to parse.");
  return JSON.parse(await readFile(join(outDir, jsonFile), "utf8"));
}

export const WHISPER_MISSING_MESSAGE =
  "Local Whisper unavailable. Install whisper.cpp / faster-whisper (or OpenAI whisper) " +
  "and ffmpeg, or set WHISPER_CMD (tokens {input} {model}). ffmpeg is baked into the " +
  "Docker image. Falling back to the offline StubTranscriber.";

// ---------------------------------------------------------------------------
// The transcriber.
// ---------------------------------------------------------------------------

export class WhisperTranscriber implements Transcriber {
  /** True only when BOTH a Whisper CLI and ffmpeg are present. */
  async isAvailable(): Promise<boolean> {
    const [det, ff] = await Promise.all([detectWhisper(), ffmpegAvailable()]);
    return det.available && ff;
  }

  async transcribe(media: MediaAsset): Promise<Transcript> {
    const det = await detectWhisper();
    if (!det.available) throw new Error(WHISPER_MISSING_MESSAGE);
    const ffbin = process.env.FFMPEG_PATH || "ffmpeg";
    if (!(await ffmpegAvailable(ffbin))) throw new Error(WHISPER_MISSING_MESSAGE);

    // SECURITY: media.src is client-supplied. Validate it resolves to a real,
    // local, regular file inside the allowed media dir BEFORE handing it to
    // ffmpeg — otherwise a crafted src ("/etc/passwd", "http://…", "concat:…",
    // "-flag") would be arbitrary-file-read / SSRF / flag-smuggling.
    const safeSrc = await assertLocalMediaPath(media.src);

    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workDir = await mkdtemp(join(tmpdir(), "cadence-whisper-"));
    try {
      // 1) Extract audio to a 16 kHz mono wav (Whisper's expected input).
      // Constrain ffmpeg to the local file/pipe protocols (blocks http/tcp/…
      // SSRF) and hand it the VALIDATED absolute realpath. ffmpeg's `-i`
      // consumes its argument literally (GET_ARG — never re-parsed as an
      // option), and `safeSrc` is an absolute realpath that can never begin
      // with "-", so the input can never be interpreted as a flag.
      const wav = join(workDir, "audio.wav");
      await run(ffbin, [
        "-y", "-protocol_whitelist", "file,pipe",
        "-i", safeSrc,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        wav,
      ]);

      // 2) Run Whisper → JSON.
      const { bin, args } = await buildWhisperCommand(det, wav, workDir);
      const stdout = await run(bin, args);

      // 3) Parse into the shared Transcript type.
      const json = await loadWhisperJson(stdout, workDir);
      const transcript = parseWhisperJson(json, media.id);
      if (transcript.durationSec === 0 && media.durationSec) {
        transcript.durationSec = round(media.durationSec);
      }
      return transcript;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
