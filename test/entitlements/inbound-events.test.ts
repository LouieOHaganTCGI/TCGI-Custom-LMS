import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commerceEvent, type SimEventInput } from "../../dev/commerce-sim.js";
import { signEventBody } from "../../src/lib/crypto.js";
import { TEST_COMMERCE_SECRET } from "../support/env.js";
import { createHarness, enrolAndLaunch, ownerQuery, TEST_ISSUER, type Harness } from "../support/harness.js";

/** INT-01 / INT-02 over HTTP: the signed inbound contract (docs/04 §1–2) and its effects on access. */
let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

const SRC = "woocommerce:tcgi-store-sim";
const make = (i: Omit<SimEventInput, "idpIssuer">) => commerceEvent({ idpIssuer: TEST_ISSUER, ...i });
async function post(env: Record<string, unknown>, opts: { secret?: string; keyId?: string; path?: string; body?: string; signatureAt?: number } = {}) {
  const body = opts.body ?? JSON.stringify(env);
  return h.app.inject({
    method: "POST", url: `/integrations/v1/events/${opts.path ?? SRC}`,
    headers: { "content-type": "application/json", "tcgi-signature": signEventBody(opts.secret ?? TEST_COMMERCE_SECRET, body, opts.signatureAt), "tcgi-key-id": opts.keyId ?? "k1" },
    payload: body,
  });
}
const eligible = async (key: string) => (await h.app.inject({ method: "GET", url: "/learn", headers: { cookie: (await h.loginAs(key)).cookie } })).body;

describe("transport and response contract", () => {
  it("202 with a receipt for a new, validly signed event. The same key and payload again gives 200 (duplicate)", async () => {
    const env = make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "T-100" });
    const first = await post(env);
    expect(first.statusCode).toBe(202);
    const again = await post(env);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ receipt_id: first.json().receipt_id, duplicate: true });
    const rows = await ownerQuery("select 1 from integration_event where idempotency_key=$1", [env.idempotency_key]);
    expect(rows).toHaveLength(1);
  });

  it("409 when an idempotency key is reused with a different payload (and it is audited)", async () => {
    const env = make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "T-101" });
    expect((await post(env)).statusCode).toBe(202);
    const tampered = { ...env, data: { ...(env.data as object), external_line_id: "2" } };
    expect((await post(tampered)).statusCode).toBe(409);
    expect(await ownerQuery("select 1 from audit_entry where action='integration.event_idempotency_conflict'")).toHaveLength(1);
  });

  it("401 for a bad signature, a wrong key, an unknown key id, an unknown source, a stale timestamp or a tampered body", async () => {
    const env = make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "T-102" });
    const body = JSON.stringify(env);
    expect((await post(env, { secret: "a-completely-different-secret-value-xxxxxxxx" })).statusCode).toBe(401);
    expect((await post(env, { keyId: "nope" })).statusCode).toBe(401);
    expect((await post(env, { path: "woocommerce:unknown-store" })).statusCode).toBe(401);
    expect((await post(env, { signatureAt: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    const sig = signEventBody(TEST_COMMERCE_SECRET, body);
    const r = await h.app.inject({ method: "POST", url: `/integrations/v1/events/${SRC}`, headers: { "content-type": "application/json", "tcgi-signature": sig, "tcgi-key-id": "k1" }, payload: body.replace("T-102", "T-999") });
    expect(r.statusCode).toBe(401);
    expect(await ownerQuery("select 1 from integration_event where aggregate_id like 'T-102%' or aggregate_id like 'T-999%'")).toHaveLength(0);
  });

  it("accepts the rotated second key (zero-downtime key rotation)", async () => {
    const env = make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "T-103" });
    expect((await post(env, { keyId: "k2", secret: `${TEST_COMMERCE_SECRET}-rotated` })).statusCode).toBe(202);
  });

  it("401 when the envelope source doesn't match the signed path's source", async () => {
    const env = make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "T-104", source: "woocommerce:other-store" });
    expect((await post(env)).statusCode).toBe(401);
  });

  it("422 for schema violations (validated against docs/contracts) and for non-JSON", async () => {
    const env = make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "T-105" });
    const bad = { ...env, data: { ...(env.data as Record<string, unknown>), action: "revoke" } }; // type/action mismatch
    const r = await post(bad);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("schema_validation_failed");
    expect((await post(env, { body: "not json" })).statusCode).toBe(422);
  });

  it("browser sessions are not accepted as purchase proof (no signature → 401)", async () => {
    const login = await h.loginAs("learner-ent-b-1");
    const env = make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "T-106" });
    const r = await h.app.inject({ method: "POST", url: `/integrations/v1/events/${SRC}`, headers: { "content-type": "application/json", cookie: login.cookie }, payload: JSON.stringify(env) });
    expect(r.statusCode).toBe(401);
  });
});

