# 05 — Delivery backlog: two-week vertical slices to Q3 2027

Status: **Draft for review.** Estimates are pre-discovery ranges in **person-weeks (pw)** for the supplier team (A-07: about 8 pw of capacity per slice). No costs are given. Finance converts pw using supplier rates (DEC-02).

## Rules for every slice

- **Vertical:** each slice ends in a demo, on **staging**, of a user-visible journey. "API done, UI next slice" doesn't count as a slice.
- **Definition of done (the test gate):**
  1. The slice's TS-* suites are green in CI.
  2. TS-SEC is green for every new route (route inventory updated).
  3. No critical or high dependency or SAST findings.
  4. Migrations are forward-only and reversible by a tested down or restore path.
  5. axe-core is clean on new screens, and the manual keyboard check is done.
  6. The OpenAPI spec and docs are updated.
  7. The demo has been run by the requirement owner, and acceptance is recorded in the RTM.
  8. The "simulated vs real" list for the slice is written down.
- **Decision gate:** a slice **doesn't start** if any decision it depends on is still open two weeks before its start date (see 07). The fallback is to swap in the next unblocked slice, and report the slip.

## Calendar

| Phase | Slice | Dates | Theme |
|---|---|---|---|
| Discovery | D1 | 05–16 Oct 2026 | Phase A review, access requests, package intake |
| | D2 | 19–30 Oct 2026 | **SCORM runtime PoC** (evaluation harness, throwaway) |
| | D3 | 02–13 Nov 2026 | **Migration spike, part 1** (Brightspace extraction) |
| | D4 | 16–27 Nov 2026 | **Migration spike, part 2** (injection test), supplier estimates |
| | D5 | 30 Nov–11 Dec 2026 | Contracting, account provisioning (on approval), runtime licence if needed |
| Buffer | — | 14 Dec 2026–01 Jan 2027 | Holiday. No planned delivery |
| **Phase B** | S1–S3 | 04 Jan–12 Feb 2027 | First production-quality vertical slice (brief gate: "real package launched, resumed and completed") |
| Build | S4–S11 | 15 Feb–04 Jun 2027 | P0 scope needed for the pilot |
| Migration track | M1–M3 | 26 Apr–04 Jun 2027 | In parallel, with the brief's "extra migration capacity" |
| Pilot readiness | S12 | 07–18 Jun 2027 | Hardening, independent reviews, restore drill, **pilot go/no-go on 18 Jun** |
| Pilot | S13–S14 | 21 Jun–16 Jul 2027 | Pilot with real learners, with P1 work in parallel |
| Q3 rollout | S15–S19 | 19 Jul–24 Sep 2027 | Phased migration waves per cohort, P1 completion, handover |

Irish public holidays that reduce capacity: 1 Feb (S3), 17 Mar (S6), 29 Mar (S7), 3 May (S9), 7 Jun (S12), 2 Aug (S16).

## Slices

