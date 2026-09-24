import type { FastifyInstance } from "fastify";
import pg from "pg";
import type { Config } from "../../src/config.js";
import { seed, type SeedResult } from "../../src/seed.js";
import { createServices, type Services } from "../../src/services.js";
import { buildAppServer } from "../../src/web/app-server.js";
import { buildContentServer } from "../../src/web/content-server.js";
import type { RegisteredRoute } from "../../src/web/route-policy.js";
import type { DestinationAdapter } from "../../src/modules/integration/dispatcher.js";
import { OWNER_URL, testConfig } from "./env.js";

export const TEST_ISSUER = "http://127.0.0.1:4499";

/** Owner-role client for arranging and asserting (bypasses RLS as table owner, and never used by app code). */
export async function ownerQuery<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export async function resetData(): Promise<void> {
  const tables = await ownerQuery<{ tablename: string }>("select tablename from pg_tables where schemaname='public' and tablename not like 'kysely_%'");
  await ownerQuery(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export interface Harness {
  config: Config;
  services: Services;
  app: FastifyInstance;
  content: FastifyInstance;
  routes: RegisteredRoute[];
  data: SeedResult;
  /** Create a real server-side session for a seeded person. Returns the cookie header and CSRF token. */
  loginAs(personKey: string): Promise<{ cookie: string; csrf: string; personId: string }>;
  close(): Promise<void>;
}

export async function createHarness(opts: { config?: Record<string, string>; adapters?: Map<string, DestinationAdapter> } = {}): Promise<Harness> {
  await resetData();
  const config = testConfig(opts.config);
  const services = createServices(config, opts.adapters ? { adapters: opts.adapters } : {});
  const routes: RegisteredRoute[] = [];
  const app = await buildAppServer(services, routes);
  const content = await buildContentServer(services, routes);
  await app.ready();
  await content.ready();
  const data = await seed(services, TEST_ISSUER);
  return {
    config, services, app, content, routes, data,
    async loginAs(personKey) {
      const personId = data.people[personKey];
      if (!personId) throw new Error(`unknown seeded person ${personKey}`);
      const [link] = await ownerQuery<{ id: string }>("select id from identity_link where person_id=$1", [personId]);
      const { cookieValue, csrfToken } = await services.sessions.create(personId, link!.id);
      return { cookie: `lms_sid=${cookieValue}`, csrf: csrfToken, personId };
    },
    async close() {
      await app.close();
      await content.close();
      await services.close();
    },
  };
}

/** Parse a Set-Cookie header into a Cookie header value (name=value only). */
export function cookieFrom(setCookie: string | string[] | undefined, name: string): string | null {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of all) {
    const [pair] = c.split(";");
    if (pair && pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}

export const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
export const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** Enrol (if needed) and launch a placement as a logged-in person. Returns the content-origin cookie for the attempt. */
export async function enrolAndLaunch(h: Harness, login: { cookie: string; csrf: string }, courseSlug: string, placementIndex = 0) {
  const courseId = h.data.courses[courseSlug]!;
  const enrol = await h.app.inject({ method: "POST", url: `/learn/courses/${courseId}/enrol`, headers: { cookie: login.cookie, ...FORM }, payload: form({ _csrf: login.csrf }) });
  if (enrol.statusCode !== 303) throw new Error(`enrol failed: ${enrol.statusCode} ${enrol.body.slice(0, 200)}`);
  const enrolmentId = enrol.headers.location!.split("/").pop()!;
  const page = await h.app.inject({ method: "GET", url: `/learn/enrolments/${enrolmentId}`, headers: { cookie: login.cookie } });
  const placementIds = [...page.body.matchAll(/placements\/([0-9a-f-]{36})\/launch/g)].map((m) => m[1]!);
  const placementId = placementIds[placementIndex]!;
  const launch = await h.app.inject({ method: "POST", url: `/learn/enrolments/${enrolmentId}/placements/${placementId}/launch`, headers: { cookie: login.cookie, ...FORM }, payload: form({ _csrf: login.csrf }) });
  if (launch.statusCode !== 303) throw new Error(`launch failed: ${launch.statusCode}`);
  const launchUrl = new URL(launch.headers.location!);
  const exch = await h.content.inject({ method: "GET", url: `${launchUrl.pathname}${launchUrl.search}` });
  if (exch.statusCode !== 303) throw new Error(`launch exchange failed: ${exch.statusCode} ${exch.body}`);
  const attemptId = exch.headers.location!.split("/")[2]!;
  const contentCookie = cookieFrom(exch.headers["set-cookie"], "lms_lt")!;
  const rawSetCookie = ([] as string[]).concat(exch.headers["set-cookie"] ?? []).join("\n");
  return { enrolmentId, placementId, placementIds, attemptId, contentCookie, rawSetCookie, launchCode: launchUrl.searchParams.get("code")! };
}
