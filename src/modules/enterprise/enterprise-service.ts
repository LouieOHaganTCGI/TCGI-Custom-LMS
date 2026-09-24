import { sql } from "kysely";
import type { ScopedDb, Trx } from "../../db/scoped.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import { audit, personActor } from "../audit/audit.js";
import { asPrincipal, NotFoundError, RuleViolation, type AuthzContext } from "../authz/authz.js";
import { grantInTrx } from "../entitlements/entitlement-commands.js";
import { enqueueEvent } from "../integration/outbox.js";

export const INVITATION_TTL_DAYS = 14; // PROVISIONAL, pending DEC-12 and DEC-25

export interface TeamMember {
  personId: string;
  name: string;
  email: string | null;
  membershipStatus: string;
  seatState: "allocated" | "released" | null;
  enrolments: { enrolmentId: string; courseTitle: string; status: string; placementsTotal: number; placementsCompleted: number; completedAt: Date | null; accessEnd: Date | null }[];
  cpd: { total: number; unit: string }[];
  pendingInvitationExpires: Date | null;
}

export interface AgreementView {
  id: string;
  reference: string;
  seatLimit: number;
  seatsUsed: number;
  accessStart: Date;
  accessEnd: Date;
  status: string;
  courses: { id: string; title: string; tier: string }[];
}

export interface TeamView {
  organisation: { id: string; name: string; slug: string };
  agreements: AgreementView[];
  members: TeamMember[];
}

/**
 * Enterprise administration (ENT-01, ENT-02, ENT-03, ID-03). Manager operations run in the manager's own RLS
 * scope, and each first checks that the organisation is one they manage (server-derived). Otherwise it's a 404.
 * Seat-limit enforcement locks the agreement row, so concurrent assignments can't exceed it.
 */
export class EnterpriseService {
  constructor(
    private readonly db: ScopedDb,
    private readonly opts: { appBaseUrl: string; eventSource: string },
  ) {}

  private assertManages(ctx: AuthzContext, orgId: string): void {
    if (!ctx.platform && !ctx.managedOrgIds.includes(orgId)) throw new NotFoundError("organisation");
  }

  managedOrganisations(ctx: AuthzContext) {
    return asPrincipal(this.db, ctx, "manage.orgs", (trx) =>
      ctx.managedOrgIds.length === 0 ? Promise.resolve([]) :
        trx.selectFrom("organisation").select(["id", "name", "slug"]).where("id", "in", [...ctx.managedOrgIds]).orderBy("name").execute(),
    );
  }

  teamView(ctx: AuthzContext, orgId: string): Promise<TeamView> {
    this.assertManages(ctx, orgId);
    return asPrincipal(this.db, ctx, "manage.team", async (trx) => {
      const org = await trx.selectFrom("organisation").select(["id", "name", "slug"]).where("id", "=", orgId).where("kind", "=", "enterprise").executeTakeFirst();
      if (!org) throw new NotFoundError("organisation");
      const agreements = await loadAgreements(trx, orgId);
      const members = await trx
        .selectFrom("organisation_membership as m").innerJoin("person as p", "p.id", "m.person_id")
        .select(["p.id", "p.display_name", "p.primary_email", "m.status"])
        .where("m.organisation_id", "=", orgId).orderBy("p.display_name").execute();
      const ids = members.map((m) => m.id);
      const none = ids.length === 0;
      const seats = none ? [] : await trx.selectFrom("seat_allocation").select(["person_id", "state"]).where("organisation_id", "=", orgId).where("person_id", "in", ids).orderBy("allocated_at").execute();
      const enrolments = none ? [] : await trx
        .selectFrom("enrolment as en").innerJoin("course as c", "c.id", "en.course_id")
        .select((eb) => ["en.id", "en.person_id", "c.title", "en.status", "en.completed_at", "en.access_end",
          eb.selectFrom("course_placement as p").select(sql<string>`count(*)`.as("n")).whereRef("p.course_revision_id", "=", "en.course_revision_id").where("p.required", "=", true).as("total"),
          eb.selectFrom("course_placement as p").select(sql<string>`count(*)`.as("n")).whereRef("p.course_revision_id", "=", "en.course_revision_id").where("p.required", "=", true)
            .where((w) => w.exists(w.selectFrom("attempt as a").innerJoin("progress_state as ps", "ps.attempt_id", "a.id").select("a.id")
              .whereRef("a.enrolment_id", "=", "en.id").whereRef("a.placement_id", "=", "p.id").where("ps.first_completed_at", "is not", null))).as("done"),
        ])
        .where("en.organisation_id", "=", orgId) // only this licensing context: never the person's own B2C learning (T-03)
        .where("en.person_id", "in", ids).orderBy("c.title").execute();
      const cpd = none ? [] : await trx.selectFrom("cpd_award").select(["person_id", "unit", sql<string>`sum(value)`.as("total")])
        .where("organisation_id", "=", orgId).where("person_id", "in", ids).groupBy(["person_id", "unit"]).execute();
      const invites = none ? [] : await trx.selectFrom("invitation").select(["person_id", "expires_at"])
        .where("organisation_id", "=", orgId).where("accepted_at", "is", null).where("revoked_at", "is", null).execute();
      return {
        organisation: org,
        agreements,
        members: members.map((m) => ({
          personId: m.id, name: m.display_name, email: m.primary_email, membershipStatus: m.status,
          seatState: (seats.filter((s) => s.person_id === m.id).at(-1)?.state ?? null) as TeamMember["seatState"],
          enrolments: enrolments.filter((e) => e.person_id === m.id).map((e) => ({
            enrolmentId: e.id, courseTitle: e.title, status: e.status, placementsTotal: Number(e.total ?? 0), placementsCompleted: Number(e.done ?? 0),
            completedAt: e.completed_at, accessEnd: e.access_end,
          })),
          cpd: cpd.filter((c) => c.person_id === m.id).map((c) => ({ total: Number(c.total), unit: c.unit })),
          pendingInvitationExpires: invites.find((i) => i.person_id === m.id)?.expires_at ?? null,
        })),
      };
    });
  }

