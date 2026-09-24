import { sql } from "kysely";
import type { ScopedDb } from "../../db/scoped.js";
import { signEventBody } from "../../lib/crypto.js";
import { audit, type Actor } from "../audit/audit.js";
import { NotFoundError, RuleViolation } from "../authz/authz.js";

export type DeliveryOutcome =
  | { kind: "delivered"; httpStatus: number }
  | { kind: "retry"; httpStatus: number | null; error: string; retryAfterSeconds?: number }
  | { kind: "dead"; httpStatus: number | null; error: string };

export interface DestinationAdapter {
  readonly name: string;
  deliver(envelopeJson: string): Promise<DeliveryOutcome>;
}

/**
 * Posts the signed contract envelope to a URL (docs/04-event-contracts.md §1 signing scheme).
 * This is how Phase B reaches the "HubSpot" destination: a local stub, or a sandbox receiver once
 * approved. **It is not a HubSpot API integration.** The HubSpot object mapping waits on DEC-08.
 */
export class SignedWebhookDestination implements DestinationAdapter {
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly secret: string,
    private readonly keyId: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async deliver(body: string): Promise<DeliveryOutcome> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "tcgi-signature": signEventBody(this.secret, body), "tcgi-key-id": this.keyId },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (e) {
      return { kind: "retry", httpStatus: null, error: `network: ${(e as Error).message}`.slice(0, 500) };
    }
    const excerpt = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status >= 200 && res.status < 300) return { kind: "delivered", httpStatus: res.status };
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      return { kind: "retry", httpStatus: res.status, error: `HTTP ${res.status} ${excerpt}`, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterSeconds: ra } : {}) };
    }
    return { kind: "dead", httpStatus: res.status, error: `HTTP ${res.status} ${excerpt}` };
  }
}

/** Backoff per docs/04 §3: 30 s, 2 m, 10 m, 30 m, 2 h, 6 h, then every 6 h. */
export const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200, 21600];
export function backoffSeconds(attempts: number): number {
  return BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 21600;
}

/**
 * Delivers pending outbox messages (ADR-0006).
 * - Ordering: a message is eligible only if no earlier message for the same (destination, aggregate) is
 *   still undelivered. A dead message blocks its aggregate until an admin replays it.
 * - Concurrency: rows are claimed with FOR UPDATE SKIP LOCKED, so several workers can run safely.
 * - Every attempt is recorded in delivery_attempt.
 */
export class OutboxDispatcher {
  constructor(
    private readonly db: ScopedDb,
    private readonly adapters: ReadonlyMap<string, DestinationAdapter>,
    private readonly maxAttempts: number,
  ) {}

  /** Process up to `limit` messages. Returns how many were attempted. */
  async runOnce(limit = 20, now = () => new Date()): Promise<number> {
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const did = await this.db.withSystem("outbox-dispatch", async (trx) => {
        const t = now();
        const msg = await trx
          .selectFrom("outbox_message as m")
          .select(["m.id", "m.destination", "m.payload", "m.attempts"])
          .where("m.status", "=", "pending")
          .where("m.next_attempt_at", "<=", t)
          .where((eb) =>
            eb.not(eb.exists(
              eb.selectFrom("outbox_message as prior").select("prior.id")
                .whereRef("prior.destination", "=", "m.destination")
                .whereRef("prior.aggregate_type", "=", "m.aggregate_type")
                .whereRef("prior.aggregate_id", "=", "m.aggregate_id")
                .whereRef("prior.seq", "<", "m.seq")
                .where("prior.status", "<>", "delivered"),
            )),
          )
          .orderBy("m.seq")
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!msg) return false;

        const adapter = this.adapters.get(msg.destination);
        const started = Date.now();
        const outcome: DeliveryOutcome = adapter
          ? await adapter.deliver(JSON.stringify(msg.payload))
          : { kind: "retry", httpStatus: null, error: `destination '${msg.destination}' is not configured` };
        const attempts = msg.attempts + 1;
        const final: DeliveryOutcome =
          outcome.kind === "retry" && attempts >= this.maxAttempts ? { kind: "dead", httpStatus: outcome.httpStatus, error: `max attempts reached: ${outcome.error}` } : outcome;

        await trx
          .insertInto("delivery_attempt")
          .values({ outbox_id: msg.id, http_status: final.httpStatus, outcome: final.kind, error: final.kind === "delivered" ? null : final.error, duration_ms: Date.now() - started })
          .execute();
        if (final.kind === "delivered") {
          await trx.updateTable("outbox_message").set({ status: "delivered", attempts, delivered_at: t, last_error: null }).where("id", "=", msg.id).execute();
        } else if (final.kind === "retry") {
          const delay = Math.max(final.retryAfterSeconds ?? 0, backoffSeconds(attempts));
          await trx.updateTable("outbox_message").set({ attempts, last_error: final.error, next_attempt_at: new Date(t.getTime() + delay * 1000) }).where("id", "=", msg.id).execute();
        } else {
          await trx.updateTable("outbox_message").set({ status: "dead", attempts, last_error: final.error }).where("id", "=", msg.id).execute();
        }
        return true;
      });
      if (!did) break;
      processed++;
    }
    return processed;
  }

  /** Admin replay of a dead message (audited, capability integration.replay). */
  async replay(messageId: string, actor: Actor, requestId: string | null): Promise<void> {
    await this.db.withSystem("outbox-dispatch", async (trx) => {
      const m = await trx.selectFrom("outbox_message").select(["id", "status", "attempts", "last_error"]).where("id", "=", messageId).forUpdate().executeTakeFirst();
      if (!m) throw new NotFoundError("outbox message");
      if (m.status !== "dead") throw new RuleViolation("only dead-lettered messages can be replayed", "not_dead");
      await trx.updateTable("outbox_message").set({ status: "pending", attempts: 0, next_attempt_at: sql`now()` }).where("id", "=", m.id).execute();
      await audit(trx, { actor, action: "integration.replayed", entityType: "outbox_message", entityId: m.id, before: { status: m.status, attempts: m.attempts, last_error: m.last_error }, after: { status: "pending" }, requestId });
    });
  }
}
