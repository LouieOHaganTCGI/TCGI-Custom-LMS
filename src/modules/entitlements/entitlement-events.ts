import { promises as fs } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { sql } from "kysely";
import type { ScopedDb, Trx } from "../../db/scoped.js";
import { sha256Hex, verifyEventSignature } from "../../lib/crypto.js";
import { audit, type Actor } from "../audit/audit.js";
import { enqueueEvent } from "../integration/outbox.js";
import { foldEntitlement, FOLD_RULE_VERSION, type FoldAction, type FoldEvent, type FoldState } from "./fold.js";

/** Signing keys per inbound source, from the secrets manager / env (never the database). */
export type InboundSources = Record<string, { keys: Record<string, string> }>;

export interface IngestResult {
  status: 200 | 202 | 401 | 409 | 422;
  body: Record<string, unknown>;
}

const CONTRACTS_DIR = new URL("../../../docs/contracts/", import.meta.url);

type EntitlementEnvelope = {
  id: string; type: string; schema_version: string; source: string; idempotency_key: string; occurred_at: string; effective_at: string;
  aggregate: { type: string; id: string }; source_sequence?: number;
  data: {
    external_order_id: string; external_line_id: string; action: FoldAction; effective_at: string; access_end?: string | null; quantity?: number; reason_code?: string;
    learner: { idp_issuer?: string; idp_subject?: string; commerce_customer_id: string; email: string };
    product: { external_product_id: string; external_variant_id?: string };
  };
};

/**
 * INT-01/02: signed, versioned entitlement events from existing commerce (docs/04). Receipt and
 * processing are separate. The event is durably stored before 202 is returned, then the order line's
 * entitlement is re-derived. If processing fails, the worker retries events still in "received".
 */
export class EntitlementEventService {
  private validator: Promise<ValidateFunction> | null = null;

  constructor(
    private readonly db: ScopedDb,
    private readonly sources: InboundSources,
    private readonly eventSource: string,
  ) {}

