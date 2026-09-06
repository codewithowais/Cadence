/**
 * Typed, tenant-scoped repositories over the Cadence schema.
 *
 * INVARIANTS (see queries.ts for the SQL):
 *  - Every tenant-data function takes a tenant scope (`orgId`, and `projectId`
 *    where relevant) and passes it into a builder that pins it in the WHERE/VALUES
 *    clause. No function can read or write another tenant's rows.
 *  - All values are bound as parameters ($1…$N) — never interpolated.
 *  - `edit_doc_versions` is append-only; docs are validated by @cadence/core's
 *    `parseEditDoc` BEFORE they touch the database.
 *
 * (`createOrg`/`createUser` are the identity roots — an org IS a tenant and a
 * user is a global identity — so they take no parent scope by design.)
 */
import { parseEditDoc, type EditDoc } from "@cadence/core";
import type { PoolClient } from "pg";
import { getPool, run } from "./client";
import {
  addMembershipQuery,
  bumpEditDocPointerQuery,
  createMediaQuery,
  createOrgQuery,
  createProjectQuery,
  createUserQuery,
  deleteProjectQuery,
  firstOrgForUserQuery,
  getEditDocVersionQuery,
  getLatestEditDocQuery,
  getMembershipQuery,
  getOrgQuery,
  getProjectQuery,
  insertEditDocVersionQuery,
  listEditDocVersionsQuery,
  listMediaQuery,
  listOrgMembersQuery,
  listProjectsQuery,
  renameProjectQuery,
  updateUserNameQuery,
  upsertUserQuery,
  type MediaInput,
  type MembershipRole,
} from "./queries";

// --- Row shapes (as returned by the RETURNING / SELECT lists) ---------------

export interface OrgRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}
export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface MembershipRow {
  id: string;
  user_id: string;
  org_id: string;
  role: MembershipRole;
  created_at: Date;
  updated_at: Date;
}
export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}
export interface MediaRow {
  id: string;
  org_id: string;
  project_id: string;
  kind: "video" | "audio" | "image";
  src: string;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface EditDocVersionRow {
  id: string;
  org_id: string;
  project_id: string;
  version: number;
  doc: unknown;
  created_at: Date;
  created_by: string | null;
}

/** A validated edit-doc plus its version metadata. */
export interface EditDocVersion {
  version: number;
  doc: EditDoc;
  createdAt: Date;
  createdBy: string | null;
}

export interface TenantScope {
  readonly orgId: string;
}
export interface ProjectScope extends TenantScope {
  readonly projectId: string;
}

// --- Identity roots ---------------------------------------------------------

export async function createOrg(name: string): Promise<OrgRow> {
  const res = await run<OrgRow>(createOrgQuery(name));
  return res.rows[0]!;
}

/** Fetch the caller's own org (id comes from the session). Null if not found. */
export async function getOrg(orgId: string): Promise<OrgRow | null> {
  const res = await run<OrgRow>(getOrgQuery(orgId));
  return res.rows[0] ?? null;
}

export async function createUser(email: string, name: string | null = null): Promise<UserRow> {
  const res = await run<UserRow>(createUserQuery(email, name));
  return res.rows[0]!;
}

export async function addMembership(
  userId: string,
  orgId: string,
  role: MembershipRole = "member",
): Promise<MembershipRow> {
  const res = await run<MembershipRow>(addMembershipQuery(userId, orgId, role));
  return res.rows[0]!;
}

/** Authorization primitive: the membership row (with role) or null. */
export async function getMembership(userId: string, orgId: string): Promise<MembershipRow | null> {
  const res = await run<MembershipRow>(getMembershipQuery(userId, orgId));
  return res.rows[0] ?? null;
}

/** One member of an org: their global identity plus their role in this tenant. */
export interface OrgMemberRow {
  id: string;
  email: string;
  name: string | null;
  role: MembershipRole;
  created_at: Date;
}

/**
 * Update the acting user's display name. Tenant-scoped: `scope.userId` is the
 * session's own user id and the write only lands when that user is a member of
 * `scope.orgId` (see updateUserNameQuery's EXISTS guard). Returns the updated
 * user row, or null when the pair didn't match (→ caller answers 404).
 */
export async function updateUserName(
  scope: TenantScope & { readonly userId: string },
  name: string,
): Promise<UserRow | null> {
  const res = await run<UserRow>(updateUserNameQuery(scope.orgId, scope.userId, name));
  return res.rows[0] ?? null;
}

/** List the members (with roles) of the caller's org. Tenant-scoped by orgId. */
export async function listOrgMembers(scope: TenantScope): Promise<OrgMemberRow[]> {
  const res = await run<OrgMemberRow>(listOrgMembersQuery(scope.orgId));
  return res.rows;
}

/** The identity + active tenant a session is scoped to after sign-in. */
export interface Account {
  readonly user: UserRow;
  readonly org: OrgRow;
}

/**
 * Sign-in provisioning root, idempotent and transactional. Find-or-creates the
 * user by (case-insensitive) email; if they belong to no org yet, creates a
 * personal workspace org + an `owner` membership. Returns the user and the org
 * the session will be scoped to. Never trusts a client-supplied user/org id —
 * identity comes only from the verified email.
 */
export async function provisionAccount(email: string, name: string | null = null): Promise<Account> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    const userRes = await run<UserRow>(upsertUserQuery(email, name), client);
    const user = userRes.rows[0]!;

