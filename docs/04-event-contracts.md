# 04 — Event contracts

Status: **Draft v1 for review.** Architecture: [ADR-0006](adr/0006-integration-events.md). Machine-readable schemas: [`contracts/`](contracts/). Worked examples: [`contracts/examples/`](contracts/examples/). These are validated against the schemas by `npm run contracts:validate` (docs/contracts/validate.ts).

The contracts define **what the LMS accepts and emits**. They don't define commerce, HubSpot or Accredible internals. Who builds the WooCommerce-side producer is **DEC-10**. The mapping to HubSpot objects is **DEC-08**. The Accredible issuance policy is **DEC-24**.

## 1. Common envelope (every event, both directions)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `spec` | const `tcgi.lms.event/1` | ✔ | Envelope version. Breaking changes → `/2`. |
| `id` | UUID | ✔ | Unique ID for this message, set by the producer. |
| `type` | string | ✔ | For example `entitlement.purchase_completed`. |
| `schema_version` | semver `MAJOR.MINOR` | ✔ | Version of the `data` schema for this `type`. Minor versions are additive only. |
| `source` | string | ✔ | Producer identity, for example `woocommerce:tcgi-store-staging`. It must match the signing key's registered source. |
| `idempotency_key` | string ≤ 200 | ✔ | Stable across producer retries of the *same business fact*. |
| `occurred_at` | RFC 3339 UTC | ✔ | When the producer recorded the fact. |
| `effective_at` | RFC 3339 UTC | ✔ | When the fact takes effect (it may differ, for example a back-dated refund). |
| `aggregate` | `{type, id}` | ✔ | The entity whose order matters, for example `{type:"commerce_line", id:"<order>:<line>"}`. |
| `source_sequence` | integer ≥ 0 | recommended | Monotonic per aggregate at the producer. Used as a tie-breaker. |
| `data` | object | ✔ | A type-specific payload. |

### Transport and signing (inbound to the LMS)

- `POST /integrations/v1/events/{source}` over HTTPS only.
- Headers:
  - `TCGI-Signature: t=<unix-seconds>,v1=<hex(HMAC-SHA256(secret, t + "." + raw_body))>`
  - `TCGI-Key-Id: <key id>`

  Two active keys per source allow rotation without downtime.
- The receiver rejects the message if:
  - the signature is invalid;
  - `|now − t| > 300 s`;
  - the source in the path ≠ the envelope's `source` ≠ the key's source;
  - the body is larger than 256 KB.
- **Browser callbacks are never accepted** as purchase proof (INT-01). The endpoint accepts only machine principals.

### Response semantics (inbound)

