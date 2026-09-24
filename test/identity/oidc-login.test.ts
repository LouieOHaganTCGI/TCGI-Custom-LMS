import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYNTHETIC_PEOPLE } from "../../src/seed.js";
import { safeReturnTo } from "../../src/modules/identity/oidc.js";
import { startTestIdp, type TestIdp } from "../../dev/test-idp.js";
import { cookieFrom, createHarness, ownerQuery, type Harness } from "../support/harness.js";

/**
 * ID-01 / ID-04 against a real OpenID Provider over HTTP (the local test IdP, not miniOrange). The OIDC
 * relying-party code under test is the production code path. Only the IdP differs.
 */
let idp: TestIdp;
let h: Harness;

class Jar {
  private c = new Map<string, string>();
  store(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const [k, ...v] = pair!.split("=");
      this.c.set(k!.trim(), v.join("="));
    }
  }
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Drive the browser leg: app /auth/login → IdP authorize → choose user → back to app /auth/callback. */
async function signIn(user: string, returnTo = "/learn", invite?: string) {
  const start = await h.app.inject({ method: "GET", url: `/auth/login?return_to=${encodeURIComponent(returnTo)}${invite ? `&invite=${encodeURIComponent(invite)}` : ""}` });
  expect(start.statusCode).toBe(302);
  const authCookie = cookieFrom(start.headers["set-cookie"], "lms_auth")!;
  const jar = new Jar();
  let url = start.headers.location!;
  for (let i = 0; i < 10; i++) {
    if (url.startsWith(h.config.APP_BASE_URL)) break;
    const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header() } });
    jar.store(res);
    if (res.status >= 300 && res.status < 400) {
      url = new URL(res.headers.get("location")!, url).href;
      continue;
    }
    const html = await res.text();
    const action = /action="([^"]+)"/.exec(html)![1]!;
    const post = await fetch(new URL(action, url), { method: "POST", redirect: "manual", headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" }, body: `login=${encodeURIComponent(user)}` });
    jar.store(post);
    url = new URL(post.headers.get("location")!, url).href;
  }
  const cb = new URL(url);
  return { authCookie, callbackPath: `${cb.pathname}${cb.search}` };
}

async function complete(authCookie: string, callbackPath: string) {
  return h.app.inject({ method: "GET", url: callbackPath, headers: { cookie: authCookie } });
}

beforeAll(async () => {
  idp = await startTestIdp({
    port: 4499,
    clientId: "tcgi-lms-test",
    clientSecret: "test-only-secret-value-not-used-anywhere-else-oidc",
    redirectUris: ["http://localhost:3100/auth/callback"],
    users: [...SYNTHETIC_PEOPLE.map((p) => ({ sub: p.key, name: p.name, email: p.email })), { sub: "stranger-1", name: "Unlinked Stranger", email: "aoife.synthetic@example.test" }],
  });
});
afterAll(async () => {
  await h?.close();
  await idp.close();
});
beforeEach(async () => {
  if (h) await h.close();
  h = await createHarness();
});

