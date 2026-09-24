import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuleViolation } from "../../src/modules/authz/authz.js";
import { createHarness, form, FORM, ownerQuery, type Harness } from "../support/harness.js";

/** Identity ≠ entitlement ≠ enrolment (brief §6), plus the single entitlement write path (INT-01/02 foundation). */
let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
const actor = { type: "system" as const, label: "test" };
const cmd = (over: Partial<Parameters<Harness["services"]["entitlements"]["grant"]>[0]> = {}) => ({
  source: "test-source", externalOrderId: "ORDER-1", externalLineId: "LINE-1", personId: h.data.people["learner-ent-a-1"]!,
  organisationId: h.data.orgs["synthetic-enterprise-a"]!, courseId: h.data.courses["synthetic-course-scorm2004"]!, grantType: "manual" as const,
  validFrom: new Date("2026-09-01T00:00:00Z"), validUntil: new Date("2027-09-01T00:00:00Z"), reason: "test", ...over,
});

describe("entitlement command", () => {
  it("is idempotent on (source, order, line): an identical repeat is a no-op", async () => {
    const a = await h.services.entitlements.grant(cmd(), actor);
    const b = await h.services.entitlements.grant(cmd(), actor);
    expect(a.outcome).toBe("created");
    expect(b).toEqual({ entitlementId: a.entitlementId, outcome: "no_change" });
    const [n] = await ownerQuery<{ n: string }>("select count(*) as n from entitlement where external_order_id='ORDER-1'");
    expect(n!.n).toBe("1");
  });

  it("refuses conflicting terms for an existing line instead of silently overwriting", async () => {
    await expect(h.services.entitlements.grant(cmd({ validUntil: new Date("2030-01-01T00:00:00Z") }), actor)).rejects.toBeInstanceOf(RuleViolation);
  });

  it("records the decision and an audit entry for every grant", async () => {
    const rows = await ownerQuery<{ rule_version: string }>("select d.rule_version from entitlement_decision d join entitlement e on e.id=d.entitlement_id where e.external_order_id='ORDER-1'");
    expect(rows).toHaveLength(1);
    const audits = await ownerQuery("select 1 from audit_entry where action='entitlement.granted' and reason='test'");
    expect(audits).toHaveLength(1);
  });

  it("refuses a grant into an organisation the person doesn't belong to", async () => {
    await expect(h.services.entitlements.grant(cmd({ externalOrderId: "ORDER-2", organisationId: h.data.orgs["synthetic-enterprise-b"]! }), actor)).rejects.toThrow(/not an active member/);
  });

  it("rejects an invalid window", async () => {
    await expect(h.services.entitlements.grant(cmd({ externalOrderId: "ORDER-3", validUntil: new Date("2026-01-01T00:00:00Z") }), actor)).rejects.toThrow(/validUntil/);
  });
});

describe("enrolment rules", () => {
  it("enrolment needs an in-window entitlement. Expired or not-yet-valid grants don't count", async () => {
    const brian = await h.loginAs("learner-ent-a-1");
    const course = h.data.courses["synthetic-pathway-two-lessons"]!;
    await h.services.entitlements.grant(cmd({ externalOrderId: "ORDER-EXPIRED", courseId: course, validFrom: new Date("2020-01-01T00:00:00Z"), validUntil: new Date("2021-01-01T00:00:00Z") }), actor);
    await h.services.entitlements.grant(cmd({ externalOrderId: "ORDER-FUTURE", courseId: course, validFrom: new Date("2099-01-01T00:00:00Z"), validUntil: new Date("2100-01-01T00:00:00Z") }), actor);
    const r = await h.app.inject({ method: "POST", url: `/learn/courses/${course}/enrol`, headers: { cookie: brian.cookie, ...FORM }, payload: form({ _csrf: brian.csrf }) });
    expect(r.statusCode).toBe(404);
  });

  it("pins the published course revision, copies the access end from the entitlement, and is idempotent", async () => {
    const brian = await h.loginAs("learner-ent-a-1");
    const course = h.data.courses["synthetic-course-scorm2004"]!;
    const r1 = await h.app.inject({ method: "POST", url: `/learn/courses/${course}/enrol`, headers: { cookie: brian.cookie, ...FORM }, payload: form({ _csrf: brian.csrf }) });
    const r2 = await h.app.inject({ method: "POST", url: `/learn/courses/${course}/enrol`, headers: { cookie: brian.cookie, ...FORM }, payload: form({ _csrf: brian.csrf }) });
    expect(r1.headers.location).toBe(r2.headers.location);
    const id = r1.headers.location!.split("?")[0]!.split("/").pop();
    const [en] = await ownerQuery<{ course_revision_id: string; access_end: Date; organisation_id: string }>("select course_revision_id, access_end, organisation_id from enrolment where id=$1", [id]);
    const [rev] = await ownerQuery<{ id: string }>("select id from course_revision where course_id=$1 and state='published'", [course]);
    expect(en!.course_revision_id).toBe(rev!.id);
    expect(en!.access_end.toISOString()).toBe("2027-09-01T00:00:00.000Z");
    expect(en!.organisation_id).toBe(h.data.orgs["synthetic-enterprise-a"]);
    const [n] = await ownerQuery<{ n: string }>("select count(*) as n from outbox_message where aggregate_id=$1 and event_type='enrolment.created'", [id]);
    expect(n!.n).toBe("1");
  });

  it("the database enforces one live enrolment per person, course and organisation, even under a race", async () => {
    const aoife = await h.loginAs("learner-b2c-1");
    const course = h.data.courses["synthetic-course-scorm12"]!;
    const results = await Promise.all([1, 2, 3].map(() => h.app.inject({ method: "POST", url: `/learn/courses/${course}/enrol`, headers: { cookie: aoife.cookie, ...FORM }, payload: form({ _csrf: aoife.csrf }) })));
    const [n] = await ownerQuery<{ n: string }>("select count(*) as n from enrolment where person_id=$1 and course_id=$2", [aoife.personId, course]);
    expect(n!.n).toBe("1");
    expect(results.map((r) => r.statusCode)).toEqual([303, 303, 303]);
    expect(new Set(results.map((r) => r.headers.location)).size).toBe(1);
  });
});
