"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import { SsoButtons } from "@/components/auth/SsoButtons";

/** Same loose check the server uses (lib/session.isValidEmail) — mirrored client-side. */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Dev sign-in form. Progressive enhancement over a native form POST:
 * without JS the browser submits to /api/auth/login and follows the 303 to
 * /dashboard exactly as before. With JS we add inline email validation, a
 * loading state, and inline error display — but still let the browser perform
 * the real submit + redirect, so the DevAuthProvider cookie flow is untouched.
 */
export function SignInForm({ initialError }: { initialError?: string }) {
  const emailId = useId();
  const nameId = useId();
  const errorId = useId();

  const emailRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // Seeded from a server round-trip (JS-off fallback), then owned client-side.
  const [error, setError] = useState<string | null>(initialError ?? null);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const email = emailRef.current?.value ?? "";
    if (!isValidEmail(email)) {
      e.preventDefault();
      setError("Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    // Valid: let the native submit + server redirect proceed; show loading.
    setError(null);
    setBusy(true);
  }

  return (
    <div>
      <form
        action="/api/auth/login"
        method="post"
        onSubmit={handleSubmit}
        noValidate
        className="space-y-4"
        aria-describedby={error ? errorId : undefined}
      >
        {error && (
          <p
            id={errorId}
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="mt-0.5 h-4 w-4 flex-none"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 5a1 1 0 112 0v5a1 1 0 11-2 0V5zm1 9.5a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5z"
                clipRule="evenodd"
              />
            </svg>
            <span>{error}</span>
          </p>
        )}

        <div>
          <label htmlFor={emailId} className="mb-1.5 block text-xs font-medium text-muted">
            Email
          </label>
          <input
            ref={emailRef}
            id={emailId}
            name="email"
            type="email"
            required
            autoFocus
            autoComplete="email"
            inputMode="email"
            placeholder="you@studio.com"
            disabled={busy}
            aria-invalid={error ? true : undefined}
            onInput={() => error && setError(null)}
            className="w-full rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-sm text-text placeholder:text-faint transition-colors focus:border-amber/40 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor={nameId} className="mb-1.5 block text-xs font-medium text-muted">
            Name <span className="text-faint">(optional)</span>
          </label>
          <input
            id={nameId}
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Your name"
            disabled={busy}
            className="w-full rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-sm text-text placeholder:text-faint transition-colors focus:border-amber/40 focus:outline-none disabled:opacity-50"
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy && (
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              fill="none"
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          {busy ? "Opening your workspace…" : "Continue"}
        </button>
      </form>

      <div className="my-6 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        <span className="text-[0.7rem] uppercase tracking-wider text-faint">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <SsoButtons />

      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/editor" className="text-teal underline-offset-2 hover:underline">
          Continue without an account
        </Link>{" "}
        <span className="text-faint">— edit in the scratch workspace.</span>
      </p>
    </div>
  );
}
