import Link from "next/link";

/**
 * Shared top nav / account menu for the authed pages (dashboard, settings).
 * Server component: it just renders links + a sign-out form (POST /api/auth/logout).
 */
export function TopNav({ email, active }: { email: string; active: "dashboard" | "settings" }) {
  const link = (href: string, label: string, key: "dashboard" | "settings") => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={[
        "rounded-lg px-3 py-1.5 text-sm transition",
        active === key ? "bg-elevated text-text" : "text-muted hover:text-text",
      ].join(" ")}
    >
      {label}
    </Link>
  );

  return (
    <header className="border-b border-line-soft bg-panel/50">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-6 py-3">
        <Link href="/dashboard" className="mr-2 flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber font-bold text-onaccent">C</div>
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">Cadence</span>
        </Link>
        {link("/dashboard", "Projects", "dashboard")}
        {link("/settings", "Settings", "settings")}

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden max-w-[16rem] truncate text-xs text-faint sm:inline" title={email}>
            {email}
          </span>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="rounded-lg border border-line bg-elevated px-3 py-1.5 text-sm text-muted transition hover:text-text"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
