import pg from "pg";
import { migrateToLatest } from "../../src/db/migrate.js";
import { OWNER_URL } from "./env.js";

/** Recreate the test schema from scratch and apply all migrations once per test run. */
export default async function setup(): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await c.end();
  await migrateToLatest(OWNER_URL);
}
