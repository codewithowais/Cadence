import { spawn } from "node:child_process";
import type { EnhanceProvider, EnhanceRequest, EnhanceResult } from "../provider";

/**
 * Local Real-ESRGAN (faithful super-resolution — restores detail without
 * altering faces/identity). Free to run; needs the binary installed and a model.
 * Configure the binary path via ENHANCE_LOCAL_BIN (default: realesrgan-ncnn-vulkan).
 */
export class LocalEsrganProvider implements EnhanceProvider {
  id = "local";
  label = "Real-ESRGAN (local, free) — faithful super-resolution";
  usesAI = true;
  preservesIdentity = true as const;

  constructor(private readonly bin = "realesrgan-ncnn-vulkan") {}

  async isAvailable(): Promise<boolean> {
    return which(this.bin);
  }

  async enhance(req: EnhanceRequest): Promise<EnhanceResult> {
    // Real-ESRGAN operates on frames/images; video is upscaled frame-by-frame by
    // the export worker. Here we handle a single image request.
    const scale = Math.max(2, Math.min(4, Math.round(req.scale)));
    await run(this.bin, ["-i", req.inputPath, "-o", req.outputPath, "-s", String(scale)]);
    return { outputPath: req.outputPath, provider: this.id, usedAI: true, note: `Real-ESRGAN ${scale}×` };
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))));
  });
}

function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}
