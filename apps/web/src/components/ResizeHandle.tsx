"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";

interface ResizeHandleProps {
  /** Called with the horizontal pointer delta (px) as the user drags. */
  onDelta: (dx: number) => void;
  ariaLabel: string;
  /** Keyboard step in px (arrow keys). */
  step?: number;
  className?: string;
}

/**
 * A thin vertical drag handle for resizing side panels. Pointer-drag to resize;
 * arrow keys nudge for keyboard users. Accessible (role="separator").
 */
export function ResizeHandle({ onDelta, ariaLabel, step = 16, className = "" }: ResizeHandleProps) {
  const last = useRef(0);
  const dragging = useRef(false);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragging.current = true;
    last.current = e.clientX;
    e.currentTarget.focus(); // preventDefault blocks implicit focus; restore it for keyboard nudge
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unsupported / synthetic pointer — dragging still works */
    }
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const dx = e.clientX - last.current;
    if (dx !== 0) {
      last.current = e.clientX;
      onDelta(dx);
    }
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onDelta(-step);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onDelta(step);
        }
      }}
      className={`group relative w-1.5 shrink-0 cursor-col-resize touch-none select-none ${className}`}
      title="Drag to resize"
    >
      {/* the visible divider line, brightening to teal on hover/focus */}
      <span className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-line-soft transition group-hover:w-0.5 group-hover:bg-teal/70 group-focus-visible:bg-teal" />
    </div>
  );
}
