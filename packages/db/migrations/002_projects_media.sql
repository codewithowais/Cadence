-- 002 · Projects and their media, both tenant-scoped by org_id.
--
-- A project belongs to exactly one org. Media belongs to a project AND carries
-- org_id directly (denormalized tenant column) so every media query can be
-- row-scoped by tenant without a join — cross-tenant reads are impossible when
-- the WHERE clause always pins org_id.

CREATE TABLE IF NOT EXISTS projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name       text NOT NULL DEFAULT 'Untitled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_org_id_idx ON projects (org_id);

CREATE TABLE IF NOT EXISTS media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('video', 'audio', 'image')),
  src          text NOT NULL,
  duration_sec double precision,
  width        integer,
  height       integer,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Tenant-scoped: media is always fetched by (org_id, project_id).
CREATE INDEX IF NOT EXISTS media_org_project_idx ON media (org_id, project_id);