| Slice | Demo (what someone can actually do on staging) | Requirements | Depends on | Est. (pw) | Test gate (beyond the DoD) |
|---|---|---|---|---|---|
| **D2** | An engineer launches, suspends, resumes and completes ≥ 2 real Rise packages (1.2 and 2004) in each runtime candidate. The R1–R13 compatibility matrix is filled in | CAT-01 | DEC-03 packages, DEC-14 spike course | 3–5 | Matrix R1–R13 per candidate. **This is evaluation code, not product** |
| **D3–D4** | See [06](06-migration-spike-plan.md). Evidence on whether Brightspace progress and suspend data can be extracted and resumed | MIG-01 | DEC-09 data handling, D2 harness | 4–6 | Spike report with go / partial / no-go |
| **S1** | A test user signs in to **staging** through the **miniOrange sandbox**. Their scoped identity page shows their subject, email, and role grants. An admin sees the login audit record | ID-01, ID-02 (model), ID-04 (logging), NFR-01/02/03 (base), INT-04 (OpenAPI skeleton) | DEC-05, DEC-06, DEC-07 (accounts exist) | 7–9 | TS-SEC auth negatives. Route inventory test. RLS direct-SQL test harness. Pipeline with scans. Backup enabled |
| **S2** | An admin uploads a **real sanitised Rise package** (ContentVersion, immutable and hashed), places it in a course, and seeds an **entitlement fixture via the same internal command the S4 event handler will use**. The learner sees the course, enrols and launches it from the content origin | CAT-01, CAT-02 (model), INT-01 (command), LRN-01 (start) | DEC-13 runtime, DEC-04 unit of reuse | 8–10 | TS-SCORM R1–R2. TS-SEC hostile-package fixture (T-09). Cross-tenant package URL test |
| **S3** | The learner leaves part way through, resumes on another browser or device, and completes. The dashboard shows completion. A `course.completed` event is **queued** and delivered to the **HubSpot sandbox**. An admin sees the audit trail: enrolment, progress, and delivery attempt. **Demo script published** | LRN-01, LRN-02 (minimal), INT-03 (first event), OPS-03 (audit view) | DEC-08 (sandbox and mapping; otherwise a stub, labelled *simulated*) | 8–10 | TS-SCORM R3–R9. TS-OUT (fault-injected stub). **TS-E2E full Phase B journey** |
| **S4** | A purchase in **WooCommerce staging** grants access in ≤ 60 s. A refund revokes it. A replayed, duplicated or reordered stream produces the correct state. An admin sees event → decision → entitlement | INT-01, INT-02, LRN-03 (event-driven) | DEC-10 producer, DEC-11 rules | 7–9 | **TS-EVT** property tests (random permutations and duplicates). Signature, replay and 409 cases |
| **S5** | An Org A manager invites learners up to the seat limit (the next one is refused), assigns permitted courses, and can't see Org B in any way. Invited learners link their existing miniOrange identity. Deactivation removes access | ENT-01, ENT-02, ID-02, ID-03, ID-04 | DEC-12 contracts (5 clients), DEC-33 | 8–10 | TS-SEC full matrix with two orgs plus a dual-context learner. Last-seat race test |
| **S6** | An editor tags a course (tier, topic, CPD), submits it for review, an approver publishes it. One ContentVersion is placed in two courses with a single stored object. Publishing v2 leaves in-progress learners on v1 | CAT-02, CAT-03, CAT-05 | DEC-18, DEC-19 (upgrade policy) | 7–9 | TS-ACAD version pinning. Only approvers can publish (TS-SEC) |
| **S7** | A learning path with prerequisites. Mobile-first dashboard with next action and access end. An admin extends one learner with a reason. Cohort dates enforced | CAT-04, LRN-02, LRN-03 | DEC-19 (mastery transfer) | 8–10 | TS-ACAD rule cases. Clock-controlled expiry. TS-A11Y on dashboard |
| **S8** | Summative assessment, part 1: approved question banks, randomised draw, pass mark, attempt limit, **server-scored** | LRN-04 | **DEC-15, DEC-16** | 8–11 | TS-ACAD: one case per approved rule. The client can't set its own score |
| **S9** | Resits, moderation hold states, Result finalisation. Audited correction with approval. CPD awarded once per completion, with totals by date range | LRN-04, LRN-05, OPS-03 | DEC-16, DEC-22, DEC-33 | 8–11 | TS-ACAD (resit, correction, CPD duplicate replay). Append-only raw-evidence DB tests |
| **S10** | A manager's scoped report and CSV export (audited). TCGI ops dashboard with filters and integration errors. The reconciliation report matches transactional counts, with freshness shown | ENT-03, OPS-01, OPS-02 | DEC-23 | 7–9 | TS-SEC export scope and CSV injection. Reconciliation tests |
| **S11** | Full HubSpot event set with the nightly reconciliation clean. Accredible sandbox: requested → issued link → revoked, with no duplicates. CPD transcript PDF | INT-03, INT-05, LRN-06 | DEC-08, DEC-24, DEC-17 | 8–10 | TS-OUT (all destinations, DLQ and replay). Transcript IDOR test |
| **M1** (∥ S9) | Import mappers from the pseudonymised Brightspace extract into staging, per the spike outcome | MIG-01, ID-03 | Spike result, DEC-28 | 2–3 | TS-MIG counts |
| **M2** (∥ S10) | **Dry run 1** of the pilot cohort. Exceptions register generated | MIG-01 | M1 | 2–3 | TS-MIG checksums |
| **M3** (∥ S11) | **Dry run 2**, reconciled, with the rollback rehearsed | MIG-01 | M2, DEC-29 | 2–3 | TS-MIG with zero critical exceptions |
| **S12** | **Pilot readiness:** independent pen test and accessibility audit findings fixed. Load test at the agreed profile. **Restore drill.** SLO dashboards and alert routing. Support runbook and training. **Go/no-go on 18 Jun 2027** | NFR-03 to NFR-08 | DEC-21, DEC-27 (reviews booked by 26 Feb) | 8–10 + external reviews | TS-OPS restore. Pen test criticals and highs closed |
| **S13** | Pilot week 1–2: support. P1: org branding and catalogue visibility, search | ID-05, CAT-06 | DEC-31 | 6–8 | TS-SEC catalogue enumeration |
| **S14** | Pilot complete, **sign-off**. P1: PDF, video and article resources. Messaging with consent and opt-out | CAT-07, LRN-07 | DEC-25 | 6–8 | Consent-rule tests. TS-A11Y media |
| **S15** | **Wave 1** migration (per cohort, per the criteria in §9 of the brief). P1: seat reassignment and bulk upload, full data export | ENT-04, OPS-04 | DEC-32, DEC-30 | 6–8 + migration | TS-MIG per wave. Export round-trip |
| **S16** | Wave 2. P1: Hivebrite link (if approved) | INT-06 | DEC-26 | 6–8 | TS-SEC (Hivebrite shared fields) |
| **S17–S19** | Waves 3+ (enterprise clients at their renewal points), parallel run, incident reviews, **handover** (runbooks, IaC, access to TCGI) | MIG-01 | DEC-29 | 18–24 | Cutover criteria per cohort |

