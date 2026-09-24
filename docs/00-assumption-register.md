# 00 — Assumption, conflict and gap register

Status: **Draft for senior-engineer review** · Baseline: `TCGI_LMS_MVP_Build_Brief_2027.md` (planning version 24 Sep 2026)

This register lists every assumption the Phase A documents rely on, the conflicts and gaps found in the brief, and the facts this repo does **not** have. Nothing here is a business decision. Each item points to the decision that resolves it in [07-business-decisions.md](07-business-decisions.md) (`DEC-xx`).

Rule for all later work: if an item is still `Open` when a slice needs it, the slice either waits or uses the "safe default" below, and the demo labels that behaviour as provisional. Where there is no safe default, the slice waits.

## A. Repository inspection (24 Sep 2026)

| Finding | Consequence |
|---|---|
| The repo has one commit holding only the brief. There is no code, package manifest, CI, infrastructure, `CLAUDE.md` or `docs/` convention. | This is a greenfield proposal. No framework is locked in (see ADRs, all at status *Proposed*). |
| The repo holds **no Rise SCORM packages**, sanitised or otherwise. | The SCORM runtime PoC (backlog D2) and Phase B are blocked until packages arrive (DEC-03). |
| No miniOrange, HubSpot, Accredible, WooCommerce or Brightspace sandbox credentials or documentation. | Identity, event and migration designs are based on the brief plus public standards. Vendor behaviour is marked *unverified*. |

## B. Assumptions (A-xx)

