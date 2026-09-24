import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, enrolAndLaunch, ownerQuery, type Harness } from "../support/harness.js";

/** LRN-01: save and restore of SCORM runtime state through the content-origin API, as the player uses it. */
let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

const commit = (attemptId: string, cookie: string, body: unknown, ct = "application/json") =>
  h.content.inject({ method: "POST", url: `/a/${attemptId}/runtime/commit`, headers: { cookie, "content-type": ct }, payload: JSON.stringify(body) });
const state = async (attemptId: string, cookie: string) => {
  const r = await h.content.inject({ method: "GET", url: `/a/${attemptId}/runtime/state`, headers: { cookie } });
  expect(r.statusCode).toBe(200);
  return r.json() as { edition: string; cmi: Record<string, unknown> & { core?: Record<string, unknown> } };
};

describe("save and restore (SCORM 1.2)", () => {
  it("persists suspend data and location, then resumes with entry=resume", async () => {
    const login = await h.loginAs("learner-ent-a-1");
    const l = await enrolAndLaunch(h, login, "synthetic-course-scorm12");
    const first = await state(l.attemptId, l.contentCookie);
    expect(first.edition).toBe("1.2");
    expect(first.cmi.core!.entry).toBe("ab-initio");

    const c1 = await commit(l.attemptId, l.contentCookie, { cmi: { core: { lesson_status: "incomplete", lesson_location: "screen-2", exit: "suspend" }, suspend_data: "{\"screen\":2}" } });
    expect(c1.json()).toMatchObject({ result: true, errorCode: 0, seq: 1 });

    // Relaunch from the app: a new code and token, the same attempt.
    const again = await enrolAndLaunch(h, login, "synthetic-course-scorm12");
    expect(again.attemptId).toBe(l.attemptId);
    const resumed = await state(again.attemptId, again.contentCookie);
    expect(resumed.cmi.core).toMatchObject({ entry: "resume", lesson_location: "screen-2", lesson_status: "incomplete" });
    expect(resumed.cmi.suspend_data).toBe("{\"screen\":2}");
    // The dashboard reflects a started-but-not-completed course as "Resume", not "Start".
    const dash = await h.app.inject({ method: "GET", url: "/learn", headers: { cookie: login.cookie } });
    expect(dash.body).toContain("Resume course");
    expect(dash.body).not.toContain(">Start course<");
  });

  it("stores every raw commit append-only, in order, with a hash", async () => {
    const rows = await ownerQuery<{ seq: number; payload_sha256: string }>("select seq, payload_sha256 from runtime_commit order by id");
    expect(rows.map((r) => r.seq)).toEqual([1]);
    expect(rows[0]!.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("completion (SCORM 2004)", () => {
  it("completes the placement and the course once. Later commits never erase completion history", async () => {
    const login = await h.loginAs("learner-ent-b-1");
    const l = await enrolAndLaunch(h, login, "synthetic-course-scorm2004");
    await commit(l.attemptId, l.contentCookie, { cmi: { completion_status: "incomplete", location: "p1" } });
    const done = await commit(l.attemptId, l.contentCookie, { cmi: { completion_status: "completed", success_status: "passed", score: { raw: "80", min: "0", max: "100", scaled: "0.8" } } });
    expect(done.statusCode).toBe(200);
    // Repeat completion and a regressing status: neither may duplicate or erase anything.
    await commit(l.attemptId, l.contentCookie, { cmi: { completion_status: "completed" } });
    await commit(l.attemptId, l.contentCookie, { cmi: { completion_status: "incomplete" } }, "text/plain;charset=UTF-8");

    const [en] = await ownerQuery<{ status: string; completed_at: Date }>("select status, completed_at from enrolment where id=$1", [l.enrolmentId]);
    expect(en!.status).toBe("completed");
    const [ps] = await ownerQuery<{ first_completed_at: Date | null; completion_status: string; score_raw: string; success_status: string }>(
      "select first_completed_at, completion_status, score_raw, success_status from progress_state where attempt_id=$1", [l.attemptId]);
    expect(ps!.first_completed_at).not.toBeNull();
    expect(ps!.completion_status).toBe("incomplete"); // the latest reported state is kept as reported…
    expect(ps!.success_status).toBe("passed");
    expect(ps!.score_raw).toBe("80");
    const events = await ownerQuery<{ event_type: string }>("select event_type from outbox_message where aggregate_id=$1 order by seq", [l.enrolmentId]);
    expect(events.map((e) => e.event_type)).toEqual(["enrolment.created", "course.completed"]); // …but completion is recorded exactly once
    const audits = await ownerQuery("select 1 from audit_entry where action='enrolment.completed' and entity_id=$1", [l.enrolmentId]);
    expect(audits).toHaveLength(1);

    const page = await h.app.inject({ method: "GET", url: `/learn/enrolments/${l.enrolmentId}`, headers: { cookie: login.cookie } });
    expect(page.body).toContain("Course completed on");
  });

  it("a multi-lesson course completes only when every required lesson is complete", async () => {
    const login = await h.loginAs("learner-b2c-1");
    const first = await enrolAndLaunch(h, login, "synthetic-pathway-two-lessons", 0);
    await commit(first.attemptId, first.contentCookie, { cmi: { core: { lesson_status: "passed" } } });
    let [en] = await ownerQuery<{ status: string }>("select status from enrolment where id=$1", [first.enrolmentId]);
    expect(en!.status).toBe("active");
    const second = await enrolAndLaunch(h, login, "synthetic-pathway-two-lessons", 1);
    expect(second.enrolmentId).toBe(first.enrolmentId);
    await commit(second.attemptId, second.contentCookie, { cmi: { completion_status: "completed" } });
    [en] = await ownerQuery<{ status: string }>("select status from enrolment where id=$1", [first.enrolmentId]);
    expect(en!.status).toBe("completed");
  });

  it("progress in a reused lesson is tracked per enrolment. Completing it in one course doesn't complete another (CAT-02 / CAT-04 default)", async () => {
    const login = await h.loginAs("learner-b2c-1");
    const other = await enrolAndLaunch(h, login, "synthetic-course-scorm12");
    const s = await state(other.attemptId, other.contentCookie);
    expect(s.cmi.core!.entry).toBe("ab-initio");
    const [en] = await ownerQuery<{ status: string }>("select status from enrolment where id=$1", [other.enrolmentId]);
    expect(en!.status).toBe("active");
  });
});

describe("guards", () => {
  it("rejects suspend_data over the SCORM 1.2 limit (4096 characters)", async () => {
    const login = await h.loginAs("admin-1");
    const l = await enrolAndLaunch(h, login, "synthetic-course-scorm12");
    const r = await commit(l.attemptId, l.contentCookie, { cmi: { suspend_data: "x".repeat(4097) } });
    expect(r.statusCode).toBe(409);
  });

  it("refuses runtime access after the enrolment's access window ends", async () => {
    const login = await h.loginAs("admin-1");
    const l = await enrolAndLaunch(h, login, "synthetic-course-scorm12");
    await ownerQuery("update enrolment set access_end = now() - interval '1 minute' where id=$1", [l.enrolmentId]);
    expect((await commit(l.attemptId, l.contentCookie, { cmi: { core: { lesson_status: "passed" } } })).statusCode).toBe(403);
    const relaunch = await h.app.inject({ method: "POST", url: `/learn/enrolments/${l.enrolmentId}/placements/${l.placementId}/launch`,
      headers: { cookie: login.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `_csrf=${login.csrf}` });
    expect(relaunch.statusCode).toBe(409);
  });
});
