import { notFound } from "next/navigation";
import type { EditDoc } from "@cadence/core";
import { getLatestEditDoc, getProject } from "@cadence/db";
import { requireSession } from "@/lib/session";
import { Editor } from "@/components/Editor";
import { ProjectEditor } from "@/components/ProjectEditor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project — Cadence" };

type Loaded =
  | { status: "ok"; name: string; doc?: EditDoc }
  | { status: "not-found" }
  | { status: "no-workspace" }
  | { status: "db-down" };

/** Load a project + its latest edit-doc, tenant-scoped by the session's org. */
async function load(orgId: string | undefined, projectId: string): Promise<Loaded> {
  if (!orgId) return { status: "no-workspace" };
  try {
    const scope = { orgId, projectId };
    const project = await getProject(scope);
    if (!project) return { status: "not-found" };
    const latest = await getLatestEditDoc(scope);
    return { status: "ok", name: project.name, doc: latest?.doc };
  } catch {
    return { status: "db-down" };
  }
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const loaded = await load(session.orgId, id);

  if (loaded.status === "not-found") notFound();

  // DB unreachable or no workspace → fall back to the scratch editor with a
  // notice, so the page still loads and stays usable (Save is unavailable).
  if (loaded.status === "db-down") {
    return (
      <Editor
        backHref="/dashboard"
        notice="Couldn't reach the database — editing in scratch mode. Changes won't be saved until Postgres is back."
      />
    );
  }
  if (loaded.status === "no-workspace") {
    return (
      <Editor
        backHref="/dashboard"
        notice="No workspace is connected, so this project can't be loaded or saved. Start Postgres and sign in again."
      />
    );
  }

  return (
    <ProjectEditor
      projectId={id}
      projectName={loaded.name}
      initialDoc={loaded.doc}
      notice={
        loaded.doc
          ? null
          : "New project — describe an edit or add media, then Save to create the first version. Note: media files aren't persisted; re-add them to preview."
      }
    />
  );
}
