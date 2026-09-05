/** m:ss.d timecode. */
export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const d = Math.floor((s % 1) * 10);
  return `${m}:${String(r).padStart(2, "0")}.${d}`;
}

/** Trigger a client-side file download (free, no server). */
export function download(name: string, text: string, type = "application/json"): void {
  downloadBlob(name, new Blob([text], { type }));
}

/** Trigger a client-side download of an arbitrary Blob (e.g. an exported .mp4). */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
