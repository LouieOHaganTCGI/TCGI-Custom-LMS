import type { ScopedDb } from "../../db/scoped.js";
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
        .select(["c.id", "c.slug", "c.title", "c.tier", "r.revision_no", "r.published_at"])
        .orderBy("c.created_at", "desc")
        .execute(),
    );
  }
}