| ID | Assumption | Basis | Validate by | If wrong | Status |
|---|---|---|---|---|---|
| A-01 | miniOrange can act as an OIDC OP or SAML 2.0 IdP for a new service provider, and can issue a **stable, non-reassignable subject identifier** per person. | Brief §2 (miniOrange already federates Brightspace and Hivebrite). | DEC-06; sandbox test in S1 | If only email is available, ID-01 cannot be met as written. Needs an identity-linking redesign. | Open |
| A-02 | The same miniOrange subject is used for Brightspace and Hivebrite, so it can link a learner and a member without matching on email. | Brief §2, ID-03 | Export a sample of miniOrange user attributes (pseudonymised) | Account linking falls back to a verified-email invitation flow with manual review. | Open |
| A-03 | Rise courses are exported as **single-SCO** packages that don't rely on SCORM 2004 sequencing and navigation beyond the defaults. | Typical Rise export behaviour; not verified for TCGI | Content inventory (DEC-04) and manifest scan in D2 | The runtime needs full SCORM 2004 sequencing, which strongly favours a commercial engine (ADR-0002). | Open |
| A-04 | "Microlessons" may or may not be separate packages. We assume **nothing** until the inventory is done. | Brief §5.2, content-model decision | DEC-04 | If lessons are embedded in larger packages, the unit of reuse (CAT-02) is the package, not the lesson. | Open |
| A-05 | Only one party (TCGI's WordPress maintainer or the LMS supplier) can build a signed entitlement emitter or adapter on the WooCommerce side. The LMS team can't write to production WordPress. | Brief §1 boundary; operating rules | DEC-10 | INT-01 has no producer, and purchase-to-access can't be demonstrated. | Open |
| A-06 | Every enterprise learner belongs to exactly one of the five client organisations **per enrolment context**. A person can also hold B2C enrolments that their employer must not see. | Brief §4, §6 | Enterprise roster (DEC-12) | The tenancy model still holds, but the visibility rules need revisiting. | Open |
| A-07 | Supplier capacity is about 8 person-weeks per 2-week slice: tech lead 1.0, two full-stack engineers 2.0, and QA, UX/accessibility and DevOps/security about 1.0 combined. | Brief §8 team assumption | Supplier proposal | The backlog dates in 05 move. The critical path is recomputed. | Open |
| A-08 | High-stakes diploma assessment results must be defensible (auditable, not client-forgeable). | LRN-04 "secure result audit" | DEC-15 | If SCORM-reported scores are acceptable for diplomas, LRN-04 is smaller in scope. | Open |
| A-09 | Brightspace stays contractually available to affected learners through the Q3 2027 parallel run. | Brief header, §7 | DEC-01 | Continuity fails whatever we build. Stop and escalate. | Open |
| A-10 | HubSpot can receive LMS events into an agreed object model (contact property, custom object or timeline event). A HubSpot **sandbox or developer test account** is available. | INT-03 | DEC-08 | Phase B's "queue a HubSpot sandbox event" step is demonstrated against a local stub only and labelled *simulated*. | Open |
| A-11 | EU hosting means that primary data stores, backups, logs and processing sit in an EU region (Ireland preferred). Global CDN edge caching of **non-personal static SCORM assets** is acceptable. | Brief §6 | DEC-07 (Boris plus data-protection lead) | If not, the CDN must be restricted to EU edges, or dropped. | Open |
| A-12 | The team never handles real personal data outside TCGI-approved environments. The migration spike runs extraction inside a TCGI-controlled environment, and only pseudonymised output reaches engineers and coding tools. | Brief §6, operating rules | DEC-09 | The spike can't run until a handling route is approved. | Open |

## C. Conflicts and tensions found in the brief (C-xx)

| ID | Conflict | Why it matters | Proposed handling | Resolves via |
|---|---|---|---|---|
| C-01 | The Brightspace contract ends **31 Dec 2026**, but the migration is Q3 2027. | If there is no bridge, learners lose access before the new LMS exists. This is a hard stop, not a technical risk. | Treat the bridge as the first gate. No build award without it (brief §9). | DEC-01 |
| C-02 | The prompt names **Aayushi and Andre** as decision owners, but the brief never defines their roles. It only mentions a "named Product/Ops decision-maker". | Decisions can't be assigned with confidence. | In 07, decisions of the Product/Ops kind are marked "Aayushi / Andre — TBC". Please confirm who owns each one. | DEC-00 |
| C-03 | CAT-02 (independent reusable microlessons) may be impossible if lessons are embedded in larger Rise packages. | Adding catalogue records doesn't create reuse. | Prove the unit of reuse with real packages in D2. Model ContentItem at package granularity until then. | DEC-04 |
| C-04 | LRN-04 asks for "secure result audit", but SCORM scores are **reported by JavaScript running in the learner's browser** and can be forged. | A diploma result based only on `cmi.score` isn't tamper-evident. | Keep Rise quizzes for formative checks. Use a server-side assessment engine for summative, diploma-bearing assessments, if Product confirms (ADR-0002, threat T-11). | DEC-15 |
| C-05 | The brief's plan (pilot May–Jun 2027) versus a realistic P0 estimate at about 8 pw per slice. The P0 scope takes roughly S1–S11 (to 4 Jun 2027) *if* all decisions land on time. | Pilot readiness is on the critical path with no float. | The backlog (05) shows pilot entry in S12 (7 Jun 2027). The options are more capacity, a narrower pilot scope, or accepting a pilot starting in June. | DEC-20 |
| C-06 | 99.9% monthly availability (about 43 minutes of downtime a month) versus a single-region, small-team deployment with no funded on-call. | The 99.9% figure is a contractual commitment. It needs multi-AZ hosting, monitoring and a paid on-call rota. | Design for multi-AZ within one EU region. Price on-call separately (brief §8). | DEC-21 |
| C-07 | The budget: no funded in-house LMS build (2027 straw man) versus €150k–€350k of external spend (brief §2, §8). | Phase B can't start without an approved envelope. | We estimate in person-weeks only. Finance prices them. **No prices are invented here.** | DEC-02 |
| C-08 | INT-02 "overdue instalments" versus instalments owned by WooCommerce and payment providers. | The LMS can't see payment state unless an event is emitted for it. | The LMS acts only on explicit `entitlement.suspended` or `revoked` events from commerce. It never polls payment status. The policy comes from Finance. | DEC-11 |
| C-09 | Phase B requires a **staging deployment**, but no hosting provider or account is approved. | Operating rules forbid locking hosting without approval. | ADR-0003 proposes options. Staging waits for DEC-07. | DEC-07 |
| C-10 | "Unified transcript view" (brief §2) versus HubSpot staying authoritative for about 2,000 historical completions, which are out of scope for migration. | A learner may expect to see old results in the LMS. | Default: the LMS shows only LMS-era records, plus a read-only link-out if approved. | DEC-17 |
| C-11 | The 5-minute revocation target depends on how fast WooCommerce emits events, which the LMS doesn't control. | We can only measure the latency from receiving an event to the access change. | The LMS SLO is "≤ 60 s from a valid event received to access changed". The end-to-end 5 minutes requires an emitter SLO. | DEC-10 |
| C-12 | The prompt asks the migration spike to test "real active Brightspace learner progress", but the operating rules forbid real personal data. | Both can't be satisfied unless the data is handled inside TCGI. | A12 above: TCGI runs extraction in its own environment, pseudonymises, and shares only structural findings and hashed IDs. | DEC-09 |

## D. Facts we don't have and must not invent

The following have **not** been invented anywhere in these docs. Each shows as a placeholder or an open decision:

- Examination rules, pass marks, attempt limits, resit rules, moderation and classification (LRN-04). Waits for DEC-15 and DEC-16.
- Prices, licence fees, hosting costs, supplier rates. Estimates are in person-weeks only.
- The miniOrange subject identifier claim or attribute name, and its entity or issuer IDs.
- Consent or opt-out policy for messaging (LRN-07), and privacy rules for sharing with Hivebrite (INT-06).
- Enterprise licence rights: seat limits, reassignment and rotation, allowed catalogue, access periods.
- Guarantees that migrated progress will resume. The spike (06) establishes whether this is feasible.
- The HubSpot object model and field names, and the Accredible issuance policy.
- Whether Rustici SCORM Cloud and Rustici Engine can be hosted in the EU, and what they cost. Both need a vendor quote.