describe("effects on access", () => {
  it("a purchase grants access and the learner can enrol. A refund withdraws the enrolment but keeps progress", async () => {
    const buy = make({ action: "purchase", learnerSubject: "learner-ent-a-1", product: "SYN-PROD-FOUNDATION-01", order: "E-200" });
    expect((await post(buy)).statusCode).toBe(202);
    expect(await eligible("learner-ent-a-1")).toContain("Enrol in Synthetic course: SCORM 2004 lesson");
    const login = await h.loginAs("learner-ent-a-1");
    const l = await enrolAndLaunch(h, login, "synthetic-course-scorm2004");
    await h.content.inject({ method: "POST", url: `/a/${l.attemptId}/runtime/commit`, headers: { cookie: l.contentCookie, "content-type": "application/json" }, payload: JSON.stringify({ cmi: { location: "p2" } }) });
    const [ent] = await ownerQuery<{ organisation_id: string; grant_type: string }>("select organisation_id, grant_type from entitlement where external_order_id='E-200'");
    expect(ent).toEqual({ organisation_id: h.data.orgs["tcgi-direct"], grant_type: "commerce_line" }); // B2C context, from the server, not the payload

    const refund = make({ action: "refund", learnerSubject: "learner-ent-a-1", product: "SYN-PROD-FOUNDATION-01", order: "E-200" });
    expect((await post(refund)).statusCode).toBe(202);
    const [en] = await ownerQuery<{ status: string }>("select status from enrolment where id=$1", [l.enrolmentId]);
    expect(en!.status).toBe("withdrawn");
    expect(await ownerQuery("select 1 from runtime_commit where attempt_id=$1", [l.attemptId])).toHaveLength(1); // progress kept (R-7)
    const ev = await ownerQuery<{ event_type: string }>("select event_type from outbox_message where aggregate_id=$1 order by seq", [l.enrolmentId]);
    expect(ev.map((e) => e.event_type)).toEqual(["enrolment.created", "enrolment.status_changed"]);
    // The lesson can no longer be launched, and runtime writes are refused.
    const relaunch = await h.app.inject({ method: "POST", url: `/learn/enrolments/${l.enrolmentId}/placements/${l.placementId}/launch`, headers: { cookie: login.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `_csrf=${login.csrf}` });
    expect(relaunch.statusCode).toBe(409);
    const decisions = await ownerQuery("select 1 from entitlement_decision d join entitlement e on e.id=d.entitlement_id where e.external_order_id='E-200'");
    expect(decisions).toHaveLength(2);
  });

  it("refund-before-purchase arrival still ends with no access", async () => {
    const t0 = new Date(Date.now() - 3600_000);
    const buy = make({ action: "purchase", learnerSubject: "learner-b2c-1", product: "SYN-PROD-FOUNDATION-01", order: "E-201", effectiveAt: t0 });
    const refund = make({ action: "refund", learnerSubject: "learner-b2c-1", product: "SYN-PROD-FOUNDATION-01", order: "E-201", effectiveAt: new Date(t0.getTime() + 60_000) });
    expect((await post(refund)).statusCode).toBe(202);
    expect((await post(buy)).statusCode).toBe(202);
    const [ent] = await ownerQuery<{ status: string }>("select status from entitlement where external_order_id='E-201'");
    expect(ent!.status).toBe("revoked");
  });

  it("an extension moves the enrolment's access end and emits a status change", async () => {
    // Eoin has no other entitlement to this course, so the enrolment must be justified by this commerce line.
    await post(make({ action: "purchase", learnerSubject: "manager-ent-a-1", product: "SYN-PROD-FOUNDATION-01", order: "E-202", accessEnd: new Date(Date.now() + 10 * 86_400_000) }));
    const login = await h.loginAs("manager-ent-a-1");
    const r = await h.app.inject({ method: "POST", url: `/learn/courses/${h.data.courses["synthetic-course-scorm2004"]}/enrol`, headers: { cookie: login.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `_csrf=${login.csrf}` });
    expect(r.statusCode).toBe(303);
    const enrolmentId = r.headers.location!.split("?")[0]!.split("/").pop()!;
    const newEnd = new Date(Date.now() + 400 * 86_400_000);
    expect((await post(make({ action: "extend", learnerSubject: "manager-ent-a-1", product: "SYN-PROD-FOUNDATION-01", order: "E-202", accessEnd: newEnd }))).statusCode).toBe(202);
    const [en] = await ownerQuery<{ access_end: Date; status: string }>("select access_end, status from enrolment where id=$1", [enrolmentId]);
    expect(en!.status).toBe("active");
    expect(Math.abs(en!.access_end.getTime() - newEnd.getTime())).toBeLessThan(1000);
    const ev = await ownerQuery<{ event_type: string; reason: string }>("select event_type, payload->'data'->>'reason_code' as reason from outbox_message where aggregate_id=$1 order by seq", [enrolmentId]);
    expect(ev).toEqual([{ event_type: "enrolment.created", reason: null }, { event_type: "enrolment.status_changed", reason: "access_changed" }]);
  });

  it("unknown products and unmatched learners are held, and apply after the mapping is fixed and the line reprocessed", async () => {
    const env = make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-NOT-MAPPED", order: "E-203" });
    expect((await post(env)).statusCode).toBe(202);
    let [row] = await ownerQuery<{ status: string; status_reason: string }>("select status, status_reason from integration_event where aggregate_id='E-203:1'");
    expect(row).toEqual({ status: "held", status_reason: "unknown_product_mapping" });
    const anon = make({ action: "purchase", learnerSubject: null, product: "SYN-PROD-PATHWAY-01", order: "E-204" });
    await post(anon);
    const [row2] = await ownerQuery<{ status_reason: string }>("select status_reason from integration_event where aggregate_id='E-204:1'");
    expect(row2!.status_reason).toMatch(/unmatched_learner/);

    const admin = await h.loginAs("admin-1");
    const map = await h.app.inject({ method: "POST", url: "/admin/mappings", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: admin.csrf, source: SRC, external_product_id: "SYN-PROD-NOT-MAPPED", course_id: h.data.courses["synthetic-course-scorm12"]! }).toString() });
    expect(map.statusCode).toBe(303);
    const [evRow] = await ownerQuery<{ id: string }>("select id from integration_event where aggregate_id='E-203:1'");
    const rp = await h.app.inject({ method: "POST", url: `/admin/entitlement-events/${evRow!.id}/reprocess`, headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `_csrf=${admin.csrf}` });
    expect(rp.statusCode).toBe(303);
    [row] = await ownerQuery<{ status: string; status_reason: string }>("select status, status_reason from integration_event where aggregate_id='E-203:1'");
    expect(row!.status).toBe("processed");
  });

  it("a partial refund is held (DEC-11) and access stays unchanged", async () => {
    await post(make({ action: "purchase", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "E-205" }));
    await post(make({ action: "partial-refund", learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "E-205" }));
    const [ent] = await ownerQuery<{ status: string }>("select status from entitlement where external_order_id='E-205'");
    expect(ent!.status).toBe("active");
    const held = await ownerQuery<{ status_reason: string }>("select status_reason from integration_event where aggregate_id='E-205:1' and status='held'");
    expect(held.map((x) => x.status_reason)).toEqual(["partial_refund_rule_pending_DEC-11"]);
  });

  it("stored event evidence can't be altered", async () => {
    await expect(ownerQuery("update integration_event set payload='{}'::jsonb")).rejects.toThrow(/immutable/);
  });

  it("the admin page lists events and held reasons. Learners can't see it", async () => {
    const admin = await h.loginAs("admin-1");
    const page = await h.app.inject({ method: "GET", url: "/admin/entitlement-events?status=held", headers: { cookie: admin.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("partial_refund_rule_pending_DEC-11");
    const learner = await h.loginAs("learner-b2c-1");
    expect((await h.app.inject({ method: "GET", url: "/admin/entitlement-events", headers: { cookie: learner.cookie } })).statusCode).toBe(404);
  });
});
