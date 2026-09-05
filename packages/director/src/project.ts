/**
 * ProjectState — the in-memory working set the Director operates on: the current
 * edit-doc (source of truth), the media assets, and their transcripts. In the app
 * this is loaded from / versioned in the DB; here it is a plain object so the
 * Director and tools stay pure and testable.
 */
import { parseEditDoc, type EditDoc, type MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

export interface ProjectStateInit {
  doc?: EditDoc;
  media?: MediaAsset[];
  transcripts?: Transcript[];
}

/** An empty but valid edit-doc. */
export function emptyDoc(): EditDoc {
  return parseEditDoc({ version: 1, meta: {}, media: [], tracks: [] });
}

export class ProjectState {
  doc: EditDoc;
  media: MediaAsset[];
  private transcripts: Map<string, Transcript>;

  constructor(init: ProjectStateInit = {}) {
    this.doc = init.doc ?? emptyDoc();
    this.media = init.media ?? [];
    this.transcripts = new Map((init.transcripts ?? []).map((t) => [t.mediaId, t]));
  }

  addMedia(asset: MediaAsset): void {
    if (!this.media.some((m) => m.id === asset.id)) this.media.push(asset);
  }

  setTranscript(t: Transcript): void {
    this.transcripts.set(t.mediaId, t);
  }

  getTranscript(mediaId: string): Transcript | undefined {
    return this.transcripts.get(mediaId);
  }

  /** Replace the edit-doc, validating it against the schema first. */
  setDoc(doc: unknown): EditDoc {
    this.doc = parseEditDoc(doc);
    return this.doc;
  }
}