describe("OIDC sign-in (ID-01)", () => {
  it("signs a provisioned user in, sets a hardened session cookie, and audits the login", async () => {
    const { authCookie, callbackPath } = await signIn("learner-ent-a-1");
    expect(callbackPath).toMatch(/^\/auth\/callback\?code=/);
    const res = await complete(authCookie, callbackPath);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/learn");
    const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("lms_sid="))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const learn = await h.app.inject({ method: "GET", url: "/learn", headers: { cookie: setCookie.split(";")[0]! } });
    expect(learn.statusCode).toBe(200);
    expect(learn.body).toContain("Welcome back, Brian");
    const [a] = await ownerQuery<{ action: string; entity_id: string }>("select action, entity_id from audit_entry where action='auth.login'");
    expect(a!.entity_id).toBe(h.data.people["learner-ent-a-1"]);
  });

  it("identifies people by issuer and subject: an email change at the IdP updates the same person (and is audited)", async () => {
    idp.setEmail("learner-ent-a-1", "brian.new-address@example.test");
    try {
      const { authCookie, callbackPath } = await signIn("learner-ent-a-1");
      expect((await complete(authCookie, callbackPath)).statusCode).toBe(303);
      const [p] = await ownerQuery<{ id: string; primary_email: string }>("select id, primary_email from person where id=$1", [h.data.people["learner-ent-a-1"]]);
      expect(p!.primary_email).toBe("brian.new-address@example.test");
      const [count] = await ownerQuery<{ n: string }>("select count(*) as n from person");
      expect(count!.n).toBe(String(SYNTHETIC_PEOPLE.length)); // no duplicate person created
      const [audit] = await ownerQuery<{ before: { primary_email: string }; after: { primary_email: string } }>("select before, after from audit_entry where action='person.attributes_updated_from_idp'");
      expect(audit!.before.primary_email).toBe("brian.synthetic@example.test");
      expect(audit!.after.primary_email).toBe("brian.new-address@example.test");
    } finally {
      idp.setEmail("learner-ent-a-1", "brian.synthetic@example.test");
    }
  });

  it("never links by email: an unlinked subject with a known person's email is denied, not merged", async () => {
    const { authCookie, callbackPath } = await signIn("stranger-1"); // same email as Aoife, different subject
    const res = await complete(authCookie, callbackPath);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("no learning account is linked");
    expect(([] as string[]).concat(res.headers["set-cookie"] ?? []).some((c) => c.startsWith("lms_sid="))).toBe(false);
    const [denied] = await ownerQuery<{ reason: string }>("select reason from audit_entry where action='auth.login_denied'");
    expect(denied!.reason).toBe("no_linked_account");
  });

  it("replaying a callback fails (the login request is single-use)", async () => {
    const { authCookie, callbackPath } = await signIn("learner-b2c-1");
    expect((await complete(authCookie, callbackPath)).statusCode).toBe(303);
    expect((await complete(authCookie, callbackPath)).statusCode).toBe(400);
  });

  it("rejects a callback with a tampered state, or without the browser-binding cookie", async () => {
    const first = await signIn("learner-b2c-1");
    const tampered = first.callbackPath.replace(/state=[^&]+/, "state=tampered");
    expect((await complete(first.authCookie, tampered)).statusCode).toBe(400);
    const second = await signIn("learner-b2c-1");
    expect((await h.app.inject({ method: "GET", url: second.callbackPath })).statusCode).toBe(400);
    const third = await signIn("learner-b2c-1");
    expect((await complete("lms_auth=someone-elses-request", third.callbackPath)).statusCode).toBe(400);
  });

  it("denies a deactivated person at sign-in (ID-04)", async () => {
    await ownerQuery("update person set status='deactivated' where id=$1", [h.data.people["learner-b2c-1"]]);
    const { authCookie, callbackPath } = await signIn("learner-b2c-1");
    expect((await complete(authCookie, callbackPath)).statusCode).toBe(403);
  });

  it("does not allow open redirects through return_to", async () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) expect(safeReturnTo(bad)).toBe("/learn");
    expect(safeReturnTo("/learn/enrolments/1")).toBe("/learn/enrolments/1");
    const { authCookie, callbackPath } = await signIn("learner-b2c-1", "https://evil.example/");
    expect((await complete(authCookie, callbackPath)).headers.location).toBe("/learn");
  });

  it("logout revokes the server-side session", async () => {
    const { authCookie, callbackPath } = await signIn("learner-b2c-1");
    const res = await complete(authCookie, callbackPath);
    const sid = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("lms_sid="))!.split(";")[0]!;
    const page = await h.app.inject({ method: "GET", url: "/learn", headers: { cookie: sid } });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const out = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: sid, "content-type": "application/x-www-form-urlencoded" }, payload: `_csrf=${csrf}` });
    expect(out.statusCode).toBe(303);
    expect((await h.app.inject({ method: "GET", url: "/learn", headers: { cookie: sid } })).statusCode).toBe(303);
  });
});

describe("self-registration (DEC-06, default off)", () => {
  it("when explicitly enabled, a new subject gets a fresh person in TCGI Direct", async () => {
    await h.close();
    h = await createHarness({ config: { AUTH_ALLOW_SELF_REGISTRATION: "true" } });
    const { authCookie, callbackPath } = await signIn("stranger-1");
    expect((await complete(authCookie, callbackPath)).statusCode).toBe(303);
    const [link] = await ownerQuery<{ linked_via: string; person_id: string }>("select linked_via, person_id from identity_link where subject='stranger-1'");
    expect(link!.linked_via).toBe("self_registration");
    expect(link!.person_id).not.toBe(h.data.people["learner-b2c-1"]); // same email, still a different person
  });
});

