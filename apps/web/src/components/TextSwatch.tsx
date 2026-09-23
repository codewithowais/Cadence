"use client";

/**
 * Tiny live previews drawn with the SAME shared canvas code as the Stage and the
 * export: a sample text clip (for animation / effect / font tiles) and a
 * background swatch (gradient / animated / pattern). Animated previews only run
 * while hovered/focused (or when `playing`), so a gallery of dozens stays cheap.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  drawSolid,
  drawText,
  parseEditDoc,
  type SolidClip,
  type TextClip,
} from "@cadence/core";

const PW = 240; // composition size of the preview (drawn scaled to the element)
const PH = 120;

function useLoop(active: boolean, period: number): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setT(((now - t0) / 1000) % period);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, period]);
  return active ? t : -1;
}

function useCanvas(draw: (ctx: CanvasRenderingContext2D, s: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || PW / 2;
    const h = cv.clientHeight || PH / 2;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const s = cv.width / PW;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    draw(ctx, s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** A sample text clip (composition 240×120) with the given overrides. */
export function sampleText(text: string, over: Record<string, unknown>, duration = 2.4): TextClip {
  return parseEditDoc({
    version: 1,
    meta: { width: PW, height: PH },
    tracks: [
      {
        id: "t",
        kind: "visual",
        clips: [
          {
            id: "s",
            kind: "text",
            start: 0,
            duration,
            text,
            fontSize: 30,
            fontWeight: "bold",
            color: "#ffffff",
            transform: { x: PW / 2, y: PH / 2 },
            ...over,
          },
        ],
      },
    ],
  }).tracks[0]!.clips[0] as TextClip;
}

export function TextSwatch({
  clip,
  animate = false,
  restTime,
  background = "#1b2030",
  className = "",
}: {
  clip: TextClip;
  /** Loop the clip's animation (e.g. on hover). */
  animate?: boolean;
  /** Time drawn when not animating (default: settled). */
  restTime?: number;
  background?: string;
  className?: string;
}) {
  const [fontsTick, setFontsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    document.fonts
      ?.load(`bold 30px ${clip.fontFamily}`)
      .then(() => alive && setFontsTick((n) => n + 1))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [clip.fontFamily]);
  const t = useLoop(animate, clip.duration);
  const drawAt = t >= 0 ? t : restTime ?? Math.min(clip.duration * 0.75, 1.6);
  const ref = useCanvas(
    (ctx, s) => {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, PW, PH);
      drawText(ctx, clip, drawAt, { pxScale: s });
    },
    [clip, drawAt, background, fontsTick],
  );
  return <canvas ref={ref} aria-hidden="true" className={`block h-full w-full ${className}`} />;
}

export function BackgroundSwatch({ spec, animate = false }: { spec: Record<string, unknown>; animate?: boolean }) {
  const clip = useMemo(
    () =>
      parseEditDoc({
        version: 1,
        meta: { width: PW, height: PH },
        tracks: [{ id: "b", kind: "visual", clips: [{ id: "b", kind: "solid", start: 0, duration: 30, ...spec }] }],
      }).tracks[0]!.clips[0] as SolidClip,
    [spec],
  );
  const t = useLoop(animate, 30);
  const drawAt = t >= 0 ? t : 1;
  const ref = useCanvas((ctx) => drawSolid(ctx, clip, PW, PH, drawAt), [clip, drawAt]);
  return <canvas ref={ref} aria-hidden="true" className="block h-full w-full" />;
}
