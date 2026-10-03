"use client";

import type { Ctx2D } from "@cadence/core";

let cached: Ctx2D | null | undefined;

/**
 * A shared offscreen 2D context used ONLY to measure text (the on-canvas selection
 * box needs a text block's real width/height). Returns null on the server or when
 * canvas is unavailable — the pure math then falls back to its estimator.
 */
export function getMeasureCtx(): Ctx2D | null {
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return null;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    cached = (ctx as unknown as Ctx2D | null) ?? null;
  } catch {
    cached = null;
  }
  return cached;
}
