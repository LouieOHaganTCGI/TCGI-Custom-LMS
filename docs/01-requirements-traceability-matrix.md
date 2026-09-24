# 01 — Requirements traceability matrix (P0 / P1)

Status: **Draft for review** · Source: brief §5 (functional), §3 and §6 (outcomes and non-functional)

## How to read this

- **Owner** is the *proposed* acceptance owner. The brief (§8) names Aishwarya for LMS rules and UAT, Boris for integration and security architecture and acceptance, and Finance for commercial rules. "Product/Ops" means the brief's named Product/Ops decision-maker. The prompt names Aayushi and Andre, but the brief doesn't define their roles, so those rows read **Product/Ops (Aayushi/Andre, TBC)** until DEC-00 is resolved.
- **Slice** refers to [05-delivery-backlog.md](05-delivery-backlog.md).
- **Test** refers to the test suites defined below. A requirement is *accepted* only when its demonstration was run by the owner **and** its automated tests pass in CI against staging.
- **Unresolved decision** refers to [07-business-decisions.md](07-business-decisions.md). A requirement whose decision is open can be built only to the stated safe default, and is flagged provisional in demos.
- ENT-05 is P2 and out of scope. It is listed at the end for completeness.

### Test suites

| Suite | What it proves | How it avoids "asserting hard-coded values" |
|---|---|---|
| **TS-SEC** | Tenant and role boundaries across API, DB (RLS), file and download URLs, SCORM content origin, exports | Two seeded tenants with overlapping IDs. Each scoped endpoint is enumerated from the route table. Every role × every foreign resource is attempted. A route not covered by the matrix fails the build. There is also a direct-SQL RLS test with no application code in the path. |
| **TS-EVT** | Inbound event signature, idempotency, duplicates, reordering, late arrival, replay | Property-based tests: generate random permutations and duplications of an event stream, then assert that the resulting entitlement equals the result of processing the canonical order. Signature tests use tampered bodies, stale timestamps and wrong keys. |
| **TS-OUT** | Outbox delivery, retry, dead-letter and reconciliation | A fault-injecting stub for HubSpot and Accredible (timeouts, 429, 5xx, partial success). Asserts exactly-once *effect* using the idempotency keys the receiver saw. |
| **TS-ACAD** | Academic rules: attempts, pass marks, resits, completion, CPD, no double counting, version pinning | Table-driven cases **written from the approved rules (DEC-15, DEC-16, DEC-19, DEC-22)**, not from the implementation. Each case cites its rule reference. |
| **TS-SCORM** | Real Rise 1.2 and 2004 packages: launch, suspend, resume, relaunch, complete, pass or fail, score, attempts, on desktop and mobile | Playwright drives the **real package** in Chromium plus mobile emulation, and a manual real-device pass on iOS Safari and Android Chrome. Assertions are on persisted CMI state read back from the DB. |
| **TS-E2E** | End-to-end learner, manager and admin journeys on staging | Playwright journeys that start from an IdP sign-in against the miniOrange sandbox and an inbound signed event. |
| **TS-MIG** | Migration transform and reconciliation | Counts and per-record checksums between the pseudonymised source extract and the LMS. An exceptions register is generated, and must be empty for critical items. |
| **TS-A11Y** | WCAG 2.1 AA for platform UI | axe-core in CI, plus a manual keyboard and screen-reader script (NVDA and VoiceOver) each slice. An independent audit happens before the pilot. |
| **TS-OPS** | Backup and restore, rollback, monitoring, alerting | Scripted restore into an isolated environment with row-count and checksum comparison. Rollback of the last migration, and a synthetic alert test. |

## 5.1 Identity and organisation boundaries

