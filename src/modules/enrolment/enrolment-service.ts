import { sql } from "kysely";
import type { ScopedDb } from "../../db/scoped.js";
import { audit, personActor } from "../audit/audit.js";
import { asPrincipal, NotFoundError, RuleViolation, type AuthzContext } from "../authz/authz.js";
import { enqueueEvent } from "../integration/outbox.js";

export interface EligibleCourse {
  courseId: string;
  slug: string;
  title: string;
  tier: string;
  accessEnd: Date | null;
}

export interface EnrolmentSummary {
  enrolmentId: string;
  courseId: string;
  courseTitle: string;
  tier: string;
  status: string;
  accessEnd: Date | null;
  completedAt: Date | null;
  placementsTotal: number;
  placementsCompleted: number;
  organisationName: string;
}

/**
 * Enrolment (brief §6: identity ≠ entitlement ≠ enrolment). An enrolment needs an active, in-window
 * entitlement owned by the same person. The licensing organisation comes from the entitlement, never from
 * the request. It pins the course revision that is published at enrolment time (CAT-05).
 */
export class EnrolmentService {
  constructor(
    private readonly db: ScopedDb,
    private readonly eventSource: string,
  ) {}

  listEligible(ctx: AuthzContext, now = new Date()): Promise<EligibleCourse[]> {
    return asPrincipal(this.db, ctx, "enrolment.list-eligible", async (trx) => {
      const rows = await trx
        .selectFrom("entitlement as e")
        .innerJoin("course as c", "c.id", "e.course_id")
        .select(["c.id as courseId", "c.slug", "c.title", "c.tier", "e.valid_until as accessEnd"])
        .where("e.person_id", "=", ctx.personId)
        .where("e.status", "=", "active")
        .where("e.valid_from", "<=", now)
        .where((eb) => eb.or([eb("e.valid_until", "is", null), eb("e.valid_until", ">", now)]))
        .where((eb) =>
          eb.not(
            eb.exists(
              eb.selectFrom("enrolment as en").select("en.id").whereRef("en.course_id", "=", "e.course_id").where("en.person_id", "=", ctx.personId)
                .whereRef("en.organisation_id", "=", "e.organisation_id").where("en.status", "in", ["active", "completed"]),
            ),
          ),
        )
        .orderBy("c.title")
        .execute();
      return rows;
    });
  }

  listMine(ctx: AuthzContext): Promise<EnrolmentSummary[]> {
    return asPrincipal(this.db, ctx, "enrolment.list-mine", async (trx) => {
      const rows = await trx
        .selectFrom("enrolment as en")
        .innerJoin("course as c", "c.id", "en.course_id")
        .innerJoin("organisation as o", "o.id", "en.organisation_id")
        .select((eb) => [
          "en.id as enrolmentId", "c.id as courseId", "c.title as courseTitle", "c.tier", "en.status", "en.access_end as accessEnd",
          "en.completed_at as completedAt", "o.name as organisationName",
          eb.selectFrom("course_placement as p").select(sql<string>`count(*)`.as("n")).whereRef("p.course_revision_id", "=", "en.course_revision_id").where("p.required", "=", true).as("placementsTotal"),
          eb
            .selectFrom("course_placement as p")
            .select(sql<string>`count(*)`.as("n"))
            .whereRef("p.course_revision_id", "=", "en.course_revision_id")
            .where("p.required", "=", true)
            .where((w) =>
              w.exists(
                w.selectFrom("attempt as a").innerJoin("progress_state as ps", "ps.attempt_id", "a.id").select("a.id")
                  .whereRef("a.enrolment_id", "=", "en.id").whereRef("a.placement_id", "=", "p.id").where("ps.first_completed_at", "is not", null),
              ),
            )
            .as("placementsCompleted"),
        ])
        .where("en.person_id", "=", ctx.personId)
        .orderBy("en.enrolled_at", "desc")
        .execute();
      return rows.map((r) => ({ ...r, placementsTotal: Number(r.placementsTotal ?? 0), placementsCompleted: Number(r.placementsCompleted ?? 0) }));
    });
  }

