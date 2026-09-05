import { spawn } from "node:child_process";
import { buildCliArgs, type EnhanceProvider, type EnhanceRequest, type EnhanceResult } from "../provider";

/**
 * Runs ANY external CLI as the upscaler — this is the extensible AI option. Set
 * a command template with {input} {output} {scale} {sharpen} {denoise}, e.g.
 *   realesrgan-ncnn-vulkan -i {input} -o {output} -s {scale}
 * or a wrapper script around any AI CLI you prefer. YOU are responsible for
 * pointing it at a FAITHFUL model (Real-ESRGAN and similar) — not a generative
 * face model. Nothing runs until you configure the command.
 */
export class CliEnhanceProvider implements EnhanceProvider {
  id = "cli";
  label = "Custom CLI (bring your own upscaler)";
  usesAI = true;
  preservesIdentity = true as const;

  constructor(private readonly command: string | undefined) {}

  async isAvailable(): Promise<boolean> {
    return typeof this.command === "string" && this.command.trim().length > 0;
  }

  async enhance(req: EnhanceRequest): Promise<EnhanceResult> {
    if (!this.command) throw new Error("No enhance CLI configured (set ENHANCE_CLI_COMMAND).");
    const args = buildCliArgs(this.command, {
      input: req.inputPath,
      output: req.outputPath,
      scale: req.scale,
      sharpen: req.sharpen,
      denoise: req.denoise,
    });
    const bin = args.shift();
    if (!bin) throw new Error("Empty enhance CLI command.");
    await run(bin, args);
    return { outputPath: req.outputPath, provider: this.id, usedAI: true, note: `ran ${bin}` };
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))));
  });
}
