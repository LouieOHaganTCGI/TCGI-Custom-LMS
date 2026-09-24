import { promises as fs } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHubSpotStub, type HubSpotStub } from "../../dev/hubspot-stub.js";
import { SignedWebhookDestination } from "../../src/modules/integration/dispatcher.js";
import { testConfig } from "../support/env.js";
import { createHarness, enrolAndLaunch, ownerQuery, type Harness } from "../support/harness.js";

/** INT-03 / TS-OUT: the transactional outbox with a fault-injecting stand-in for HubSpot (the local stub, not HubSpot). */
let stub: HubSpotStub;
let h: Harness;
const secret = testConfig().OUTBOUND_SIGNING_SECRET;

beforeAll(async () => {
  stub = await startHubSpotStub({ port: 0, secret });
  h = await createHarness({ adapters: new Map([["hubspot", new SignedWebhookDestination("hubspot", stub.url, secret, "k1", 2000)]]) });
});
afterAll(async () => {
  await h.close();
  await stub.close();
});
afterEach(() => stub.failNext(0, 500));

async function makeEvents(who = "learner-ent-a-1", course = "synthetic-course-scorm12") {
  const login = await h.loginAs(who);
  const l = await enrolAndLaunch(h, login, course);
  return l;
}
const later = (seconds: number) => () => new Date(Date.now() + seconds * 1000);