  /**
   * Enrol the principal in a course they're entitled to. Idempotent: it returns the existing live
   * enrolment. Concurrent requests race on the enrolment_one_live_per_course unique index. The loser
   * retries once and finds the winner's enrolment.
   */
  async enrol(ctx: AuthzContext, courseId: string, requestId: string | null = null, now = new Date()): Promise<{ enrolmentId: string; created: boolean }> {
    try {
      return await this.enrolOnce(ctx, courseId, requestId, now);
    } catch (e) {
      if ((e as { code?: string; constraint?: string }).code === "23505" && (e as { constraint?: string }).constraint === "enrolment_one_live_per_course") {
        return this.enrolOnce(ctx, courseId, requestId, now);
      }
      throw e;
    }
  }

  private enrolOnce(ctx: AuthzContext, courseId: string, requestId: string | null, now: Date): Promise<{ enrolmentId: string; created: boolean }> {
    return asPrincipal(this.db, ctx, "enrolment.enrol", async (trx) => {
      const ent = await trx
        .selectFrom("entitlement")
        .select(["id", "organisation_id", "valid_from", "valid_until", "grant_type"])
        .where("person_id", "=", ctx.personId)
        .where("course_id", "=", courseId)
        .where("status", "=", "active")
        .where("valid_from", "<=", now)
        .where((eb) => eb.or([eb("valid_until", "is", null), eb("valid_until", ">", now)]))
        .orderBy("valid_until", "desc")
        .executeTakeFirst();
      if (!ent) throw new NotFoundError("course"); // not entitled looks the same as not existing

      const live = await trx
        .selectFrom("enrolment").select("id")
        .where("person_id", "=", ctx.personId).where("course_id", "=", courseId).where("organisation_id", "=", ent.organisation_id)
        .where("status", "in", ["active", "completed"])
        .executeTakeFirst();
      if (live) return { enrolmentId: live.id, created: false };

      const rev = await trx
        .selectFrom("course_revision as r").innerJoin("course as c", "c.id", "r.course_id")
        .select(["r.id", "r.revision_no", "r.completion_rule_ref", "c.slug"])
        .where("r.course_id", "=", courseId).where("r.state", "=", "published")
        .orderBy("r.revision_no", "desc")
        .executeTakeFirst();
      if (!rev) throw new RuleViolation("course has no published revision", "not_published");
      const org = await trx.selectFrom("organisation").select("slug").where("id", "=", ent.organisation_id).executeTakeFirstOrThrow();

      const en = await trx
        .insertInto("enrolment")
        .values({
          organisation_id: ent.organisation_id,
          person_id: ctx.personId,
          course_id: courseId,
          course_revision_id: rev.id,
          entitlement_id: ent.id,
          access_start: now,
          access_end: ent.valid_until,
          completion_rule_ref: rev.completion_rule_ref,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await enqueueEvent(trx, this.eventSource, {
        type: "enrolment.created",
        aggregate: { type: "enrolment", id: en.id },
        occurredAt: now,
        data: {
          enrolment_id: en.id,
          person_ref: { person_id: ctx.personId },
          organisation_ref: org.slug,
          course_ref: rev.slug,
          course_revision: rev.revision_no,
          access_start: now.toISOString(),
          access_end: ent.valid_until?.toISOString() ?? null,
          justification_type: ent.grant_type === "commerce_line" ? "commerce_line" : ent.grant_type === "seat" ? "seat" : "manual",
        },
      });
      await audit(trx, {
        actor: personActor(ctx.personId, ctx.displayName),
        action: "enrolment.created",
        entityType: "enrolment",
        entityId: en.id,
        organisationId: ent.organisation_id,
        after: { course_id: courseId, course_revision_id: rev.id, entitlement_id: ent.id, access_end: ent.valid_until },
        requestId,
      });
      return { enrolmentId: en.id, created: true };
    });
  }
}
