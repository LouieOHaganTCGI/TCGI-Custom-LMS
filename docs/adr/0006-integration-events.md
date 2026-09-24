# ADR-0006 — Integration events: inbox, outbox and entitlement derivation

- Status: **Proposed** (Boris, DEC-05; producer ownership DEC-10)
- Date: 2026-09-24

## Context

INT-01/02 require signed, versioned, idempotent entitlement events from existing commerce, safe under duplicates, lateness and reordering. INT-03 requires outbound events to HubSpot via an outbox with retries, DLQ and nightly reconciliation. INT-05 needs the same for Accredible. Every event, decision and resulting state must be auditable. The detailed contracts are in [04-event-contracts.md](../04-event-contracts.md).

## Decisions proposed

### 1. Durable inbox before acknowledgement

The inbound HTTP handler does five things, then returns **202**:
1. Verify the signature and timestamp.
2. Validate the schema.
3. Insert into `integration_event` (unique on `(source, idempotency_key)`).
4. Enqueue processing, in the same transaction.
5. Return 202.

Processing happens asynchronously. A duplicate `idempotency_key` with the **same** payload hash returns 200 with the original receipt. With a **different** payload hash it returns 409 and raises an alert, because it indicates a producer bug or tampering.

### 2. Derive entitlement state; don't apply deltas

For each commerce line `(source, external_order_id, external_line_id)`, the entitlement is **recomputed** from *all* stored events for that line, ordered by `(effective_at, source_sequence, received_at)`. Folding "refund" before "purchase" still produces "revoked". A late "extension" dated before a refund doesn't resurrect access. Each recompute writes an `entitlement_decision` row (inputs, rule version, before and after) for audit. This makes reordering and duplication safe **by construction**, and the property-based tests in TS-EVT verify it.

### 3. Transactional outbox for every outbound effect

Domain changes (enrolment created, completion, result finalised, credential requested) write an `outbox_message` in the same DB transaction. A worker delivers each one to its destination adapter (HubSpot or Accredible), recording a `delivery_attempt`. Retries use capped exponential backoff with jitter. After N attempts (N from DEC-08), the message goes to **dead-letter** and is visible in the admin integration-errors view (OPS-01). A replay is an audited action (`integration.replay`).

### 4. Per-destination idempotency and ordering

Every outbound message carries a stable `event_id`. Adapters use the destination's own idempotency or upsert semantics where available. Otherwise they check existence before creating, keyed by our event or aggregate ID stored on the remote record. Messages for the same aggregate are delivered **in order** (by aggregate sequence). Different aggregates run in parallel.

### 5. Reconciliation

A nightly job (and on demand):
- Compares LMS state with each destination's state for a rolling window.
- Checks commerce: every paid line in the commerce export has a corresponding entitlement. This depends on an approved read-only export or API (DEC-10).
- Produces a discrepancy report.

Reconciliation **never auto-grants access**. Discrepancies go to a support queue, unless an approved rule says otherwise.

### 6. Queue technology

Postgres-backed (ADR-0001). At MVP volume, a broker adds cost with no benefit. The adapter interface keeps SQS or similar as a later swap.

## Consequences

- Access changes are asynchronous but fast. Target: ≤ 60 s from a valid event received to access changed (C-11).
- The entitlement fold needs a clearly versioned rule set from Finance (DEC-11). Rule changes are recorded with a version, and re-folding historical lines under a new rule is an explicit, audited migration, never automatic.
