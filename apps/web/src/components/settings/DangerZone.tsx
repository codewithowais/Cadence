/**
 * Danger zone: irreversible-feeling actions kept visually distinct.
 *  - Sign out: a native POST to the existing /api/auth/logout (clears the cookie).
 *  - Delete workspace: intentionally DISABLED. Deleting an org cascades to every
 *    project, media asset, and edit-doc version in the tenant with no undo, so it
 *    is deliberately not wired to a self-serve destructive route here — it needs
 *    an owner-only, audited flow. Shown disabled with a contact-support note.
 *
 * Rendered inside the (client) SettingsView; it uses no client-only APIs itself.
 */
export function DangerZone({ role }: { role: string | null }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-elevated/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text">Sign out</h3>
          <p className="mt-0.5 text-sm text-muted">End this session on this device.</p>
        </div>
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="w-full rounded-xl border border-line bg-panel px-4 py-2 text-sm font-semibold text-text transition hover:border-amber/40 sm:w-auto"
          >
            Sign out
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-danger/30 bg-danger/[0.06] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-danger">Delete workspace</h3>
            <p className="mt-0.5 text-sm text-muted">
              Permanently removes this workspace and every project, asset, and version in it. This can't be undone.
            </p>
          </div>
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Contact support to delete a workspace"
            className="w-full cursor-not-allowed rounded-xl border border-danger/40 bg-transparent px-4 py-2 text-sm font-semibold text-danger/70 opacity-60 sm:w-auto"
          >
            Delete workspace
          </button>
        </div>
        <p className="mt-3 border-t border-danger/20 pt-3 text-xs text-muted">
          Workspace deletion is owner-only and handled manually to prevent accidental data loss.{" "}
          {role === "owner" ? (
            <>
              You're an owner — email{" "}
              <a href="mailto:support@cadence.app" className="text-teal underline-offset-2 hover:underline">
                support@cadence.app
              </a>{" "}
              to request it.
            </>
          ) : (
            <>Ask a workspace owner, or contact support@cadence.app.</>
          )}
        </p>
      </div>
    </div>
  );
}