describe("invitations (ID-03): linking by invite token plus IdP identity, never by email", () => {
  async function createInvite(name: string, email: string) {
    const mgr = await h.loginAs("manager-ent-a-1");
    const r = await h.app.inject({ method: "POST", url: `/manage/orgs/${h.data.orgs["synthetic-enterprise-a"]}/invitations`,
      headers: { cookie: mgr.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ _csrf: mgr.csrf, name, email }).toString() });
    expect(r.statusCode).toBe(201);
    const token = /\/invite\/([A-Za-z0-9_-]{20,})/.exec(r.body)![1]!;
    const [p] = await ownerQuery<{ id: string }>("select id from person where display_name=$1", [name]);
    return { token, placeholderId: p!.id, mgr };
  }

  it("a new learner accepts: the invited person gets the IdP identity and becomes an active member", async () => {
    idp.users.set("invitee-new-1", { sub: "invitee-new-1", name: "Fiona Invitee", email: "fiona.personal@example.test" });
    const { token, placeholderId } = await createInvite("Fiona Invitee", "fiona.work@example.test");
    const landing = await h.app.inject({ method: "GET", url: `/invite/${token}` });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain("Synthetic Enterprise A");
    const { authCookie, callbackPath } = await signIn("invitee-new-1", "/learn?flash=invite-accepted", token);
    const res = await complete(authCookie, callbackPath);
    expect(res.statusCode).toBe(303);
    const [link] = await ownerQuery<{ person_id: string; linked_via: string }>("select person_id, linked_via from identity_link where subject='invitee-new-1'");
    expect(link).toEqual({ person_id: placeholderId, linked_via: "invitation" });
    const [m] = await ownerQuery<{ status: string }>("select status from organisation_membership where person_id=$1", [placeholderId]);
    expect(m!.status).toBe("active");
    // Single use: the same link can't be accepted again.
    expect((await h.app.inject({ method: "GET", url: `/invite/${token}` })).statusCode).toBe(404);
    idp.users.set("invitee-new-2", { sub: "invitee-new-2", name: "Someone Else", email: "fiona.work@example.test" });
    const again = await signIn("invitee-new-2", "/learn", token);
    const r2 = await complete(again.authCookie, again.callbackPath);
    expect(r2.statusCode).toBe(403);
    expect(r2.body).toContain("expired or has already been used");
  });

  it("an existing B2C learner accepts: the placeholder merges into their account, with no duplicate person, and the seat moves with it", async () => {
    const { token, placeholderId, mgr } = await createInvite("Aoife at Work", "aoife.work@example.test");
    const course = h.data.courses["synthetic-course-scorm12"]!;
    const assign = await h.app.inject({ method: "POST", url: `/manage/orgs/${h.data.orgs["synthetic-enterprise-a"]}/assignments`,
      headers: { cookie: mgr.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ _csrf: mgr.csrf, person_id: placeholderId, course_id: course }).toString() });
    expect(assign.statusCode).toBe(303);
    const aoife = h.data.people["learner-b2c-1"]!;
    const { authCookie, callbackPath } = await signIn("learner-b2c-1", "/learn", token);
    expect((await complete(authCookie, callbackPath)).statusCode).toBe(303);
    const [m] = await ownerQuery<{ status: string }>("select status from organisation_membership where person_id=$1 and organisation_id=$2", [aoife, h.data.orgs["synthetic-enterprise-a"]]);
    expect(m!.status).toBe("active");
    const [seat] = await ownerQuery<{ person_id: string }>("select person_id from seat_allocation where state='allocated' and person_id in ($1,$2)", [aoife, placeholderId]);
    expect(seat!.person_id).toBe(aoife);
    const ents = await ownerQuery<{ person_id: string; status: string }>("select person_id, status from entitlement where grant_type='seat' and course_id=$1 and person_id in ($2,$3)", [course, aoife, placeholderId]);
    expect(ents).toEqual([{ person_id: aoife, status: "active" }]);
    const [ph] = await ownerQuery<{ status: string }>("select status from person where id=$1", [placeholderId]);
    expect(ph!.status).toBe("deactivated");
    expect(await ownerQuery("select 1 from identity_link where subject='learner-b2c-1'")).toHaveLength(1);
    const [a] = await ownerQuery<{ after: { merged_placeholder: string } }>("select after from audit_entry where action='invitation.accepted' order by id desc limit 1");
    expect(a!.after.merged_placeholder).toBe(placeholderId);
  });

  it("an unknown subject with no valid invite is still denied (no email matching)", async () => {
    const { authCookie, callbackPath } = await signIn("stranger-1", "/learn", "not-a-real-token");
    expect((await complete(authCookie, callbackPath)).statusCode).toBe(403);
  });
});