**Totals, as a sanity check:**

| Phase | Estimate (pw) | Capacity (pw) |
|---|---|---|
| Discovery | 7–11 | — |
| Phase B (S1–S3) | 23–29 | 24 |
| S4–S11 | 61–79 | 64 |
| Migration track (M1–M3) | 6–9 (extra capacity) | — |
| S12 | 8–10, plus external reviews | — |
| S13–S19 | 42–56 | — |
| **Total** | **about 147–194** | — |

The top of each range **exceeds** the planned capacity, so there's no float (see the critical path).

## Critical path to Q3 2027

```
DEC-01 bridge (30 Oct) ─┐
DEC-03 packages (16 Oct) → D2 runtime PoC → DEC-13 runtime (11 Dec) → S2 launch → S3 resume/complete ─┐
DEC-09 data route (30 Oct) → D3–D4 migration spike → DEC-28 transition policy ─→ M1 → M2 → M3 ───────┤
DEC-06 miniOrange + DEC-07 hosting (27 Nov–11 Dec) → S1 ────────────────────────────────────────────┤
DEC-10/11 commerce (15–29 Jan) → S4 entitlements ───────────────────────────────────────────────────┤
DEC-12 enterprise contracts (12 Feb) → S5 enterprise ─────────────────────────────────────────────────┤
DEC-15 (29 Jan) + DEC-16 (26 Mar) assessment rules → S8 → S9 ─────────────────────────────────────────┤
DEC-27 reviews booked (26 Feb) ─────────────────────────────────────────────────────────→ S12 go/no-go (18 Jun)
                                                                                           → Pilot S13–S14 → Waves S15–S19 (to 24 Sep)
```

- **The longest chain** is packages → runtime PoC → runtime decision → S2 → S3 → S8/S9 assessments → S12 → pilot → waves. **There is zero float.** Any slip of more than one slice in the assessment rules (DEC-16) or the runtime decision (DEC-13) pushes the pilot into July and compresses the Q3 waves.
- **The second chain** is the migration spike → transition policy → M1–M3. If granular transfer is impossible, the fallback (06 §6) needs Brightspace access through the whole parallel run, which ties back to DEC-01.
- **Levers if the pilot is at risk:** (a) add a third engineer from S4; (b) pilot with a B2C product that has no summative diploma assessment, moving S8–S9 off the pilot path; (c) move P1 items after wave 1 when affected courses don't need them.

## Phase B detail (S1–S3): scope and honesty rules

Phase B ends with a **concise demo script** and a report listing, for each step, one of:
- **Works:** real, on staging.
- **Simulated:** stub or fixture, and why.
- **Unverified:** for example, real iOS device testing not yet done.

The step status currently expected, subject to decisions:

| Step | Expected status | Condition |
|---|---|---|
| miniOrange sandbox sign-in | Works | If DEC-06 provides a sandbox. Otherwise blocked. **No mock IdP will be presented as miniOrange** |
| Scoped learner identity | Works | — |
| Entitlement fixture | **Simulated by design** (a fixture through the real command) | The signed event endpoint is S4 |
| Course enrolment | Works | — |
| Launch a real sanitised Rise package | Works | If DEC-03 packages and the DEC-13 runtime are in place |
| Save and restore progress | Works | — |
| Display completion | Works | — |
| Queue a HubSpot sandbox event | Works if DEC-08 provides a sandbox. Otherwise *simulated* (a local stub), and labelled so | — |
| Admin audit record | Works | — |
| Staging deployment | Works | If DEC-07 is approved and accounts exist. **No production deploy** |
