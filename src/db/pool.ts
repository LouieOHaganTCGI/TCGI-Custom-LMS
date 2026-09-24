import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

// Return numeric/bigint columns as strings (no silent precision loss), and timestamps as Date objects.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

/**
 * Raw database handle. Restricted by lint rule: application code must use withAuthz / withSystem from
 * ./scoped.ts, so that every query runs inside a transaction with an RLS context (ADR-0004).
 */
export function createDb(connectionString: string, max = 10): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max, application_name: "tcgi-lms" }) }),
  });
}
