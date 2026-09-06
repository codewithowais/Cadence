/**
 * Pooled Postgres client, built from `DATABASE_URL`.
 *
 * A single lazily-created `pg.Pool` is shared per process (Next route handlers,
 * the migrate script, and the verify checks all reuse it). `pg` is used via its
 * real typed API (verified against node_modules/@types/pg/index.d.ts): a `Pool`
 * constructed with `{ connectionString }`, and `pool.query({ text, values })`.
 */
import { Pool, type PoolConfig, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { SqlQuery } from "./queries";

let pool: Pool | undefined;

/** Read + validate the connection string. Throws a clear error if unset. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env (and run Postgres via `docker compose up db`).",
    );
  }
  return url;
}

/** Get the process-wide pool, creating it on first use. */
export function getPool(config?: PoolConfig): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      // Keep connection attempts snappy so health checks degrade fast when the DB is down.
      connectionTimeoutMillis: 5_000,
      ...config,
    });
  }
  return pool;
}

/**
 * Run a parameterized query built by the pure builders in ./queries.
 * Values are ALWAYS bound positionally ($1…$N) — never string-interpolated.
 */
export async function run<R extends QueryResultRow = QueryResultRow>(
  q: SqlQuery,
  client?: PoolClient,
): Promise<QueryResult<R>> {
  const runner = client ?? getPool();
  // Spread to a mutable array to satisfy pg's `values?: any[]` (our SqlQuery is readonly).
  return runner.query<R>({ text: q.text, values: [...q.values] });
}

/**
 * Ping the database. Returns true if a trivial round-trip succeeds; never throws
 * (so callers like the health check can degrade gracefully when the DB is down).
 */
export async function pingDb(): Promise<boolean> {
  try {
    const res = await getPool().query({ text: "SELECT 1 AS ok" });
    return res.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

/** Close the pool (tests / graceful shutdown). Safe to call when never opened. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