  private validate(): Promise<ValidateFunction> {
    this.validator ??= (async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats.default(ajv);
      for (const f of ["envelope.v1.schema.json", "entitlement.v1.schema.json"]) {
        ajv.addSchema(JSON.parse(await fs.readFile(new URL(f, CONTRACTS_DIR), "utf8")));
      }
      return ajv.getSchema("https://tcgi.example/lms/contracts/entitlement.v1.schema.json")!;
    })();
    return this.validator;
  }

  async ingest(pathSource: string, headers: { signature?: string; keyId?: string }, rawBody: string, now = new Date()): Promise<IngestResult> {
    const src = Object.prototype.hasOwnProperty.call(this.sources, pathSource) ? this.sources[pathSource] : undefined;
    const secret = src && headers.keyId && Object.prototype.hasOwnProperty.call(src.keys, headers.keyId) ? src.keys[headers.keyId] : undefined;
    if (!secret || !verifyEventSignature(secret, headers.signature, rawBody, 300, Math.floor(now.getTime() / 1000))) {
      await this.securityEvent("integration.event_signature_rejected", pathSource, { key_id: headers.keyId ?? null });
      return { status: 401, body: { error: "invalid_signature" } };
    }
    let env: EntitlementEnvelope;
    try {
      env = JSON.parse(rawBody);
    } catch {
      return { status: 422, body: { error: "invalid_json" } };
    }
    const validate = await this.validate();
    if (!validate(env)) return { status: 422, body: { error: "schema_validation_failed", details: (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath} ${e.message}`) } };
    if (env.source !== pathSource) {
      await this.securityEvent("integration.event_source_mismatch", pathSource, { envelope_source: env.source });
      return { status: 401, body: { error: "source_mismatch" } };
    }

    const payloadHash = sha256Hex(rawBody);
    const inserted = await this.db.withSystem("entitlement-command", async (trx) => {
      const row = await trx
        .insertInto("integration_event")
        .values({
          source: env.source, idempotency_key: env.idempotency_key, envelope_id: env.id, event_type: env.type, schema_version: env.schema_version,
          aggregate_id: `${env.data.external_order_id}:${env.data.external_line_id}`, effective_at: env.effective_at, source_sequence: env.source_sequence ?? null,
          payload: rawBody, payload_sha256: payloadHash,
        })
        .onConflict((c) => c.columns(["source", "idempotency_key"]).doNothing())
        .returning(["id"])
        .executeTakeFirst();
      if (row) return { id: row.id, duplicate: false as const };
      const existing = await trx.selectFrom("integration_event").select(["id", "payload_sha256"]).where("source", "=", env.source).where("idempotency_key", "=", env.idempotency_key).executeTakeFirstOrThrow();
      return { id: existing.id, duplicate: true as const, sameHash: existing.payload_sha256 === payloadHash };
    });
    if (inserted.duplicate) {
      if (inserted.sameHash) return { status: 200, body: { receipt_id: inserted.id, duplicate: true } };
      await this.securityEvent("integration.event_idempotency_conflict", pathSource, { idempotency_key: env.idempotency_key, receipt_id: inserted.id });
      return { status: 409, body: { error: "idempotency_key_reused_with_different_payload", receipt_id: inserted.id } };
    }
    try {
      await this.processAggregate(env.source, `${env.data.external_order_id}:${env.data.external_line_id}`, { type: "service", label: `commerce:${env.source}` });
    } catch {
      // It stays "received". The worker retries (processPending). Receipt still succeeds: the event is durable.
    }
    return { status: 202, body: { receipt_id: inserted.id } };
  }

  /** Worker: retry events that were stored but not processed (for example after a crash). */
  async processPending(limit = 20): Promise<number> {
    const rows = await this.db.withSystem("entitlement-command", (trx) =>
      trx.selectFrom("integration_event").select(["source", "aggregate_id"]).distinct().where("status", "=", "received").orderBy("source").limit(limit).execute(),
    );
    for (const r of rows) await this.processAggregate(r.source, r.aggregate_id, { type: "system", label: "entitlement worker" });
    return rows.length;
  }

  /**
   * Re-derive the entitlement for one commerce line from all of its events. It's idempotent: running it again
   * with no new events changes nothing.
   */
  processAggregate(source: string, aggregateId: string, actor: Actor, requestId: string | null = null): Promise<void> {
    return this.db.withSystem("entitlement-command", async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`${source}|${aggregateId}`}))`.execute(trx);
      const rows = await trx.selectFrom("integration_event").selectAll().where("source", "=", source).where("aggregate_id", "=", aggregateId).execute();
      if (rows.length === 0) return;
      const envs = new Map(rows.map((r) => [r.id, r.payload as EntitlementEnvelope]));

      // Resolve product and learner per event. Unresolvable events are held with a reason, never guessed.
      const direct = await trx.selectFrom("organisation").select("id").where("kind", "=", "tcgi_direct").executeTakeFirstOrThrow();
      const resolved = new Map<string, { courseId: string; productRefId: string; personId: string } | null>();
      const fold: FoldEvent[] = [];
      for (const r of rows) {
        const e = envs.get(r.id)!;
        let preHeld: string | undefined;
        const product = await trx.selectFrom("commercial_product_reference").select(["id", "course_id"])
          .where("source", "=", source).where("external_product_id", "=", e.data.product.external_product_id).where("active", "=", true).executeTakeFirst();
        const learner = e.data.learner.idp_issuer && e.data.learner.idp_subject
          ? await trx.selectFrom("identity_link").select("person_id").where("issuer", "=", e.data.learner.idp_issuer).where("subject", "=", e.data.learner.idp_subject).executeTakeFirst()
          : undefined;
        if (!product) preHeld = "unknown_product_mapping";
        else if (!learner) preHeld = "unmatched_learner (DEC-10 claim flow pending)";
        resolved.set(r.id, product && learner ? { courseId: product.course_id, productRefId: product.id, personId: learner.person_id } : null);
        fold.push({
          id: r.id, action: e.data.action, effectiveAt: new Date(e.effective_at), sourceSequence: r.source_sequence === null ? null : Number(r.source_sequence),
          receivedAt: r.received_at, accessEnd: e.data.access_end ? new Date(e.data.access_end) : null, reasonCode: e.data.reason_code ?? null,
          quantity: e.data.quantity ?? null, ...(preHeld ? { preHeld } : {}),
        });
      }
      // Every applicable event on a line must agree on learner and product.
      const targets = new Set([...resolved.values()].filter(Boolean).map((t) => `${t!.personId}|${t!.courseId}`));
      if (targets.size > 1) {
        for (const r of rows) await trx.updateTable("integration_event").set({ status: "held", status_reason: "inconsistent_learner_or_product_on_line", processed_at: new Date() }).where("id", "=", r.id).execute();
        return;
      }
      const result = foldEntitlement(fold);
      const target = [...resolved.values()].find(Boolean) ?? null;

      let entitlementId: string | null = null;
      if (result.state && target) entitlementId = await this.applyState(trx, source, aggregateId, target, direct.id, result.state, result.applied, actor, requestId);

      const now = new Date();
      for (const id of result.applied) await trx.updateTable("integration_event").set({ status: "processed", status_reason: null, processed_at: now, entitlement_id: entitlementId }).where("id", "=", id).execute();
      for (const h of result.held) await trx.updateTable("integration_event").set({ status: "held", status_reason: h.reason, processed_at: now, entitlement_id: entitlementId }).where("id", "=", h.id).execute();
    });
  }

  private async applyState(
    trx: Trx, source: string, aggregateId: string, t: { courseId: string; productRefId: string; personId: string }, orgId: string, s: FoldState,
    appliedIds: string[], actor: Actor, requestId: string | null,
  ): Promise<string> {
    const [order, line] = splitAggregate(aggregateId);
    const existing = await trx.selectFrom("entitlement").selectAll().where("source", "=", source).where("external_order_id", "=", order).where("external_line_id", "=", line).forUpdate().executeTakeFirst();
    const next = {
      person_id: t.personId, organisation_id: orgId, course_id: t.courseId, grant_type: "commerce_line" as const, product_ref_id: t.productRefId,
      status: s.status, valid_from: s.validFrom.toISOString(), valid_until: s.validUntil?.toISOString() ?? null,
    };
    const before = existing
      ? { status: existing.status, valid_from: existing.valid_from.toISOString(), valid_until: existing.valid_until?.toISOString() ?? null }
      : null;
    const changed = !before || before.status !== next.status || before.valid_from !== next.valid_from || before.valid_until !== next.valid_until;
    let id: string;
    if (!existing) {
      // A commerce purchase makes the person a TCGI Direct learner (B2C context).
      await trx.insertInto("organisation_membership").values({ organisation_id: orgId, person_id: t.personId, source: "commerce" }).onConflict((c) => c.columns(["organisation_id", "person_id"]).doNothing()).execute();
      id = (await trx.insertInto("entitlement").values({ ...next, source, external_order_id: order, external_line_id: line, updated_at: new Date() }).returning("id").executeTakeFirstOrThrow()).id;
    } else {
      id = existing.id;
      if (changed) await trx.updateTable("entitlement").set({ status: next.status, valid_from: next.valid_from, valid_until: next.valid_until, updated_at: new Date() }).where("id", "=", id).execute();
    }
    if (!changed) return id;
    await trx.insertInto("entitlement_decision").values({
      organisation_id: orgId, entitlement_id: id, input_ref: JSON.stringify({ events: appliedIds }), rule_version: FOLD_RULE_VERSION,
      before: before ? JSON.stringify(before) : null, after: JSON.stringify({ status: next.status, valid_from: next.valid_from, valid_until: next.valid_until }),
    }).execute();
    await audit(trx, { actor, action: existing ? "entitlement.rederived" : "entitlement.granted", entityType: "entitlement", entityId: id, organisationId: orgId, before, after: next, reason: FOLD_RULE_VERSION, requestId });

    // Effects on enrolments justified by this entitlement. Progress and results are never removed (R-7).
    const enrolments = await trx.selectFrom("enrolment").select(["id", "status", "access_end"]).where("entitlement_id", "=", id).where("status", "in", ["active", "completed"]).execute();
    for (const en of enrolments) {
      let status = en.status;
      let accessEnd = s.validUntil;
      let reason = "access_changed";
      if (s.status === "revoked") {
        accessEnd = s.revokedAt;
        if (en.status === "active") status = "withdrawn";
        reason = "entitlement_revoked";
      }
      const accessChanged = (en.access_end?.getTime() ?? null) !== (accessEnd?.getTime() ?? null);
      if (status === en.status && !accessChanged) continue;
      await trx.updateTable("enrolment").set({ status, access_end: accessEnd }).where("id", "=", en.id).execute();
      await enqueueEvent(trx, this.eventSource, {
        type: "enrolment.status_changed", aggregate: { type: "enrolment", id: en.id },
        data: { enrolment_id: en.id, old_status: en.status, new_status: status, access_end: accessEnd?.toISOString() ?? null, reason_code: reason },
      });
      await audit(trx, { actor, action: "enrolment.access_changed", entityType: "enrolment", entityId: en.id, organisationId: orgId,
        before: { status: en.status, access_end: en.access_end }, after: { status, access_end: accessEnd }, reason, requestId });
    }
    return id;
  }

  private async securityEvent(action: string, source: string, after: Record<string, unknown>) {
    await this.db.withSystem("entitlement-command", (trx) => audit(trx, { actor: { type: "system", label: "integration inbox" }, action, entityType: "integration_source", entityId: source, after }));
  }
}

export function splitAggregate(aggregateId: string): [string, string] {
  const i = aggregateId.lastIndexOf(":");
  return [aggregateId.slice(0, i), aggregateId.slice(i + 1)];
}
