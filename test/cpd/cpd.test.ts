import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, enrolAndLaunch, form, FORM, ownerQuery, type Harness } from "../support/harness.js";

/** LRN-05 / LRN-06 (CPD part). CPD values here are synthetic seed values (the real values and units are DEC-22). */
let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

const commit = (l: { attemptId: string; contentCookie: string }, cmi: unknown) =>
  h.content.inject({ method: "POST", url: `/a/${l.attemptId}/runtime/commit`, headers: { cookie: l.contentCookie, "content-type": "application/json" }, payload: JSON.stringify({ cmi }) });

describe("CPD awards", () => {
  it("are awarded once on course completion, whatever is replayed or relaunched", async () => {
    const login = await h.loginAs("learner-ent-a-1");
    const l = await enrolAndLaunch(h, login, "synthetic-course-scorm12");
    await commit(l, { core: { lesson_status: "passed" } });
    await commit(l, { core: { lesson_status: "passed" } });
    const again = await enrolAndLaunch(h, login, "synthetic-course-scorm12");
    await commit(again, { core: { lesson_status: "completed" } });
    const awards = await ownerQuery<{ value: string; unit: string; organisation_id: string }>("select value, unit, organisation_id from cpd_award where enrolment_id=$1", [l.enrolmentId]);
    expect(awards).toEqual([{ value: "1", unit: "CPD units (synthetic)", organisation_id: h.data.orgs["synthetic-enterprise-a"] }]);
    const [ev] = await ownerQuery<{ cpd: { amount: number; unit: string } }>("select payload->'data'->'cpd_awarded' as cpd from outbox_message where event_type='course.completed' and aggregate_id=$1", [l.enrolmentId]);
    expect(ev!.cpd).toEqual({ amount: 1, unit: "CPD units (synthetic)" });
  });

  it("snapshot the value: changing a course's CPD later never rewrites existing awards", async () => {
    const admin = await h.loginAs("admin-1");
    const r = await h.app.inject({ method: "POST", url: `/admin/courses/${h.data.courses["synthetic-course-scorm12"]}/cpd`, headers: { cookie: admin.cookie, ...FORM },
      payload: form({ _csrf: admin.csrf, cpd_value: "4", cpd_unit: "CPD units (synthetic)" }) });
    expect(r.statusCode).toBe(303);
    const [a] = await ownerQuery<{ value: string }>("select value from cpd_award limit 1");
    expect(a!.value).toBe("1");
    expect(await ownerQuery("select 1 from audit_entry where action='course.cpd_changed'")).toHaveLength(1);
  });

  it("aren't awarded for courses with no CPD value", async () => {
    await ownerQuery("update course set cpd_value=null, cpd_unit=null where slug='synthetic-course-scorm2004'");
    const login = await h.loginAs("learner-ent-b-1");
    const l = await enrolAndLaunch(h, login, "synthetic-course-scorm2004");
    await commit(l, { completion_status: "completed" });
    expect(await ownerQuery("select 1 from cpd_award where enrolment_id=$1", [l.enrolmentId])).toHaveLength(0);
  });

  it("admin validation: value and unit are both required, or both empty", async () => {
    const admin = await h.loginAs("admin-1");
    for (const [v, u] of [["2", ""], ["", "hours"], ["-1", "hours"], ["abc", "hours"]]) {
      const r = await h.app.inject({ method: "POST", url: `/admin/courses/${h.data.courses["synthetic-course-scorm12"]}/cpd`, headers: { cookie: admin.cookie, ...FORM }, payload: form({ _csrf: admin.csrf, cpd_value: v!, cpd_unit: u! }) });
      expect(r.statusCode, `${v}/${u}`).toBe(400);
    }
  });
});

describe("learner CPD pages", () => {
  it("show totals by calendar year and in total, and the record, for the learner's own awards only", async () => {
    const brian = await h.loginAs("learner-ent-a-1");
    const page = await h.app.inject({ method: "GET", url: "/cpd", headers: { cookie: brian.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Synthetic course: SCORM 1.2 lesson");
    expect(page.body).toContain(`CPD units (synthetic) in ${new Date().getFullYear()}`);
    const ciara = await h.loginAs("learner-ent-b-1");
    const other = await h.app.inject({ method: "GET", url: "/cpd", headers: { cookie: ciara.cookie } });
    expect(other.body).toContain("No CPD recorded yet");
  });

  it("export a CSV transcript (audited) and a printable transcript", async () => {
    const brian = await h.loginAs("learner-ent-a-1");
    const csv = await h.app.inject({ method: "GET", url: "/cpd/transcript.csv", headers: { cookie: brian.cookie } });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toBe("Course,Tier,Provided by,CPD value,Unit,Awarded (UTC)");
    expect(csv.body).toContain("Synthetic course: SCORM 1.2 lesson,microlesson,Synthetic Enterprise A,1,CPD units (synthetic)");
    expect(await ownerQuery("select 1 from audit_entry where action='cpd.transcript_exported'")).toHaveLength(1);
    const t = await h.app.inject({ method: "GET", url: "/cpd/transcript", headers: { cookie: brian.cookie } });
    expect(t.body).toContain("CPD transcript");
    expect(t.body).toContain("Brian Synthetic");
  });

  it("the manager sees each member's CPD earned in their organisation", async () => {
    const mgr = await h.loginAs("manager-ent-a-1");
    const page = await h.app.inject({ method: "GET", url: `/manage/orgs/${h.data.orgs["synthetic-enterprise-a"]}`, headers: { cookie: mgr.cookie } });
    expect(page.body).toMatch(/1 CPD units \(synthetic\)/);
  });
});
