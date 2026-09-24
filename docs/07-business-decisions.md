# 07 — Business decisions needed, with the dates they block delivery

Status: **For circulation.** "Needed by" is the latest date that keeps the baseline plan in [05](05-delivery-backlog.md). In most cases that's two weeks before the dependent slice starts, with longer lead time where procurement or third parties are involved. If a date is missed, the dependent slice is swapped or slips, and the critical path is recomputed.

**Owner note (C-02, updated 24 Sep 2026):** functional spec v3.0 §6 defines the roles:
- **Aayushi:** Head of Operations and Project Manager. She owns ops, migration, pilot and comms decisions.
- **Andre:** Product Manager. He owns catalogue, product and experience decisions.
- **Aishwarya:** LMS Manager. She owns LMS rules and UAT.
- **Boris:** Head of Tech. He owns integration and security.
- **Anthony:** final sign-off authority. The prompt didn't list him.

Owners below follow those roles. Boris should confirm the allocation (DEC-00). A **data-protection lead** is still unnamed.

## Master register

| ID | Decision | Owner(s) | Needed by | Blocks | If late or undecided |
|---|---|---|---|---|---|
| DEC-00 | Confirm the role-based allocation below (from spec §6), confirm which gates need **Anthony's** final sign-off (budget, go/no-go), and name the data-protection lead | Boris | **Fri 9 Oct 2026** | All sign-offs | Decisions stall. Nothing proceeds on assumed authority |
| DEC-01 | Brightspace 2027 bridge: renewal or extension term, overlap through the Q3 parallel run, notice conditions, **data export rights** | Finance + Aayushi | **Fri 30 Oct 2026**, or the contractual notice date if earlier (unknown) | Everything. Continuity (C-01). Migration spike M-c | **Stop.** No build award (brief §9) |
| DEC-02 | Approved cost envelope for external build and migration (brief range €150k–€350k is a hypothesis only) | Finance | Fri 27 Nov 2026 | Supplier contract, D5 onward | No build award |
| DEC-03 | Supply ≥ 2 **sanitised** real Rise exports (≥ 1 SCORM 1.2, ≥ 1 SCORM 2004, ≥ 1 with a quiz), with permission to use them in development tooling | Aishwarya | **Fri 16 Oct 2026** | D2 runtime PoC, then S2 | The runtime decision slips one-for-one |
| DEC-04 | Content inventory and **unit of reuse**: are microlessons separate packages, or embedded? Launch settings, multi-SCO usage | Aishwarya + Andre | Fri 27 Nov 2026 | DEC-13 (single- vs multi-SCO), CAT-02 model in S2 | ContentItem is modelled at package granularity. Reuse is limited (C-03) |
| DEC-05 | Approve the architecture ADRs 0001, 0003–0006 (stack, hosting approach, tenancy, identity, events) | Boris | Fri 16 Oct 2026 | Discovery build-out, supplier briefing | Supplier proposals aren't comparable |
| DEC-06 | miniOrange: protocol (OIDC or SAML), **sandbox tenant**, stable subject attribute, verified email claim, logout and deactivation, whether B2C self-registration and email-based claiming are allowed, staff MFA | Boris | Facts by Fri 13 Nov 2026. **Sandbox live by Fri 11 Dec 2026** | S1 (Phase B sign-in), ID-01, ID-03, ID-04 | Phase B can't show real sign-in. **A mock IdP won't be presented as miniOrange** |
| DEC-07 | Hosting provider, EU region, TCGI-owned account structure, CDN policy, data-protection acceptance (ADR-0003) | Boris + Finance | Fri 27 Nov 2026 | D5 provisioning, S1 staging | No staging in Phase B. Local-only demo, labelled so |
| DEC-08 | HubSpot: sandbox or developer test account, object model (contact property, custom object or timeline), field allow-list, matching key, retry limits | Boris + Aishwarya | Sandbox by **Fri 15 Jan 2027** (S3). Full mapping by Fri 7 May 2027 (S11) | S3 event, S11 full integration | S3 uses a local stub, labelled *simulated* |
| DEC-09 | Data-handling route for the migration spike (extraction inside TCGI's environment, pseudonymisation, who runs it) | Boris + data-protection lead | **Fri 30 Oct 2026** | D3–D4 spike Step 5 | Only the synthetic-learner steps run. The real-cohort evidence slips |
| DEC-10 | WooCommerce entitlement **producer**: who builds it (TCGI's WordPress maintainer or the supplier), approach (a plugin emitting our contract, or an adapter on native Woo webhooks), staging store, emitter latency SLO, read-only reconciliation export, unclaimed-entitlement policy | Boris + Aayushi | Fri 15 Jan 2027 | S4 | Purchase-to-access can't be demonstrated. S4 swaps with S5 |
| DEC-11 | Commerce rules: full or partial refund, cancellation, chargeback, **instalment default** (suspend or revoke?), extension types, manual grants, re-purchase on a refunded line | Finance | Fri 29 Jan 2027 | S4 derivation rules R-1 to R-7 | Partial refunds and instalment events are held for manual review |
| DEC-12 | Enterprise agreements for the 5 clients: seat limits, access periods, allowed catalogue, manager assignments, invite rules, renewal dates (a pseudonymised summary is fine) | Aayushi + Finance | Fri 12 Feb 2027 | S5 | S5 slips. **Contract rights aren't invented** |
| DEC-13 | SCORM runtime selection, based on the D2 and D4 evidence and a vendor quote if commercial (ADR-0002). Includes whether to buy an external SCORM specialist review | Boris + Finance | Fri 11 Dec 2026 | S2 (launch) | **Critical path.** Phase B slips one-for-one |
| DEC-14 | (a) Spike course. (b) Pilot cohort: one self-paced B2C product and one enterprise client | Aayushi + Aishwarya | (a) **Fri 16 Oct 2026**. (b) Fri 29 Jan 2027 | (a) D2–D4. (b) Prioritisation of S4–S11 and M1 | (a) The spike isn't representative. (b) Scope can't be trimmed to the pilot |
| DEC-15 | Summative assessments: stay inside Rise (client-reported scores) or move to a **native server-scored engine** for diplomas (C-04, T-11) | Aishwarya + Andre | Fri 29 Jan 2027 | S8 scope, estimates, ADR-0001 re-check | S8–S9 capacity is held. The pilot excludes diploma-bearing assessment |
| DEC-16 | Assessment rules per launch diploma: randomisation, pass marks, attempt limits, resits, moderation, classification, relaunch policy | Aishwarya | Fri 26 Mar 2027 | S8–S9, the R7 test | **Nothing is coded without these rules.** S8 swaps with S10 |
| DEC-17 | Historical transcript: show pre-migration HubSpot results in the LMS (read-only), link out, or leave out (C-10) | Andre + Aishwarya | Fri 7 May 2027 | S11 transcript | Default: LMS-era records only |
| DEC-18 | Launch taxonomy and tiers. Review and approval roles for publishing | Andre | Fri 26 Feb 2027 | S6 | Minimal tags only |
| DEC-19 | Versioning policy: which cohorts get a new version. Prior-mastery transfer across products and versions (CAT-04, CAT-05) | Aishwarya | Fri 26 Feb 2027 | S6 (pinning UI), S7 (transfer rules) | Default: pinned to the enrolment version, no automatic credit transfer |
| DEC-20 | Accept the pilot starting **June** 2027 (plan) rather than May (brief), or fund extra capacity or narrow the pilot scope (C-05) | Aayushi + Finance + Boris; Anthony signs off | Fri 27 Nov 2026 | Supplier staffing | The plan in 05 stands, with zero float |
| DEC-21 | Availability commitment (99.9%?), RPO and RTO, support hours, on-call and escalation model, load-test profile (C-06) | Finance + Boris | Fri 30 Apr 2027 | S12 go/no-go | No contracted SLO for the pilot. Best-effort support only |
| DEC-22 | CPD rules: credit per course, unit, awarding condition, date basis, org totals | Aishwarya | Fri 9 Apr 2027 | S9 | CPD isn't awarded in the pilot |
| DEC-23 | Reporting definitions (for example "active learner"), freshness expectations, reconciliation sample and sign-off | Aishwarya + Finance | Fri 23 Apr 2027 | S10 | Reports ship without signed definitions and can't be accepted |
| DEC-24 | Accredible: issuance and revocation policy, sandbox access, which results trigger issuance | Aishwarya + Boris | Fri 7 May 2027 | S11 | Credentials stay manual for the pilot |
| DEC-25 | Messaging: consent and opt-out policy, lawful basis, sending channel (HubSpot or an LMS mailer), templates | Aayushi + data-protection lead | Fri 18 Jun 2027 | S14 (LRN-07) | No automated messages are sent |
| DEC-26 | Hivebrite: whether to link, the SSO link-out, which learning status may be shared, and the privacy rule | Andre + Boris | Fri 16 Jul 2027 | S16 (INT-06) | A link-out only, with no data sharing |
| DEC-27 | Independent pen test and accessibility audit: budget, supplier, booked dates (late May to June 2027) | Finance + Boris | **Fri 26 Feb 2027** (for booking lead time) | S12 go/no-go | **No production release** (brief §9) |
| DEC-28 | Transition policy per course when granular transfer isn't possible (06 §6). Extension allowances. Learner communications | Aayushi + Aishwarya | Preliminary Fri 15 Jan 2027 (after the spike). Final Fri 9 Apr 2027 | M1–M3, pilot | Migration tooling can't be finalised |
| DEC-29 | Parallel-run rules: source-of-truth timestamp per cohort, change freeze or delta capture, Brightspace access removal criteria | Aayushi + Aishwarya | Fri 7 May 2027 | M3 dry run 2, waves | No cutover |
| DEC-30 | Data retention (audit, raw SCORM, exports), OPS-04 export formats, deletion requests | Boris + data-protection lead | Fri 2 Jul 2027 (retention for backups needed by S1: provisional default of 35 days PITR plus agreed logical backups) | S15 (OPS-04) | A provisional retention policy applies, flagged |
| DEC-31 | Enterprise branding and per-org catalogue visibility rules | Andre | Fri 4 Jun 2027 | S13 (ID-05) | Default TCGI branding |
| DEC-32 | Seat reassignment and rotation rules per contract, bulk upload format | Aayushi + Finance | Fri 2 Jul 2027 | S15 (ENT-04) | Reassignment done by TCGI support only |
| DEC-33 | Support-agent data scope and correction permissions. Which academic corrections need second-person approval | Aishwarya + Boris | Fri 12 Feb 2027 | S5 (roles), S9 (corrections) | Support gets read-only access, and all corrections need approval |
| DEC-35 | Enterprise-admin self-service **learning-path authoring** inside their tenant (spec §3.2) versus the brief's ENT-05 (P2). Is it needed for launch clients? | Andre + Aayushi | Fri 12 Feb 2027 | S5–S7 scope | Default is the brief: TCGI authors paths and managers assign them |
| DEC-34 | IP, source-code and infrastructure ownership, TCGI-owned repo and cloud accounts, handover and escrow terms (brief §9) | Finance + Boris | Fri 27 Nov 2026 | Supplier contract, D5 | No supplier access to accounts |

## By person

### Boris (integration and security architecture, acceptance)
DEC-00, DEC-05, DEC-06, DEC-07, DEC-08, DEC-09, DEC-10, DEC-13, DEC-20, DEC-21, DEC-24, DEC-26, DEC-27, DEC-30, DEC-33, DEC-34.
**The earliest are DEC-00 (9 Oct), DEC-05 (16 Oct) and DEC-09 (30 Oct).**

### Aishwarya (LMS rules and UAT)
DEC-03, DEC-04, DEC-08, DEC-14, DEC-15, DEC-16, DEC-17, DEC-19, DEC-22, DEC-23, DEC-24, DEC-28, DEC-29, DEC-33.
**The earliest are DEC-03 and DEC-14a (16 Oct).**

### Finance
DEC-01, DEC-02, DEC-07, DEC-11, DEC-12, DEC-13, DEC-20, DEC-21, DEC-23, DEC-27, DEC-32, DEC-34.
**The earliest is DEC-01, the Brightspace bridge (30 Oct or the notice date).**

### Aayushi (Head of Ops and PM)
DEC-01, DEC-10, DEC-12, DEC-14, DEC-20, DEC-25, DEC-28, DEC-29, DEC-32.
**The earliest are DEC-14a (16 Oct) and DEC-01 (30 Oct).**

### Andre (Product Manager)
DEC-04, DEC-15, DEC-17, DEC-18, DEC-26, DEC-31, DEC-35.
**The earliest is DEC-04 (27 Nov).**

### Anthony (final sign-off)
DEC-02, DEC-20, and the S12 pilot go/no-go (to confirm under DEC-00).

### Data-protection lead (not named in the brief)
DEC-07 (acceptance), DEC-09, DEC-25, DEC-30.

## The next 5 weeks at a glance

| Date | Decisions due |
|---|---|
| Fri 9 Oct 2026 | DEC-00 |
| Fri 16 Oct 2026 | DEC-03, DEC-05, DEC-14a |
| Fri 30 Oct 2026 | DEC-01, DEC-09 |
| Fri 13 Nov 2026 | DEC-06 (facts) |
| Fri 27 Nov 2026 | DEC-02, DEC-04, DEC-07, DEC-20, DEC-34 |
