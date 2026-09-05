/**
 * Enhance provider contract.
 *
 * HARD RULE — FAITHFULNESS: every provider here does *detail-preserving*
 * upscaling/cleanup only. It may add real detail, sharpen, and denoise, but it
 * MUST NOT alter faces, identity, or content (no generative redraw / "reimagine"
 * models). `preservesIdentity` is `true` for all of them as a standing contract;
 * an operator who wires a CLI/API is responsible for pointing it at a faithful
 * model (e.g. Real-ESRGAN), never a generative face model.
 */

export interface EnhanceRequest {
  inputPath: string;
  outputPath: string;
  /** Upscale factor, e.g. 2 for 2×. */
  scale: number;
  /** 0..1 sharpen amount. */
  sharpen: number;
  /** 0..1 denoise amount. */
  denoise: number;
  kind: "image" | "video";
}

export interface EnhanceResult {
  outputPath: string;
  provider: string;
  usedAI: boolean;
  note?: string;
}

export interface EnhanceProvider {
  id: string;
  label: string;
  usesAI: boolean;
  /** Always true: providers here never change faces/identity/content. */
  preservesIdentity: true;
  /** True when this provider can run in the current environment. */
  isAvailable(): Promise<boolean>;
  enhance(req: EnhanceRequest): Promise<EnhanceResult>;
}

/**
 * Turn a command template into argv, substituting {input} {output} {scale}
 * {sharpen} {denoise}. Supports simple quoted tokens for paths with spaces.
 * Pure + testable.
 */
export function buildCliArgs(template: string, vars: Record<string, string | number>): string[] {
  const tokens = template.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return tokens.map((raw) => {
    const unq = raw.replace(/^["']|["']$/g, "");
    return unq.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
  });
}