    const existing = await run<OrgRow>(firstOrgForUserQuery(user.id), client);
    let org = existing.rows[0];
    if (!org) {
      const orgName = `${(name && name.trim()) || email.split("@")[0] || "My"}'s workspace`;
      const created = await run<OrgRow>(createOrgQuery(orgName), client);
      org = created.rows[0]!;
      await run<MembershipRow>(addMembershipQuery(user.id, org.id, "owner"), client);
    }

    await client.query("COMMIT");
    return { user, org };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- Projects (tenant-scoped) -----------------------------------------------

export async function createProject(orgId: string, name: string): Promise<ProjectRow> {
  const res = await run<ProjectRow>(createProjectQuery(orgId, name));
  return res.rows[0]!;
}

export async function listProjects(orgId: string): Promise<ProjectRow[]> {
  const res = await run<ProjectRow>(listProjectsQuery(orgId));
  return res.rows;
}

export async function getProject(scope: ProjectScope): Promise<ProjectRow | null> {
  const res = await run<ProjectRow>(getProjectQuery(scope.orgId, scope.projectId));
  return res.rows[0] ?? null;
}

/**
 * Rename a project in place. Tenant-scoped by (orgId, projectId). Returns the
 * updated row, or null when no project with that id exists in the tenant's org
 * (so the caller can answer 404 without a separate existence check).
 */
export async function renameProject(scope: ProjectScope, name: string): Promise<ProjectRow | null> {
  const res = await run<ProjectRow>(renameProjectQuery(scope.orgId, scope.projectId, name));
  return res.rows[0] ?? null;
}

/**
 * Delete a project (cascades to its media + edit-doc history). Tenant-scoped by
 * (orgId, projectId). Returns true when a row was deleted, false when nothing
 * matched — i.e. the project isn't in the caller's org (→ 404, no cross-tenant leak).
 */
export async function deleteProject(scope: ProjectScope): Promise<boolean> {
  const res = await run<{ id: string }>(deleteProjectQuery(scope.orgId, scope.projectId));
  return res.rows.length > 0;
}

/**
 * Duplicate a project within the SAME org: copy the source's name (+" copy") and
 * its latest edit-doc as version 1 of a fresh project. Fully tenant-scoped — the
 * source is looked up by (orgId, projectId) and the new rows are written under the
 * same orgId — and atomic (one transaction). Returns the new project row, or null
 * when the source isn't in the caller's org.
 */
export async function duplicateProject(
  scope: ProjectScope,
  opts: { name?: string; userId: string | null } = { userId: null },
): Promise<ProjectRow | null> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Verify the source belongs to this tenant before copying anything.
    const src = await run<ProjectRow>(getProjectQuery(scope.orgId, scope.projectId), client);
    const source = src.rows[0];
    if (!source) {
      await client.query("ROLLBACK");
      return null;
    }

