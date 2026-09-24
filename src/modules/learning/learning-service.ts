import { sql } from "kysely";
import type { ScopedDb, Trx } from "../../db/scoped.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import { audit, personActor } from "../audit/audit.js";
import { asPrincipal, NotFoundError, RuleViolation, type AuthzContext } from "../authz/authz.js";
import { enqueueEvent } from "../integration/outbox.js";
import { normalise, resumeState, SUSPEND_DATA_LIMIT, type NormalisedCmi } from "./cmi.js";
import { issueLaunchToken, LAUNCH_CODE_TTL_SECONDS, LAUNCH_TOKEN_TTL_SECONDS, type LaunchClaims } from "./launch-token.js";

export interface PlacementView {
  placementId: string;
  position: number;
  title: string;
  required: boolean;
  scormVersion: "1.2" | "2004";
  completion: string;
  success: string;
  scoreRaw: string | null;
  firstCompletedAt: Date | null;
  started: boolean;
}

export interface EnrolmentView {
  enrolmentId: string;
  courseTitle: string;
  courseTier: string;
  status: string;
  accessEnd: Date | null;
  completedAt: Date | null;
  revisionNo: number;
  organisationName: string;
  placements: PlacementView[];
}

export interface AttemptContext {
  attemptId: string;
  personId: string;
  displayName: string;
  organisationId: string;
  enrolmentId: string;
  placementId: string;
  scormVersion: "1.2" | "2004";
  packageSha256: string;
  launchHref: string;
  placementTitle: string;
}

/**
 * The learner's side of course delivery: viewing an enrolment, launching a placement, and the SCORM runtime
 * persistence (LRN-01). Raw commits are appended untouched. ProgressState is derived from them.
 */
export class LearningService {
  constructor(
    private readonly db: ScopedDb,
    private readonly opts: { launchTokenSecret: string; contentBaseUrl: string; eventSource: string },
  ) {}

  getEnrolment(ctx: AuthzContext, enrolmentId: string): Promise<EnrolmentView> {
    return asPrincipal(this.db, ctx, "learning.view-enrolment", async (trx) => {
      // Explicit person filter in addition to RLS: even platform admins see only their own learning here.
      const en = await trx
        .selectFrom("enrolment as en")
        .innerJoin("course as c", "c.id", "en.course_id")
        .innerJoin("course_revision as r", "r.id", "en.course_revision_id")
        .innerJoin("organisation as o", "o.id", "en.organisation_id")
        .select(["en.id", "en.status", "en.access_end", "en.completed_at", "en.course_revision_id", "c.title", "c.tier", "r.revision_no", "o.name as org_name"])
        .where("en.id", "=", enrolmentId)
        .where("en.person_id", "=", ctx.personId)
        .executeTakeFirst();
      if (!en) throw new NotFoundError("enrolment");
      const placements = await trx
        .selectFrom("course_placement as p")
        .innerJoin("content_version as cv", "cv.id", "p.content_version_id")
        .leftJoin("attempt as a", (j) => j.onRef("a.placement_id", "=", "p.id").on("a.enrolment_id", "=", enrolmentId))
        .leftJoin("progress_state as ps", "ps.attempt_id", "a.id")
        .select(["p.id", "p.position", "p.title", "p.required", "cv.scorm_version", "ps.completion_status", "ps.success_status", "ps.score_raw",
          "ps.first_completed_at", "a.id as attempt_id"])
        .where("p.course_revision_id", "=", en.course_revision_id)
        .orderBy("p.position")
        .orderBy("a.attempt_no", "desc")
        .execute();
      const seen = new Set<string>();
      const views: PlacementView[] = [];
      for (const p of placements) {
        if (seen.has(p.id)) continue; // keep the latest attempt per placement
        seen.add(p.id);
        views.push({
          placementId: p.id, position: p.position, title: p.title, required: p.required, scormVersion: p.scorm_version,
          completion: p.completion_status ?? "not_attempted", success: p.success_status ?? "unknown", scoreRaw: p.score_raw ?? null,
          firstCompletedAt: p.first_completed_at ?? null, started: p.attempt_id !== null,
        });
      }
      return {
        enrolmentId: en.id, courseTitle: en.title, courseTier: en.tier, status: en.status, accessEnd: en.access_end, completedAt: en.completed_at,
        revisionNo: en.revision_no, organisationName: en.org_name, placements: views,
      };
    });
  }

