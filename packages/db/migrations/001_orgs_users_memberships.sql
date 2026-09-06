-- 001 · Tenancy roots: orgs (the tenant), users (global identities), and the
-- memberships join that binds a user to an org with a role.
--
-- Multi-tenancy model: `orgs` is the tenant boundary. Every tenant-scoped table
-- downstream (projects, media, edit_docs, edit_doc_versions) carries `org_id` so
-- reads/writes can be row-scoped to a single tenant. `users` are GLOBAL identity
-- rows (one human, one row) and deliberately carry no org_id — a user reaches a
-- tenant only through a `memberships` row, so the same user can belong to many
-- orgs. `memberships` is itself tenant-scoped by org_id.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

CREATE TABLE IF NOT EXISTS orgs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);

-- Tenant-scoped lookups: "who is in this org" and "what orgs is this user in".
CREATE INDEX IF NOT EXISTS memberships_org_id_idx ON memberships (org_id);
CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships (user_id);
