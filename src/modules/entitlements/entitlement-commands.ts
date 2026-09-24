import type { ScopedDb } from "../../db/scoped.js";
import { audit, type Actor } from "../audit/audit.js";
import { RuleViolation } from "../authz/authz.js";

export interface GrantEntitlementCommand {
  /** A trusted source identifier, for example "phase-b-fixture" now, or "woocommerce:tcgi-store-staging" in S4. */
  source: string;
  externalOrderId: string;
  externalLineId: string;
  personId: string;
  /** The licensing context. Always decided server-side from the trusted source, never from a browser. */
  organisationId: string;
  courseId: string;
  grantType: "commerce_line" | "seat" | "manual";
  validFrom: Date;
  validUntil: Date | null;
  reason: string;
}

export interface GrantResult {
  entitlementId: string;
  outcome: "created" | "no_change";
}

/**
 * The single write path for granting access (INT-01/02). Phase B calls it from a fixture. S4's signed-event
 * handler will call it after verification and derivation (ADR-0006). It's idempotent on
 * (source, order, line). A repeat with identical terms is a no-op. Conflicting terms are refused here, and
 * S4 will re-derive them from the ordered event log.
 */
export class EntitlementCommands {
  constructor(private readonly db: ScopedDb) {}

  async grant(cmd: GrantEntitlementCommand, actor: Actor, requestId: string | null = null): Promise<GrantResult> {
    if (cmd.validUntil && cmd.validUntil <= cmd.validFrom) throw new RuleViolation("validUntil must be after validFrom", "bad_window");
    return this.db.withSystem("entitlement-command", async (trx) => {
      const existing = await trx
        .selectFrom("entitlement")
        .selectAll()
        .where("source", "=", cmd.source)
        .where("external_order_id", "=", cmd.externalOrderId)
        .where("external_line_id", "=", cmd.externalLineId)
        .forUpdate()
        .executeTakeFirst();
      const terms = {
        person_id: cmd.personId,
        organisation_id: cmd.organisationId,
        course_id: cmd.courseId,
        grant_type: cmd.grantType,
        status: "active" as const,
        valid_from: cmd.validFrom.toISOString(),
        valid_until: cmd.validUntil?.toISOString() ?? null,
      };
      if (existing) {
        const same =
          existing.person_id === terms.person_id && existing.organisation_id === terms.organisation_id && existing.course_id === terms.course_id &&
          existing.grant_type === terms.grant_type && existing.status === "active" && existing.valid_from.toISOString() === terms.valid_from &&
          (existing.valid_until?.toISOString() ?? null) === terms.valid_until;
        if (same) return { entitlementId: existing.id, outcome: "no_change" as const };
        throw new RuleViolation("conflicting grant for an existing order line; changes must arrive as events (S4)", "conflicting_grant");
      }
      const membership = await trx
        .selectFrom("organisation_membership")
        .select("id")
        .where("organisation_id", "=", cmd.organisationId)
        .where("person_id", "=", cmd.personId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!membership) throw new RuleViolation("person is not an active member of the licensing organisation", "not_member");

      const ent = await trx
        .insertInto("entitlement")
        .values({
          ...terms,
          source: cmd.source,
          external_order_id: cmd.externalOrderId,
          external_line_id: cmd.externalLineId,
          updated_at: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("entitlement_decision")
        .values({
          organisation_id: cmd.organisationId,
          entitlement_id: ent.id,
          input_ref: JSON.stringify({ source: cmd.source, order: cmd.externalOrderId, line: cmd.externalLineId, reason: cmd.reason }),
          rule_version: "grant/v0-fixture",
          before: null,
          after: JSON.stringify(terms),
        })
        .execute();
      await audit(trx, {
        actor,
        action: "entitlement.granted",
        entityType: "entitlement",
        entityId: ent.id,
        organisationId: cmd.organisationId,
        after: { ...terms, source: cmd.source },
        reason: cmd.reason,
        requestId,
      });
      return { entitlementId: ent.id, outcome: "created" as const };
    });
  }
}
