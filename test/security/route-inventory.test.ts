import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceRoutePolicies, type RegisteredRoute } from "../../src/web/route-policy.js";
import { createHarness, type Harness } from "../support/harness.js";

/** TS-SEC route inventory: every route declares an authorisation policy, and the declared policies are coherent. */
let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

describe("route inventory", () => {
  it("a route without a policy prevents the server from starting", async () => {
    const app = Fastify();
    enforceRoutePolicies(app, "app", []);
    expect(() => app.get("/unprotected", async () => "oops")).toThrow(/no authorisation policy/);
  });

  it("launch-token routes are only allowed on the content origin, and session routes only on the app origin", async () => {
    const app = Fastify();
    enforceRoutePolicies(app, "app", []);
    expect(() => app.get("/x", { config: { policy: { auth: "launch-token", tenancy: "attempt" } } }, async () => "")).toThrow(/content origin/);
    const content = Fastify();
    enforceRoutePolicies(content, "content", []);
    expect(() => content.get("/y", { config: { policy: { auth: "session", capability: "learning.self", tenancy: "self" } } }, async () => "")).toThrow(/must not use app sessions/);
  });

  it("the registered route table matches the reviewed inventory", () => {
    const table = h.routes.map((r: RegisteredRoute) => `${r.origin} ${r.method} ${r.url} ${r.policy.auth}${"capability" in r.policy ? `:${r.policy.capability}` : ""} ${r.policy.tenancy}`).sort();
    // Changing this list is a security review item (ADR-0004): new routes must be added deliberately.
    expect(table).toEqual([
      "app GET / public none",
      "app GET /admin session:audit.read platform",
      "app GET /admin/audit session:audit.read platform",
      "app GET /admin/content session:content.import platform",
      "app GET /admin/entitlement-events session:entitlement.admin platform",
      "app GET /admin/integrations session:integration.read platform",
      "app GET /admin/mappings session:entitlement.admin platform",
      "app GET /admin/organisations session:org.admin platform",
      "app GET /admin/organisations/:orgId session:org.admin platform",
      "app GET /assets/app.css public none",
      "app GET /assets/app.js public none",
      "app GET /auth/callback public none",
      "app GET /auth/login public none",
      "app GET /cpd session:learning.self self",
      "app GET /cpd/transcript session:learning.self self",
      "app GET /cpd/transcript.csv session:learning.self self",
      "app GET /health public none",
      "app GET /invite/:token public none",
      "app GET /learn session:learning.self self",
      "app GET /learn/enrolments/:enrolmentId session:learning.self self",
      "app GET /manage session:org.manage org",
      "app GET /manage/orgs/:orgId session:org.manage org",
      "app GET /manage/orgs/:orgId/export.csv session:report.export.org org",
      "app GET /me session:learning.self self",
      "app POST /admin/content/upload session:content.import platform",
      "app POST /admin/courses session:course.publish platform",
      "app POST /admin/courses/:courseId/cpd session:course.publish platform",
      "app POST /admin/entitlement-events/:id/reprocess session:entitlement.admin platform",
      "app POST /admin/integrations/:id/replay session:integration.replay platform",
      "app POST /admin/mappings session:entitlement.admin platform",
      "app POST /admin/organisations session:org.admin platform",
      "app POST /admin/organisations/:orgId/agreements session:org.admin platform",
      "app POST /admin/organisations/:orgId/invitations session:org.admin platform",
      "app POST /admin/organisations/:orgId/managers session:org.admin platform",
      "app POST /admin/seats/:seatId/release session:org.admin platform",
      "app POST /auth/logout session:learning.self self",
      "app POST /integrations/v1/events/:source signed-event system",
      "app POST /learn/courses/:courseId/enrol session:learning.self self",
      "app POST /learn/enrolments/:enrolmentId/placements/:placementId/launch session:learning.self self",
      "app POST /manage/orgs/:orgId/assignments session:org.manage org",
      "app POST /manage/orgs/:orgId/invitations session:org.manage org",
      "content GET /a/:attemptId/pkg/* launch-token attempt",
      "content GET /a/:attemptId/player launch-token attempt",
      "content GET /a/:attemptId/runtime/state launch-token attempt",
      "content GET /health public none",
      "content GET /launch public none",
      "content GET /static/* public none",
      "content POST /a/:attemptId/runtime/commit launch-token attempt",
    ]);
  });

  it("every state-changing session route is CSRF-protected (the upload checks CSRF in its handler)", () => {
    const unprotected = h.routes.filter((r) => r.origin === "app" && r.method !== "GET" && r.policy.auth === "session" && r.policy.csrf === false).map((r) => r.url);
    expect(unprotected).toEqual(["/admin/content/upload"]);
  });
});
