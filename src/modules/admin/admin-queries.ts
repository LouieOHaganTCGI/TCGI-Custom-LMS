import { sql } from "kysely";
import type { ScopedDb } from "../../db/scoped.js";
import { audit, personActor } from "../audit/audit.js";
import { NotFoundError, RuleViolation } from "../authz/authz.js";
import { asPrincipal, type AuthzContext } from "../authz/authz.js";

export interface AuditRow {
  id: string;
  occurredAt: Date;
  actorType: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  organisation: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  entryHash: string;
}

export interface AuditFilter {
  action?: string;
  entityType?: string;
  entityId?: string;
  beforeId?: string;
}

/**
 * Read models for TCGI admin screens. Routes gate them by capability, and the RLS platform scope
 * additionally enforces visibility. Paging is keyset-based (by id), never OFFSET.
 */
export class AdminQueries {
  constructor(private readonly db: ScopedDb) {}

  audit(ctx: AuthzContext, f: AuditFilter, pageSize = 50): Promise<AuditRow[]> {
    return asPrincipal(this.db, ctx, "admin.audit", async (trx) => {
      let q = trx
        .selectFrom("audit_entry as a")
        .leftJoin("organisation as o", "o.id", "a.organisation_id")
        .select(["a.id", "a.occurred_at", "a.actor_type", "a.actor_label", "a.action", "a.entity_type", "a.entity_id", "o.name as org", "a.before", "a.after", "a.reason", "a.entry_hash"])
        .orderBy("a.id", "desc")
        .limit(pageSize);
      if (f.action) q = q.where("a.action", "=", f.action);
      if (f.entityType) q = q.where("a.entity_type", "=", f.entityType);
      if (f.entityId) q = q.where("a.entity_id", "=", f.entityId);
      if (f.beforeId && /^\d+$/.test(f.beforeId)) q = q.where("a.id", "<", f.beforeId);
      const rows = await q.execute();
      return rows.map((r) => ({
        id: r.id, occurredAt: r.occurred_at, actorType: r.actor_type, actorLabel: r.actor_label, action: r.action, entityType: r.entity_type,
        entityId: r.entity_id, organisation: r.org, before: r.before, after: r.after, reason: r.reason, entryHash: r.entry_hash,
      }));
    });
  }

  outbox(ctx: AuthzContext, status?: "pending" | "delivered" | "dead", pageSize = 50) {
    return asPrincipal(this.db, ctx, "admin.outbox", async (trx) => {
      let q = trx
        .selectFrom("outbox_message")
        .select(["id", "seq", "destination", "event_type", "aggregate_type", "aggregate_id", "status", "attempts", "next_attempt_at", "last_error", "created_at", "delivered_at"])
        .orderBy("seq", "desc")
        .limit(pageSize);
      if (status) q = q.where("status", "=", status);
      const msgs = await q.execute();
      const ids = msgs.map((m) => m.id);
      const attempts = ids.length
        ? await trx.selectFrom("delivery_attempt").select(["outbox_id", "attempted_at", "http_status", "outcome", "error", "duration_ms"]).where("outbox_id", "in", ids).orderBy("id").execute()
        : [];
      return msgs.map((m) => ({ ...m, deliveries: attempts.filter((a) => a.outbox_id === m.id) }));
    });
  }

  contentVersions(ctx: AuthzContext) {
    return asPrincipal(this.db, ctx, "admin.content", (trx) =>
      trx
        .selectFrom("content_version as cv")
        .innerJoin("content_item as ci", "ci.id", "cv.content_item_id")
        .select(["cv.id", "ci.stable_key", "cv.version_no", "cv.title", "cv.scorm_version", "cv.scorm_edition", "cv.package_sha256", "cv.launch_href", "cv.file_count", "cv.created_at", "cv.status"])
        .orderBy("cv.created_at", "desc")
        .limit(200)
        .execute(),
    );
  }

  courses(ctx: AuthzContext) {
    return asPrincipal(this.db, ctx, "admin.courses", (trx) =>
      trx
        .selectFrom("course as c")
        .leftJoin("course_revision as r", (j) => j.onRef("r.course_id", "=", "c.id").on("r.state", "=", "published"))
        .select(["c.id", "c.slug", "c.title", "c.tier", "r.revision_no", "r.published_at", "c.cpd_value", "c.cpd_unit"])
        .orderBy("c.created_at", "desc")
        .execute(),
    );
  }

