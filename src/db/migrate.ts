import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { createDb } from "./pool.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Forward-only SQL migrations (src/db/migrations/NNNN_name.sql), applied in order inside a transaction
 * by Kysely's migrator. The migrator records applied migrations and holds a lock. Rollback is restore
 * from backup or a new corrective migration (see docs/runbooks). Down migrations are deliberately not
 * provided, because they tend to destroy learner data.
 */
class SqlFileProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const out: Record<string, Migration> = {};
    for (const file of files) {
      const text = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      out[file.replace(/\.sql$/, "")] = { up: async (db) => void (await sql.raw(text).execute(db)) };
    }
    return out;
  }
}

export async function migrateToLatest(ownerConnectionString: string): Promise<string[]> {
  const db = createDb(ownerConnectionString, 1);
  try {
    const migrator = new Migrator({ db, provider: new SqlFileProvider() });
    const { error, results } = await migrator.migrateToLatest();
    if (error) {
      const failed = results?.find((r) => r.status === "Error");
      throw new Error(`Migration failed${failed ? ` at ${failed.migrationName}` : ""}: ${String(error)}`);
    }
    return (results ?? []).map((r) => r.migrationName);
  } finally {
    await db.destroy();
  }
}
