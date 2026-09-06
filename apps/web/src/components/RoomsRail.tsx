"use client";

export type RoomKey = "media" | "edit" | "design" | "words" | "demo" | "audio" | "deliver";

interface Room {
  key: RoomKey;
  label: string;
  hint: string;
  path: string; // simple SVG path glyph
}

const ROOMS: Room[] = [
  { key: "media", label: "Media", hint: "Your footage", path: "M4 5h16v14H4z M4 9h16" },
  { key: "edit", label: "Edit", hint: "Cut & arrange", path: "M4 12h16 M8 8l-4 4 4 4 M16 8l4 4-4 4" },
  { key: "design", label: "Design", hint: "Looks, color, text & FX", path: "M12 3a9 9 0 100 18 4 4 0 010-8 4 4 0 000-8z M12 3v4 M18 8l-3 3" },
  { key: "words", label: "Words", hint: "Edit by transcript", path: "M5 6h14 M5 10h14 M5 14h9 M5 18h5" },
  { key: "demo", label: "Demo", hint: "Walkthroughs", path: "M5 3l6 15 2-6 6-2z M13 13l6 6" },
  { key: "audio", label: "Audio", hint: "Music & mix", path: "M4 10v4 M8 6v12 M12 8v8 M16 5v14 M20 10v4" },
  { key: "deliver", label: "Deliver", hint: "Quality & export", path: "M12 3v12 M8 11l4 4 4-4 M5 19h14" },
];

interface RoomsRailProps {
  room: RoomKey;
  onRoomChange: (room: RoomKey) => void;
  /** If set, the brand "C" becomes a link home (e.g. /dashboard). */
  backHref?: string;
}

export function RoomsRail({ room, onRoomChange, backHref }: RoomsRailProps) {
  // The single brand mark in the editor (the DirectorRail duplicate was removed).
  // It doubles as the home affordance when a `backHref` is provided.
  const brand = backHref ? (
    <a
      href={backHref}
      aria-label="Cadence — back home"
      title="Cadence — back home"
      className="mb-3 grid h-9 w-9 place-items-center rounded-xl bg-amber font-bold text-ink transition hover:bg-amber-bright"
    >
      C
    </a>
  ) : (
    <div className="mb-3 grid h-9 w-9 place-items-center rounded-xl bg-amber font-bold text-ink">C</div>
  );
  return (
    <nav
      aria-label="Rooms"
      className="hidden md:flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line-soft bg-panel/60 py-4"
    >
      {brand}
      {ROOMS.map((r) => {
        const active = r.key === room;
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => onRoomChange(r.key)}
            title={`${r.label} — ${r.hint}`}
            aria-current={active ? "page" : undefined}
            className={[
              "group flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] transition",
              active ? "font-semibold text-amber" : "font-medium text-faint hover:text-muted",
            ].join(" ")}
          >
            <span
              className={[
                "grid h-9 w-9 place-items-center rounded-xl border transition",
                active
                  ? "border-amber/50 bg-amber/15 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-amber)_30%,transparent)]"
                  : "border-transparent group-hover:border-line group-hover:bg-elevated",
              ].join(" ")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d={r.path} />
              </svg>
            </span>
            {r.label}
          </button>
        );
      })}
    </nav>
  );
}
