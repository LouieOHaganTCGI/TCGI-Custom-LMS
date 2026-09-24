import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Services } from "./services.js";
import { zipDirectory } from "./lib/zip-dir.js";

/**
 * Synthetic seed data for development, tests and the Phase B demo. **Every person here is fictional**,
 * uses example.test addresses, and signs in through the local test IdP (or through miniOrange sandbox
 * test users mapped with `cli person:provision`). No real personal data.
 */
export const SYNTHETIC_PEOPLE = [
  { key: "learner-b2c-1", name: "Aoife Synthetic", email: "aoife.synthetic@example.test", org: "tcgi-direct", admin: false },
  { key: "learner-ent-a-1", name: "Brian Synthetic", email: "brian.synthetic@example.test", org: "synthetic-enterprise-a", admin: false },
  { key: "learner-ent-b-1", name: "Ciara Synthetic", email: "ciara.synthetic@example.test", org: "synthetic-enterprise-b", admin: false },
  { key: "admin-1", name: "Dana Admin (synthetic)", email: "dana.admin@example.test", org: "tcgi-direct", admin: true },
  { key: "manager-ent-a-1", name: "Eoin Manager (synthetic)", email: "eoin.manager@example.test", org: "synthetic-enterprise-a", admin: false },
] as const;

/** Synthetic commerce source for the local simulator (dev/commerce-sim.ts). Not a real store. */
export const SIM_COMMERCE_SOURCE = "woocommerce:tcgi-store-sim";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_DIR = path.join(ROOT, "fixtures", "scorm");

export interface SeedResult {
  orgs: Record<string, string>;
  people: Record<string, string>;
  contentVersions: { scorm12: string; scorm2004: string };
  courses: Record<string, string>;
}

