/**
 * Entitlement derivation (ADR-0006 §2, docs/04 §2.3). A pure function: the entitlement for one commerce line
 * is RECOMPUTED from all of its events, ordered by (effective_at, source_sequence, received_at, id).
 * The same set of events therefore gives the same result whatever order or duplication they arrived in.
 *
 * Rules R-1..R-7 are PROPOSED and await Finance approval (DEC-11). Anything the proposal doesn't define is
 * HELD for review rather than guessed.
 */
export type FoldAction = "grant" | "revoke" | "extend" | "suspend" | "reinstate";

export interface FoldEvent {
  id: string;
  action: FoldAction;
  effectiveAt: Date;
  sourceSequence: number | null;
  receivedAt: Date;
  accessEnd: Date | null;
  reasonCode: string | null;
  quantity: number | null;
  /** Set when the event can't be applied for a reason outside the fold (unknown product, unmatched learner). */
  preHeld?: string;
}

export interface FoldState {
  status: "active" | "revoked";
  validFrom: Date;
  validUntil: Date | null;
  revokedAt: Date | null;
}

export interface FoldResult {
  state: FoldState | null;
  applied: string[];
  held: { id: string; reason: string }[];
}

export const FOLD_RULE_VERSION = "entitlement-fold/v0-proposed (DEC-11 pending)";

export function orderEvents<T extends FoldEvent>(events: T[]): T[] {
  return [...events].sort(
    (a, b) =>
      a.effectiveAt.getTime() - b.effectiveAt.getTime() ||
      (a.sourceSequence ?? Number.MAX_SAFE_INTEGER) - (b.sourceSequence ?? Number.MAX_SAFE_INTEGER) ||
      a.receivedAt.getTime() - b.receivedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Reasons that stop an event on its own, before folding. */
export function classify(e: FoldEvent): string | null {
  if (e.preHeld) return e.preHeld;
  if (e.quantity !== null && e.quantity !== 1) return "quantity_not_supported";
  if (e.action === "grant" && e.accessEnd === null) return "no_access_end_or_duration_rule"; // no duration is invented
  if (e.action === "extend" && e.accessEnd === null) return "extension_without_access_end";
  if (e.action === "revoke" && e.reasonCode === "refund_partial") return "partial_refund_rule_pending_DEC-11";
  if (e.action === "suspend" || e.action === "reinstate") return "suspension_rule_pending_DEC-11";
  return null;
}

export function foldEntitlement(events: FoldEvent[]): FoldResult {
  const applied: string[] = [];
  const held: { id: string; reason: string }[] = [];
  let state = null as FoldState | null; // (cast avoids TS narrowing to null across loop iterations)
  let revokedWithoutGrant = false;

  for (const e of orderEvents(events)) {
    const pre = classify(e);
    if (pre) {
      held.push({ id: e.id, reason: pre });
      continue;
    }
    switch (e.action) {
      case "grant": {
        if (revokedWithoutGrant || state?.status === "revoked") {
          held.push({ id: e.id, reason: "grant_after_revoke_on_same_line" }); // R-2: re-purchase should be a new line
        } else if (state === null) {
          state = { status: "active", validFrom: e.effectiveAt, validUntil: e.accessEnd, revokedAt: null }; // R-1
          applied.push(e.id);
        } else if (state.validUntil?.getTime() === e.accessEnd?.getTime()) {
          applied.push(e.id); // an identical repeat of the grant: no change
        } else {
          held.push({ id: e.id, reason: "conflicting_second_grant" });
        }
        break;
      }
      case "revoke": {
        if (state === null) {
          revokedWithoutGrant = true; // refund effective before any purchase: the line can never become active
          applied.push(e.id);
        } else if (state.status === "revoked") {
          applied.push(e.id); // already revoked: no change
        } else {
          state = { ...state, status: "revoked", revokedAt: e.effectiveAt }; // R-2, R-7
          applied.push(e.id);
        }
        break;
      }
      case "extend": {
        if (state === null) held.push({ id: e.id, reason: revokedWithoutGrant ? "extension_after_revoke" : "extension_without_grant" });
        else if (state.status === "revoked") held.push({ id: e.id, reason: "extension_after_revoke" }); // R-3
        else if (state.validUntil && e.accessEnd! < state.validUntil && e.reasonCode !== "manual") held.push({ id: e.id, reason: "extension_would_shorten_access" });
        else {
          state = { ...state, validUntil: e.accessEnd };
          applied.push(e.id);
        }
        break;
      }
      default:
        held.push({ id: e.id, reason: "unsupported_action" });
    }
  }
  if (state === null && revokedWithoutGrant) {
    // Record the line as revoked from the start, so a late-arriving purchase can't grant access (R-6).
    const first = orderEvents(events).find((e) => applied.includes(e.id))!;
    state = { status: "revoked", validFrom: first.effectiveAt, validUntil: first.effectiveAt, revokedAt: first.effectiveAt };
  }
  return { state, applied, held };
}
