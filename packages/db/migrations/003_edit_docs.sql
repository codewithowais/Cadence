-- 003 · Edit-docs: the versioned single source of truth (edits-as-code).
--
-- `edit_docs` holds one CURRENT pointer row per project (current_version).
-- `edit_doc_versions` is APPEND-ONLY: every save writes a new immutable row
-- (project_id, version, doc jsonb). History is never mutated or deleted — you
-- roll forward by inserting a higher version and bumping the pointer. Both tables
-- carry org_id so every read/write is tenant-scoped.

CREATE TABLE IF NOT EXISTS edit_docs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  current_version integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- one current-doc pointer per project
  UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS edit_docs_org_id_idx ON edit_docs (org_id);

CREATE TABLE IF NOT EXISTS edit_doc_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  doc        jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- append-only: a (project, version) pair is written exactly once
  UNIQUE (project_id, version)
);

-- Fast "latest version for this tenant's project" and history listing.
CREATE INDEX IF NOT EXISTS edit_doc_versions_project_version_idx
  ON edit_doc_versions (project_id, version DESC);
CREATE INDEX IF NOT EXISTS edit_doc_versions_org_id_idx
  ON edit_doc_versions (org_id);