| ID | Pri | Requirement (summary) | Owner (proposed) | Slice | Demonstration | Test | Unresolved decision |
|---|---|---|---|---|---|---|---|
| ID-01 | P0 | Use miniOrange as the external IdP through SAML 2.0 or OIDC. Map an immutable subject and a verified email. Never key accounts on email. | Boris | S1 | Sign in on staging through the miniOrange sandbox. Change the test user's email in the IdP, sign in again, and show it is the same LMS person with the email updated and an audit entry. | TS-SEC (forged, unsigned or replayed assertions or tokens, wrong audience or issuer, `alg:none`, XML signature wrapping if SAML), TS-E2E | DEC-06 (protocol, subject claim, logout). A-01 |
| ID-02 | P0 | TCGI staff, B2C learner and org-scoped enterprise roles. Checks in APIs, DB queries and downloads. | Boris | S1 (model), S5 (enterprise) | A manager of Org A tries Org B URLs and IDs and gets 404. A support agent sees only permitted fields. | TS-SEC: full route × role × tenant matrix plus RLS direct-SQL | DEC-33 (support-agent scope) |
| ID-03 | P0 | Invitation and account linking for migrated users. No duplicate identities for someone who is both learner and member. | Product/Ops (Aayushi/Andre, TBC) + Boris | S5 (invites), M1–M3 (migration linking) | A migrated learner accepts an invite, signs in with their existing miniOrange identity, and links to the pre-created record. A second invite for the same subject is refused. | TS-E2E, TS-MIG (duplicate-person detection report) | DEC-06, A-02 |
| ID-04 | P0 | Deactivation and recovery through the IdP. Log authentication and permission changes. | Boris | S1 (auth logging), S5 (deactivation) | Deactivate in the IdP: the next session refresh is denied. An LMS admin suspends a person with a reason: it is audited and access is removed. | TS-SEC (session revocation), audit assertions | DEC-06 (does miniOrange support back-channel logout or SCIM?) |
| ID-05 | P1 | Branding and catalogue visibility per enterprise org, with no leakage. | Product/Ops (Aayushi/Andre, TBC) | S13 | Org A and Org B managers and learners see their own branding and permitted catalogue only. | TS-SEC (catalogue enumeration), visual snapshot | DEC-31 |

## 5.2 Content, catalogue and course delivery

| ID | Pri | Requirement (summary) | Owner (proposed) | Slice | Demonstration | Test | Unresolved decision |
|---|---|---|---|---|---|---|---|
| CAT-01 | P0 | Import, validate, launch and track real Rise SCORM 1.2 and 2004 packages: completion, success, score, attempts, suspend and resume, relaunch. Use a specialist runtime. | Aishwarya (content) + Boris (runtime) | D2 (evaluation), S2–S3 (product) | Launch two real packages (1.2 and 2004), leave part way through, resume on another device, complete, and view the persisted status and score. | TS-SCORM compatibility matrix (06 §5 and ADR-0002) | DEC-03 (packages), DEC-13 (runtime) |
| CAT-02 | P0 | Reusable ContentItem, immutable ContentVersion, and separate CoursePlacement. One lesson in two products without two uploads. | Aishwarya | S2 (model), S6 (UI) | Place one ContentVersion in two courses. The storage shows one object, and the learner's progress in course A isn't overwritten by course B (see CAT-04 for any credit transfer). | TS-ACAD (placement isolation), DB constraint tests (versions immutable) | DEC-04 (unit of reuse) |
| CAT-03 | P0 | Product tiers plus independent topic, competency, role, CPD and format tags. Launch taxonomy first. | Product/Ops (Aayushi/Andre, TBC) | S6 | An editor tags a course, a learner filters by tier. A batch import of taxonomy is shown. | Import validation tests | DEC-18 |
| CAT-04 | P0 | Sequence, prerequisites and completion rules. Explicit rule for prior-mastery transfer. Never double count or erase. | Aishwarya | S7 | A path with a prerequisite blocks launch until it's met. A shared lesson completed in course A is handled per the approved transfer rule in course B. | TS-ACAD (cases from DEC-19) | DEC-19 |
| CAT-05 | P0 | Draft → review → approve → publish. A new version preserves in-progress records, with a deliberate cohort decision. | Aishwarya | S6 | Publish v2 while a learner is mid-course on v1. The learner stays pinned to v1 unless an admin runs an audited "move cohort" action. | TS-ACAD (version pinning), TS-SEC (only approvers publish) | DEC-18 (roles), DEC-19 (upgrade policy) |
| CAT-06 | P1 | Search and filter by title, topic, role, competency, level and tier, per audience. | Product/Ops (Aayushi/Andre, TBC) | S13 | A learner and a manager search. Results respect the tenant catalogue. | TS-SEC (search can't leak another org's courses) | DEC-18 |
| CAT-07 | P1 | PDFs, video, articles and external resources, with accessibility metadata. | Aishwarya | S14 | Add a PDF and a captioned video to a course, with required alt and caption metadata enforced. | TS-A11Y, upload validation (type sniffing, AV scan) | Hosting or streaming approach (DEC-07) |