describe("delivery", () => {
  it("delivers a signed envelope that validates against the published contract schema", async () => {
    const l = await makeEvents();
    await h.content.inject({ method: "POST", url: `/a/${l.attemptId}/runtime/commit`, headers: { cookie: l.contentCookie, "content-type": "application/json" }, payload: JSON.stringify({ cmi: { core: { lesson_status: "passed" } } }) });
    expect(await h.services.dispatcher.runOnce()).toBe(2);
    const received = [...stub.events.values()].filter((e) => (e.envelope.aggregate as { id: string }).id === l.enrolmentId);
    expect(received.map((e) => e.type)).toEqual(["enrolment.created", "course.completed"]);

    const dir = path.resolve("docs/contracts");
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default(ajv);
    for (const f of ["envelope.v1.schema.json", "learning-events.v1.schema.json"]) ajv.addSchema(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
    const validate = ajv.getSchema("https://tcgi.example/lms/contracts/learning-events.v1.schema.json")!;
    for (const e of received) expect(validate(e.envelope), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(received)).not.toMatch(/@example\.test/); // no email leaves the LMS (DEC-08 matching key pending)
  });

  it("records every attempt and retries a 5xx with backoff, then delivers", async () => {
    await makeEvents("learner-ent-b-1", "synthetic-course-scorm2004");
    stub.failNext(1, 503);
    expect(await h.services.dispatcher.runOnce(1)).toBe(1);
    const [m] = await ownerQuery<{ id: string; status: string; attempts: number; next_attempt_at: Date }>("select id, status, attempts, next_attempt_at from outbox_message where status <> 'delivered' order by seq limit 1");
    expect(m).toMatchObject({ status: "pending", attempts: 1 });
    expect(m!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000); // first backoff step is 30 s
    expect(await h.services.dispatcher.runOnce(5)).toBe(0); // not due yet
    expect(await h.services.dispatcher.runOnce(5, later(31))).toBe(1);
    const attempts = await ownerQuery<{ outcome: string; http_status: number }>("select outcome, http_status from delivery_attempt where outbox_id=$1 order by id", [m!.id]);
    expect(attempts).toEqual([{ outcome: "retry", http_status: 503 }, { outcome: "delivered", http_status: 200 }]);
  });

  it("dead-letters immediately on a non-retryable 4xx, blocks later events for that aggregate only, and replays in order", async () => {
    const l = await makeEvents("learner-b2c-1", "synthetic-course-scorm12");
    await h.content.inject({ method: "POST", url: `/a/${l.attemptId}/runtime/commit`, headers: { cookie: l.contentCookie, "content-type": "application/json" }, payload: JSON.stringify({ cmi: { core: { lesson_status: "passed" } } }) });
    const other = await makeEvents("admin-1", "synthetic-course-scorm12");
    stub.failNext(1, 400);
    await h.services.dispatcher.runOnce(10);
    const rows = await ownerQuery<{ aggregate_id: string; event_type: string; status: string }>("select aggregate_id, event_type, status from outbox_message where aggregate_id = any($1) order by seq", [[l.enrolmentId, other.enrolmentId]]);
    expect(rows).toEqual([
      { aggregate_id: l.enrolmentId, event_type: "enrolment.created", status: "dead" },
      { aggregate_id: l.enrolmentId, event_type: "course.completed", status: "pending" }, // blocked behind the dead event
      { aggregate_id: other.enrolmentId, event_type: "enrolment.created", status: "delivered" }, // other aggregates are unaffected
    ]);
    const [dead] = await ownerQuery<{ id: string }>("select id from outbox_message where aggregate_id=$1 and status='dead'", [l.enrolmentId]);
    const admin = await h.loginAs("admin-1");
    const replay = await h.app.inject({ method: "POST", url: `/admin/integrations/${dead!.id}/replay`, headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `_csrf=${admin.csrf}` });
    expect(replay.statusCode).toBe(303);
    await h.services.dispatcher.runOnce(10);
    const after = await ownerQuery<{ status: string }>("select status from outbox_message where aggregate_id=$1 order by seq", [l.enrolmentId]);
    expect(after.map((r) => r.status)).toEqual(["delivered", "delivered"]);
    const [audit] = await ownerQuery<{ actor_label: string }>("select actor_label from audit_entry where action='integration.replayed' and entity_id=$1", [dead!.id]);
    expect(audit!.actor_label).toBe("Dana Admin (synthetic)");
    const order = [...stub.events.values()].filter((e) => (e.envelope.aggregate as { id: string }).id === l.enrolmentId).map((e) => e.type);
    expect(order).toEqual(["enrolment.created", "course.completed"]);
  });

  it("dead-letters after the maximum number of retryable failures", async () => {
    await makeEvents("learner-ent-a-1", "synthetic-course-scorm12").catch(() => undefined);
    const [m] = await ownerQuery<{ id: string }>("insert into outbox_message (id, destination, event_type, aggregate_type, aggregate_id, payload) values (gen_random_uuid(), 'hubspot', 'enrolment.created', 'enrolment', 'synthetic-max', '{}'::jsonb) returning id");
    stub.failNext(100, 500);
    let clock = 0;
    for (let i = 0; i < h.config.OUTBOX_MAX_ATTEMPTS + 2; i++) await h.services.dispatcher.runOnce(1, later((clock += 30000)));
    const [row] = await ownerQuery<{ status: string; attempts: number; last_error: string }>("select status, attempts, last_error from outbox_message where id=$1", [m!.id]);
    expect(row!.status).toBe("dead");
    expect(row!.attempts).toBe(h.config.OUTBOX_MAX_ATTEMPTS);
    expect(row!.last_error).toMatch(/max attempts/);
  });

  it("the receiver sees a redelivered event once, by id (idempotent effect)", async () => {
    const [m] = await ownerQuery<{ id: string }>("select id from outbox_message where status='delivered' limit 1");
    const before = stub.events.get(m!.id)!.deliveries;
    await ownerQuery("update outbox_message set status='pending', next_attempt_at=now() where id=$1", [m!.id]); // simulate a lost acknowledgement
    await h.services.dispatcher.runOnce(1);
    expect(stub.events.get(m!.id)!.deliveries).toBe(before + 1);
    expect([...stub.events.values()].filter((e) => e.id === m!.id)).toHaveLength(1);
  });

  it("a destination with the wrong signing secret is rejected by the receiver (the message is not silently dropped)", async () => {
    const bad = new SignedWebhookDestination("hubspot", stub.url, "the-wrong-secret-for-this-receiver-xxxx", "k1");
    const outcome = await bad.deliver(JSON.stringify({ id: "x" }));
    expect(outcome).toMatchObject({ kind: "dead", httpStatus: 401 });
    expect(stub.rejectedSignatures).toBeGreaterThan(0);
  });
});
