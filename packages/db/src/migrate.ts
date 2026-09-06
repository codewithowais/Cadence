/**
 * Migration runner: applies packages/db/migrations/00N_*.sql in numeric order,
 * tracked in a `_migrations` table, idempotent (already-applied files are
 * skipped). Each file runs inside its own transaction, so a failure leaves the
 * DB at the last good migration.
 *
 * Run it:  DATABASE_URL=... npm -w @cadence/db run migrate
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { closePool, getPool } from "./client";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** A migration file, parsed from its `00N_name.sql` filename. */
export interface MigrationFile {
  readonly index: number;
  readonly name: string;
  readonly filename: string;
}

const MIGRATION_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

/**
 * PURE: parse + order migration filenames. Validates the `00N_name.sql` naming,
 * sorts by numeric index, and rejects duplicate indices. Testable with no DB.
 */
export function orderMigrations(filenames: readonly string[]): MigrationFile[] {
  const parsed: MigrationFile[] = [];
  for (const filename of filenames) {
    const m = MIGRATION_RE.exec(filename);
    if (!m) continue; // ignore non-migration files (READMEs, etc.)
    parsed.push({ index: Number(m[1]), name: m[2]!, filename });
  }
  parsed.sort((a, b) => a.index - b.index);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i]!.index === parsed[i - 1]!.index) {
      throw new Error(`duplicate migration index ${parsed[i]!.index}: ${parsed[i - 1]!.filename} vs ${parsed[i]!.filename}`);
    }
  }
  return parsed;
}

/** List the on-disk migrations, ordered. */
export function listMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return orderMigrations(readdirSync(dir));
}

/** Apply all pending migrations against the given pool. Returns applied names. */
export async function runMigrations(pool: Pool = getPool(), dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query({
    text: `CREATE TABLE IF NOT EXISTS _migrations (
             filename   text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           )`,
  });

  const done = await pool.query<{ filename: string }>({ text: `SELECT filename FROM _migrations` });
  const applied = new Set(done.rows.map((r) => r.filename));

  const pending = listMigrations(dir).filter((m) => !applied.has(m.filename));
  const results: string[] = [];

  for (const migration of pending) {
    const sql = readFileSync(resolve(dir, migration.filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      // Record which file was applied (parameterized — filename is bound, not interpolated).
      await client.query({ text: `INSERT INTO _migrations (filename) VALUES ($1)`, values: [migration.filename] });
      await client.query("COMMIT");
      results.push(migration.filename);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${migration.filename} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }
  return results;
}

/** CLI entry: `tsx src/migrate.ts`. */
async function main(): Promise<void> {
  const all = listMigrations();
  console.log(`migrate: ${all.length} migration file(s) found in ${MIGRATIONS_DIR}`);
  const applied = await runMigrations();
  if (applied.length === 0) console.log("migrate: nothing to apply — database is up to date.");
  else console.log(`migrate: applied ${applied.length}:\n  ${applied.join("\n  ")}`);
  await closePool();
}

// Only run when executed directly (not when imported by the verify gate).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\nmigrate FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
