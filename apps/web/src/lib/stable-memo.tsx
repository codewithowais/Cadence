"use client";

import { memo, useRef, type ComponentType, type FunctionComponent } from "react";

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wrap a panel so it skips re-rendering when only its CALLBACK identities change.
 *
 * The editor re-renders every animation frame during playback (`timeSec` state),
 * and it passes fresh inline closures (`onSend={(p) => …}`) to every panel, which
 * defeats plain `React.memo`. This HOC hands the inner component STABLE proxy
 * functions — one per prop name — that always call the LATEST prop ("latest ref"
 * pattern), then shallow-memoizes on the remaining (data) props. So a panel that
 * doesn't depend on time (top bar, chat rail, rooms rail…) renders only when its
 * data changes, and its handlers can never go stale (they always read the newest
 * closure, e.g. the current doc).
 *
 * Non-function props are compared by identity (React.memo's shallow compare), so
 * callers must pass stable objects (state / useMemo) to get the win — unstable
 * ones just fall back to rendering, never to wrong behavior.
 *
 * Use it only for components whose function props are EVENT HANDLERS. A render
 * prop (a function the child calls during render to get JSX) would be memoized
 * away from the parent's state changes.
 */
export function withStableHandlers<P extends object>(Inner: ComponentType<P>): FunctionComponent<P> {
  const Memo = memo(Inner) as unknown as ComponentType<P>;
  const name = Inner.displayName || Inner.name || "Component";

  function StableHandlers(props: P) {
    const latest = useRef(props);
    latest.current = props; // same pattern as Editor's urlsRef/filesRef mirrors
    const proxies = useRef<Map<string, AnyFn>>(new Map());
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === "function") {
        let proxy = proxies.current.get(key);
        if (!proxy) {
          proxy = (...args: unknown[]) => {
            const fn = (latest.current as Record<string, unknown>)[key];
            return typeof fn === "function" ? (fn as AnyFn)(...args) : undefined;
          };
          proxies.current.set(key, proxy);
        }
        next[key] = proxy;
      } else {
        next[key] = value;
      }
    }
    return <Memo {...(next as P)} />;
  }
  StableHandlers.displayName = `Stable(${name})`;
  return StableHandlers;
}
