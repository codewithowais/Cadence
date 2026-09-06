/**
 * On-preview placement — the shared contract between the Demo room (which arms a
 * gesture), the Editor (which owns the state + resolves the promise) and the Stage
 * overlay (which captures the pointer and reports composition FRACTIONS).
 *
 * The whole point of the Walkthrough room is spatial authoring: a screenshot
 * carries no field pixels, so the user's own click/drag on the preview IS the
 * field detector. The overlay converts pointer pixels into 0..1 fractions of the
 * rendered composition rect (the Stage frame element is exactly that rect, so a
 * fraction is just local-offset / size — no letterbox math, but we clamp 0..1).
 * The caller then multiplies by `doc.meta.width` / `doc.meta.height` to get the
 * composition px the pure fns (typeText / addCursor / addCallout) expect.
 */

/** Which gesture the preview overlay should capture. */
export type PlacementMode = "point" | "path" | "rect";

/** A single placed point, as a fraction (0..1) of the composition width/height. */
export interface PlacementPoint {
  xFrac: number;
  yFrac: number;
}

/** A normalized rectangle (top-left origin + size), each field a 0..1 fraction. */
export interface PlacementRect {
  xFrac: number;
  yFrac: number;
  wFrac: number;
  hFrac: number;
}

/** The result of a completed placement gesture. */
export interface PlacementResult {
  mode: PlacementMode;
  /**
   * "point" → one point; "path" → the ordered waypoints (last one is the click);
   * "rect" → a single point at the rect's top-left (plus `rect`).
   */
  points: PlacementPoint[];
  /** Present for "rect": the dragged rectangle. */
  rect?: PlacementRect;
}

/** An armed placement gesture — the mode plus a short helper line for the overlay. */
export interface PlacementRequest {
  mode: PlacementMode;
  hint: string;
}

/**
 * Arm an on-preview placement gesture. Resolves with the result once the user
 * completes it, or `null` if they cancel (Esc / empty). One gesture at a time —
 * arming a new one cancels any prior pending gesture.
 */
export type BeginPlacement = (mode: PlacementMode, hint: string) => Promise<PlacementResult | null>;
