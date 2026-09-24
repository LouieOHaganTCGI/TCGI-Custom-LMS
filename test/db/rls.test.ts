import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_URL } from "../support/env.js";
import { createHarness, ownerQuery, type Harness } from "../support/harness.js";

/**
 * TS-SEC defence in depth (ADR-0004): these tests talk to PostgreSQL directly as the application role
 * (lms_app) with no application code in the path. They prove that row-level security, grants and
 * immutability triggers hold even if a query in the app forgets its WHERE clause.
 */
const TENANT_TABLES = ["entitlement", "entitlement_decision", "enrolment", "attempt", "runtime_commit", "progress_state", "audit_entry", "outbox_message",
  "delivery_attempt", "web_session", "auth_request", "launch_code", "identity_link", "person", "organisation_membership", "role_grant", "organisation"];

async function asApp<T extends pg.QueryResultRow>(ctx: { person?: string; orgs?: string[]; platform?: boolean }, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: APP_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("select set_config('app.person_id', $1, true), set_config('app.managed_org_ids', $2, true), set_config('app.platform', $3, true)", [
      ctx.person ?? "", `{${(ctx.orgs ?? []).join(",")}}`, ctx.platform ? "true" : "false"]);
    const r = await c.query<T>(sql, params);
    await c.query("COMMIT");
    return r.rows;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

let h: Harness;
let aoife: string, brian: string, ciara: string;
let orgA: string, orgB: string;

beforeAll(async () => {
  h = await createHarness();
  aoife = h.data.people["learner-b2c-1"]!;
  brian = h.data.people["learner-ent-a-1"]!;
  ciara = h.data.people["learner-ent-b-1"]!;
  orgA = h.data.orgs["synthetic-enterprise-a"]!;
  orgB = h.data.orgs["synthetic-enterprise-b"]!;
  // Give each learner an enrolment with an attempt and a commit, via the real services.
  for (const key of ["learner-b2c-1", "learner-ent-a-1", "learner-ent-b-1"]) {
    const { cookie, csrf } = await h.loginAs(key);
    const learn = await h.app.inject({ method: "GET", url: "/learn", headers: { cookie } });
    const courseId = /\/learn\/courses\/([0-9a-f-]{36})\/enrol/.exec(learn.body)![1]!;
    const r = await h.app.inject({ method: "POST", url: `/learn/courses/${courseId}/enrol`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `_csrf=${csrf}` });
    expect(r.statusCode).toBe(303);
  }
});
afterAll(async () => h.close());

describe("application role privileges", () => {
  it("lms_app is not superuser, cannot bypass RLS and owns no tables", async () => {
    const [role] = await ownerQuery<{ rolsuper: boolean; rolbypassrls: boolean }>("select rolsuper, rolbypassrls from pg_roles where rolname='lms_app'");
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await ownerQuery("select tablename from pg_tables where schemaname='public' and tableowner='lms_app'");
    expect(owned).toEqual([]);
  });

  it("every application table has row-level security enabled", async () => {
    const rows = await ownerQuery<{ tablename: string }>("select tablename from pg_tables where schemaname='public' and not rowsecurity and tablename not like 'kysely_%'");
    expect(rows).toEqual([]);
  });

  it("lms_app has no access to the migration bookkeeping tables", async () => {
    await expect(asApp({ platform: true }, "select * from kysely_migration")).rejects.toThrow(/permission denied/);
  });
});

describe("row-level security with no or foreign context", () => {
  it("with no context, every tenant table returns zero rows", async () => {
    for (const t of TENANT_TABLES) {
      const rows = await asApp({}, `select 1 from ${t}`);
      expect(rows, `table ${t} leaked rows without context`).toEqual([]);
    }
  });

  it("a learner sees only their own enrolments, attempts and entitlements", async () => {
    const enrolments = await asApp<{ person_id: string }>({ person: brian }, "select person_id from enrolment");
    expect(enrolments.length).toBeGreaterThan(0);
    expect(new Set(enrolments.map((e) => e.person_id))).toEqual(new Set([brian]));
    const ents = await asApp<{ person_id: string }>({ person: brian }, "select person_id from entitlement");
    expect(new Set(ents.map((e) => e.person_id))).toEqual(new Set([brian]));
    const people = await asApp<{ id: string }>({ person: brian }, "select id from person");
    expect(people.map((p) => p.id)).toEqual([brian]);
  });

  it("an Org A manager context sees Org A records and nothing from Org B or TCGI Direct", async () => {
    const rows = await asApp<{ organisation_id: string }>({ orgs: [orgA] }, "select organisation_id from enrolment");
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.organisation_id))).toEqual(new Set([orgA]));
    const people = await asApp<{ id: string }>({ orgs: [orgA] }, "select id from person");
    expect(people.map((p) => p.id)).toContain(brian);
    expect(people.map((p) => p.id)).not.toContain(ciara);
    expect(people.map((p) => p.id)).not.toContain(aoife);
    const bRows = await asApp<{ person_id: string }>({ orgs: [orgB] }, "select person_id from enrolment");
    expect(new Set(bRows.map((r) => r.person_id))).toEqual(new Set([ciara]));
    const audits = await asApp<{ organisation_id: string }>({ orgs: [orgA] }, "select organisation_id from audit_entry");
    expect(audits.every((a) => a.organisation_id === orgA)).toBe(true);
  });

  it("a learner cannot insert an enrolment for someone else", async () => {
    const [ent] = await ownerQuery<{ id: string; course_id: string; organisation_id: string }>("select id, course_id, organisation_id from entitlement where person_id=$1 limit 1", [ciara]);
    const [rev] = await ownerQuery<{ id: string }>("select id from course_revision where course_id=$1", [ent!.course_id]);
    await expect(
      asApp({ person: brian }, `insert into enrolment (organisation_id, person_id, course_id, course_revision_id, entitlement_id, access_start, completion_rule_ref)
        values ($1, $2, $3, $4, $5, now(), 'x')`, [ent!.organisation_id, ciara, ent!.course_id, rev!.id, ent!.id]),
    ).rejects.toThrow(/row-level security/);
  });

  it("a learner cannot grant themselves an entitlement or a role", async () => {
    await expect(asApp({ person: brian }, "insert into role_grant (person_id, role, scope_type, reason) values ($1, 'tcgi_admin', 'platform', 'x')", [brian])).rejects.toThrow(/row-level security/);
    const [c] = await ownerQuery<{ id: string }>("select id from course limit 1");
    await expect(asApp({ person: brian }, `insert into entitlement (organisation_id, person_id, course_id, grant_type, source, external_order_id, external_line_id, status, valid_from)
      values ($1, $2, $3, 'manual', 'x', 'x', 'x', 'active', now())`, [orgA, brian, c!.id])).rejects.toThrow(/row-level security/);
  });
});

