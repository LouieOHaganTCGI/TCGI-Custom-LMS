import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueLaunchToken } from "../../src/modules/learning/launch-token.js";
import { createHarness, enrolAndLaunch, form, FORM, ownerQuery, type Harness } from "../support/harness.js";

/**
 * TS-SEC authorisation matrix (brief §4: "Organisation A users must never enumerate Organisation B … by
 * changing a URL or API parameter"). Each foreign resource is tried directly by ID.
 */
let h: Harness;
let aoife: { cookie: string; csrf: string; personId: string };
let brian: { cookie: string; csrf: string; personId: string };
let ciara: { cookie: string; csrf: string; personId: string };
let admin: { cookie: string; csrf: string; personId: string };
let brianLaunch: Awaited<ReturnType<typeof enrolAndLaunch>>;
let ciaraLaunch: Awaited<ReturnType<typeof enrolAndLaunch>>;

beforeAll(async () => {
  h = await createHarness();
  aoife = await h.loginAs("learner-b2c-1");
  brian = await h.loginAs("learner-ent-a-1");
  ciara = await h.loginAs("learner-ent-b-1");
  admin = await h.loginAs("admin-1");
  brianLaunch = await enrolAndLaunch(h, brian, "synthetic-course-scorm12");
  ciaraLaunch = await enrolAndLaunch(h, ciara, "synthetic-course-scorm2004");
});
afterAll(async () => h.close());

const get = (url: string, cookie?: string) => h.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
const post = (url: string, who: { cookie: string; csrf: string }, extra: Record<string, string> = {}) =>
  h.app.inject({ method: "POST", url, headers: { cookie: who.cookie, ...FORM }, payload: form({ _csrf: who.csrf, ...extra }) });

describe("authentication", () => {
  it("unauthenticated page requests redirect to sign-in, and unauthenticated writes get 401", async () => {
    const r = await get("/learn");
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/?return_to=%2Flearn");
    const w = await h.app.inject({ method: "POST", url: `/learn/courses/${h.data.courses["synthetic-course-scorm12"]}/enrol`, headers: FORM, payload: "" });
    expect(w.statusCode).toBe(401);
  });

  it("a forged or revoked session cookie is not accepted", async () => {
    expect((await get("/learn", "lms_sid=forged-value")).statusCode).toBe(303);
    const temp = await h.loginAs("learner-b2c-1");
    await h.services.sessions.revoke(temp.cookie.split("=")[1]!);
    expect((await get("/learn", temp.cookie)).statusCode).toBe(303);
  });

  it("a deactivated person's existing session stops working immediately (ID-04)", async () => {
    const temp = await h.loginAs("learner-ent-b-1");
    await ownerQuery("update person set status='deactivated' where id=$1", [temp.personId]);
    try {
      expect((await get("/learn", temp.cookie)).statusCode).toBe(303);
    } finally {
      await ownerQuery("update person set status='active' where id=$1", [temp.personId]);
    }
  });
});

