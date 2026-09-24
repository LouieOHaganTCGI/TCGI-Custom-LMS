/**
 * LOCAL COMMERCE SIMULATOR. This is NOT WooCommerce. It emits signed entitlement events exactly as the contract
 * (docs/04 §2) requires, so the S4 flow can be exercised before the real producer exists (DEC-10).
 *
 *   npx tsx dev/commerce-sim.ts purchase --learner learner-ent-b-1 --product SYN-PROD-FOUNDATION-01 --order SIM-1001
 *   npx tsx dev/commerce-sim.ts refund   --learner learner-ent-b-1 --product SYN-PROD-FOUNDATION-01 --order SIM-1001
 *   npx tsx dev/commerce-sim.ts extend   --learner learner-ent-b-1 --product SYN-PROD-FOUNDATION-01 --order SIM-1001 --days 400
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { signEventBody } from "../src/lib/crypto.js";
import { DEV_PORTS, SIM_COMMERCE_SECRET } from "./stack-env.js";

export type SimAction = "purchase" | "refund" | "extend" | "partial-refund";

export interface SimEventInput {
  action: SimAction;
  source?: string;
  idpIssuer: string;
  learnerSubject: string | null;
  product: string;
  order: string;
  line?: string;
  effectiveAt?: Date;
  accessEnd?: Date | null;
  sequence?: number;
  idempotencyKey?: string;
}

const TYPES: Record<SimAction, { type: string; action: string; reason?: string }> = {
  purchase: { type: "entitlement.purchase_completed", action: "grant" },
  refund: { type: "entitlement.refunded", action: "revoke", reason: "refund_full" },
  "partial-refund": { type: "entitlement.refunded", action: "revoke", reason: "refund_partial" },
  extend: { type: "entitlement.access_extended", action: "extend", reason: "paid_extension" },
};

export function commerceEvent(i: SimEventInput): Record<string, unknown> {
  const t = TYPES[i.action];
  const effective = (i.effectiveAt ?? new Date()).toISOString();
  const line = i.line ?? "1";
  return {
    spec: "tcgi.lms.event/1",
    id: randomUUID(),
    type: t.type,
    schema_version: "1.0",
    source: i.source ?? "woocommerce:tcgi-store-sim",
    idempotency_key: i.idempotencyKey ?? `${i.order}-${line}-${i.action}-${randomUUID().slice(0, 8)}`,
    occurred_at: new Date().toISOString(),
    effective_at: effective,
    aggregate: { type: "commerce_line", id: `${i.order}:${line}` },
    ...(i.sequence !== undefined ? { source_sequence: i.sequence } : {}),
    data: {
      external_order_id: i.order,
      external_line_id: line,
      learner: {
        ...(i.learnerSubject ? { idp_issuer: i.idpIssuer, idp_subject: i.learnerSubject } : {}),
        commerce_customer_id: `SIM-C-${i.learnerSubject ?? "anon"}`,
        email: "synthetic.buyer@example.test",
      },
      product: { external_product_id: i.product },
      action: t.action,
      effective_at: effective,
      ...(i.action === "purchase" || i.action === "extend" ? { access_end: i.accessEnd === undefined ? new Date(Date.now() + 365 * 86_400_000).toISOString() : i.accessEnd?.toISOString() ?? null } : {}),
      ...(t.reason ? { reason_code: t.reason } : {}),
      ...(i.action === "purchase" ? { quantity: 1 } : {}),
    },
  };
}

export async function sendSigned(appBaseUrl: string, envelope: Record<string, unknown>, opts: { secret?: string; keyId?: string } = {}): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify(envelope);
  const res = await fetch(new URL(`/integrations/v1/events/${String(envelope.source)}`, appBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "tcgi-signature": signEventBody(opts.secret ?? SIM_COMMERCE_SECRET, body), "tcgi-key-id": opts.keyId ?? "sim-1" },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { learner: { type: "string" }, product: { type: "string" }, order: { type: "string" }, days: { type: "string" }, line: { type: "string" } } });
  if (!cmd || !(cmd in TYPES) || !values.product || !values.order) {
    console.error("usage: commerce-sim.ts purchase|refund|extend|partial-refund --learner <subject> --product <id> --order <id> [--days N]");
    process.exit(2);
  }
  const env = commerceEvent({
    action: cmd as SimAction, idpIssuer: `http://127.0.0.1:${DEV_PORTS.idp}`, learnerSubject: values.learner ?? null, product: values.product, order: values.order,
    ...(values.line ? { line: values.line } : {}),
    ...(values.days ? { accessEnd: new Date(Date.now() + Number(values.days) * 86_400_000) } : {}),
  });
  sendSigned(`http://localhost:${DEV_PORTS.app}`, env).then((r) => console.log(r.status, JSON.stringify(r.body)));
}
