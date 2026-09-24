import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_URL } from "../support/env.js";
import { createHarness, enrolAndLaunch, form, FORM, ownerQuery, type Harness } from "../support/harness.js";

/** ENT-01, ENT-02, ENT-03 and TS-SEC for the manager portal. Two tenants plus a dual-context learner (T-03). */
let h: Harness;
let mgr: { cookie: string; csrf: string; personId: string };
let orgA: string, orgB: string;
beforeAll(async () => {
  h = await createHarness();
  mgr = await h.loginAs("manager-ent-a-1");
  orgA = h.data.orgs["synthetic-enterprise-a"]!;
  orgB = h.data.orgs["synthetic-enterprise-b"]!;
});
afterAll(async () => h.close());

const get = (url: string, cookie: string) => h.app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, who: { cookie: string; csrf: string }, fields: Record<string, string> = {}) =>
  h.app.inject({ method: "POST", url, headers: { cookie: who.cookie, ...FORM }, payload: form({ _csrf: who.csrf, ...fields }) });

describe("manager scope", () => {
  it("/manage takes a single-org manager straight to their team", async () => {
    const r = await get("/manage", mgr.cookie);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/manage/orgs/${orgA}`);
    const page = await get(`/manage/orgs/${orgA}`, mgr.cookie);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Brian Synthetic");
    expect(page.body).toContain("0 / 3"); // seats in use / limit from the synthetic agreement
  });

  it("another organisation's ID in the URL gives 404 for every manager route (IDOR)", async () => {
    expect((await get(`/manage/orgs/${orgB}`, mgr.cookie)).statusCode).toBe(404);
    expect((await get(`/manage/orgs/${orgB}/export.csv`, mgr.cookie)).statusCode).toBe(404);
    expect((await post(`/manage/orgs/${orgB}/invitations`, mgr, { name: "X", email: "x@example.test" })).statusCode).toBe(404);
    const ciara = h.data.people["learner-ent-b-1"]!;
    expect((await post(`/manage/orgs/${orgB}/assignments`, mgr, { person_id: ciara, course_id: h.data.courses["synthetic-course-scorm2004"]! })).statusCode).toBe(404);
  });

  it("learners and TCGI Direct learners can't open the manager portal", async () => {
    const brian = await h.loginAs("learner-ent-a-1");
    expect((await get("/manage", brian.cookie)).statusCode).toBe(404);
    expect((await get(`/manage/orgs/${orgA}`, brian.cookie)).statusCode).toBe(404);
  });

  it("a manager can't assign a course to someone outside their organisation", async () => {
    const outsider = h.data.people["learner-ent-b-1"]!;
    const r = await post(`/manage/orgs/${orgA}/assignments`, mgr, { person_id: outsider, course_id: h.data.courses["synthetic-course-scorm12"]! });
    expect(r.statusCode).toBe(404);
  });

  it("the manager never sees a team member's personal (B2C) learning (T-03)", async () => {
    // Make Brian a dual-context learner: an Org A member with his own TCGI Direct enrolment.
    await ownerQuery("insert into organisation_membership (organisation_id, person_id, source) values ($1,$2,'test') on conflict do nothing", [h.data.orgs["tcgi-direct"], h.data.people["learner-ent-a-1"]]);
    await h.services.entitlements.grant({ source: "test", externalOrderId: "B2C-BRIAN", externalLineId: "1", personId: h.data.people["learner-ent-a-1"]!, organisationId: h.data.orgs["tcgi-direct"]!,
      courseId: h.data.courses["synthetic-course-scorm2004"]!, grantType: "manual", validFrom: new Date(Date.now() - 1000), validUntil: new Date(Date.now() + 86_400_000), reason: "test" }, { type: "system", label: "test" });
    const brian = await h.loginAs("learner-ent-a-1");
    await enrolAndLaunch(h, brian, "synthetic-course-scorm2004");
    const page = await get(`/manage/orgs/${orgA}`, mgr.cookie);
    expect(page.body).not.toContain("Synthetic course: SCORM 2004 lesson");
    const csv = (await get(`/manage/orgs/${orgA}/export.csv`, mgr.cookie)).body;
    expect(csv).not.toContain("SCORM 2004");
  });
});

describe("seats and assignment (ENT-02)", () => {
  it("assigning a course allocates a seat, grants a seat entitlement in the org context, and is audited", async () => {
    const brian = h.data.people["learner-ent-a-1"]!;
    const r = await post(`/manage/orgs/${orgA}/assignments`, mgr, { person_id: brian, course_id: h.data.courses["synthetic-pathway-two-lessons"]! });
    expect(r.statusCode).toBe(303);
    const [ent] = await ownerQuery<{ grant_type: string; organisation_id: string; valid_until: Date }>(
      "select grant_type, organisation_id, valid_until from entitlement where person_id=$1 and course_id=$2 and grant_type='seat'", [brian, h.data.courses["synthetic-pathway-two-lessons"]]);
    expect(ent).toMatchObject({ grant_type: "seat", organisation_id: orgA });
    expect(await ownerQuery("select 1 from seat_allocation where person_id=$1 and state='allocated'", [brian])).toHaveLength(1);
    expect(await ownerQuery("select 1 from audit_entry where action='seat.allocated'")).toHaveLength(1);
    // A second course for the same member uses the same seat.
    await post(`/manage/orgs/${orgA}/assignments`, mgr, { person_id: brian, course_id: h.data.courses["synthetic-course-scorm12"]! });
    expect(await ownerQuery("select 1 from seat_allocation where person_id=$1 and state='allocated'", [brian])).toHaveLength(1);
  });

  it("courses outside the agreement can't be assigned", async () => {
    const r = await post(`/manage/orgs/${orgA}/assignments`, mgr, { person_id: h.data.people["learner-ent-a-1"]!, course_id: h.data.courses["synthetic-course-scorm2004"]! });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain("included in an active agreement for your organisation");
  });

  it("the seat limit holds under concurrent assignments (exactly the remaining seats are allocated)", async () => {
    const invitees: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await post(`/manage/orgs/${orgA}/invitations`, mgr, { name: `Race Person ${i}`, email: `race${i}@example.test` });
      expect(r.statusCode).toBe(201);
      const [p] = await ownerQuery<{ id: string }>("select id from person where display_name=$1", [`Race Person ${i}`]);
      invitees.push(p!.id);
    }
    const [before] = await ownerQuery<{ n: string }>("select count(*) as n from seat_allocation s join agreement a on a.id=s.agreement_id where a.organisation_id=$1 and s.state='allocated'", [orgA]);
    const course = h.data.courses["synthetic-course-scorm12"]!;
    const results = await Promise.all(invitees.map((id) => post(`/manage/orgs/${orgA}/assignments`, mgr, { person_id: id, course_id: course })));
    const [after] = await ownerQuery<{ n: string }>("select count(*) as n from seat_allocation s join agreement a on a.id=s.agreement_id where a.organisation_id=$1 and s.state='allocated'", [orgA]);
    expect(Number(after!.n)).toBe(3);
    expect(results.filter((r) => r.statusCode === 303)).toHaveLength(3 - Number(before!.n));
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.body.includes("seats on this agreement are in use"))).toBe(true);
  });

  it("TCGI releases a seat: seat entitlements are revoked, active enrolments withdrawn, history kept", async () => {
    const brian = h.data.people["learner-ent-a-1"]!;
    const brianLogin = await h.loginAs("learner-ent-a-1");
    const l = await enrolAndLaunch(h, brianLogin, "synthetic-pathway-two-lessons");
    const [seat] = await ownerQuery<{ id: string }>("select id from seat_allocation where person_id=$1 and state='allocated'", [brian]);
    const admin = await h.loginAs("admin-1");
    expect((await post(`/admin/seats/${seat!.id}/release`, mgr, { reason: "left company" })).statusCode).toBe(404); // managers can't (DEC-32 default)
    const r = await post(`/admin/seats/${seat!.id}/release`, admin, { reason: "left company" });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/admin/organisations/${orgA}?flash=seat-released`);
    const [en] = await ownerQuery<{ status: string }>("select status from enrolment where id=$1", [l.enrolmentId]);
    expect(en!.status).toBe("withdrawn");
    expect(await ownerQuery("select 1 from attempt where enrolment_id=$1", [l.enrolmentId])).toHaveLength(1);
  });
});

