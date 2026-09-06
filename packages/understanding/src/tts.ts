/**
 * Text-to-speech (voice-over) provider contract — FREE-FIRST + MONEY-GATED.
 *
 * Mirrors @cadence/enhance: a small, pluggable `TtsProvider` interface plus an
 * env-driven registry. The DEFAULT is `none` — there is no free, offline speech
 * synthesizer bundled, so voice-over generation is honestly gated behind an
 * operator wiring a CLI (any `say`/`piper`/`coqui`/… command) or a hosted API.
 * When nothing is configured the provider is UNAVAILABLE and the tool fails
 * gracefully with a clear "no TTS provider configured (money-gated)" message —
 * never a silent no-op and never a fake audio file.
 *
 * The Director depends only on this interface, exactly like the enhance seam, so
 * the free-first / gated split stays honest and swappable.
 */

/** What the caller wants spoken and where the audio should land. */
export interface TtsRequest {
  /** The script to synthesize. */
  text: string;
  /** Local path the provider must write the rendered audio to. */
  outputPath: string;
  /** Optional named voice (provider-specific; passed through as {voice}). */
  voice?: string;
  /** Output container the provider should produce. */
  format?: "mp3" | "wav";
}

export interface TtsResult {
  outputPath: string;
  provider: string;
  usesAI: boolean;
  /** Rendered duration in seconds when the provider can report it. */
  durationSec?: number;
  note?: string;
}

export interface TtsProvider {
  id: string;
  label: string;
  usesAI: boolean;
  /** True when this provider can run in the current environment (configured). */
  isAvailable(): Promise<boolean>;
  /** Synthesize `req.text` to `req.outputPath`. Throws when unavailable. */
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

/** The clear, honest message surfaced when no TTS provider is configured. */
export const TTS_UNAVAILABLE_MESSAGE =
  "No TTS provider configured (money-gated). Voice-over needs a speech synthesizer: " +
  "set TTS_PROVIDER=cli with TTS_CLI_COMMAND (e.g. a piper/coqui/say wrapper), " +
  "or TTS_PROVIDER=api with TTS_API_URL + TTS_API_KEY.";

/**
 * Turn a command template into argv, substituting {text} {output} {voice}
 * {format}. Supports simple quoted tokens so a script path (or the text) with
 * spaces survives as one argument. Pure + testable — mirrors enhance's
 * `buildCliArgs`.
 */
export function buildTtsArgs(template: string, vars: Record<string, string>): string[] {
  const tokens = template.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return tokens.map((raw) => {
    const unq = raw.replace(/^["']|["']$/g, "");
    return unq.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  });
}

/**
 * `none` — the default, free-tier stance: NO synthesizer is bundled, so this
 * provider is never available and always throws the gated message. It exists so
 * `selectTtsProvider` always returns something and the tool can report honestly.
 */
export class NoneTtsProvider implements TtsProvider {
  id = "none";
  label = "None (no voice-over — money-gated; configure a provider)";
  usesAI = false;

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async synthesize(_req: TtsRequest): Promise<TtsResult> {
    throw new Error(TTS_UNAVAILABLE_MESSAGE);
  }
}

/**
 * `cli` — run ANY external TTS CLI. Set a command template with
 * {text} {output} {voice} {format}, e.g.
 *   piper --model en_US.onnx --output_file {output} --text {text}
 * or a wrapper around macOS `say`, coqui-tts, etc. Nothing runs until you
 * configure the command (money/setup gate).
 */
export class CliTtsProvider implements TtsProvider {
  id = "cli";
  label = "Custom CLI (bring your own TTS)";
  usesAI = true;

  constructor(private readonly command: string | undefined) {}

  async isAvailable(): Promise<boolean> {
    return typeof this.command === "string" && this.command.trim().length > 0;
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    if (!this.command) throw new Error("No TTS CLI configured (set TTS_CLI_COMMAND).");
    // Imported lazily so this module stays import-safe for pure (browser/verify) use.
    const { spawn } = await import("node:child_process");
    const args = buildTtsArgs(this.command, {
      text: req.text,
      output: req.outputPath,
      voice: req.voice ?? "",
      format: req.format ?? "mp3",
    });
    const bin = args.shift();
    if (!bin) throw new Error("Empty TTS CLI command.");
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, args, { stdio: "inherit" });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))));
    });
    return { outputPath: req.outputPath, provider: this.id, usesAI: true, note: `ran ${bin}` };
  }
}

/**
 * `api` — hosted TTS endpoint (metered — money gate). Sends the text, writes back
 * the returned audio bytes. Configure via TTS_API_URL + TTS_API_KEY.
 */
export class ApiTtsProvider implements TtsProvider {
  id = "api";
  label = "Hosted API (metered) — neural voice-over";
  usesAI = true;

  constructor(
    private readonly url: string | undefined,
    private readonly apiKey: string | undefined,
  ) {}

  async isAvailable(): Promise<boolean> {
    return !!this.url && !!this.apiKey;
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    if (!this.url || !this.apiKey) throw new Error("TTS API not configured (TTS_API_URL / TTS_API_KEY).");
    const { writeFile } = await import("node:fs/promises");
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ text: req.text, voice: req.voice, format: req.format ?? "mp3" }),
    });
    if (!res.ok) throw new Error(`TTS API failed: ${res.status}`);
    await writeFile(req.outputPath, Buffer.from(await res.arrayBuffer()));
    return { outputPath: req.outputPath, provider: this.id, usesAI: true, note: "hosted API" };
  }
}

export interface TtsConfig {
  provider: string;
  cliCommand?: string;
  apiUrl?: string;
  apiKey?: string;
}

/** Read TTS config from env. `TTS_PROVIDER` picks the active provider (default "none"). */
export function ttsConfigFromEnv(env: Record<string, string | undefined> = process.env): TtsConfig {
  return {
    provider: env.TTS_PROVIDER?.toLowerCase() || "none",
    cliCommand: env.TTS_CLI_COMMAND,
    apiUrl: env.TTS_API_URL,
    apiKey: env.TTS_API_KEY,
  };
}

/** All known TTS providers for the given config (for UI listing). */
export function allTtsProviders(cfg: TtsConfig): TtsProvider[] {
  return [new NoneTtsProvider(), new CliTtsProvider(cfg.cliCommand), new ApiTtsProvider(cfg.apiUrl, cfg.apiKey)];
}

/** The active provider. Falls back to the (unavailable) `none` path for "none"/unknown. */
export function selectTtsProvider(cfg: TtsConfig): TtsProvider {
  switch (cfg.provider) {
    case "cli":
      return new CliTtsProvider(cfg.cliCommand);
    case "api":
      return new ApiTtsProvider(cfg.apiUrl, cfg.apiKey);
    case "none":
    default:
      return new NoneTtsProvider();
  }
}

/** Rough spoken-duration estimate (~2.6 words/sec) for when a provider can't report it. */
export function estimateSpeechSec(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.5, Math.round((words / 2.6) * 100) / 100);
}