| Case | HTTP | Producer action |
|---|---|---|
| Stored durably (new) | **202** `{receipt_id}` | Done. |
| Duplicate: same `(source, idempotency_key)` **and** the same payload hash | **200** `{receipt_id}` (the original) | Done. Safe to stop retrying. |
| Same key, **different** payload hash | **409** | Don't retry. Alert (this is a producer bug or tampering). |
| Signature, timestamp or key failure | **401** | Don't retry blindly. Fix configuration. Logged as a security event. |
| Schema invalid, or unknown `type` or `schema_version` | **422** with an error list | Don't retry. Fix the producer. Stored in quarantine for inspection. |
| LMS unavailable, or 5xx / 429 | 5xx / 429 | Retry with backoff: 1 m, 5 m, 15 m, 1 h, then hourly up to 72 h (the producer's queue must be durable, see DEC-10). |

Receipt ≠ processing. Processing outcomes (applied, no-op, held for review, rejected by business rule) are visible in the admin integration view, and through `GET /integrations/v1/receipts/{receipt_id}` for the producer.

## 2. Inbound: entitlement events (commerce → LMS)

`aggregate = {type: "commerce_line", id: "<external_order_id>:<external_line_id>"}`

`data` (all types share this core; INT-01 fields in **bold**):

| Field | Required | Notes |
|---|---|---|
| **`external_order_id`** | ✔ | The commerce order ID. |
| **`external_line_id`** | ✔ | The order line or item ID. One line = one entitlement. |
| **`learner`** | ✔ | `{ idp_subject?, idp_issuer?, commerce_customer_id, email }`. See §2.2 on matching. |
| **`product`** | ✔ | `{ external_product_id, external_variant_id? }`. Mapped by `CommercialProductReference`. Unknown products are held for review. |
| **`action`** | ✔ | `grant`, `revoke`, `extend`, `suspend` or `reinstate`. It must be consistent with `type`. |
| **`effective_at`** | ✔ | Taken from the envelope, repeated here for clarity. |
| **`access_end`** | for `grant` and `extend` | RFC 3339, or null. If null, the product mapping's approved duration rule applies. **If neither exists, the event is held for review.** No default duration is invented. |
| `quantity` | optional | Must be 1 for B2C in v1. Larger quantities are held for review (multi-seat B2C isn't a known flow). |
| `reason_code` | for `revoke`, `suspend` and `extend` | For example `refund_full`, `refund_partial`, `order_cancelled`, `chargeback`, `instalment_overdue`, `goodwill_extension`, `manual`. The allowed list is subject to DEC-11. |
| `source_actor` | optional | A staff reference in commerce for manual orders. Not PII if avoidable. |

### 2.1 Event types

| `type` | `action` | Business fact | Status |
|---|---|---|---|
| `entitlement.purchase_completed` | grant | The order line is paid (or a zero-value or manual order was approved in commerce) | v1 |
| `entitlement.manual_granted` | grant | A staff grant made in commerce. LMS-admin manual grants use the internal command with `source = lms-admin` and produce the same decision records | v1 |
| `entitlement.refunded` | revoke | A full refund, **or** a partial refund if DEC-11 says it revokes | v1 |
| `entitlement.cancelled` | revoke | The order was cancelled before or after access | v1 |
| `entitlement.access_extended` | extend | A paid or goodwill extension. `access_end` is the new absolute end | v1 |
| `entitlement.suspended` / `entitlement.reinstated` | suspend / reinstate | For example an overdue instalment. **Only if DEC-11 approves this flow** | v1 (feature-flagged) |

Expiry is **not an event**. It is evaluated by the LMS from `valid_until` (and it's clock-testable).

### 2.2 Learner matching (requires DEC-06 and DEC-10)

1. If `idp_subject` and `idp_issuer` are present, match the IdentityLink. This is the preferred path.
2. Otherwise, create the entitlement as **unclaimed**, bound to `commerce_customer_id`. The learner claims it via a signed claim link in the order email, or at first sign-in if the IdP's *verified* email equals the order email **and** DEC-06 approves email-based claiming for B2C.
3. Unclaimed entitlements older than N days (N from DEC-10) appear in the support queue.

### 2.3 Entitlement derivation rules (proposed; Finance must approve, DEC-11)

The state is recomputed from **all** events for the aggregate, sorted by `(effective_at, source_sequence, received_at)` (ADR-0006):

| Rule | Proposed behaviour | Open point |
|---|---|---|
| R-1 | `grant` → active from `effective_at` to `access_end` | — |
| R-2 | `revoke` → revoked from `effective_at`. It is terminal for this line: a later `grant` on the **same** line is held for review, not auto-applied | Is that right for re-purchases? (A re-purchase should be a new line.) |
| R-3 | `extend` → `valid_until = access_end`, applied only if the line is active or expired (not revoked) at `effective_at`. An extension that shortens access needs `reason_code = manual` and is held for review | DEC-11 |
| R-4 | `suspend` → access paused. `reinstate` → access resumes. Whether the paused time extends `valid_until` is up to DEC-11 | DEC-11 |
| R-5 | A partial refund is held for review unless DEC-11 defines it | DEC-11 |
| R-6 | Events whose `effective_at` is older than the latest applied event are **re-folded**, not appended. The decision record shows the reorder | — |
| R-7 | Revocation removes **access**, never progress or results. Enrolments move to `withdrawn` and history is kept | Confirm with Aishwarya |

Latency objective: ≤ 60 s p95 from a valid 202 to the access change (C-11). The brief's 5-minute purchase-to-access target also depends on how fast the producer emits.

## 3. Outbound: learning events (LMS → HubSpot, and future subscribers)

Delivered from the transactional outbox (ADR-0006). The same envelope is used. `source = "tcgi-lms:<env>"`. For outbound messages, `idempotency_key` = `id`.

| `type` | Aggregate | Emitted when | `data` (proposed) |
|---|---|---|---|
| `enrolment.created` | enrolment | An enrolment is committed | `enrolment_id, person_ref, organisation_ref, course_ref, course_revision, access_start, access_end, justification_type` |
| `enrolment.status_changed` | enrolment | Status changes: active, expired, withdrawn or completed. Also access-end changes | `enrolment_id, old_status, new_status, access_end, reason_code` |
| `progress.milestone` | enrolment | A placement completes. Optional: HubSpot may not want this granularity (DEC-08) | `enrolment_id, placement_ref, content_version_ref, completion_status, success_status, occurred_at` |
| `course.completed` | enrolment | The course completion rule is satisfied | `enrolment_id, completed_at, completion_rule_version, cpd_awarded?` |
| `assessment.result_finalised` | result | A result is finalised (after moderation, if required) | `result_id, enrolment_id, assessment_ref, outcome, score?, classification?, attempt_no, finalised_at` |
| `assessment.result_corrected` | result | An approved correction | `result_id, correction_id, old, new, reason_code` (free-text reason stays in the LMS) |
| `credential.status_changed` | credential | The credential state changes (requested, issued, revoked, failed) | `credential_id, result_id, provider, state, external_url?, acknowledged_at?` |

**`person_ref`** is the LMS person ID plus, for HubSpot matching, the field DEC-08 approves (for example email or an existing HubSpot contact ID). **No other PII is sent** beyond the per-destination allow-list.

### Delivery and failure handling

| Stage | Behaviour |
|---|---|
| Ordering | Per aggregate, in `aggregate_seq` order. A failed message blocks later messages **for that aggregate only**. |
| Retry | Capped exponential backoff with jitter: 30 s, 2 m, 10 m, 30 m, 2 h, 6 h, then every 6 h up to 72 h (tunable per DEC-08). HubSpot 429 honours `Retry-After`. |
| Non-retryable | 4xx other than 408 and 429 → DLQ immediately, with the response excerpt stored (PII redacted). |
| DLQ | Visible in admin (OPS-01) with count, age and error. `integration.replay` (audited) re-queues after a fix. |
| Idempotent effect | The adapter writes our `event_id` or aggregate ID to the remote record and upserts on it, so a replay can't create duplicates. |
| Reconciliation | Nightly: for each aggregate changed in the last N days, compare LMS state with the destination and produce a discrepancy report. Auto-repair re-sends **the LMS's current state** (never invents state). |
| Objective | ≤ 5 min p95 normal delivery (INT-03), measured from outbox commit to destination 2xx. |

## 4. Credentials (LMS ↔ Accredible)

This is a **command plus acknowledgement** flow, not fire-and-forget:

1. The LMS creates an `ExternalCredential(state=requested)` when the approved issuance rule is met (DEC-24) and writes an outbox message `credential.issue_requested` to the Accredible adapter.
2. The adapter calls the Accredible API (exact endpoints to be verified in the Accredible sandbox; **not assumed**) with our `credential_id` stored as an external reference, so a retry doesn't create a second credential.
3. On an acknowledged success, the state becomes `issued` with the external ID and URL, and `credential.status_changed` is emitted. **The learner sees "issued" only now** (LRN-06).
4. Revocation: `credential.revoke_requested` → acknowledged → `revoked`.
5. Failure: after retries → `failed`, visible in admin. The nightly reconciliation compares LMS credentials with Accredible records.

## 5. Contract governance

- Schemas live in `docs/contracts/` and are versioned in Git. The CI of both the LMS and the producer validates example payloads against them.
- A new optional field is a minor bump. Removing a field or changing its meaning is a major bump, and the old version is supported for an agreed overlap.
- Unknown fields are ignored (tolerant reader) and preserved in the stored payload.
- Sandbox test keys only. **No live secrets in the repo.**