  /** Invite a learner. It returns the one-time link (the raw token is never stored). Email delivery awaits DEC-25. */
  invite(ctx: AuthzContext, orgId: string, input: { name: string; email: string }, requestId: string | null, now = new Date()): Promise<{ personId: string; link: string }> {
    this.assertManages(ctx, orgId);
    const name = input.name.trim().slice(0, 120);
    const email = input.email.trim().toLowerCase().slice(0, 254);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new RuleViolation("Enter the learner's name and a valid email address.", "invalid_invite");
    const token = randomToken(32);
    return asPrincipal(this.db, ctx, "manage.invite", async (trx) => {
      const expires = new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000);
      const r = await sql<{ id: string }>`select invite_person(${orgId}::uuid, ${name}, ${email}, ${sha256Hex(token)}, ${expires}) as id`.execute(trx);
      const personId = r.rows[0]!.id;
      await audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "invitation.created", entityType: "person", entityId: personId, organisationId: orgId,
        after: { name, email, expires_at: expires }, requestId });
      return { personId, link: new URL(`/invite/${token}`, this.opts.appBaseUrl).href };
    });
  }

  /**
   * Assign a course from an active agreement to a member. This allocates a seat if the member doesn't hold
   * one (up to the seat limit), then grants a seat entitlement. Idempotent for the same member and course.
   */
  assignCourse(ctx: AuthzContext, orgId: string, personId: string, courseId: string, requestId: string | null, now = new Date()): Promise<{ seatAllocated: boolean }> {
    this.assertManages(ctx, orgId);
    return asPrincipal(this.db, ctx, "manage.assign", async (trx) => {
      const member = await trx.selectFrom("organisation_membership").select("status").where("organisation_id", "=", orgId).where("person_id", "=", personId).executeTakeFirst();
      if (!member || member.status === "ended") throw new NotFoundError("member");
      const agreement = await trx
        .selectFrom("agreement as a").innerJoin("agreement_course as ac", "ac.agreement_id", "a.id")
        .select(["a.id", "a.seat_limit", "a.access_start", "a.access_end"])
        .where("a.organisation_id", "=", orgId).where("ac.course_id", "=", courseId).where("a.status", "=", "active")
        .where("a.access_start", "<=", now).where("a.access_end", ">", now)
        .orderBy("a.access_end", "desc").forUpdate("a").executeTakeFirst();
      if (!agreement) throw new RuleViolation("This course isn't included in an active agreement for your organisation.", "course_not_in_agreement");

      let seatAllocated = false;
      const seat = await trx.selectFrom("seat_allocation").select("id").where("agreement_id", "=", agreement.id).where("person_id", "=", personId).where("state", "=", "allocated").executeTakeFirst();
      if (!seat) {
        const used = await trx.selectFrom("seat_allocation").select(sql<string>`count(*)`.as("n")).where("agreement_id", "=", agreement.id).where("state", "=", "allocated").executeTakeFirstOrThrow();
        if (Number(used.n) >= agreement.seat_limit) throw new RuleViolation(`All ${agreement.seat_limit} seats on this agreement are in use. Contact TCGI to change your agreement.`, "seat_limit_reached");
        const s = await trx.insertInto("seat_allocation").values({ organisation_id: orgId, agreement_id: agreement.id, person_id: personId, allocated_by: ctx.personId }).returning("id").executeTakeFirstOrThrow();
        await audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "seat.allocated", entityType: "seat_allocation", entityId: s.id, organisationId: orgId,
          after: { agreement_id: agreement.id, person_id: personId, seats_used: Number(used.n) + 1, seat_limit: agreement.seat_limit }, requestId });
        seatAllocated = true;
      }
      await grantInTrx(trx, {
        source: `agreement:${agreement.id}`, externalOrderId: agreement.id, externalLineId: `${personId}:${courseId}`, personId, organisationId: orgId, courseId,
        grantType: "seat", validFrom: agreement.access_start, validUntil: agreement.access_end, reason: "course assigned by manager",
      }, personActor(ctx.personId, ctx.displayName), requestId, "seat-grant/v0 (terms from agreement, DEC-12)");
      return { seatAllocated };
    });
  }

  /** ENT-03: CSV of this organisation's learning records only. Audited. */
  async exportCsv(ctx: AuthzContext, orgId: string, requestId: string | null): Promise<string> {
    const view = await this.teamView(ctx, orgId);
    const rows: (string | number | null)[][] = [["Learner", "Email", "Membership", "Course", "Status", "Lessons completed", "Lessons total", "Completed at", "Access end", "CPD (this organisation)"]];
    for (const m of view.members) {
      const cpd = m.cpd.map((c) => `${c.total} ${c.unit}`).join("; ");
      if (m.enrolments.length === 0) rows.push([m.name, m.email, m.membershipStatus, "", "", "", "", "", "", cpd]);
      for (const e of m.enrolments) {
        rows.push([m.name, m.email, m.membershipStatus, e.courseTitle, e.status, e.placementsCompleted, e.placementsTotal, e.completedAt?.toISOString() ?? "", e.accessEnd?.toISOString() ?? "", cpd]);
      }
    }
    await asPrincipal(this.db, ctx, "manage.export", (trx) =>
      audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "report.exported", entityType: "organisation", entityId: orgId, organisationId: orgId,
        after: { report: "team-progress", rows: rows.length - 1 }, requestId }),
    );
    return toCsv(rows);
  }

  // ------------------------------------------------------------------------------------------ TCGI admin

  listOrganisations(ctx: AuthzContext) {
    return asPrincipal(this.db, ctx, "admin.orgs", async (trx) => {
      const orgs = await trx.selectFrom("organisation").select(["id", "name", "slug", "status", "created_at"]).where("kind", "=", "enterprise").orderBy("name").execute();
      const counts = await trx.selectFrom("organisation_membership").select(["organisation_id", sql<string>`count(*)`.as("n")]).groupBy("organisation_id").execute();
      const seats = await trx.selectFrom("seat_allocation").select(["organisation_id", sql<string>`count(*)`.as("n")]).where("state", "=", "allocated").groupBy("organisation_id").execute();
      const limits = await trx.selectFrom("agreement").select(["organisation_id", sql<string>`sum(seat_limit)`.as("n")]).where("status", "=", "active").groupBy("organisation_id").execute();
      const n = (arr: { organisation_id: string; n: string }[], id: string) => Number(arr.find((x) => x.organisation_id === id)?.n ?? 0);
      return orgs.map((o) => ({ ...o, members: n(counts, o.id), seatsUsed: n(seats, o.id), seatLimit: n(limits, o.id) }));
    });
  }

  createOrganisation(ctx: AuthzContext, input: { slug: string; name: string }, requestId: string | null) {
    if (!ctx.platform) throw new NotFoundError("organisation");
    if (!/^[a-z0-9-]{2,64}$/.test(input.slug) || !input.name.trim()) throw new RuleViolation("Enter a name and a slug (lowercase letters, numbers and hyphens).", "invalid_org");
    return asPrincipal(this.db, ctx, "admin.org-create", async (trx) => {
      const exists = await trx.selectFrom("organisation").select("id").where("slug", "=", input.slug).executeTakeFirst();
      if (exists) throw new RuleViolation("That slug is already used.", "slug_taken");
      const o = await trx.insertInto("organisation").values({ slug: input.slug, kind: "enterprise", name: input.name.trim().slice(0, 200) }).returning("id").executeTakeFirstOrThrow();
      await audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "organisation.created", entityType: "organisation", entityId: o.id, organisationId: o.id, after: input, requestId });
      return o.id;
    });
  }

  organisationDetail(ctx: AuthzContext, orgId: string) {
    if (!ctx.platform) throw new NotFoundError("organisation");
    return asPrincipal(this.db, ctx, "admin.org-detail", async (trx) => {
      const org = await trx.selectFrom("organisation").select(["id", "name", "slug"]).where("id", "=", orgId).where("kind", "=", "enterprise").executeTakeFirst();
      if (!org) throw new NotFoundError("organisation");
      const agreements = await loadAgreements(trx, orgId);
      const members = await trx.selectFrom("organisation_membership as m").innerJoin("person as p", "p.id", "m.person_id")
        .select(["p.id", "p.display_name", "p.primary_email", "m.status"]).where("m.organisation_id", "=", orgId).orderBy("p.display_name").execute();
      const seats = await trx.selectFrom("seat_allocation as s").innerJoin("person as p", "p.id", "s.person_id").innerJoin("agreement as a", "a.id", "s.agreement_id")
        .select(["s.id", "s.state", "s.allocated_at", "s.released_at", "p.display_name", "a.reference"]).where("s.organisation_id", "=", orgId).orderBy("s.allocated_at", "desc").execute();
      const managers = await trx.selectFrom("role_grant as g").innerJoin("person as p", "p.id", "g.person_id").select(["g.id", "p.display_name", "g.created_at"])
        .where("g.organisation_id", "=", orgId).where("g.role", "=", "enterprise_manager").where("g.valid_to", "is", null).execute();
      const courses = await trx.selectFrom("course as c").innerJoin("course_revision as r", (j) => j.onRef("r.course_id", "=", "c.id").on("r.state", "=", "published"))
        .select(["c.id", "c.title", "c.tier"]).orderBy("c.title").execute();
      return { org, agreements, members, seats, managers, courses };
    });
  }

  createAgreement(ctx: AuthzContext, orgId: string, input: { reference: string; seatLimit: number; accessStart: Date; accessEnd: Date; courseIds: string[] }, requestId: string | null) {
    if (!ctx.platform) throw new NotFoundError("organisation");
    if (!input.reference.trim() || !Number.isInteger(input.seatLimit) || input.seatLimit < 1 || !(input.accessEnd > input.accessStart) || input.courseIds.length === 0) {
      throw new RuleViolation("Enter a reference, a seat limit of 1 or more, an end date after the start date, and at least one course.", "invalid_agreement");
    }
    return asPrincipal(this.db, ctx, "admin.agreement-create", async (trx) => {
      const a = await trx.insertInto("agreement").values({ organisation_id: orgId, reference: input.reference.trim().slice(0, 100), seat_limit: input.seatLimit,
        access_start: input.accessStart, access_end: input.accessEnd, created_by: ctx.personId }).returning("id").executeTakeFirstOrThrow();
      for (const c of new Set(input.courseIds)) await trx.insertInto("agreement_course").values({ agreement_id: a.id, course_id: c }).execute();
      await audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "agreement.created", entityType: "agreement", entityId: a.id, organisationId: orgId,
        after: { ...input, courseIds: [...new Set(input.courseIds)] }, reason: "terms entered by TCGI from the client contract (DEC-12)", requestId });
      return a.id;
    });
  }

  grantManager(ctx: AuthzContext, orgId: string, personId: string, requestId: string | null) {
    if (!ctx.platform) throw new NotFoundError("organisation");
    return asPrincipal(this.db, ctx, "admin.grant-manager", async (trx) => {
      const m = await trx.selectFrom("organisation_membership").select("status").where("organisation_id", "=", orgId).where("person_id", "=", personId).executeTakeFirst();
      if (!m || m.status !== "active") throw new RuleViolation("Only active members (who have accepted their invitation) can be managers.", "not_active_member");
      const exists = await trx.selectFrom("role_grant").select("id").where("person_id", "=", personId).where("organisation_id", "=", orgId).where("role", "=", "enterprise_manager").where("valid_to", "is", null).executeTakeFirst();
      if (exists) return;
      const g = await trx.insertInto("role_grant").values({ person_id: personId, role: "enterprise_manager", scope_type: "organisation", organisation_id: orgId, granted_by: ctx.personId, reason: "granted by TCGI admin" })
        .returning("id").executeTakeFirstOrThrow();
      await audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "role.granted", entityType: "role_grant", entityId: g.id, organisationId: orgId, after: { person_id: personId, role: "enterprise_manager" }, requestId });
    });
  }

  /** PROVISIONAL (DEC-32): TCGI releases seats. This revokes that seat's entitlements and withdraws active enrolments. History is kept. */
  releaseSeat(ctx: AuthzContext, seatId: string, reason: string, requestId: string | null, now = new Date()): Promise<string> {
    if (!ctx.platform) throw new NotFoundError("seat");
    if (!reason.trim()) throw new RuleViolation("A reason is required to release a seat.", "reason_required");
    return asPrincipal(this.db, ctx, "admin.release-seat", async (trx) => {
      const s = await trx.selectFrom("seat_allocation").selectAll().where("id", "=", seatId).where("state", "=", "allocated").forUpdate().executeTakeFirst();
      if (!s) throw new NotFoundError("seat");
      await trx.updateTable("seat_allocation").set({ state: "released", released_by: ctx.personId, released_at: now, release_reason: reason.trim() }).where("id", "=", seatId).execute();
      const ents = await trx.selectFrom("entitlement").select(["id"]).where("source", "=", `agreement:${s.agreement_id}`).where("person_id", "=", s.person_id).where("status", "=", "active").execute();
      for (const e of ents) {
        await trx.updateTable("entitlement").set({ status: "revoked", updated_at: now }).where("id", "=", e.id).execute();
        await trx.insertInto("entitlement_decision").values({ organisation_id: s.organisation_id, entitlement_id: e.id, input_ref: JSON.stringify({ seat_released: seatId }),
          rule_version: "seat-release/v0 (DEC-32)", before: JSON.stringify({ status: "active" }), after: JSON.stringify({ status: "revoked" }) }).execute();
        const ens = await trx.selectFrom("enrolment").select(["id", "status"]).where("entitlement_id", "=", e.id).where("status", "=", "active").execute();
        for (const en of ens) {
          await trx.updateTable("enrolment").set({ status: "withdrawn", access_end: now }).where("id", "=", en.id).execute();
          await enqueueEvent(trx, this.opts.eventSource, { type: "enrolment.status_changed", aggregate: { type: "enrolment", id: en.id },
            data: { enrolment_id: en.id, old_status: "active", new_status: "withdrawn", access_end: now.toISOString(), reason_code: "seat_released" } });
        }
      }
      await audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "seat.released", entityType: "seat_allocation", entityId: seatId, organisationId: s.organisation_id,
        before: { state: "allocated" }, after: { state: "released", entitlements_revoked: ents.length }, reason: reason.trim(), requestId });
      return s.organisation_id;
    });
  }
}

async function loadAgreements(trx: Trx, orgId: string): Promise<AgreementView[]> {
  const rows = await trx.selectFrom("agreement").selectAll().where("organisation_id", "=", orgId).orderBy("access_end", "desc").execute();
  const out: AgreementView[] = [];
  for (const a of rows) {
    const used = await trx.selectFrom("seat_allocation").select(sql<string>`count(*)`.as("n")).where("agreement_id", "=", a.id).where("state", "=", "allocated").executeTakeFirstOrThrow();
    const courses = await trx.selectFrom("agreement_course as ac").innerJoin("course as c", "c.id", "ac.course_id").select(["c.id", "c.title", "c.tier"]).where("ac.agreement_id", "=", a.id).orderBy("c.title").execute();
    out.push({ id: a.id, reference: a.reference, seatLimit: a.seat_limit, seatsUsed: Number(used.n), accessStart: a.access_start, accessEnd: a.access_end, status: a.status, courses });
  }
  return out;
}

/** RFC 4180 CSV with spreadsheet formula-injection protection (threat T-06). */
export function toCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