export async function seed(services: Services, issuer: string, now = new Date()): Promise<SeedResult> {
  const system = { type: "system" as const, label: "seed (synthetic data)" };
  const orgs: Record<string, string> = {};
  const people: Record<string, string> = {};

  await services.db.withSystem("seed", async (trx) => {
    for (const o of [
      { slug: "tcgi-direct", kind: "tcgi_direct" as const, name: "TCGI Direct (B2C)" },
      { slug: "synthetic-enterprise-a", kind: "enterprise" as const, name: "Synthetic Enterprise A" },
      { slug: "synthetic-enterprise-b", kind: "enterprise" as const, name: "Synthetic Enterprise B" },
    ]) {
      const row = await trx.insertInto("organisation").values(o).onConflict((c) => c.column("slug").doUpdateSet({ name: o.name })).returning("id").executeTakeFirstOrThrow();
      orgs[o.slug] = row.id;
    }
    for (const p of SYNTHETIC_PEOPLE) {
      const existing = await trx.selectFrom("identity_link").select("person_id").where("issuer", "=", issuer).where("subject", "=", p.key).executeTakeFirst();
      if (existing) {
        people[p.key] = existing.person_id;
        continue;
      }
      const person = await trx.insertInto("person").values({ display_name: p.name, primary_email: p.email, email_verified: true, updated_at: now }).returning("id").executeTakeFirstOrThrow();
      people[p.key] = person.id;
      await trx.insertInto("identity_link").values({ person_id: person.id, issuer, subject: p.key, linked_via: "provisioning" }).execute();
      await trx.insertInto("organisation_membership").values({ organisation_id: orgs[p.org]!, person_id: person.id, source: "seed" }).execute();
      if (p.admin) {
        await trx.insertInto("role_grant").values({ person_id: person.id, role: "tcgi_admin", scope_type: "platform", organisation_id: null, reason: "synthetic seed admin" }).execute();
      }
    }
  });

  const v12 = await services.content.importPackage(await zipDirectory(path.join(FIXTURE_DIR, "synthetic-scorm12")), { stableKey: "synthetic-lesson-scorm12" }, system);
  const v04 = await services.content.importPackage(await zipDirectory(path.join(FIXTURE_DIR, "synthetic-scorm2004")), { stableKey: "synthetic-lesson-scorm2004" }, system);

  const courses: Record<string, string> = {};
  const courseDefs = [
    { slug: "synthetic-course-scorm12", title: "Synthetic course: SCORM 1.2 lesson", tier: "microlesson" as const, versions: [v12.contentVersionId] },
    { slug: "synthetic-course-scorm2004", title: "Synthetic course: SCORM 2004 lesson", tier: "foundation" as const, versions: [v04.contentVersionId] },
    // CAT-02 demonstration: the same content versions reused in a second course, with no second upload.
    { slug: "synthetic-pathway-two-lessons", title: "Synthetic pathway: two reused lessons", tier: "professional_certificate" as const, versions: [v12.contentVersionId, v04.contentVersionId] },
  ];
  for (const c of courseDefs) {
    const existing = await services.db.withSystem("seed", (trx) => trx.selectFrom("course").select("id").where("slug", "=", c.slug).executeTakeFirst());
    courses[c.slug] = existing
      ? existing.id
      : (await services.content.createAndPublishCourse({ slug: c.slug, title: c.title, tier: c.tier, placements: c.versions.map((id) => ({ contentVersionId: id })) }, system)).courseId;
  }

  // Phase B entitlement fixture. It goes through the same command the S4 signed-event handler will use.
  const from = new Date(now.getTime() - 24 * 3600_000);
  const until = new Date(now.getTime() + 365 * 24 * 3600_000);
  const grants = [
    { person: "learner-b2c-1", org: "tcgi-direct", course: "synthetic-course-scorm12" },
    { person: "learner-b2c-1", org: "tcgi-direct", course: "synthetic-course-scorm2004" },
    { person: "learner-b2c-1", org: "tcgi-direct", course: "synthetic-pathway-two-lessons" },
    { person: "learner-ent-a-1", org: "synthetic-enterprise-a", course: "synthetic-course-scorm12" },
    { person: "learner-ent-b-1", org: "synthetic-enterprise-b", course: "synthetic-course-scorm2004" },
    { person: "admin-1", org: "tcgi-direct", course: "synthetic-course-scorm12" },
  ];
  for (const g of grants) {
    const exists = await services.db.withSystem("seed", (trx) =>
      trx.selectFrom("entitlement").select("id").where("source", "=", "phase-b-fixture").where("external_order_id", "=", `FIXTURE-${g.person}`).where("external_line_id", "=", g.course).executeTakeFirst(),
    );
    if (exists) continue; // re-seeding keeps the original fixture grant
    await services.entitlements.grant(
      {
        source: "phase-b-fixture", externalOrderId: `FIXTURE-${g.person}`, externalLineId: g.course, personId: people[g.person]!, organisationId: orgs[g.org]!,
        courseId: courses[g.course]!, grantType: "manual", validFrom: from, validUntil: until, reason: "Phase B entitlement fixture (simulated purchase/seat)",
      },
      system,
    );
  }
  // Synthetic enterprise set-up: a manager, agreements and seat limits. These are NOT real contract terms (DEC-12).
  await services.db.withSystem("seed", async (trx) => {
    const mgr = people["manager-ent-a-1"]!;
    const hasRole = await trx.selectFrom("role_grant").select("id").where("person_id", "=", mgr).where("role", "=", "enterprise_manager").executeTakeFirst();
    if (!hasRole) {
      await trx.insertInto("role_grant").values({ person_id: mgr, role: "enterprise_manager", scope_type: "organisation", organisation_id: orgs["synthetic-enterprise-a"]!, reason: "synthetic seed manager" }).execute();
    }
    const agreements = [
      { org: "synthetic-enterprise-a", reference: "SYNTHETIC-A-AGREEMENT", seats: 3, courses: ["synthetic-course-scorm12", "synthetic-pathway-two-lessons"] },
      { org: "synthetic-enterprise-b", reference: "SYNTHETIC-B-AGREEMENT", seats: 2, courses: ["synthetic-course-scorm2004"] },
    ];
    for (const a of agreements) {
      const exists = await trx.selectFrom("agreement").select("id").where("organisation_id", "=", orgs[a.org]!).where("reference", "=", a.reference).executeTakeFirst();
      if (exists) continue;
      const row = await trx.insertInto("agreement").values({ organisation_id: orgs[a.org]!, reference: a.reference, seat_limit: a.seats,
        access_start: new Date(now.getTime() - 30 * 86_400_000), access_end: new Date(now.getTime() + 365 * 86_400_000) }).returning("id").executeTakeFirstOrThrow();
      for (const c of a.courses) await trx.insertInto("agreement_course").values({ agreement_id: row.id, course_id: courses[c]! }).execute();
    }
    // Commerce product mappings for the local simulator.
    for (const [product, course] of [["SYN-PROD-FOUNDATION-01", "synthetic-course-scorm2004"], ["SYN-PROD-PATHWAY-01", "synthetic-pathway-two-lessons"]] as const) {
      await trx.insertInto("commercial_product_reference").values({ source: SIM_COMMERCE_SOURCE, external_product_id: product, course_id: courses[course]! })
        .onConflict((c) => c.columns(["source", "external_product_id"]).doNothing()).execute();
    }
    // Demo CPD values (synthetic: the real values and unit are DEC-22).
    await trx.updateTable("course").set({ cpd_value: 1, cpd_unit: "CPD units (synthetic)" }).where("id", "=", courses["synthetic-course-scorm12"]!).where("cpd_value", "is", null).execute();
    await trx.updateTable("course").set({ cpd_value: 2.5, cpd_unit: "CPD units (synthetic)" }).where("id", "in", [courses["synthetic-course-scorm2004"]!, courses["synthetic-pathway-two-lessons"]!]).where("cpd_value", "is", null).execute();
  });
  return { orgs, people, contentVersions: { scorm12: v12.contentVersionId, scorm2004: v04.contentVersionId }, courses };
}