  /**
   * Launch a placement. It reuses the latest attempt (resume). Relaunch-after-completion policy is
   * PROVISIONAL (DEC-16, test R7). It returns a one-time launch code URL on the content origin. The
   * code is single-use, valid for 60 s, and swapped server-side for an attempt-scoped token.
   */
  launch(ctx: AuthzContext, enrolmentId: string, placementId: string, requestId: string | null = null, now = new Date()): Promise<{ launchUrl: string; attemptId: string }> {
    return asPrincipal(this.db, ctx, "learning.launch", async (trx) => {
      const en = await trx
        .selectFrom("enrolment")
        .select(["id", "organisation_id", "course_revision_id", "status", "access_end"])
        .where("id", "=", enrolmentId)
        .where("person_id", "=", ctx.personId)
        .executeTakeFirst();
      if (!en) throw new NotFoundError("enrolment");
      assertAccessOpen(en, now);
      const pl = await trx
        .selectFrom("course_placement as p")
        .innerJoin("content_version as cv", "cv.id", "p.content_version_id")
        .select(["p.id", "p.content_version_id", "cv.runtime_provider", "cv.status"])
        .where("p.id", "=", placementId)
        .where("p.course_revision_id", "=", en.course_revision_id)
        .executeTakeFirst();
      if (!pl) throw new NotFoundError("placement");

      let attempt = await trx
        .selectFrom("attempt").select(["id", "attempt_no"])
        .where("enrolment_id", "=", en.id).where("placement_id", "=", pl.id)
        .orderBy("attempt_no", "desc")
        .executeTakeFirst();
      if (!attempt) {
        attempt = await trx
          .insertInto("attempt")
          .values({
            organisation_id: en.organisation_id, enrolment_id: en.id, person_id: ctx.personId, placement_id: pl.id,
            content_version_id: pl.content_version_id, attempt_no: 1, runtime_provider: pl.runtime_provider,
          })
          .returning(["id", "attempt_no"])
          .executeTakeFirstOrThrow();
        await trx.insertInto("progress_state").values({ attempt_id: attempt.id, organisation_id: en.organisation_id, person_id: ctx.personId, updated_at: now }).execute();
      }
      const code = randomToken(32);
      await trx
        .insertInto("launch_code")
        .values({ code_hash: sha256Hex(code), attempt_id: attempt.id, person_id: ctx.personId, expires_at: new Date(now.getTime() + LAUNCH_CODE_TTL_SECONDS * 1000) })
        .execute();
      await audit(trx, {
        actor: personActor(ctx.personId, ctx.displayName), action: "attempt.launched", entityType: "attempt", entityId: attempt.id,
        organisationId: en.organisation_id, after: { enrolment_id: en.id, placement_id: pl.id, attempt_no: attempt.attempt_no }, requestId,
      });
      const url = new URL(`/launch`, this.opts.contentBaseUrl);
      url.searchParams.set("code", code);
      return { launchUrl: url.href, attemptId: attempt.id };
    });
  }

  /** Content origin: swap a one-time launch code for an attempt-scoped token. */
  async exchangeLaunchCode(code: string | undefined, now = new Date()): Promise<{ token: string; attemptId: string } | null> {
    if (!code || code.length > 128) return null;
    const row = await this.db.withSystem("launch-exchange", (trx) =>
      trx
        .updateTable("launch_code")
        .set({ used_at: now })
        .where("code_hash", "=", sha256Hex(code))
        .where("used_at", "is", null)
        .where("expires_at", ">", now)
        .returning(["attempt_id", "person_id"])
        .executeTakeFirst(),
    );
    if (!row) return null;
    const iat = Math.floor(now.getTime() / 1000);
    const token = issueLaunchToken(this.opts.launchTokenSecret, { att: row.attempt_id, per: row.person_id, iat, exp: iat + LAUNCH_TOKEN_TTL_SECONDS });
    return { token, attemptId: row.attempt_id };
  }

  /** Load and re-validate the attempt behind a verified token. It runs as the token's person (RLS applies). */
  async attemptContext(claims: LaunchClaims, now = new Date()): Promise<AttemptContext | null> {
    return this.db.withPerson(claims.per, "runtime.context", async (trx) => loadAttempt(trx, claims, now));
  }

