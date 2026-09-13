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

/**
 * Trigger a client-side download of an arbitrary Blob (e.g. an exported .mp4) to
 * the user's Downloads folder — free, no server round-trip.
 *
 * ROBUSTNESS: the anchor is appended to the DOM before clicking (some browsers
 * ignore a click on a detached anchor), and the object URL is revoked on a delay
 * rather than synchronously. Revoking immediately after `.click()` can CANCEL the
 * download of a multi-MB file before the browser has finished reading the blob —
 * a common cause of "export doesn't download". The delayed cleanup still frees the
 * memory once the download has started.
 */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 60_000);
}
