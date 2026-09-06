"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";

interface ResizeHandleProps {
  /** Primary-axis pointer delta (px): x for vertical dividers, y for horizontal. */
  onDelta: (delta: number) => void;
  ariaLabel: string;
  /** "vertical" = a column divider you drag left/right (default). "horizontal" = a row divider you drag up/down. */
  orientation?: "vertical" | "horizontal";
  /** Keyboard step in px (arrow keys). */
  step?: number;
  className?: string;
}

/**
 * A thin drag handle for resizing adjacent panels. Pointer-drag to resize; arrow
 * keys nudge for keyboard users. Accessible (role="separator"). The default amber
 * focus outline is suppressed in favor of a subtle teal divider line (north-star:
 * teal = selection), so a focused/hovered handle reads as a hairline, not a bar.
 */
export function ResizeHandle({
  onDelta,
  ariaLabel,
  orientation = "vertical",
  step = 16,
  className = "",
}: ResizeHandleProps) {
  const last = useRef(0);
  const dragging = useRef(false);
  const horizontal = orientation === "horizontal";

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragging.current = true;
    last.current = horizontal ? e.clientY : e.clientX;
    e.currentTarget.focus();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic/unsupported pointer — dragging still works */
    }
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const pos = horizontal ? e.clientY : e.clientX;
    const d = pos - last.current;
    if (d !== 0) {
      last.current = pos;
      onDelta(d);
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

  const decKey = horizontal ? "ArrowUp" : "ArrowLeft";
  const incKey = horizontal ? "ArrowDown" : "ArrowRight";

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(e) => {
        if (e.key === decKey) {
          e.preventDefault();
          onDelta(-step);
        } else if (e.key === incKey) {
          e.preventDefault();
          onDelta(step);
        }
      }}
      className={[
        "group relative shrink-0 touch-none select-none outline-none",
        horizontal ? "h-1.5 w-full cursor-row-resize" : "w-1.5 self-stretch cursor-col-resize",
        className,
      ].join(" ")}
      title="Drag to resize"
    >
      {/* the visible hairline — subtle by default, teal on hover/keyboard-focus */}
      <span
        className={[
          "pointer-events-none absolute bg-line-soft transition-colors",
          horizontal
            ? "inset-x-0 top-1/2 h-px -translate-y-1/2 group-hover:bg-teal/70 group-focus-visible:bg-teal"
            : "inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover:bg-teal/70 group-focus-visible:bg-teal",
        ].join(" ")}
      />
    </div>
  );
}