  async resumeCmi(claims: LaunchClaims): Promise<Record<string, unknown> | null> {
    return this.db.withPerson(claims.per, "runtime.state", async (trx) => {
      const a = await loadAttempt(trx, claims, new Date());
      if (!a) return null;
      const p = await trx
        .selectFrom("progress_state")
        .select(["completion_status", "success_status", "score_raw", "score_min", "score_max", "score_scaled", "location", "suspend_data", "exit_mode"])
        .where("attempt_id", "=", a.attemptId)
        .executeTakeFirst();
      const hasState = p && (p.suspend_data !== null || p.location !== null || p.completion_status !== "not_attempted");
      // The learner id given to content is the opaque LMS person id: no email or other PII (threat T-14).
      return resumeState(a.scormVersion, hasState ? p : null, { id: a.personId, name: a.displayName });
    });
  }

  /**
   * Persist a runtime commit: append the raw payload, then update the derived state. It returns whether
   * this commit completed the course.
   */
  async commit(claims: LaunchClaims, payload: unknown, now = new Date()): Promise<{ seq: number; courseCompleted: boolean }> {
    return this.db.withPerson(claims.per, "runtime.commit", async (trx) => {
      const a = await loadAttempt(trx, claims, now);
      if (!a) throw new NotFoundError("attempt");
      const n: NormalisedCmi = normalise(a.scormVersion, payload);
      if (n.suspendData !== undefined && n.suspendData.length > SUSPEND_DATA_LIMIT[a.scormVersion]) {
        throw new RuleViolation(`suspend_data exceeds the SCORM ${a.scormVersion} limit`, "suspend_data_too_large");
      }
      const raw = JSON.stringify(payload ?? {});
      // Serialise commits per attempt, so seq is gap-free and derived state follows commit order.
      const locked = await trx.selectFrom("progress_state").selectAll().where("attempt_id", "=", a.attemptId).forUpdate().executeTakeFirstOrThrow();
      const seq = locked.last_commit_seq + 1;
      await trx
        .insertInto("runtime_commit")
        .values({ organisation_id: a.organisationId, attempt_id: a.attemptId, person_id: a.personId, seq, payload: raw, payload_sha256: sha256Hex(raw) })
        .execute();

      const becameComplete = locked.first_completed_at === null && n.completion === "completed";
      await trx
        .updateTable("progress_state")
        .set({
          ...(n.completion !== undefined ? { completion_status: n.completion } : {}),
          ...(n.success !== undefined ? { success_status: n.success } : {}),
          ...(n.scoreRaw !== undefined ? { score_raw: n.scoreRaw } : {}),
          ...(n.scoreMin !== undefined ? { score_min: n.scoreMin } : {}),
          ...(n.scoreMax !== undefined ? { score_max: n.scoreMax } : {}),
          ...(n.scoreScaled !== undefined ? { score_scaled: n.scoreScaled } : {}),
          ...(n.location !== undefined ? { location: n.location } : {}),
          ...(n.suspendData !== undefined ? { suspend_data: n.suspendData } : {}),
          ...(n.exit !== undefined ? { exit_mode: n.exit } : {}),
          ...(n.totalTime !== undefined ? { total_time: n.totalTime } : {}),
          ...(becameComplete ? { first_completed_at: now } : {}),
          last_commit_seq: seq,
          updated_at: now,
        })
        .where("attempt_id", "=", a.attemptId)
        .execute();
      await trx.updateTable("attempt").set({ last_commit_at: now }).where("id", "=", a.attemptId).execute();

      let courseCompleted = false;
      if (becameComplete) {
        await audit(trx, {
          actor: personActor(a.personId, a.displayName), action: "progress.placement_completed", entityType: "attempt", entityId: a.attemptId,
          organisationId: a.organisationId, after: { placement_id: a.placementId, success: n.success ?? locked.success_status, score_raw: n.scoreRaw ?? null, source: "client_reported" },
        });
        courseCompleted = await this.evaluateCourseCompletion(trx, a, now);
      }
      return { seq, courseCompleted };
    });
  }