describe("CSV export (ENT-03)", () => {
  it("is audited and neutralises spreadsheet formulas in learner-controlled text (T-06)", async () => {
    await post(`/manage/orgs/${orgA}/invitations`, mgr, { name: "=HYPERLINK(\"http://evil\",\"x\")", email: "formula@example.test" });
    const before = (await ownerQuery("select 1 from audit_entry where action='report.exported'")).length;
    const r = await get(`/manage/orgs/${orgA}/export.csv`, mgr.cookie);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.body).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(r.body).not.toMatch(/^=HYPERLINK/m);
    expect(await ownerQuery("select 1 from audit_entry where action='report.exported'")).toHaveLength(before + 1);
  });
});

describe("database-level protections", () => {
  async function asApp(ctx: { person: string; orgs: string[] }, sql: string, params: unknown[] = []) {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("select set_config('app.person_id',$1,true), set_config('app.managed_org_ids',$2,true), set_config('app.platform','false',true)", [ctx.person, `{${ctx.orgs.join(",")}}`]);
      const r = await c.query(sql, params);
      await c.query("COMMIT");
      return r.rows;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }
  it("invite_person refuses organisations the caller doesn't manage", async () => {
    await expect(asApp({ person: mgr.personId, orgs: [orgA] }, "select invite_person($1, 'x', 'x@example.test', 'h', now() + interval '1 day')", [orgB])).rejects.toThrow(/not permitted/);
  });
  it("a manager can't write a non-seat entitlement or a seat for another organisation", async () => {
    await expect(asApp({ person: mgr.personId, orgs: [orgA] }, `insert into entitlement (organisation_id, person_id, course_id, grant_type, source, external_order_id, external_line_id, status, valid_from)
      values ($1,$2,$3,'manual','x','x','x','active',now())`, [orgA, mgr.personId, h.data.courses["synthetic-course-scorm12"]])).rejects.toThrow(/row-level security/);
    await expect(asApp({ person: mgr.personId, orgs: [orgA] }, `insert into entitlement (organisation_id, person_id, course_id, grant_type, source, external_order_id, external_line_id, status, valid_from)
      values ($1,$2,$3,'seat','x','x','y','active',now())`, [orgB, mgr.personId, h.data.courses["synthetic-course-scorm12"]])).rejects.toThrow(/row-level security/);
  });
  it("a manager can't release or reassign seats directly", async () => {
    const rows = await asApp({ person: mgr.personId, orgs: [orgA] }, "update seat_allocation set state='released' where organisation_id=$1 returning id", [orgA]);
    expect(rows).toEqual([]);
  });
});
