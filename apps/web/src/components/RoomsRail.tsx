interface Room {
  key: string;
  label: string;
  hint: string;
  active: boolean;
  path: string; // simple SVG path glyph
}

const ROOMS: Room[] = [
  { key: "media", label: "Media", hint: "Your footage", active: false, path: "M4 5h16v14H4z M4 9h16" },
  { key: "edit", label: "Edit", hint: "Cut & arrange", active: true, path: "M4 12h16 M8 8l-4 4 4 4 M16 8l4 4-4 4" },
  { key: "color", label: "Color", hint: "Phase 2", active: false, path: "M12 3a9 9 0 100 18 4 4 0 010-8 4 4 0 000-8z" },
  { key: "vfx", label: "VFX", hint: "Phase 3", active: false, path: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l3 3 M15 15l3 3" },
  { key: "audio", label: "Audio", hint: "Phase 2", active: false, path: "M4 10v4 M8 6v12 M12 8v8 M16 5v14 M20 10v4" },
  { key: "deliver", label: "Deliver", hint: "Export", active: false, path: "M12 3v12 M8 11l4 4 4-4 M5 19h14" },
];

export function RoomsRail() {
  return (
    <nav
      aria-label="Rooms"
      className="hidden md:flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line-soft bg-panel/60 py-4"
    >
      <div className="mb-3 grid h-9 w-9 place-items-center rounded-xl bg-amber text-ink font-bold">C</div>
      {ROOMS.map((r) => (
        <button
          key={r.key}
          type="button"
          disabled={!r.active}
          title={`${r.label} — ${r.hint}`}
          aria-current={r.active ? "page" : undefined}
          className={[
            "group flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium transition",
            r.active
              ? "text-amber"
              : "text-faint hover:text-muted disabled:cursor-not-allowed disabled:opacity-50",
          ].join(" ")}
        >
          <span
            className={[
              "grid h-9 w-9 place-items-center rounded-xl border transition",
              r.active
                ? "border-amber/40 bg-amber/10"
                : "border-transparent group-hover:border-line",
            ].join(" ")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d={r.path} />
            </svg>
          </span>
          {r.label}
        </button>
      ))}
    </nav>
  );
}
