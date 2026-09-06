"use client";

import { useEffect, useId, useState } from "react";
import {
  ASPECT_OPTIONS,
  DEFAULT_PREFS,
  LOOK_OPTIONS,
  QUALITY_OPTIONS,
  loadPrefs,
  savePrefs,
  type EditorPrefs as Prefs,
} from "./prefs";

/**
 * Per-browser editor defaults, persisted to localStorage under `cadence:prefs`.
 * SSR-safe: renders DEFAULT_PREFS on the server and the first client paint, then
 * hydrates from storage in an effect (so there's no hydration mismatch). Each
 * change is written back immediately; the editor reads the same key on open.
 */
export function EditorPrefs() {
  const baseId = useId();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  // Hydrate from localStorage after mount (window is only available client-side).
  useEffect(() => {
    setPrefs(loadPrefs());
    setLoaded(true);
  }, []);

  function update<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      const ok = savePrefs(next);
      if (ok) {
        setSavedTick(true);
        window.setTimeout(() => setSavedTick(false), 1600);
      }
      return next;
    });
  }

  const selectClass =
    "w-full appearance-none rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-sm text-text outline-none transition focus:border-amber/50 disabled:opacity-50";

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${baseId}-aspect`} label="Default aspect ratio" hint="New projects and the frame picker start here.">
          <SelectWrap>
            <select
              id={`${baseId}-aspect`}
              value={prefs.defaultAspect}
              disabled={!loaded}
              onChange={(e) => update("defaultAspect", e.target.value as Prefs["defaultAspect"])}
              className={selectClass}
            >
              {ASPECT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </SelectWrap>
        </Field>

        <Field id={`${baseId}-look`} label="Default look" hint="Preselected in the Color room.">
          <SelectWrap>
            <select
              id={`${baseId}-look`}
              value={prefs.defaultLook}
              disabled={!loaded}
              onChange={(e) => update("defaultLook", e.target.value as Prefs["defaultLook"])}
              className={selectClass}
            >
              {LOOK_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </SelectWrap>
        </Field>

        <Field id={`${baseId}-quality`} label="Default export quality" hint="The preset the export menu opens on.">
          <SelectWrap>
            <select
              id={`${baseId}-quality`}
              value={prefs.defaultQuality}
              disabled={!loaded}
              onChange={(e) => update("defaultQuality", e.target.value as Prefs["defaultQuality"])}
              className={selectClass}
            >
              {QUALITY_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </SelectWrap>
        </Field>

        <Field id={`${baseId}-muted`} label="Preview audio" hint="Whether the player starts with sound on.">
          <label
            htmlFor={`${baseId}-muted`}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-elevated px-3.5 py-2.5"
          >
            <input
              id={`${baseId}-muted`}
              type="checkbox"
              checked={prefs.startUnmuted}
              disabled={!loaded}
              onChange={(e) => update("startUnmuted", e.target.checked)}
              className="h-4 w-4 accent-amber"
            />
            <span className="text-sm text-text">Start playback unmuted</span>
          </label>
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <span aria-live="polite" className="text-xs text-teal">
          {savedTick ? "Saved to this browser." : " "}
        </span>
        <span className="ml-auto text-xs text-faint">
          Stored on this device only (localStorage · <code className="text-muted">cadence:prefs</code>).
        </span>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-faint">
        {label}
      </label>
      {children}
      <p className="mt-1.5 text-xs text-faint">{hint}</p>
    </div>
  );
}

/** Select with a chevron affordance (the native arrow is hidden via appearance-none). */
function SelectWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <svg
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}
