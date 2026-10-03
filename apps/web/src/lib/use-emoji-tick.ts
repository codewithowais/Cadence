"use client";

import { useEffect, useState } from "react";
import { onEmojiLoaded } from "./emoji-assets";

/** A counter that bumps whenever a lazily-loaded emoji sprite arrives, so canvases redraw. */
export function useEmojiTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => onEmojiLoaded(() => setTick((n) => n + 1)), []);
  return tick;
}
