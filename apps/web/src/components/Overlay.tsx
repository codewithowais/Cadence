"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  /** Tailwind classes for the panel (width, padding…). */
  panelClassName?: string;
  /** Vertical placement: `top` (command palette) or `center`. */
  placement?: "top" | "center";
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A small accessible modal shell: `role="dialog"` + `aria-modal`, Escape and
 * backdrop-click close, Tab is trapped inside, and focus returns to whatever was
 * focused before it opened. The entrance motion is a short fade/rise that the
 * global `prefers-reduced-motion` rule flattens.
 */
export function Overlay({ open, onClose, label, panelClassName = "", placement = "center", children }: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Focus the first field (or the first focusable) once mounted.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const first = panel.querySelector<HTMLElement>("input, textarea") ?? panel.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      const back = restoreRef.current;
      // Return focus to the opener if it's still in the page — unless the action
      // that closed us deliberately moved focus somewhere (e.g. the composer).
      requestAnimationFrame(() => {
        const lost = !document.activeElement || document.activeElement === document.body;
        if (lost && back && document.contains(back)) back.focus();
      });
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className={`fixed inset-0 z-[60] flex justify-center bg-black/40 px-4 backdrop-blur-[2px] ${placement === "top" ? "items-start pt-[12vh]" : "items-center py-6"}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <style>{"@keyframes cadence-pop{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}"}</style>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ animation: "cadence-pop 140ms ease-out" }}
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_64px_-20px_rgba(24,34,38,0.35)] ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

/** A keycap. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-line bg-elevated px-1.5 py-0.5 font-chrome text-[10px] font-medium text-muted shadow-sm">
      {children}
    </kbd>
  );
}
