import { randomUUID } from "node:crypto";
import type { Trx } from "../../db/scoped.js";

/** The outbound envelope, per docs/contracts/envelope.v1.schema.json. */
export interface EventEnvelope<T = Record<string, unknown>> {
  spec: "tcgi.lms.event/1";
  id: string;
  type: string;
  schema_version: string;
  source: string;
  idempotency_key: string;
  occurred_at: string;
  effective_at: string;
  aggregate: { type: string; id: string };
  data: T;
}

export interface EnqueueInput<T> {
  type: string;
  aggregate: { type: string; id: string };
  data: T;
  occurredAt?: Date;
  effectiveAt?: Date;
}

export const DESTINATIONS = ["hubspot"] as const;
export type Destination = (typeof DESTINATIONS)[number];

/**
 * Transactional outbox (ADR-0006). Call inside the same transaction as the domain change, so either
 * both commit or neither does. One row per destination.
 */
export async function enqueueEvent<T extends Record<string, unknown>>(
  trx: Trx,
  sourceLabel: string,
  input: EnqueueInput<T>,
  destinations: readonly Destination[] = DESTINATIONS,
): Promise<EventEnvelope<T>[]> {
  const out: EventEnvelope<T>[] = [];
  for (const destination of destinations) {
    const id = randomUUID();
    const occurred = (input.occurredAt ?? new Date()).toISOString();
    const env: EventEnvelope<T> = {
      spec: "tcgi.lms.event/1",
      id,
      type: input.type,
      schema_version: "1.0",
      source: sourceLabel,
      idempotency_key: id,
      occurred_at: occurred,
      effective_at: (input.effectiveAt ?? input.occurredAt ?? new Date()).toISOString(),
      aggregate: input.aggregate,
      data: input.data,
    };
    await trx
      .insertInto("outbox_message")
      .values({
        id,
        destination,
        event_type: input.type,
        aggregate_type: input.aggregate.type,
        aggregate_id: input.aggregate.id,
        payload: JSON.stringify(env),
        next_attempt_at: new Date(),
      })
      .execute();
    out.push(env);
  }
  return out;
}
