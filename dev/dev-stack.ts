/**
 * Local development and E2E stack: migrate, seed synthetic data, then start the LOCAL TEST IdP, the local
 * HubSpot stub, the LMS app origin, the content origin and the outbox worker.
 *
 *   npm run db:local && npm run dev
 *   → http://localhost:3000  (sign in as a synthetic user)
 *
 * Everything here is local and synthetic. There are no live credentials and no external calls.
 */
import { loadConfig } from "../src/config.js";
import { migrateToLatest } from "../src/db/migrate.js";
import { seed, SYNTHETIC_PEOPLE } from "../src/seed.js";
import { createServices } from "../src/services.js";
import { startLms } from "../src/server.js";
import { startHubSpotStub } from "./hubspot-stub.js";
import { startTestIdp } from "./test-idp.js";
import { DEV_PORTS, E2E_PORTS, stackEnv } from "./stack-env.js";
import pg from "pg";

const DB = process.env.DEV_DB ?? "lms_dev";
const PORTS = DB === "lms_e2e" ? E2E_PORTS : DEV_PORTS;
const env = { ...stackEnv(DB, PORTS, process.env.DEV_PG), ...process.env };

async function main() {
  const config = loadConfig(env);
  if (process.env.DEV_RESET === "true") {
    // Throwaway databases only: a guard so this can never wipe anything else.
    if (!/_(e2e|test)$/.test(DB)) throw new Error(`DEV_RESET refused for database ${DB}`);
    const c = new pg.Client({ connectionString: config.MIGRATION_DATABASE_URL });
    await c.connect();
    await c.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await c.end();
  }
  await migrateToLatest(config.MIGRATION_DATABASE_URL!);
  const idp = await startTestIdp({
    port: PORTS.idp,
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    redirectUris: [new URL("/auth/callback", config.APP_BASE_URL).href],
    // Plus IdP-only users with NO LMS account, for invitation demos (they are linked when they accept).
    users: [...SYNTHETIC_PEOPLE.map((p) => ({ sub: p.key, name: p.name, email: p.email })),
      { sub: "new-starter-1", name: "Grace Newstarter", email: "grace.newstarter@example.test" },
      { sub: "new-starter-2", name: "Hugh Newstarter", email: "hugh.newstarter@example.test" }],
  });
  const stub = await startHubSpotStub({ port: PORTS.stub, secret: config.OUTBOUND_SIGNING_SECRET });
  const services = createServices(config);
  const seeded = await seed(services, config.OIDC_ISSUER);
  const lms = await startLms(config, services);
  console.log(`LMS app:      ${config.APP_BASE_URL}`);
  console.log(`Content:      ${config.CONTENT_BASE_URL}`);
  console.log(`Test IdP:     ${idp.issuer}   (LOCAL TEST IdP, not miniOrange)`);
  console.log(`HubSpot stub: ${stub.url}   (LOCAL STUB, not HubSpot)`);
  console.log(`Seeded courses: ${Object.keys(seeded.courses).join(", ")}`);
  const shutdown = async () => {
    await lms.stop();
    await stub.close();
    await idp.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