  /** OPS-01: live counts straight from transactional tables (no copy, no staleness). */
  overview(ctx: AuthzContext, now = new Date()) {
    return asPrincipal(this.db, ctx, "admin.overview", async (trx) => {
      const n = async (q: Promise<{ n: string } | undefined>) => Number((await q)?.n ?? 0);
      const in30 = new Date(now.getTime() + 30 * 86_400_000);
      const ago30 = new Date(now.getTime() - 30 * 86_400_000);
      return {
        activeLearners: await n(trx.selectFrom("enrolment").select(sql<string>`count(distinct person_id)`.as("n")).where("status", "=", "active").executeTakeFirst()),
        activeEnrolments: await n(trx.selectFrom("enrolment").select(sql<string>`count(*)`.as("n")).where("status", "=", "active").executeTakeFirst()),
        completions30d: await n(trx.selectFrom("enrolment").select(sql<string>`count(*)`.as("n")).where("completed_at", ">=", ago30).executeTakeFirst()),
        expiring30d: await n(trx.selectFrom("enrolment").select(sql<string>`count(*)`.as("n")).where("status", "=", "active").where("access_end", ">", now).where("access_end", "<=", in30).executeTakeFirst()),
        outboxDead: await n(trx.selectFrom("outbox_message").select(sql<string>`count(*)`.as("n")).where("status", "=", "dead").executeTakeFirst()),
        outboxPending: await n(trx.selectFrom("outbox_message").select(sql<string>`count(*)`.as("n")).where("status", "=", "pending").executeTakeFirst()),
        inboundHeld: await n(trx.selectFrom("integration_event").select(sql<string>`count(*)`.as("n")).where("status", "=", "held").executeTakeFirst()),
        organisations: await n(trx.selectFrom("organisation").select(sql<string>`count(*)`.as("n")).where("kind", "=", "enterprise").executeTakeFirst()),
        generatedAt: now,
      };
    });
  }

  inboundEvents(ctx: AuthzContext, status?: "received" | "processed" | "held", pageSize = 100) {
    return asPrincipal(this.db, ctx, "admin.inbound", async (trx) => {
      let q = trx.selectFrom("integration_event as e").leftJoin("entitlement as en", "en.id", "e.entitlement_id").leftJoin("person as p", "p.id", "en.person_id").leftJoin("course as c", "c.id", "en.course_id")
        .select(["e.id", "e.source", "e.event_type", "e.aggregate_id", "e.effective_at", "e.source_sequence", "e.received_at", "e.status", "e.status_reason", "e.processed_at", "e.payload",
          "en.id as entitlement_id", "en.status as entitlement_status", "en.valid_until", "p.display_name as learner", "c.title as course"])
        .orderBy("e.received_at", "desc").limit(pageSize);
      if (status) q = q.where("e.status", "=", status);
      return q.execute();
    });
  }

  async inboundEvent(ctx: AuthzContext, id: string): Promise<{ source: string; aggregate_id: string }> {
    const r = await asPrincipal(this.db, ctx, "admin.inbound-one", (trx) => trx.selectFrom("integration_event").select(["source", "aggregate_id"]).where("id", "=", id).executeTakeFirst());
    if (!r) throw new NotFoundError("event");
    return r;
  }

  entitlementHistory(ctx: AuthzContext, entitlementId: string) {
    return asPrincipal(this.db, ctx, "admin.entitlement-history", (trx) =>
      trx.selectFrom("entitlement_decision").select(["id", "rule_version", "before", "after", "input_ref", "decided_at"]).where("entitlement_id", "=", entitlementId).orderBy("id").execute(),
    );
  }

  mappings(ctx: AuthzContext) {
    return asPrincipal(this.db, ctx, "admin.mappings", async (trx) => ({
      mappings: await trx.selectFrom("commercial_product_reference as m").innerJoin("course as c", "c.id", "m.course_id")
        .select(["m.id", "m.source", "m.external_product_id", "m.active", "m.created_at", "c.title"]).orderBy("m.created_at", "desc").execute(),
      courses: await trx.selectFrom("course").select(["id", "title"]).orderBy("title").execute(),
    }));
  }

  createMapping(ctx: AuthzContext, input: { source: string; externalProductId: string; courseId: string }, requestId: string | null) {
    if (!ctx.platform) throw new NotFoundError("mapping");
    if (!/^[a-z0-9-]+:[a-z0-9-]+$/.test(input.source) || !input.externalProductId.trim()) throw new RuleViolation("Enter a source (for example woocommerce:tcgi-store-staging) and a product ID.", "invalid_mapping");
    return asPrincipal(this.db, ctx, "admin.mapping-create", async (trx) => {
      const exists = await trx.selectFrom("commercial_product_reference").select("id").where("source", "=", input.source).where("external_product_id", "=", input.externalProductId.trim()).executeTakeFirst();
      if (exists) throw new RuleViolation("That product is already mapped for this source.", "mapping_exists");
      const m = await trx.insertInto("commercial_product_reference").values({ source: input.source, external_product_id: input.externalProductId.trim(), course_id: input.courseId }).returning("id").executeTakeFirstOrThrow();
      await audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "product_mapping.created", entityType: "commercial_product_reference", entityId: m.id, after: input, requestId });
    });
  }
}
