"use client";

export type RoomKey = "media" | "edit" | "words" | "color" | "vfx" | "audio" | "deliver";

interface Room {
  key: RoomKey;
  label: string;
  hint: string;
  path: string; // simple SVG path glyph
}

const ROOMS: Room[] = [
  { key: "media", label: "Media", hint: "Your footage", path: "M4 5h16v14H4z M4 9h16" },
  { key: "edit", label: "Edit", hint: "Cut & arrange", path: "M4 12h16 M8 8l-4 4 4 4 M16 8l4 4-4 4" },
  { key: "words", label: "Words", hint: "Edit by transcript", path: "M5 6h14 M5 10h14 M5 14h9 M5 18h5" },
  { key: "color", label: "Color", hint: "Looks & grade", path: "M12 3a9 9 0 100 18 4 4 0 010-8 4 4 0 000-8z" },
  { key: "vfx", label: "VFX", hint: "B-roll & punch-in", path: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l3 3 M15 15l3 3" },
  { key: "audio", label: "Audio", hint: "Music & mix", path: "M4 10v4 M8 6v12 M12 8v8 M16 5v14 M20 10v4" },
  { key: "deliver", label: "Deliver", hint: "Quality & export", path: "M12 3v12 M8 11l4 4 4-4 M5 19h14" },
];

interface RoomsRailProps {
  room: RoomKey;
  onRoomChange: (room: RoomKey) => void;
}

export function RoomsRail({ room, onRoomChange }: RoomsRailProps) {
  return (
    <nav
      aria-label="Rooms"
      className="hidden md:flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line-soft bg-panel/60 py-4"
    >
      <div className="mb-3 grid h-9 w-9 place-items-center rounded-xl bg-amber text-ink font-bold">C</div>
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
              "group flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium transition",
              active ? "text-amber" : "text-faint hover:text-muted",
            ].join(" ")}
          >
            <span
              className={[
                "grid h-9 w-9 place-items-center rounded-xl border transition",
                active ? "border-amber/40 bg-amber/10" : "border-transparent group-hover:border-line",
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