describe("cross-learner and cross-tenant access (IDOR)", () => {
  it("a learner cannot view another tenant's enrolment by ID: 404, with no data in the body", async () => {
    const r = await get(`/learn/enrolments/${ciaraLaunch.enrolmentId}`, brian.cookie);
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("SCORM 2004");
    expect(r.body).not.toContain("Ciara");
  });

  it("a platform admin also cannot open another person's learner view through the learner routes", async () => {
    expect((await get(`/learn/enrolments/${brianLaunch.enrolmentId}`, admin.cookie)).statusCode).toBe(404);
  });

  it("a learner cannot launch a placement through someone else's enrolment", async () => {
    const r = await post(`/learn/enrolments/${ciaraLaunch.enrolmentId}/placements/${ciaraLaunch.placementId}/launch`, brian);
    expect(r.statusCode).toBe(404);
  });

  it("a learner cannot launch a placement from another course through their own enrolment", async () => {
    const r = await post(`/learn/enrolments/${brianLaunch.enrolmentId}/placements/${ciaraLaunch.placementId}/launch`, brian);
    expect(r.statusCode).toBe(404);
  });

  it("a learner cannot enrol in a course they have no entitlement for, and it looks the same as a missing course", async () => {
    const noEnt = await post(`/learn/courses/${h.data.courses["synthetic-course-scorm2004"]}/enrol`, brian);
    const missing = await post(`/learn/courses/00000000-0000-4000-8000-000000000000/enrol`, brian);
    expect(noEnt.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
  });

  it("a client-supplied organisation_id is ignored: the enrolment takes the entitlement's organisation", async () => {
    const r = await post(`/learn/courses/${h.data.courses["synthetic-course-scorm2004"]}/enrol`, aoife, { organisation_id: h.data.orgs["synthetic-enterprise-b"]! });
    expect(r.statusCode).toBe(303);
    const id = r.headers.location!.split("?")[0]!.split("/").pop();
    const [row] = await ownerQuery<{ organisation_id: string }>("select organisation_id from enrolment where id=$1", [id]);
    expect(row!.organisation_id).toBe(h.data.orgs["tcgi-direct"]);
  });

  it("a learner's dashboard lists only their own courses", async () => {
    const r = await get("/learn", brian.cookie);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Synthetic course: SCORM 1.2 lesson");
    expect(r.body).not.toContain("Synthetic course: SCORM 2004 lesson");
    expect(r.body).not.toContain("Ciara");
  });

  it("malformed IDs are handled as not found, with no database error", async () => {
    expect((await get("/learn/enrolments/not-a-uuid", brian.cookie)).statusCode).toBe(404);
    expect((await get("/learn/enrolments/'%20or%201=1--", brian.cookie)).statusCode).toBe(404);
  });
});

describe("admin capability boundaries", () => {
  const adminGets = ["/admin", "/admin/audit", "/admin/integrations", "/admin/content"];
  it.each(adminGets)("a learner gets 404 on %s (existence isn't revealed)", async (url) => {
    const r = await get(url, brian.cookie);
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("audit");
  });

  it.each(adminGets)("a TCGI admin can open %s", async (url) => {
    expect((await get(url, admin.cookie)).statusCode).toBe(200);
  });

  it("a learner cannot replay integration messages or create courses", async () => {
    const [msg] = await ownerQuery<{ id: string }>("select id from outbox_message limit 1");
    expect((await post(`/admin/integrations/${msg!.id}/replay`, brian)).statusCode).toBe(404);
    expect((await post(`/admin/courses`, brian, { slug: "evil", title: "x", tier: "microlesson", content_version_ids: h.data.contentVersions.scorm12 })).statusCode).toBe(404);
  });
});

describe("CSRF protection", () => {
  it("rejects state-changing requests without a token, or with another session's token", async () => {
    const url = `/learn/courses/${h.data.courses["synthetic-pathway-two-lessons"]}/enrol`;
    const none = await h.app.inject({ method: "POST", url, headers: { cookie: aoife.cookie, ...FORM }, payload: "" });
    expect(none.statusCode).toBe(403);
    const other = await h.app.inject({ method: "POST", url, headers: { cookie: aoife.cookie, ...FORM }, payload: form({ _csrf: brian.csrf }) });
    expect(other.statusCode).toBe(403);
    const [count] = await ownerQuery<{ n: string }>("select count(*) as n from enrolment where course_id=$1", [h.data.courses["synthetic-pathway-two-lessons"]]);
    expect(count!.n).toBe("0");
  });
});

describe("content origin: attempt-scoped launch tokens (T-09, T-10)", () => {
  const cget = (url: string, cookie?: string) => h.content.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

  it("package files, state and the player need the launch cookie", async () => {
    const base = `/a/${brianLaunch.attemptId}`;
    for (const u of [`${base}/player`, `${base}/runtime/state`, `${base}/pkg/index.html`]) expect((await cget(u)).statusCode, u).toBe(401);
    expect((await cget(`${base}/pkg/index.html`, brianLaunch.contentCookie)).statusCode).toBe(200);
  });

  it("a token for one attempt can't be used on another attempt's path", async () => {
    const r = await cget(`/a/${ciaraLaunch.attemptId}/runtime/state`, brianLaunch.contentCookie);
    expect(r.statusCode).toBe(401);
    const c = await h.content.inject({ method: "POST", url: `/a/${ciaraLaunch.attemptId}/runtime/commit`, headers: { cookie: brianLaunch.contentCookie, "content-type": "application/json" }, payload: "{}" });
    expect(c.statusCode).toBe(401);
  });

  it("a token signed for another person's attempt is refused by the server-side re-check", async () => {
    // Even a validly signed token is re-checked against the attempt's owner (defence against a leaked secret or bug).
    const forged = issueLaunchToken(h.config.LAUNCH_TOKEN_SECRET, { att: ciaraLaunch.attemptId, per: brian.personId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 });
    expect((await cget(`/a/${ciaraLaunch.attemptId}/runtime/state`, `lms_lt=${forged}`)).statusCode).toBe(403);
  });

  it("tampered, wrongly signed and expired tokens are rejected", async () => {
    const good = brianLaunch.contentCookie.split("=")[1]!;
    const [v, body, mac] = good.split(".");
    const tampered = `${v}.${Buffer.from(JSON.stringify({ att: brianLaunch.attemptId, per: ciara.personId, iat: 1, exp: 9999999999 })).toString("base64url")}.${mac}`;
    const wrongKey = issueLaunchToken("some-other-secret-value-that-is-long-enough", { att: brianLaunch.attemptId, per: brian.personId, iat: Math.floor(Date.now() / 1000), exp: 9999999999 });
    const expired = issueLaunchToken(h.config.LAUNCH_TOKEN_SECRET, { att: brianLaunch.attemptId, per: brian.personId, iat: 900, exp: 1000 });
    for (const t of [tampered, wrongKey, expired, `${v}.${body}`]) expect((await cget(`/a/${brianLaunch.attemptId}/runtime/state`, `lms_lt=${t}`)).statusCode).toBe(401);
  });

  it("signing out of the LMS revokes that person's open lesson tokens (shared-device protection)", async () => {
    const temp = await h.loginAs("learner-ent-b-1");
    const l = await enrolAndLaunch(h, temp, "synthetic-course-scorm2004");
    await new Promise((r) => setTimeout(r, 1100)); // token issued in an earlier second than the sign-out
    expect((await cget(`/a/${l.attemptId}/runtime/state`, l.contentCookie)).statusCode).toBe(200);
    const out = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: temp.cookie, ...FORM }, payload: form({ _csrf: temp.csrf }) });
    expect(out.statusCode).toBe(303);
    expect((await cget(`/a/${l.attemptId}/runtime/state`, l.contentCookie)).statusCode).toBe(403);
    const commit = await h.content.inject({ method: "POST", url: `/a/${l.attemptId}/runtime/commit`, headers: { cookie: l.contentCookie, "content-type": "application/json" }, payload: "{}" });
    expect(commit.statusCode).toBe(403);
  });

  it("a launch code is single-use", async () => {
    expect((await cget(`/launch?code=${brianLaunch.launchCode}`)).statusCode).toBe(400);
    expect((await cget(`/launch?code=made-up`)).statusCode).toBe(400);
  });

  it("package paths can't traverse out of the package, and only files in the package index are served", async () => {
    const base = `/a/${brianLaunch.attemptId}/pkg`;
    for (const p of ["../../../etc/passwd", "..%2f..%2fetc%2fpasswd", "%2e%2e/imsmanifest.xml", "nonexistent.html"]) {
      expect((await cget(`${base}/${p}`, brianLaunch.contentCookie)).statusCode, p).toBe(404);
    }
  });

  it("the app origin does not serve package content at all", async () => {
    expect((await get(`/a/${brianLaunch.attemptId}/pkg/index.html`, brian.cookie)).statusCode).toBe(404);
  });

  it("commits need a JSON or text/plain body. Form posts are refused", async () => {
    const r = await h.content.inject({ method: "POST", url: `/a/${brianLaunch.attemptId}/runtime/commit`, headers: { cookie: brianLaunch.contentCookie, ...FORM }, payload: "a=b" });
    expect(r.statusCode).toBe(415);
  });
});

describe("security headers", () => {
  it("the app origin sends a strict CSP that forbids framing and inline script", async () => {
    const r = await get("/");
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("the launch cookie is HttpOnly, SameSite=Lax and scoped to one attempt's path", async () => {
    const exch = await enrolAndLaunch(h, aoife, "synthetic-course-scorm12");
    expect(exch.contentCookie).toMatch(/^lms_lt=lt1\./);
    expect(exch.rawSetCookie).toMatch(/HttpOnly/i);
    expect(exch.rawSetCookie).toMatch(/SameSite=Lax/i);
    expect(exch.rawSetCookie).toContain(`Path=/a/${exch.attemptId}/`);
  });

  it("content-origin package files can't be framed by other origins, and are not sniffed", async () => {
    const r = await h.content.inject({ method: "GET", url: `/a/${brianLaunch.attemptId}/pkg/index.html`, headers: { cookie: brianLaunch.contentCookie } });
    expect(r.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(r.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
});
