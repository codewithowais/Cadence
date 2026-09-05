import { fmtTime } from "@/lib/format";

interface TopBarProps {
  projectTitle: string;
  mediaLabel: string | null;
  durationSec: number;
  cutCount: number;
  codeOpen: boolean;
  onToggleCode: () => void;
  onExport: () => void;
  canExport: boolean;
}

export function TopBar(props: TopBarProps) {
  return (
    <header className="flex items-center gap-3 border-b border-line-soft bg-panel/50 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="truncate text-sm font-semibold tracking-tight text-text">{props.projectTitle}</span>
        {props.mediaLabel && (
          <span className="hidden truncate rounded-full border border-line bg-elevated px-2.5 py-1 text-xs text-muted sm:inline">
            {props.mediaLabel}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2 text-xs text-faint">
        {props.durationSec > 0 && (
          <span className="tabular-nums">
            {props.cutCount > 0 ? `${props.cutCount} cuts · ` : ""}
            {fmtTime(props.durationSec)}
          </span>
        )}
        <button
          type="button"
          onClick={props.onToggleCode}
          aria-pressed={props.codeOpen}
          className={[
            "rounded-lg border px-2.5 py-1.5 font-medium transition",
            props.codeOpen
              ? "border-teal/40 bg-teal/10 text-teal"
              : "border-line bg-elevated text-muted hover:text-text hover:border-line",
          ].join(" ")}
        >
          {"{ } code"}
        </button>
        <button
          type="button"
          onClick={props.onExport}
          disabled={!props.canExport}
          className="rounded-lg bg-amber px-3 py-1.5 font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export
        </button>
      </div>
    </header>
  );
}