  /** Completion rule "all-required-placements-completed/v0-provisional" (DEC-19). Idempotent. */
  private async evaluateCourseCompletion(trx: Trx, a: AttemptContext, now: Date): Promise<boolean> {
    const en = await trx
      .selectFrom("enrolment as en").innerJoin("course_revision as r", "r.id", "en.course_revision_id")
      .select(["en.id", "en.status", "en.course_revision_id", "en.completion_rule_ref"])
      .where("en.id", "=", a.enrolmentId).forUpdate("en")
      .executeTakeFirstOrThrow();
    if (en.status !== "active") return false;
    const remaining = await trx
      .selectFrom("course_placement as p")
      .select(sql<string>`count(*)`.as("n"))
      .where("p.course_revision_id", "=", en.course_revision_id)
      .where("p.required", "=", true)
      .where((eb) =>
        eb.not(eb.exists(
          eb.selectFrom("attempt as at").innerJoin("progress_state as ps", "ps.attempt_id", "at.id").select("at.id")
            .whereRef("at.placement_id", "=", "p.id").where("at.enrolment_id", "=", en.id).where("ps.first_completed_at", "is not", null),
        )),
      )
      .executeTakeFirstOrThrow();
    if (Number(remaining.n) > 0) return false;
    await trx.updateTable("enrolment").set({ status: "completed", completed_at: now }).where("id", "=", en.id).where("status", "=", "active").execute();

    // LRN-05: CPD is awarded once per completion (unique on the source), using the course's value at award
    // time. Awarding on course completion follows spec §3.3 and is PROVISIONAL pending DEC-22.
    const course = await trx.selectFrom("enrolment as e").innerJoin("course as c", "c.id", "e.course_id").select(["c.id", "c.cpd_value", "c.cpd_unit"]).where("e.id", "=", en.id).executeTakeFirstOrThrow();
    let cpd: { amount: number; unit: string } | undefined;
    if (course.cpd_value !== null && course.cpd_unit) {
      const award = await trx.insertInto("cpd_award").values({
        organisation_id: a.organisationId, person_id: a.personId, enrolment_id: en.id, course_id: course.id, value: course.cpd_value, unit: course.cpd_unit,
        source_type: "course_completion", source_id: en.id,
      }).onConflict((c) => c.columns(["source_type", "source_id"]).doNothing()).returning(["id", "value", "unit"]).executeTakeFirst();
      if (award) {
        cpd = { amount: Number(award.value), unit: award.unit };
        await audit(trx, { actor: personActor(a.personId, a.displayName), action: "cpd.awarded", entityType: "cpd_award", entityId: award.id, organisationId: a.organisationId,
          after: { enrolment_id: en.id, value: award.value, unit: award.unit, rule: "on-course-completion/v0 (DEC-22)" } });
      }
    }
    await enqueueEvent(trx, this.opts.eventSource, {
      type: "course.completed",
      aggregate: { type: "enrolment", id: en.id },
      occurredAt: now,
      data: { enrolment_id: en.id, completed_at: now.toISOString(), completion_rule_version: en.completion_rule_ref, ...(cpd ? { cpd_awarded: cpd } : {}) },
    });
    await audit(trx, {
      actor: personActor(a.personId, a.displayName), action: "enrolment.completed", entityType: "enrolment", entityId: en.id,
      organisationId: a.organisationId, before: { status: "active" }, after: { status: "completed", completion_rule: en.completion_rule_ref },
    });
    return true;
  }
}

function assertAccessOpen(en: { status: string; access_end: Date | null }, now: Date): void {
  if (en.status !== "active" && en.status !== "completed") throw new RuleViolation("this enrolment is not active", "enrolment_inactive");
  if (en.access_end && en.access_end <= now) throw new RuleViolation("access to this course has ended", "access_ended");
}

async function loadAttempt(trx: Trx, claims: LaunchClaims, now: Date): Promise<AttemptContext | null> {
  const a = await trx
    .selectFrom("attempt as a")
    .innerJoin("enrolment as en", "en.id", "a.enrolment_id")
    .innerJoin("content_version as cv", "cv.id", "a.content_version_id")
    .innerJoin("person as p", "p.id", "a.person_id")
    .innerJoin("course_placement as pl", "pl.id", "a.placement_id")
    .select(["pl.title as placement_title", "a.id", "a.person_id", "a.organisation_id", "a.enrolment_id", "a.placement_id", "cv.scorm_version", "cv.package_sha256", "cv.launch_href",
      "en.status", "en.access_end", "p.display_name", "p.status as person_status", "p.launch_tokens_valid_after"])
    .where("a.id", "=", claims.att)
    .where("a.person_id", "=", claims.per)
    .executeTakeFirst();
  if (!a || a.person_status !== "active") return null;
  // Revoked by sign-out or deactivation: tokens issued before that moment (whole seconds) are dead.
  if (a.launch_tokens_valid_after && claims.iat <= Math.floor(a.launch_tokens_valid_after.getTime() / 1000)) return null;
  try {
    assertAccessOpen(a, now);
  } catch {
    return null;
  }
  return {
    attemptId: a.id, personId: a.person_id, displayName: a.display_name, organisationId: a.organisation_id, enrolmentId: a.enrolment_id,
    placementId: a.placement_id, scormVersion: a.scorm_version, packageSha256: a.package_sha256, launchHref: a.launch_href,
    placementTitle: a.placement_title,
  };
}
