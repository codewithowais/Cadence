/**
 * Pure, parameterized SQL query builders.
 *
 * SECURITY CONTRACT (enforced here, testable without a DB):
 *  - Every builder returns a `{ text, values }` pair. User/tenant data goes ONLY
 *    in `values`, referenced from `text` as positional placeholders ($1, $2, …).
 *    No builder ever interpolates a value into the SQL string. This is what makes
 *    the whole data layer injection-safe.
 *  - Every tenant-scoped builder takes an `orgId` (and, where relevant, a
 *    `projectId`) and pins it in the WHERE clause, so a query can never read or
 *    write another tenant's rows.
 *
 * These builders are intentionally free of any `pg` import so they can be unit
 * tested in isolation (see scripts/verify.ts) and reused by any driver.
 */

/** A parameterized statement: SQL text with $N placeholders + ordered values. */
export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

export type MembershipRole = "owner" | "admin" | "member" | "viewer";

// ---------------------------------------------------------------------------
// Orgs / users / memberships (tenancy roots)
// ---------------------------------------------------------------------------

export function createOrgQuery(name: string): SqlQuery {
  return {
    text: `INSERT INTO orgs (name) VALUES ($1) RETURNING id, name, created_at, updated_at`,
    values: [name],
  };
}

export function createUserQuery(email: string, name: string | null): SqlQuery {
  return {
    text: `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email, name, created_at, updated_at`,
    values: [email, name],
  };
}

/**
 * Idempotent sign-in root: find-or-create a user by (case-insensitive) email.
 * Re-signing in never creates a duplicate — the unique `lower(email)` index makes
 * this an upsert that refreshes the display name when a new one is supplied.
 */
export function upsertUserQuery(email: string, name: string | null): SqlQuery {
  return {
    text: `INSERT INTO users (email, name) VALUES ($1, $2)
           ON CONFLICT (lower(email)) DO UPDATE
             SET name = COALESCE(EXCLUDED.name, users.name), updated_at = now()
           RETURNING id, email, name, created_at, updated_at`,
    values: [email, name],
  };
}

/**
 * The user's first (oldest) org membership — the tenant a session lands in on
 * sign-in. Scoped to the user via the memberships join; returns at most one row.
 */
export function firstOrgForUserQuery(userId: string): SqlQuery {
  return {
    text: `SELECT o.id, o.name, o.created_at, o.updated_at
           FROM orgs o
           JOIN memberships m ON m.org_id = o.id
           WHERE m.user_id = $1
           ORDER BY m.created_at ASC
           LIMIT 1`,
    values: [userId],
  };
}

export function addMembershipQuery(
  userId: string,
  orgId: string,
  role: MembershipRole,
): SqlQuery {
  // Idempotent: re-adding a member updates their role instead of erroring.
  return {
    text: `INSERT INTO memberships (user_id, org_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()
           RETURNING id, user_id, org_id, role, created_at, updated_at`,
    values: [userId, orgId, role],
  };
}

/** Membership lookup — the authorization primitive: is this user in this org? */
export function getMembershipQuery(userId: string, orgId: string): SqlQuery {
  return {
    text: `SELECT id, user_id, org_id, role, created_at, updated_at
           FROM memberships WHERE user_id = $1 AND org_id = $2`,
    values: [userId, orgId],
  };
}

// ---------------------------------------------------------------------------
// Projects (tenant-scoped by org_id)
// ---------------------------------------------------------------------------

export function createProjectQuery(orgId: string, name: string): SqlQuery {
  return {
    text: `INSERT INTO projects (org_id, name) VALUES ($1, $2)
           RETURNING id, org_id, name, created_at, updated_at`,
    values: [orgId, name],
  };
}

export function listProjectsQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT id, org_id, name, created_at, updated_at
           FROM projects WHERE org_id = $1 ORDER BY created_at DESC`,
    values: [orgId],
  };
}

export function getProjectQuery(orgId: string, projectId: string): SqlQuery {
  return {
    text: `SELECT id, org_id, name, created_at, updated_at
           FROM projects WHERE org_id = $1 AND id = $2`,
    values: [orgId, projectId],
  };
}

// ---------------------------------------------------------------------------
// Media (tenant-scoped by org_id + project_id)
// ---------------------------------------------------------------------------

export interface MediaInput {
  readonly kind: "video" | "audio" | "image";
  readonly src: string;
  readonly durationSec?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly label?: string | null;
}

export function createMediaQuery(
  orgId: string,
  projectId: string,
  m: MediaInput,
): SqlQuery {
  return {
    text: `INSERT INTO media (org_id, project_id, kind, src, duration_sec, width, height, label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, org_id, project_id, kind, src, duration_sec, width, height, label, created_at, updated_at`,
    values: [
      orgId,
      projectId,
      m.kind,
      m.src,
      m.durationSec ?? null,
      m.width ?? null,
      m.height ?? null,
      m.label ?? null,
    ],
  };
}

export function listMediaQuery(orgId: string, projectId: string): SqlQuery {
  return {
    text: `SELECT id, org_id, project_id, kind, src, duration_sec, width, height, label, created_at, updated_at
           FROM media WHERE org_id = $1 AND project_id = $2 ORDER BY created_at ASC`,
    values: [orgId, projectId],
  };
}

// ---------------------------------------------------------------------------
// Edit-docs (tenant-scoped; current pointer + append-only versions)
// ---------------------------------------------------------------------------

/**
 * Upsert the per-project current-doc pointer and atomically bump the version.
 * Returns the NEW current_version so the caller can insert the matching version
 * row (both happen inside one transaction in the repository).
 */
export function bumpEditDocPointerQuery(orgId: string, projectId: string): SqlQuery {
  return {
    text: `INSERT INTO edit_docs (org_id, project_id, current_version)
           VALUES ($1, $2, 1)
           ON CONFLICT (project_id) DO UPDATE
             SET current_version = edit_docs.current_version + 1, updated_at = now()
           RETURNING id, org_id, project_id, current_version, created_at, updated_at`,
    values: [orgId, projectId],
  };
}

export function insertEditDocVersionQuery(
  orgId: string,
  projectId: string,
  version: number,
  doc: unknown,
  createdBy: string | null,
): SqlQuery {
  return {
    text: `INSERT INTO edit_doc_versions (org_id, project_id, version, doc, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           RETURNING id, org_id, project_id, version, doc, created_at, created_by`,
    // doc is serialized to a JSON string bound as a value → never interpolated.
    values: [orgId, projectId, version, JSON.stringify(doc), createdBy],
  };
}

export function getLatestEditDocQuery(orgId: string, projectId: string): SqlQuery {
  return {
    text: `SELECT id, org_id, project_id, version, doc, created_at, created_by
           FROM edit_doc_versions
           WHERE org_id = $1 AND project_id = $2
           ORDER BY version DESC
           LIMIT 1`,
    values: [orgId, projectId],
  };
}

export function getEditDocVersionQuery(
  orgId: string,
  projectId: string,
  version: number,
): SqlQuery {
  return {
    text: `SELECT id, org_id, project_id, version, doc, created_at, created_by
           FROM edit_doc_versions
           WHERE org_id = $1 AND project_id = $2 AND version = $3`,
    values: [orgId, projectId, version],
  };
}

export function listEditDocVersionsQuery(orgId: string, projectId: string): SqlQuery {
  return {
    text: `SELECT version, created_at, created_by
           FROM edit_doc_versions
           WHERE org_id = $1 AND project_id = $2
           ORDER BY version DESC`,
    values: [orgId, projectId],
  };
}
