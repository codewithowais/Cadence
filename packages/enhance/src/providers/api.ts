import { readFile, writeFile } from "node:fs/promises";
import type { EnhanceProvider, EnhanceRequest, EnhanceResult } from "../provider";

/**
 * Hosted super-resolution API (metered — money gate). Point it at a FAITHFUL
 * upscaling endpoint (Real-ESRGAN / Topaz-style), never a generative face model.
 * Sends the file bytes, writes back the enhanced bytes. Configure via
 * ENHANCE_API_URL + ENHANCE_API_KEY.
 */
export class ApiEnhanceProvider implements EnhanceProvider {
  id = "api";
  label = "Hosted API (metered) — faithful super-resolution";
  usesAI = true;
  preservesIdentity = true as const;

  constructor(
    private readonly url: string | undefined,
    private readonly apiKey: string | undefined,
  ) {}

  async isAvailable(): Promise<boolean> {
    return !!this.url && !!this.apiKey;
  }

  async enhance(req: EnhanceRequest): Promise<EnhanceResult> {
    if (!this.url || !this.apiKey) throw new Error("Enhance API not configured (ENHANCE_API_URL / ENHANCE_API_KEY).");
    const bytes = await readFile(req.inputPath);
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${this.apiKey}`,
        "x-scale": String(req.scale),
        "x-faithful": "true",
      },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new Error(`enhance API failed: ${res.status}`);
    await writeFile(req.outputPath, Buffer.from(await res.arrayBuffer()));
    return { outputPath: req.outputPath, provider: this.id, usedAI: true, note: "hosted API" };
  }
}
