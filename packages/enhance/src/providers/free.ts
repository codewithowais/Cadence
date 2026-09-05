import type { EnhanceProvider, EnhanceRequest, EnhanceResult } from "../provider";

/**
 * Free, non-AI, perfectly faithful. It performs NO pixel work itself — the
 * ffmpeg export applies Lanczos upscale + unsharp + light denoise directly in
 * the filtergraph. This provider is the marker for "free enhance path".
 */
export class FreeEnhanceProvider implements EnhanceProvider {
  id = "free";
  label = "Faithful (Lanczos + sharpen/denoise) — free, no AI";
  usesAI = false;
  preservesIdentity = true as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async enhance(req: EnhanceRequest): Promise<EnhanceResult> {
    return {
      outputPath: req.inputPath,
      provider: this.id,
      usedAI: false,
      note: "applied in the export filtergraph (Lanczos scale + unsharp + hqdn3d)",
    };
  }
}
