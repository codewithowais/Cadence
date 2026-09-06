"use client";

import { useCallback } from "react";
import type { EditDoc } from "@cadence/core";
import { Editor } from "@/components/Editor";

/**
 * The editor bound to a persisted project. Reuses the shared <Editor/> and wires
 * an onSave that POSTs a new edit-doc version (tenant scope + validation happen
 * server-side in /api/projects/[id]/doc).
 */
export function ProjectEditor({
  projectId,
  projectName,
  initialDoc,
  notice,
}: {
  projectId: string;
  projectName: string;
  initialDoc?: EditDoc;
  notice?: string | null;
}) {
  const onSave = useCallback(
    async (doc: EditDoc) => {
      const res = await fetch(`/api/projects/${projectId}/doc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Save failed (${res.status}).`);
      }
    },
    [projectId],
  );

  return (
    <Editor
      initialDoc={initialDoc}
      projectName={projectName}
      onSave={onSave}
      backHref="/dashboard"
      notice={notice}
    />
  );
}
