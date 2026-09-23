"use client";

/**
 * "Everything Cadence can do" — the whole feature list in plain language,
 * grouped by job, searchable. Each row says what the feature does and, when it
 * helps, the words you can type to get it.
 */
import { useMemo, useState } from "react";
import { CATALOG, CATALOG_COUNT, type CatalogGroup } from "./catalog";

const norm = (s: string): string => s.toLowerCase().normalize("NFKD");

export function FeatureIndex() {
  const [q, setQ] = useState("");
  const groups = useMemo<CatalogGroup[]>(() => {
    const needle = norm(q.trim());
    if (!needle) return CATALOG;
    return CATALOG.map((g) => ({
      ...g,
      items: g.items.filter((it) => norm(`${g.title} ${it.name} ${it.what} ${it.say ?? ""}`).includes(needle)),
    })).filter((g) => g.items.length > 0);
  }, [q]);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <section id="features" className="border-y border-line-soft bg-panel/60">
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
        <div className="grid gap-8 lg:grid-cols-[1fr_minmax(0,22rem)] lg:items-end">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Everything Cadence can do</h2>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
              {CATALOG_COUNT} features, in plain words. Ask for any of them by typing, or use the buttons in the
              editor — both do exactly the same thing, and everything can be undone.
            </p>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">Find a feature</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Try “captions”, “vertical” or “music”"
              className="w-full rounded-xl border border-line bg-elevated px-4 py-2.5 text-sm text-text placeholder:text-faint"
            />
          </label>
        </div>

        <nav aria-label="Feature groups" className="mt-8 flex flex-wrap gap-2">
          {CATALOG.map((g) => (
            <a
              key={g.id}
              href={`#f-${g.id}`}
              className="rounded-full border border-line bg-elevated px-3 py-1 text-sm text-muted transition hover:border-amber/50 hover:text-text"
            >
              {g.title}
            </a>
          ))}
        </nav>

        <p className="sr-only" aria-live="polite">
          {q ? `${shown} matching features` : ""}
        </p>

        <div className="mt-12 space-y-14">
          {groups.length === 0 && (
            <p className="text-muted">
              Nothing matches “{q}”. Try a simpler word — or just open the editor and describe what you want.
            </p>
          )}
          {groups.map((g) => (
            <div key={g.id} id={`f-${g.id}`} className="scroll-mt-24 grid gap-6 lg:grid-cols-[16rem_1fr]">
              <div>
                <h3 className="text-xl font-semibold tracking-tight text-text">{g.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{g.summary}</p>
              </div>
              <dl className="divide-y divide-line-soft border-t border-line-soft">
                {g.items.map((it) => (
                  <div key={it.name} className="grid gap-x-6 gap-y-1 py-3.5 sm:grid-cols-[13rem_1fr]">
                    <dt className="text-[15px] font-semibold text-text">{it.name}</dt>
                    <dd className="text-[15px] leading-relaxed text-muted">
                      {it.what}
                      {it.say && (
                        <span className="mt-1 block text-text">
                          <span className="sr-only">Say: </span>
                          <span className="voice">“{it.say}”</span>
                        </span>
                      )}
                      {it.note && <span className="mt-1 block text-xs text-faint">{it.note}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
