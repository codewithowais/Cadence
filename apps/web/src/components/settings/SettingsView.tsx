"use client";

import { useRef, useState } from "react";
import { ProfileForm } from "./ProfileForm";
import { EditorPrefs } from "./EditorPrefs";
import { DangerZone } from "./DangerZone";

/** A workspace member, pre-serialized on the server (dates → strings). */
export interface MemberVM {
  id: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member" | "viewer";
  isYou: boolean;
}

export interface SettingsViewProps {
  email: string;
  userId: string;
  displayName: string | null;
  orgId: string | null;
  orgName: string | null;
  role: string | null;
  members: MemberVM[];
  /** True when the DB couldn't be reached to load members/profile. */
  dbDown: boolean;
}

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "workspace", label: "Workspace" },
  { id: "editor", label: "Editor" },
  { id: "danger", label: "Danger zone" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * Tabbed settings shell. Server-fetched data comes in as props; this component
 * owns only the active-tab UI state. The tablist is keyboard-accessible (arrow
 * keys + Home/End roving focus) and wired with aria-controls/aria-labelledby.
 */
export function SettingsView(props: SettingsViewProps) {
  const [active, setActive] = useState<TabId>("profile");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: React.KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === active);
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    const target = TABS[next];
    if (!target) return;
    setActive(target.id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="mt-6">
      <div
        role="tablist"
        aria-label="Settings sections"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto rounded-xl border border-line-soft bg-panel/50 p-1"
      >
        {TABS.map((t, idx) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.id)}
              className={[
                "whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition",
                selected ? "bg-elevated text-text shadow-sm" : "text-muted hover:text-text",
                t.id === "danger" && selected ? "text-red-200" : "",
              ].join(" ")}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {active === "profile" && (
          <Panel id="profile" title="Profile" desc="Your identity across this workspace.">
            <ProfileForm
              email={props.email}
              userId={props.userId}
              initialName={props.displayName}
              canEdit={!!props.orgId && !props.dbDown}
            />
          </Panel>
        )}

        {active === "workspace" && (
          <Panel id="workspace" title="Workspace" desc="The organization this session is scoped to, and its members.">
            <WorkspacePanel {...props} />
          </Panel>
        )}

        {active === "editor" && (
          <Panel id="editor" title="Editor preferences" desc="Defaults applied when you open the editor. Saved to this browser.">
            <EditorPrefs />
          </Panel>
        )}

        {active === "danger" && (
          <Panel id="danger" title="Danger zone" desc="Session and workspace actions.">
            <DangerZone role={props.role} />
          </Panel>
        )}
      </div>
    </div>
  );
}

function Panel({
  id,
  title,
  desc,
  children,
}: {
  id: TabId;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      tabIndex={0}
      className="rounded-2xl border border-line-soft bg-panel/50 p-6 outline-none focus-visible:ring-1 focus-visible:ring-amber/40"
    >
      <h2 className="text-base font-semibold text-text">{title}</h2>
      <p className="mt-0.5 mb-5 text-sm text-muted">{desc}</p>
      {children}
    </section>
  );
}

function WorkspacePanel({ orgId, orgName, role, members, dbDown }: SettingsViewProps) {
  if (!orgId) {
    return (
      <p className="rounded-xl border border-line-soft bg-elevated/60 px-3.5 py-3 text-sm text-muted">
        No workspace connected. Start Postgres with{" "}
        <code className="rounded bg-panel px-1.5 py-0.5 text-xs text-text">docker compose up db</code> and sign in
        again to create one.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line-soft bg-elevated/40 px-3.5 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">Workspace</div>
          <div className="mt-0.5 truncate text-sm text-text" title={orgName ?? orgId}>
            {orgName ?? "Your workspace"}
          </div>
        </div>
        <div className="rounded-xl border border-line-soft bg-elevated/40 px-3.5 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">Your role</div>
          <div className="mt-0.5 text-sm text-text">
            {role ? <RoleBadge role={role} /> : <span className="text-muted">unknown</span>}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-text">Members</h3>
          {!dbDown && members.length > 0 && (
            <span className="text-xs text-faint">
              {members.length} {members.length === 1 ? "member" : "members"}
            </span>
          )}
        </div>

        {dbDown ? (
          <p className="rounded-xl border border-line-soft bg-elevated/60 px-3.5 py-3 text-sm text-muted">
            Couldn't reach the database to list members. Start Postgres and reload to see the roster.
          </p>
        ) : members.length === 0 ? (
          <p className="rounded-xl border border-line-soft bg-elevated/60 px-3.5 py-3 text-sm text-muted">
            No members found for this workspace.
          </p>
        ) : (
          <ul className="divide-y divide-line-soft overflow-hidden rounded-xl border border-line-soft">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 bg-elevated/30 px-3.5 py-3">
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-elevated text-xs font-semibold uppercase text-amber"
                >
                  {(m.name?.trim()?.[0] ?? m.email[0] ?? "?").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text">
                      {m.name?.trim() || m.email}
                    </span>
                    {m.isYou && (
                      <span className="rounded bg-teal/15 px-1.5 py-0.5 text-[10px] font-medium text-teal">You</span>
                    )}
                  </span>
                  {m.name?.trim() && <span className="block truncate text-xs text-faint">{m.email}</span>}
                </span>
                <RoleBadge role={m.role} />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-faint">Member management (invites, role changes) is coming soon.</p>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const tone =
    role === "owner"
      ? "bg-amber/15 text-amber"
      : role === "admin"
        ? "bg-teal/15 text-teal"
        : "bg-elevated text-muted";
  return (
    <span className={["shrink-0 rounded-md px-2 py-0.5 text-xs font-medium capitalize", tone].join(" ")}>{role}</span>
  );
}
