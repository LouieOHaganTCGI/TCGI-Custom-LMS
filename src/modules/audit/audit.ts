import type { Trx } from "../../db/scoped.js";

export type Actor =
  | { type: "person"; personId: string; label: string }
  | { type: "system"; label: string }
  | { type: "service"; label: string };

export interface AuditInput {
  actor: Actor;
  action: string;
  entityType: string;
  entityId: string;
  organisationId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId?: string | null;
}

/**
 * Append an audit entry in the caller's transaction, so the audit record commits or rolls back together
 * with the change it describes. The hash chain is computed by a DB trigger. Rows can't be updated or deleted.
 * Don't put secrets or tokens in before/after.
 */
export async function audit(trx: Trx, e: AuditInput): Promise<void> {
  await trx
    .insertInto("audit_entry")
    .values({
      actor_type: e.actor.type,
      actor_person_id: e.actor.type === "person" ? e.actor.personId : null,
      actor_label: e.actor.label,
      organisation_id: e.organisationId ?? null,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId,
      before: e.before === undefined ? null : JSON.stringify(e.before),
      after: e.after === undefined ? null : JSON.stringify(e.after),
      reason: e.reason ?? null,
      request_id: e.requestId ?? null,
    })
    .execute();
}

export function personActor(personId: string, label: string): Actor {
  return { type: "person", personId, label };
}
