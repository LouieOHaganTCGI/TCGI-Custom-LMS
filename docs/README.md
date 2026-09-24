# TCGI LMS: Phase A planning pack

Status: Phase A is done, and the architecture was **accepted by Boris on 24 Sep 2026**. Phase B was **accepted**. The next batch (UX foundation, S4 commerce events, S5 enterprise, CPD) is **awaiting review**: see [slices/report-ux-s4-s5-cpd.md](slices/report-ux-s4-s5-cpd.md) and parts 1 and 2 of [phase-b/demo-script.md](phase-b/demo-script.md). Functional spec v3.0 was reconciled into [00 §E](00-assumption-register.md).

Requirement baseline: [`../TCGI_LMS_MVP_Build_Brief_2027.md`](../TCGI_LMS_MVP_Build_Brief_2027.md)

| # | Deliverable | File |
|---|---|---|
| 0 | Assumptions, conflicts and gaps register | [00-assumption-register.md](00-assumption-register.md) |
| 1 | Requirements traceability matrix (every P0 and P1) | [01-requirements-traceability-matrix.md](01-requirements-traceability-matrix.md) |
| 2 | Architecture decision records (stack, SCORM runtime, hosting, tenancy, identity, events) | [adr/](adr/README.md) |
| 3 | Data model and tenant/role threat model | [03-data-model-and-threat-model.md](03-data-model-and-threat-model.md) |
| 4 | Event contracts, with JSON Schemas and validated examples | [04-event-contracts.md](04-event-contracts.md), [contracts/](contracts/) |
| 5 | Delivery backlog: two-week slices and critical path | [05-delivery-backlog.md](05-delivery-backlog.md) |
| 6 | Migration spike plan and fallback | [06-migration-spike-plan.md](06-migration-spike-plan.md) |
| 7 | Business decisions, with blocking dates | [07-business-decisions.md](07-business-decisions.md) |

Checking the contracts: `npm run contracts:validate`. Valid examples must pass and invalid examples must be rejected.

## Plan summary

1. **Discovery (Oct–Dec 2026):**
   - D2: SCORM runtime PoC on real Rise packages, comparing open-source `scorm-again` with Rustici Engine (and SCORM Cloud only if EU residency is confirmed).
   - D3–D4: the Brightspace progress-portability spike.
   - D5: contracting and account provisioning, after approval.
2. **Phase B (S1–S3, 4 Jan–12 Feb 2027):** the production-quality vertical slice.
   - Flow: miniOrange sandbox sign-in → scoped identity → entitlement fixture → enrolment → real Rise launch → resume → completion → HubSpot sandbox event → admin audit.
   - Delivered on staging, with a demo script and a "works / simulated / unverified" report.
3. **P0 build (S4–S11, to 4 Jun 2027):** entitlements, enterprise, catalogue and versioning, paths, assessments, CPD, reporting, full integrations. Migration dry runs run in parallel (M1–M3).
4. **Pilot readiness (S12):** independent security and accessibility reviews, restore drill. **Go/no-go on 18 Jun 2027.**
5. **Pilot (S13–S14), then phased Q3 waves (S15–S19)** per cohort, with Brightspace kept for the parallel run.

Proposed architecture (all ADRs *Proposed*, none locked):
- A TypeScript modular monolith on PostgreSQL, with row-level security as a second tenant barrier.
- A Postgres-backed transactional inbox and outbox.
- A `ScormRuntimeProvider` port, with the runtime chosen on PoC evidence.
- SCORM content on a separate origin.
- miniOrange via OIDC (SAML fallback), keyed on issuer + subject, never on email.
- Provisionally AWS eu-west-1 (Dublin), pending Finance pricing and data-protection acceptance.

## Top five technical risks

| # | Risk | Likelihood / impact | Mitigation | Early signal |
|---|---|---|---|---|
| 1 | **The SCORM runtime can't faithfully run TCGI's Rise packages:** suspend and resume, 2004 sequencing, mobile commit on tab close, 1.2 `suspend_data` limits | Medium / Critical | Evidence-based runtime choice (ADR-0002 R1–R13 on real packages). A runtime port that allows swapping. A separate content origin | D2 matrix (30 Oct 2026). **Blocked until packages arrive (DEC-03)** |
| 2 | **In-progress Brightspace state isn't transferable:** `suspend_data` not exportable, package builds differ, identifiers can't be mapped without email | High / High | The D3–D4 spike with synthetic ground truth and an injection test. A per-course fallback (finish on Brightspace, transfer completed units, restart with extension). This depends on the Brightspace bridge (DEC-01) | Spike report (27 Nov 2026) |
| 3 | **Tenant or role isolation defect** (IDOR, an employer seeing personal B2C learning, package JS reaching app APIs, support over-reach) | Medium / Critical | Server-derived org context. A scoped repository plus Postgres RLS under a non-owner role. A route-inventory test. A matrix test with two tenants and a dual-context learner. Independent pen test before the pilot | TS-SEC from S1. Pen test (S12) |
| 4 | **Assessment integrity and rules:** SCORM scores are client-reported and can be forged. Diploma rules (randomisation, resits, moderation, classification) aren't specified yet | High / High | Decide early whether summative assessment is native and server-scored (DEC-15, 29 Jan). No academic rules coded without DEC-16 | DEC-15 and DEC-16 dates |
| 5 | **Entitlement correctness at the commerce boundary:** no existing signed producer in WooCommerce, ambiguous refund and instalment policy, duplicate and out-of-order events, the 5-minute revocation target | Medium / High | A signed and versioned contract with an idempotent inbox. **Derived-state folding** (safe under reordering by construction) with property-based tests. Finance-approved rules (DEC-11). Nightly reconciliation that never auto-grants | DEC-10 (who builds the producer) by 15 Jan 2027 |

Honourable mentions: the identity linking assumptions about miniOrange (A-01, A-02); zero schedule float (C-05); the availability commitment versus a small team (C-06).

## What Boris is asked to approve

1. The ADRs 0001 and 0003–0006 as the working architecture (DEC-05). ADR-0002 is approved only as a *PoC method*. The runtime choice itself comes later (DEC-13).
2. The owner allocation for Aayushi and Andre, and naming a data-protection lead (DEC-00).
3. The decision dates in [07](07-business-decisions.md). Please flag any that are unrealistic.
4. Starting D2 once the packages arrive (DEC-03). D2 is evaluation code, clearly labelled, and not Phase B.
