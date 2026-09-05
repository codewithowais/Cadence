/**
 * Provider selection + config. `ENHANCE_PROVIDER` picks the active provider;
 * "none"/"free" (default) is the free, no-AI, always-faithful path. The AI
 * options — local Real-ESRGAN, hosted API, or a custom CLI — are opt-in and
 * money/setup gated. All are identity-preserving by contract.
 */
import type { EnhanceProvider } from "./provider";
import { FreeEnhanceProvider } from "./providers/free";
import { CliEnhanceProvider } from "./providers/cli";
import { LocalEsrganProvider } from "./providers/local";
import { ApiEnhanceProvider } from "./providers/api";

export interface EnhanceConfig {
  provider: string;
  cliCommand?: string;
  apiUrl?: string;
  apiKey?: string;
  localBin?: string;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): EnhanceConfig {
  return {
    provider: env.ENHANCE_PROVIDER?.toLowerCase() || "free",
    cliCommand: env.ENHANCE_CLI_COMMAND,
    apiUrl: env.ENHANCE_API_URL,
    apiKey: env.ENHANCE_API_KEY,
    localBin: env.ENHANCE_LOCAL_BIN,
  };
}

/** All known providers for the given config (for UI listing). */
export function allProviders(cfg: EnhanceConfig): EnhanceProvider[] {
  return [
    new FreeEnhanceProvider(),
    new LocalEsrganProvider(cfg.localBin),
    new ApiEnhanceProvider(cfg.apiUrl, cfg.apiKey),
    new CliEnhanceProvider(cfg.cliCommand),
  ];
}

/** The active provider. Falls back to the free path for "none"/"free"/unknown. */
export function selectProvider(cfg: EnhanceConfig): EnhanceProvider {
  switch (cfg.provider) {
    case "local":
      return new LocalEsrganProvider(cfg.localBin);
    case "api":
      return new ApiEnhanceProvider(cfg.apiUrl, cfg.apiKey);
    case "cli":
      return new CliEnhanceProvider(cfg.cliCommand);
    case "none":
    case "free":
    default:
      return new FreeEnhanceProvider();
  }
}