describe("append-only and immutable records", () => {
  it("raw SCORM commits, audit entries and decisions cannot be updated or deleted by the app role", async () => {
    for (const sql of ["update audit_entry set action='x'", "delete from audit_entry", "update runtime_commit set seq=0", "delete from runtime_commit",
      "update entitlement_decision set rule_version='x'", "delete from enrolment", "truncate audit_entry"]) {
      await expect(asApp({ platform: true }, sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it("even the owner cannot rewrite an audit entry (trigger)", async () => {
    await expect(ownerQuery("update audit_entry set reason='rewritten' where id=1")).rejects.toThrow(/not permitted/);
  });

  it("a content version is immutable except for retirement", async () => {
    const [cv] = await ownerQuery<{ id: string }>("select id from content_version limit 1");
    await expect(ownerQuery("update content_version set launch_href='evil.html' where id=$1", [cv!.id])).rejects.toThrow(/immutable/);
    await ownerQuery("update content_version set status='retired' where id=$1", [cv!.id]);
    await ownerQuery("update content_version set status='approved' where id=$1", [cv!.id]);
  });

  it("a published course revision and its placements cannot change", async () => {
    const [rev] = await ownerQuery<{ id: string }>("select id from course_revision where state='published' limit 1");
    await expect(ownerQuery("update course_revision set completion_rule_ref='other' where id=$1", [rev!.id])).rejects.toThrow(/immutable/);
    await expect(ownerQuery("update course_placement set position=9 where course_revision_id=$1", [rev!.id])).rejects.toThrow(/immutable/);
  });

  it("the audit trail forms an unbroken hash chain", async () => {
    const rows = await ownerQuery<{ prev_hash: string; entry_hash: string }>("select prev_hash, entry_hash from audit_entry order by id");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0]!.prev_hash).toBe("0".repeat(64));
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.entry_hash);
  });
});