    const name = (opts.name && opts.name.trim()) || `${source.name} copy`;
    const created = await run<ProjectRow>(createProjectQuery(scope.orgId, name), client);
    const project = created.rows[0]!;

    // Copy the source's latest doc (if any) into the new project as version 1.
    const latest = await run<EditDocVersionRow>(
      getLatestEditDocQuery(scope.orgId, scope.projectId),
      client,
    );
    const row = latest.rows[0];
    if (row) {
      const valid = parseEditDoc(row.doc); // validate before write (never trust stored bytes)
      const pointer = await run<{ current_version: number }>(
        bumpEditDocPointerQuery(scope.orgId, project.id),
        client,
      );
      const version = pointer.rows[0]!.current_version;
      await run<EditDocVersionRow>(
        insertEditDocVersionQuery(scope.orgId, project.id, version, valid, opts.userId),
        client,
      );
    }

    await client.query("COMMIT");
    return project;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- Media (tenant-scoped) --------------------------------------------------

export async function addMedia(scope: ProjectScope, media: MediaInput): Promise<MediaRow> {
  const res = await run<MediaRow>(createMediaQuery(scope.orgId, scope.projectId, media));
  return res.rows[0]!;
}

export async function listMedia(scope: ProjectScope): Promise<MediaRow[]> {
  const res = await run<MediaRow>(listMediaQuery(scope.orgId, scope.projectId));
  return res.rows;
}

// --- Edit-docs (tenant-scoped; versioned, append-only) ----------------------

/**
 * Validate `doc` (via @cadence/core), then in ONE transaction bump the project's
 * current-version pointer and append the new immutable version row. Returns the
 * stored version. Tenant-scoped by (orgId, projectId) throughout.
 */
export async function saveEditDocVersion(
  scope: ProjectScope,
  doc: unknown,
  userId: string | null,
): Promise<EditDocVersion> {
  // Validate BEFORE any write — invalid docs never reach the DB.
  const valid = parseEditDoc(doc);

  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    const pointer = await run<{ current_version: number }>(
      bumpEditDocPointerQuery(scope.orgId, scope.projectId),
      client,
    );
    const version = pointer.rows[0]!.current_version;
    const inserted = await run<EditDocVersionRow>(
      insertEditDocVersionQuery(scope.orgId, scope.projectId, version, valid, userId),
      client,
    );
    await client.query("COMMIT");
    const row = inserted.rows[0]!;
    return { version: row.version, doc: valid, createdAt: row.created_at, createdBy: row.created_by };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getLatestEditDoc(scope: ProjectScope): Promise<EditDocVersion | null> {
  const res = await run<EditDocVersionRow>(getLatestEditDocQuery(scope.orgId, scope.projectId));
  const row = res.rows[0];
  if (!row) return null;
  return { version: row.version, doc: parseEditDoc(row.doc), createdAt: row.created_at, createdBy: row.created_by };
}

export async function getEditDocVersion(scope: ProjectScope, version: number): Promise<EditDocVersion | null> {
  const res = await run<EditDocVersionRow>(getEditDocVersionQuery(scope.orgId, scope.projectId, version));
  const row = res.rows[0];
  if (!row) return null;
  return { version: row.version, doc: parseEditDoc(row.doc), createdAt: row.created_at, createdBy: row.created_by };
}

export async function listEditDocVersions(
  scope: ProjectScope,
): Promise<Array<{ version: number; createdAt: Date; createdBy: string | null }>> {
  const res = await run<{ version: number; created_at: Date; created_by: string | null }>(
    listEditDocVersionsQuery(scope.orgId, scope.projectId),
  );
  return res.rows.map((r) => ({ version: r.version, createdAt: r.created_at, createdBy: r.created_by }));
}
