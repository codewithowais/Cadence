import type { SVGProps } from "react";

/**
 * Small, consistent inline icons for the landing page.
 * All draw with `currentColor` at a 1.6 stroke on a 24-grid so they inherit
 * text color and stay crisp at any size. Decorative by default (aria-hidden).
 */
type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ScissorsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <path d="M8.1 7.5 20 18M8.1 16.5 20 6" />
    </Base>
  );
}

export function EraserIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m5.5 14.5 4-4 5 5-4 4H7z" />
      <path d="m9.5 10.5 5-5a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8l-5 5" />
      <path d="M4 20.5h16" />
    </Base>
  );
}

export function FrameIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="8.5" y="4" width="7" height="16" rx="1.5" />
      <path d="M4 8v8M20 8v8" />
    </Base>
  );
}

export function CaptionsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M9 11.5a1.6 1.6 0 0 0-3 0v1a1.6 1.6 0 0 0 3 0M18 11.5a1.6 1.6 0 0 0-3 0v1a1.6 1.6 0 0 0 3 0" />
    </Base>
  );
}

export function LooksIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17" />
      <path d="M12 12a8.5 8.5 0 0 1 8.5-8.5" opacity="0.55" />
    </Base>
  );
}

export function TitleIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 6h14M9 6v13" />
      <path d="M15.5 11h4M17.5 11v8" />
    </Base>
  );
}

export function BrollIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="12.5" y="12.5" width="6.5" height="4.5" rx="1" fill="currentColor" opacity="0.18" />
      <path d="M8 12.5 6 15" />
    </Base>
  );
}

export function SpeedIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 16a8 8 0 0 1 16 0" />
      <path d="m12 16 4-4" />
      <path d="M4 16h1.5M18.5 16H20" />
    </Base>
  );
}

export function PhotoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.4" />
      <path d="m4 17 5-4.5 4 3.2L16 13l4 3.5" />
    </Base>
  );
}

export function ExportIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 15V4" />
      <path d="m8 8 4-4 4 4" />
      <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </Base>
  );
}

export function PunchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M18.5 5.5l-2 2M7.5 16.5l-2 2" />
    </Base>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 16V5" />
      <path d="m7 10 5-5 5 5" />
      <path d="M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" />
    </Base>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-4 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />
      <path d="M8.5 8.5h7M8.5 12h4" />
    </Base>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </Base>
  );
}
