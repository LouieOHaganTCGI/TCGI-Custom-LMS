import { describe, expect, it } from "vitest";
import { foldEntitlement, type FoldEvent } from "../../src/modules/entitlements/fold.js";

/** TS-EVT: the derivation is order-independent and duplicate-safe by construction (ADR-0006 §2). */
const T = (iso: string) => new Date(iso);
let n = 0;
const ev = (over: Partial<FoldEvent> & Pick<FoldEvent, "action" | "effectiveAt">): FoldEvent => ({
  id: `e${String(++n).padStart(3, "0")}`, sourceSequence: null, receivedAt: T("2027-01-01T00:00:00Z"), accessEnd: null, reasonCode: null, quantity: null, ...over,
});

/** Deterministic pseudo-random permutations (seeded), so failures are reproducible. */
function permutations<T>(arr: T[], count: number, seed = 42): T[][] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: count }, () => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  });
}
const canon = (r: ReturnType<typeof foldEntitlement>) => JSON.stringify({ state: r.state, applied: [...r.applied].sort(), held: [...r.held].sort((a, b) => a.id.localeCompare(b.id)) });

describe("entitlement fold", () => {
  const purchase = ev({ action: "grant", effectiveAt: T("2027-02-15T10:00:00Z"), accessEnd: T("2028-02-15T10:00:00Z") });
  const extend = ev({ action: "extend", effectiveAt: T("2027-06-01T09:00:00Z"), accessEnd: T("2028-06-01T09:00:00Z"), reasonCode: "paid_extension" });
  const refund = ev({ action: "revoke", effectiveAt: T("2027-07-01T09:00:00Z"), reasonCode: "refund_full" });

  it("purchase → active until access_end (R-1)", () => {
    expect(foldEntitlement([purchase]).state).toEqual({ status: "active", validFrom: purchase.effectiveAt, validUntil: purchase.accessEnd, revokedAt: null });
  });

  it("extension moves the end date. A refund then revokes (R-3, R-2)", () => {
    expect(foldEntitlement([purchase, extend]).state?.validUntil).toEqual(extend.accessEnd);
    expect(foldEntitlement([purchase, extend, refund]).state).toMatchObject({ status: "revoked", revokedAt: refund.effectiveAt });
  });

  it("the result is identical for 200 random arrival orders (order-independence)", () => {
    const events = [purchase, extend, refund];
    const expected = canon(foldEntitlement(events));
    for (const p of permutations(events, 200)) expect(canon(foldEntitlement(p))).toBe(expected);
  });

  it("duplicates of the same business facts don't change the result", () => {
    const dupPurchase = { ...purchase, id: "dup-purchase", receivedAt: T("2027-03-01T00:00:00Z") };
    const dupRefund = { ...refund, id: "dup-refund" };
    const base = foldEntitlement([purchase, extend, refund]).state;
    for (const p of permutations([purchase, dupPurchase, extend, refund, dupRefund], 100)) expect(foldEntitlement(p).state).toEqual(base);
  });

  it("a refund that arrives before its purchase still ends revoked (R-6)", () => {
    const r = foldEntitlement([refund, purchase]);
    expect(r.state?.status).toBe("revoked");
  });

  it("a refund effective before any purchase blocks a later grant on the same line", () => {
    const early = ev({ action: "revoke", effectiveAt: T("2027-01-01T00:00:00Z"), reasonCode: "order_cancelled" });
    const r = foldEntitlement([purchase, early]);
    expect(r.state?.status).toBe("revoked");
    expect(r.held).toEqual([{ id: purchase.id, reason: "grant_after_revoke_on_same_line" }]);
  });

  it("an extension after a refund is held, not applied (R-3)", () => {
    const lateExt = ev({ action: "extend", effectiveAt: T("2027-08-01T00:00:00Z"), accessEnd: T("2029-01-01T00:00:00Z"), reasonCode: "paid_extension" });
    const r = foldEntitlement([purchase, refund, lateExt]);
    expect(r.state?.status).toBe("revoked");
    expect(r.held.map((h) => h.reason)).toEqual(["extension_after_revoke"]);
  });

  it.each([
    ["partial refund", ev({ action: "revoke", effectiveAt: T("2027-03-01T00:00:00Z"), reasonCode: "refund_partial" }), "partial_refund_rule_pending_DEC-11"],
    ["suspension (instalment default)", ev({ action: "suspend", effectiveAt: T("2027-03-01T00:00:00Z"), reasonCode: "instalment_overdue" }), "suspension_rule_pending_DEC-11"],
    ["quantity > 1", ev({ action: "grant", effectiveAt: T("2027-02-15T10:00:00Z"), accessEnd: T("2028-01-01T00:00:00Z"), quantity: 3 }), "quantity_not_supported"],
    ["grant with no access end (no duration invented)", ev({ action: "grant", effectiveAt: T("2027-02-15T10:00:00Z"), accessEnd: null }), "no_access_end_or_duration_rule"],
    ["shortening extension", ev({ action: "extend", effectiveAt: T("2027-06-01T00:00:00Z"), accessEnd: T("2027-07-01T00:00:00Z"), reasonCode: "paid_extension" }), "extension_would_shorten_access"],
  ])("%s is held for review instead of guessed", (_label, e, reason) => {
    const r = foldEntitlement(e.action === "grant" ? [e] : [purchase, e]);
    expect(r.held).toContainEqual({ id: e.id, reason });
    if (e.action !== "grant") expect(r.state).toMatchObject({ status: "active", validUntil: purchase.accessEnd });
  });

  it("source_sequence breaks ties between events with the same effective time", () => {
    const at = T("2027-05-01T00:00:00Z");
    const a = ev({ action: "grant", effectiveAt: at, accessEnd: T("2028-01-01T00:00:00Z"), sourceSequence: 1 });
    const b = ev({ action: "revoke", effectiveAt: at, reasonCode: "refund_full", sourceSequence: 2 });
    for (const p of permutations([a, b], 20)) expect(foldEntitlement(p).state?.status).toBe("revoked");
  });
});