## 5.3 Learning, assessment and CPD

| ID | Pri | Requirement (summary) | Owner (proposed) | Slice | Demonstration | Test | Unresolved decision |
|---|---|---|---|---|---|---|---|
| LRN-01 | P0 | Per learner × content version × enrolment: status, pass or fail, timestamps, score, attempt. Keep raw SCORM state. | Aishwarya | S3 | Show the raw CMI commit log and the derived ProgressState for a learner who resumed twice. | TS-SCORM, TS-ACAD (derivation from raw log) | — |
| LRN-02 | P0 | Learner dashboard: next action, progress, access end date, outcomes, responsive. | Aishwarya | S3 (minimal), S7 (full) | A learner on a 360 px viewport sees their next action and access end date. | TS-E2E (mobile viewport), TS-A11Y | — |
| LRN-03 | P0 | Time-bound access, cohorts with dates, extensions and individual exceptions, each with reason, actor and time. | Aishwarya + Finance (extension policy) | S4 (event-driven), S7 (admin UI) | An admin extends one learner by an approved period with a reason. The audit shows old and new values. Access ends automatically at expiry. | TS-ACAD, TS-EVT (extension events), clock-controlled expiry tests | DEC-11 |
| LRN-04 | P0 | Actual launch-diploma assessment patterns: randomised selection, pass mark, attempt limits, resits, secure result audit. **Validate rules before coding.** | Aishwarya | S8–S9 | Run each approved diploma pattern end to end, including a resit. The result audit shows the question set drawn, responses and scoring version. | TS-ACAD (each approved rule → a case), TS-SEC (a client can't set its own score for summative assessments) | **DEC-15** (native or in Rise), **DEC-16** (rules). *No rules are invented.* |
| LRN-05 | P0 | CPD credit per approved completion. Learner and org totals by date range. No duplicates. | Aishwarya | S9 | Replay the completion event three times and relaunch the package: CPD is awarded once. The org total matches the sum of learners. | TS-ACAD, TS-EVT (uniqueness on award source key) | DEC-22 |
| LRN-06 | P1 | Downloadable CPD transcript. Accredible status or link, never shown as "issued" before Accredible acknowledges it. | Aishwarya | S11 | The transcript PDF downloads for your own record only. The credential shows "requested" until the sandbox acknowledgement arrives, then "issued" with a link. | TS-OUT (Accredible stub), TS-SEC (transcript IDOR) | DEC-24, DEC-17 |
| LRN-07 | P1 | Configurable deadline, inactivity and completion messages with consent and opt-out, and delivery logs. | Product/Ops (Aayushi/Andre, TBC) | S14 | Opted-out learner gets no message. The delivery log shows sent, bounced and suppressed. | TS-OUT, consent-rule tests | **DEC-25** (consent policy, sending channel) |

## 5.4 Enterprise and partner administration

| ID | Pri | Requirement (summary) | Owner (proposed) | Slice | Demonstration | Test | Unresolved decision |
|---|---|---|---|---|---|---|---|
| ENT-01 | P0 | Organisation, agreement, licence allocation, seat limit, access dates, allowed catalogue, managers. Five existing clients. | Product/Ops (Aayushi/Andre, TBC) + Finance | S5 | Load the five agreements from the approved (pseudonymised) contract summary. The seat counts reconcile. | TS-MIG (agreement reconciliation), TS-SEC | **DEC-12** |
| ENT-02 | P0 | Managers invite and assign permitted courses without a ticket. Block use beyond contract rules. | Product/Ops (Aayushi/Andre, TBC) | S5 | A manager invites up to the limit, and the next invite is refused with an explanation. A course outside the allowed catalogue can't be assigned. | TS-SEC, concurrency test (two parallel invites for the last seat) | DEC-12 |
| ENT-03 | P0 | Scoped learner status, completion, exam outcomes and CPD. CSV export with audit. | Aishwarya + Product/Ops | S10 | An Org A manager exports CSV. The export is audited, contains only Org A context enrolments, and never includes the learner's personal B2C purchases. | TS-SEC (export scope, CSV formula injection), TS-MIG (reconciliation) | DEC-23 |
| ENT-04 | P1 | Seat reassignment and rotation per agreed rules, renewal prompts, bulk upload. No invented floating-seat engine. | Product/Ops (Aayushi/Andre, TBC) + Finance | S15 | Reassign a seat per the contract rule. The history is preserved. Bulk upload validates and previews before commit. | TS-ACAD (history preserved), upload validation | DEC-32 |

## 5.5 Integration and entitlements

| ID | Pri | Requirement (summary) | Owner (proposed) | Slice | Demonstration | Test | Unresolved decision |
|---|---|---|---|---|---|---|---|
| INT-01 | P0 | Signed, versioned entitlement event: order ID, line ID, learner ID, product ID, action, effective time, access end, source, idempotency key. Never trust a browser callback. | Boris | S2 (fixture via the same command), S4 (endpoint) | Post a signed event from the WooCommerce staging adapter. Access is granted within 60 s. A tampered or replayed event is rejected and logged. | TS-EVT | DEC-10 (emitter owner or approach) |
| INT-02 | P0 | Purchase, cancellation/refund, manual grant, expiry and extension. Overdue instalment treatment per Finance. Store event, decision and result. | Finance + Boris | S4 | Show each action. The admin view shows event → decision → resulting entitlement, including an out-of-order refund-before-purchase. | TS-EVT (permutation property tests) | **DEC-11** |
| INT-03 | P0 | Versioned enrolment, progress/completion and assessment events to HubSpot through an outbox, with retries, DLQ and nightly reconciliation. Normally ≤ 5 minutes. | Boris + Aishwarya (fields) | S3 (first event), S11 (full set and reconciliation) | Complete a lesson and the event appears in the HubSpot sandbox. Kill the stub: it retries, lands in the DLQ, is replayed from the admin UI, and the reconciliation report is clean. | TS-OUT | **DEC-08** |
| INT-04 | P0 | Documented, authenticated, paginated APIs for identity links, catalogue, orgs, entitlements, enrolments and reporting. Explicit write permissions. | Boris | S1 onward (OpenAPI per slice) | The published OpenAPI spec, with a permission table per operation. A contract test runs against staging. | TS-SEC (every operation is in the permission table), contract tests | DEC-10 (which systems call which APIs) |
| INT-05 | P1 | Accredible issue, link and revoke status. Reconcile without duplicates. | Aishwarya + Boris | S11 | Completion → credential requested → sandbox issues it → link shown. Revocation flows through. A retry creates no duplicate. | TS-OUT | **DEC-24** |
| INT-06 | P1 | Hivebrite links a member to the same identity and relevant learning status under a documented privacy rule. No membership admin in the LMS. | Product/Ops (Aayushi/Andre, TBC) + Boris | S16 | A Hivebrite link-out to the LMS dashboard via SSO. If approved, a status field is shared per the privacy rule. | TS-SEC (only fields allowed by the rule) | **DEC-26** |

## 5.6 Reporting and operations

| ID | Pri | Requirement (summary) | Owner (proposed) | Slice | Demonstration | Test | Unresolved decision |
|---|---|---|---|---|---|---|---|
| OPS-01 | P0 | TCGI dashboard: active learners, enrolments, progress, completions, failed assessments, expiry and integration errors, filterable. | Aishwarya | S10 | The dashboard with filters. Each tile links to its underlying records. | Reconciliation tests (each tile = a transactional count query) | DEC-23 |
| OPS-02 | P0 | Report counts reconcile with transactions. Freshness is specified. Customer dashboards never expose another tenant. | Aishwarya + Finance | S10 | Run the reconciliation report. The freshness timestamp is shown on each report. | TS-SEC, reconciliation tests | DEC-23 |
| OPS-03 | P0 | Audited corrections: actor, reason, old and new value, approval where policy requires. Raw evidence is never modified invisibly. | Aishwarya + Boris | S9 | A support agent corrects a result. If policy needs it, it goes to approval. Raw SCORM and assessment evidence is unchanged, and the correction is layered on top. | TS-ACAD, DB tests (raw tables are append-only via grants and triggers) | DEC-33 |
| OPS-04 | P1 | Full export of customer-owned data in documented formats, to avoid lock-in. | Boris | S15 | Export an org and re-import it into an empty staging DB. Counts and checksums match. | TS-MIG round-trip | DEC-30 |

## Non-functional requirements derived from brief §3 and §6

These IDs are **derived** for traceability. They are not labelled like this in the brief.

| ID | Pri | Requirement | Owner (proposed) | Slice | Demonstration | Test | Unresolved decision |
|---|---|---|---|---|---|---|---|
| NFR-01 | P0 | EU hosting (Ireland preferred). Isolated dev, staging and prod. Infrastructure as code. | Boris | D5, S1 | An IaC plan showing the region for every resource. Environments are isolated (separate accounts). | Policy-as-code check in CI (region allow-list) | DEC-07 |
| NFR-02 | P0 | CI/CD, automated deploys, rollback, dependency and secret scanning. | Boris | S1 | A PR goes through the pipeline to staging. Roll back to the previous release. | Pipeline gates | — |
| NFR-03 | P0 | Backups, **tested** restore, central logs, uptime checks, incident escalation. | Boris | S1 (backups), S12 (drill) | A restore drill report with RPO and RTO measured. | TS-OPS | DEC-21 (RPO/RTO, on-call) |
| NFR-04 | P0 | 99.9% monthly availability objective, monitored. | Boris + Finance | S12 | The SLO dashboard and alert routing. | Synthetic checks | **DEC-21** |
| NFR-05 | P0 | WCAG 2.1 AA for the platform. Rise content tested separately. | Aishwarya | Every slice, S12 audit | Independent audit findings closed. | TS-A11Y | DEC-27 |
| NFR-06 | P0 | OWASP ASVS baseline, and an independent security test before production. | Boris | Every slice, S12 pen test | Pen test report, with critical and high findings closed. | TS-SEC, SAST/DAST | DEC-27 |
| NFR-07 | P0 | No real learner or payment data in coding tools without approved handling. | Boris | Continuous | A data-handling procedure, and synthetic or pseudonymised fixtures only. | Secret and PII scanning in CI | DEC-09 |
| NFR-08 | P1 | Page performance measured at agreed concurrency and network conditions (not an unconditional 2 s). | Boris | S12 | A load test report against the agreed profile. | k6 (or equivalent) load test | DEC-21 (profile) |
| MIG-01 | P0 | Every in-progress learner has verified granular progress *or* an agreed transition path. Exceptions register. | Product/Ops (Aayushi/Andre, TBC) + Aishwarya | D3–D4 spike, M1–M3, S15+ | A pilot migration with a zero-critical exceptions register. | TS-MIG | **DEC-28**, DEC-29 |

## Out of scope (P2)

| ID | Note |
|---|---|
| ENT-05 | Partner portals, commission, sophisticated licensing, client-created pathways. The data model keeps `Organisation.kind` extensible, but nothing gets built. |
