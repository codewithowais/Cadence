/**
 * Placeholder single-sign-on options. These are intentionally disabled — the app
 * ships with local DevAuthProvider auth today (see lib/auth.ts), and real SSO is
 * a future swap behind the same AuthProvider interface. They render so the page
 * reads as a real product, but each is clearly marked "coming soon" and cannot be
 * clicked, so nothing pretends to work.
 */

type Sso = { id: string; label: string; icon: React.ReactNode };

const PROVIDERS: Sso[] = [
  {
    id: "google",
    label: "Google",
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
        <path
          fill="currentColor"
          d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.64 4.1-5.35 4.1a5.68 5.68 0 010-11.36c1.62 0 2.7.69 3.32 1.28l2.26-2.18C16.4 4.6 14.42 3.7 12 3.7A8.3 8.3 0 1012 20.3c4.8 0 7.98-3.37 7.98-8.12 0-.55-.06-.97-.14-1.38z"
        />
      </svg>
    ),
  },
  {
    id: "github",
    label: "GitHub",
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
        <path
          fill="currentColor"
          d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 015 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0012 2z"
        />
      </svg>
    ),
  },
  {
    id: "sso",
    label: "SSO",
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none">
        <path
          d="M12 3l7 3v5c0 4.25-2.9 8.05-7 9-4.1-.95-7-4.75-7-9V6l7-3z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M9.5 12l1.8 1.8L15 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function SsoButtons() {
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {PROVIDERS.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled
          aria-disabled="true"
          title={`${p.label} sign-in — coming soon`}
          className="group flex cursor-not-allowed flex-col items-center gap-1.5 rounded-xl border border-line bg-elevated/60 px-2 py-3 text-muted opacity-70"
        >
          <span className="text-faint">{p.icon}</span>
          <span className="text-xs font-medium">{p.label}</span>
          <span className="text-[0.6rem] uppercase tracking-wide text-faint">Soon</span>
        </button>
      ))}
    </div>
  );
}
