/**
 * In-process render-slot limiter for /api/export. A free 512 MB instance can run
 * ONE 1080p x264 encode comfortably; two at once risk an OOM kill that loses BOTH
 * exports. Extra requests wait (the progress stream reports `queued`) instead of
 * crashing the box. Configure with CADENCE_EXPORT_CONCURRENCY (default 1).
 *
 * Per-process only — exactly right for the single-container Render/Docker deploy;
 * on serverless each instance has its own limiter (and its own memory).
 */

function limit(): number {
  const n = Number(process.env.CADENCE_EXPORT_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

let active = 0;
const waiters: (() => void)[] = [];

/** True when a new export would have to wait for a slot. */
export function exportSlotsBusy(): boolean {
  return active >= limit();
}

/**
 * Acquire a render slot, waiting if all are busy. Resolves to a `release` function
 * (idempotent). Rejects if `signal` aborts while waiting (the waiter is removed).
 */
export function acquireExportSlot(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      next?.();
    };
    const grant = (): void => {
      signal?.removeEventListener("abort", onAbort);
      active++;
      resolve(release);
    };
    function onAbort(): void {
      const i = waiters.indexOf(grant);
      if (i >= 0) waiters.splice(i, 1);
      reject(signal?.reason ?? new Error("aborted"));
    }
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    if (active < limit()) {
      active++;
      resolve(release);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.push(grant);
  });
}
