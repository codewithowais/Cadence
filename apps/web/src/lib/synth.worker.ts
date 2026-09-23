/**
 * Web Worker: render a `synth:` recipe (generated music / SFX) to a WAV file off
 * the main thread, so composing a minute of music never janks the editor. Pure
 * DSP from `@cadence/director/sound-synth` — the same code the verify gate runs.
 */
import { encodeWav, parseSynthSrc, renderSynthRecipe } from "@cadence/director/sound-synth";

interface SynthRequest {
  id: number;
  src: string;
}

self.onmessage = (e: MessageEvent<SynthRequest>) => {
  const { id, src } = e.data;
  try {
    const recipe = parseSynthSrc(src);
    if (!recipe) throw new Error(`Not a sound recipe: ${src}`);
    const wav = encodeWav(renderSynthRecipe(recipe));
    self.postMessage({ id, wav: wav.buffer }, { transfer: [wav.buffer] });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
