TCGI LMS MVP build brief and AI development prompt

Planning version: 24 September 2026
Decision status: Working scope for supplier estimates and technical discovery. No build contract or architecture has been approved.
Proposed delivery: Renew or extend Brightspace for continuity; develop an owned LMS over approximately six to eight months; pilot and migrate in Q3 2027 when acceptance gates are met. A calendar launch date must never override learner continuity.

1. Decision and product boundary

TCGI will evaluate three routes for its 2027 learning service: continue with Brightspace, implement LearnUpon, or build a TCGI-owned LMS with an outsourced engineering team. This document defines a credible LMS-only first phase for comparable estimates. It is not a commitment to replace ecommerce, Hivebrite membership/community or the public WordPress website in 2027.

The long-term intent is one coherent TCGI customer experience and, if justified, a unified commerce, membership and learning platform. Phase 1 should make that future technically possible through clear boundaries for identities, catalogue, entitlements, transactions and learning events. It must not absorb the cost and schedule of building those future products now.

Phase 1 owns

Learner accounts within the LMS, federated sign-in from the existing miniOrange identity provider.

Organisations, enterprise client separation, roles and permissions.

Course catalogue, Rise/SCORM packages, learning paths and modular content relationships.

Enrolment and time-bound access, B2C and enterprise seats.

Learner progress, basic assessments, results, CPD and links to Accredible credentials.

Administrator and enterprise manager workflows, operational reporting and exports.

Reliable APIs/webhooks and the minimum purchase/refund/renewal access integration with the existing WordPress/WooCommerce stack.

Migration of all active enterprise learners and confirmed active B2C learners, subject to a tested progress-continuity plan.

Phase 1 does not own

Public website, SEO content, lead forms, course checkout, VAT calculation, multi-currency price presentation, instalments, payment collection or refunds. These remain with WordPress/WooCommerce and payment providers during Phase 1.

Paid membership plans, community, directories, networking, events, member resources and Hivebrite billing/administration. Hivebrite remains the membership platform.

Identity provider replacement; miniOrange remains the identity provider unless a later decision changes it.

Historical completion migration for approximately 2,000 completed learners whose authoritative grades, completion dates and Accredible links remain in HubSpot.

Rebuilding Accredible certificate issuance, a native ecommerce store, native membership/community, mobile apps, AI recommendations, semantic search, adaptive pathways, proctoring or a general-purpose course authoring tool.

Boundary rule: The LMS must receive and reconcile entitlement-changing events, but it must not become the payment system. A future commerce or membership module can emit the same contract of events without rewriting course delivery.

2. Source facts and unresolved inputs

Item

Known position

Discovery action

Brightspace

Current contract ends 31 December 2026 in the July functional spec; 2026 fee €26,014.

Obtain written 2027 renewal/extension terms, notice conditions, overlap and export rights.

Enterprise learners

152 active seats across five clients; staggered one-year contracts.

Obtain current roster, tenant structures, access/expiry dates and expected Q3 2027 volume.

B2C migration

Active or in-progress learners move; exact count is not yet in the supplied specification.

Establish counts by course, status, extension and access end date.

Completed history

About 2,000 historical users' results and credential links are recorded in HubSpot.

Confirm completeness, ownership and whether learners need a unified transcript view.

Content

Approximately 400 microlessons; Articulate Rise packages published as SCORM 1.2/2004.

Inventory package granularity, launch settings, assessments, suspend data, reuse and current catalogue mapping.

Certificates

Accredible is the current issuer.

Specify create, revoke, link and reconciliation events; retain existing issuance policy.

Identity

miniOrange provides identity; Brightspace and Hivebrite are service providers.

Confirm SAML/OIDC setup, subject identifier, account linking and logout behaviour.

Commerce

WordPress/WooCommerce and existing payment integrations provide purchases.

Map purchase, refund, instalment default, renewal, extension and manual order paths.

The functional specification contains an ambitious vendor end-state, including native ecommerce, AI and broad content management. This MVP narrows it deliberately. The 2027 business plan has a two-person Tech salary envelope of €124,572 and no funded in-house LMS build, so the outsourced budget, internal Product/Ops time and Brightspace overlap must be presented as explicit additions to the plan.

3. Outcomes and measures

The MVP should be accepted only if it can safely serve a real TCGI B2C course and a real enterprise client. The measures below are proposed acceptance thresholds, not measured 2026 baselines.

Outcome

Acceptance measure

Evidence

Reliable learner access

100% of reconciled eligible pilot learners can sign in and access the correct content; no cross-tenant access in penetration tests.

Migrated roster reconciliation, access tests and independent security review.

Content continuity

All designated pilot Rise packages launch, resume, complete and report the correct score/status on desktop and mobile.

Package compatibility matrix and end-to-end tests.

Enterprise administration

A customer manager assigns available seats, selects permitted courses and sees only their organisation's learners and reports.

Scripted customer-admin acceptance session.

Purchase-to-access

Eligible purchase grants access and qualifying refund/revocation removes it within five minutes; duplicate/out-of-order events do not create duplicate entitlements.

Integration logs and automated event tests.

Reporting

Learner, course, assessment, CPD and organisation exports reconcile with source records; audit history exists for changes.

Sample reconciliation signed by Aishwarya and Finance/Product.

Continuity at cutover

Every in-progress learner has either verified granular progress in the new LMS or a documented, agreed transition path with no unfair loss of study or assessment entitlement.

Learner-level migration exceptions register and pilot sign-off.

Availability

Contracted service objective of at least 99.9% monthly availability, with monitoring and tested restore.

Monitoring evidence, incident procedure and restore drill.

Operational speed targets, such as a two-second page response, should be measured at agreed concurrency and network conditions during discovery rather than accepted as an unconditional promise.

4. Users, roles and journeys

Learner: SSO sign-in, see eligible products, resume learning, complete lessons and assessments, see progress/CPD/results, follow a certificate link, download a transcript, and understand access deadlines.

TCGI LMS administrator: create a course from approved content, define an access window, enrol or extend a learner, manage exceptions, review assessment outcomes, issue/reconcile credential events, inspect logs and export reports.

TCGI Product editor: draft a catalogue item or pathway, tag it with topic, role, level, product tier and CPD, submit it for review and publish an approved version without altering a live version unexpectedly.

Enterprise manager: allocate contracted seats, invite/reassign learners within agreed rules, choose approved catalogue content for their organisation, review team progress/CPD and export permitted records.

TCGI support agent: view a learner's access history and integration errors, apply authorised corrections with a reason and audit log, without obtaining unrestricted organisation data.

Integration service: provision/revoke access from trusted purchase, refund and renewal events; publish completion and assessment events to HubSpot; reconcile failed deliveries.

Permissions must be designed as scoped capabilities, not simply an is_admin flag. Organisation A users must never enumerate Organisation B users, courses, purchase entitlements or reports by changing a URL or API parameter.

5. Functional requirements

Each requirement needs a demonstration, test and named acceptance owner. P0 is mandatory for pilot/production; P1 is required before broad Q3 migration if applicable to affected courses; P2 is a later enhancement.

5.1 Identity and organisation boundaries

ID

Priority

Requirement and acceptance

ID-01

P0

Support miniOrange as external identity provider through an agreed SAML 2.0 or OIDC flow. Map an immutable subject identifier and verified email; do not identify accounts by mutable email alone.

ID-02

P0

Create TCGI staff, B2C learner and organisation-scoped enterprise roles. Enforce role and tenant checks in APIs, database queries and downloads.

ID-03

P0

Provide invitation and account-linking flows for migrated users; avoid duplicate identities where the same person is a learner and a member.

ID-04

P0

Support deactivation and account recovery through the identity provider; log authentication and permission changes.

ID-05

P1

Provide distinct branding and catalogue visibility per enterprise organisation, with no client data leakage. Custom domains can follow later.

5.2 Content, catalogue and course delivery

ID

Priority

Requirement and acceptance

CAT-01

P0

Import, validate, launch and track a representative set of Rise SCORM 1.2 and 2004 packages. Test completion, success, score, attempts, suspend/resume and relaunch. Do not hand-roll a SCORM runtime without a reviewed specialist implementation decision.

CAT-02

P0

Represent reusable microlesson identity and immutable published version separately from placements in courses and learning paths. A lesson appears in two products without uploading two independent copies.

CAT-03

P0

Support product tiers (microlesson, foundation, professional certificate, advanced certificate, diploma) and independent topic, competency, role, CPD and format tags. Start with taxonomy needed by launch products; import the rest in planned batches.

CAT-04

P0

Provide course/path sequence, prerequisites and completion rules. Define whether prior mastery transfers across products and versions; never silently count the same learning twice or erase history.

CAT-05

P0

Provide draft, review, approve and publish states. Publishing a new version preserves in-progress learner records and makes a deliberate decision on which cohort receives it.

CAT-06

P1

Search/filter by title, topic, role, competency, level and product tier for appropriate learner/manager audiences.

CAT-07

P1

Support PDFs, video, articles and external resources alongside SCORM, with accessibility metadata.

Content-model decision before implementation: determine whether the 400 microlessons exist as separate exportable Rise packages or are embedded inside larger SCORM packages. The latter cannot be treated as independently reusable lessons merely by adding catalogue records. The pilot must use real packages and prove the proposed unit of reuse.

5.3 Learning, assessment and CPD

ID

Priority

Requirement and acceptance

LRN-01

P0

Track per learner, per content version and per enrolment: not started, active, completed, passed/failed, timestamp, score and attempt. Preserve raw SCORM state for reliable resume.

LRN-02

P0

Show a learner dashboard with next action, progress, access end date, course outcomes and responsive mobile layout.

LRN-03

P0

Support time-bound access, cohorts with start/end dates, extensions and individual exception handling with reason, actor and timestamp.

LRN-04

P0

Support the actual assessment patterns used by launch diplomas: randomised question selection where required, course-specific pass mark, attempt limits, resits and secure result audit. Validate existing exam moderation and qualification classification rules with Product before coding.

LRN-05

P0

Maintain CPD credit per approved completion and expose learner and organisation totals by date range. Prevent duplicate awards for duplicate events or repeated package launches.

LRN-06

P1

Generate downloadable CPD transcript and display Accredible credential status/link; do not claim a credential was issued until acknowledged by Accredible.

LRN-07

P1

Send configurable deadline, inactivity and completion messages with opt-out/consent rules and delivery logs.

5.4 Enterprise and partner administration

ID

Priority

Requirement and acceptance

ENT-01

P0

Model organisation, agreement, licence allocation, seat limit, access start/end, allowed catalogue and manager assignments. Start with the contracts for five existing clients.

ENT-02

P0

Allow managers to invite learners and assign permitted courses without a TCGI support ticket; block use beyond contract rules.

ENT-03

P0

Show scoped learner status, completion, examination outcomes and CPD, with CSV export and audit.

ENT-04

P1

Support agreed seat reassignment and rotation rules, expiry/renewal prompts and bulk upload. Do not invent a generic consumption or floating-seat engine unless an existing contract needs it for launch.

ENT-05

P2

Partner-branded portals, commission/revenue attribution, sophisticated licensing and client-created pathways after partner product rules are specified.

5.5 Integration and entitlements

ID

Priority

Requirement and acceptance

INT-01

P0

Accept a signed, versioned entitlement event from the existing commerce integration: external order ID, line ID, learner ID, product ID, action, effective time, access end, source and idempotency key. Never trust a browser callback as payment proof.

INT-02

P0

Handle purchase, cancellation/refund, manual grant, expiry and extension; define treatment of overdue instalments with Finance/Operations. Store the event, decision and resulting entitlement for audit.

INT-03

P0

Publish versioned enrolment, progress/completion and assessment events to HubSpot using a queue/outbox with retries, dead-letter review and nightly reconciliation. Target normal delivery within five minutes.

INT-04

P0

Provide documented, authenticated, paginated APIs for learner identity linkage, catalogue, organisations, entitlements, enrolments and reporting. Explicitly define which writes are permitted and by whom.

INT-05

P1

Integrate with Accredible for issue/link/revocation status where existing certificate policy requires it; reconcile failures without creating duplicate credentials.

INT-06

P1

Allow Hivebrite to link a member to the same identity and to relevant learning status under a documented privacy rule. No membership administration in the LMS.

Use stable external identifiers. Event processing must be idempotent and safe when messages arrive twice, late or out of order. The authoritative purchase/refund record stays in the commerce system; the LMS is authoritative for current learning access and progress. HubSpot remains authoritative for pre-migration historical results and receives agreed new events.

5.6 Reporting and operations

ID

Priority

Requirement and acceptance

OPS-01

P0

TCGI dashboard: active learners, enrolments, progress, completions, failed assessments, access expiry and integration errors, filterable by date/product/organisation.

OPS-02

P0

Reconcile each report count with transactional records and specify freshness; customer dashboards must not expose another tenant.

OPS-03

P0

Provide audited administrative corrections without modifying raw evidence invisibly. Corrections have actor, reason, old/new value and approval where academic policy requires it.

OPS-04

P1

Export complete customer-owned data in documented formats, including users, enrolments, attempts, progress, CPD, entitlements and audit history, so TCGI is not locked into its own contractor.

6. Data model and architecture constraints

The implementation team must propose and validate a relational model covering: IdentityLink, Learner, Organisation, OrganisationMembership, RoleGrant, CommercialProductReference, Course, ContentItem, ContentVersion, CoursePlacement, LearningPath, Enrolment, Attempt, ProgressState, Assessment, Question, Result, CPDAward, Entitlement, SeatAllocation, Cohort, ExternalCredential, IntegrationEvent, DeliveryAttempt and AuditEntry.

The exact physical schema can differ, but these distinctions cannot disappear:

Identity vs entitlement vs enrolment vs progress: one person can have multiple products and organisation relationships without duplicate accounts.

Content object vs published version vs placement: shared content can change safely while preserving earlier learner records.

Purchase proof vs access decision: an external paid order drives a controlled entitlement event; access is not inferred from a UI redirect.

Organisation scope: every client-owned record is scoped at both API and persistence layers.

Event/outbox and audit: external failures are retriable and visible, and corrections do not erase provenance.

Proposed implementation shape for estimation: TypeScript web application and API, PostgreSQL, managed object storage/CDN for packages and files, managed background jobs/queue, monitored hosting in an EU region, infrastructure as code and CI/CD. This is a candidate stack, not permission to choose libraries without reviewing TCGI's supportability, security and contractor handover. A specialist SCORM runtime or service may be licensed if the proof of concept shows that is safer and faster; the supplier must show ownership, portability, hosting and recurring cost implications. Stripe, HubSpot, Hivebrite and Accredible remain separate services.

Provide isolated development, staging and production environments, automated deployments, rollback, backups, restore testing, secret management, dependency scanning, central logs, uptime checks and incident escalation. EU hosting is mandatory, with Ireland preferred where viable. Target WCAG 2.1 AA for the platform and test uploaded Rise content separately. Use OWASP ASVS as a security review baseline. No real learner or payment data should be sent to coding tools without approved handling.

7. Migration and cutover

Pilot cohort: One self-paced B2C product and one enterprise client, chosen to exercise real SCORM, assessment, manager, CPD and integration rules. Include learners who are part-way through content.

Inventory: Extract users, identities, organisations, current enrolments, access dates, attempt/results, SCORM package IDs and progress state. Reconcile counts and sample records before building transformation logic.

Progress proof: Test whether Brightspace exports the granular SCORM suspend/runtime state in a usable format and whether the new runtime can consume it. If not, define a learner-safe alternative per course: finish on Brightspace during overlap, transfer validated completed units, or grant equivalent extension/restart with support. Obtain Product/Ops approval and communicate it to affected learners.

Parallel run: Preserve Brightspace access for affected learners until completion or validated transfer. Avoid a hard cutover for staggered enterprise renewals and B2C extensions. Define a final source-of-truth timestamp and rules for changes during parallel run.

Reconciliation: Match learner IDs, product access, enrolment status, scores, CPD, credential links and customer rosters. Keep a named exceptions register. Do not switch a course until critical exceptions are resolved and rollback is rehearsed.

Exit: Retain an export/archive consistent with contracts and data policy, confirm read access for support/audit and only then retire Brightspace licences when contract permits.

8. Delivery plan and staffing

The following is a plausible six-to-eight-month implementation plan after a short discovery and contracted scope. It requires overlapping workstreams, outsourced delivery and timely product decisions.

Period

Delivery

Exit gate

Oct–Nov 2026

Approve Brightspace bridge; inventory requirements/data; test real SCORM packages and progress portability; choose architecture; seek fixed/estimated supplier proposals.

Signed scope, budget, bridge and proof-of-concept result.

Jan–Feb 2027

Identity, organisations, base catalogue, SCORM runtime, course/player and progress vertical slice; CI/CD and security foundations.

Real TCGI package launched, resumed and completed by test learners.

Mar–Apr 2027

Enrolment/entitlement integration, academic assessments, CPD, administrator and manager workflows, HubSpot events.

B2C purchase-to-learning and enterprise seat-to-report journeys pass in staging.

May–Jun 2027

Content batches, migration tooling, accessibility, security and load testing; pilot with real learners; support training.

Pilot completion and reconciled migration approved by Product/Ops, Tech and customer support.

Q3 2027

Phased product/client migration, parallel running, incident review and handover.

Cutover criteria satisfied per cohort, not one blanket go-live date.

Supplier team assumption: one senior technical lead accountable for architecture and code quality, two full-stack engineers, part-time QA automation, part-time UX/accessibility and DevOps/security support, with extra migration capacity around pilot/cutover. TCGI provides a named Product/Ops decision-maker, Aishwarya for LMS rules and UAT, Boris for integration/security architecture and acceptance, plus Finance for commercial rules. The supplier must identify named individuals, allocation and backup, not just promise an abstract team.

Budget hypothesis for procurement: approximately €150k–€350k of external build and migration spend for this tightly scoped LMS MVP, plus internal capacity, Brightspace overlap, hosting/runtime licences and independent security/accessibility review. This is a range for comparing supplier proposals, not a quote or approved 2027 budget. A supplier materially below it must explain reused components and excluded work; a supplier above it must show which requirements or risk controls drive the difference. A later membership/ecommerce build needs its own business case and funding.

After launch, price a retained support agreement, on-call response, security maintenance, infrastructure and enhancement capacity separately. Do not present build cost as the total cost of ownership.

9. Acceptance gates and supplier response template

The supplier should return:

Requirement-by-requirement response: native, proven third-party component, bespoke build, deferred or unsupported; demonstration evidence for each P0.

Architecture and system-of-record diagram, EU data flow, security model and SCORM runtime decision.

Working proof using at least two actual Rise exports and one incomplete learner scenario before full contract commitment.

Work breakdown with person-weeks, named roles, dependencies, assumptions, exclusions and monthly cash schedule.

Separate line items for discovery, build, SCORM/runtime licence, hosting, migration, testing, independent security review, support and future enhancement.

Brightspace migration method and explicit treatment of in-progress SCORM state.

Rights to source code, infrastructure configuration, documentation, data and deployment accounts; escrow/exit and handover terms where appropriate.

Security and privacy approach: EU processing, sub-processors, least privilege, incident notification, vulnerability remediation and independent test.

Demonstration plan and acceptance tests for B2C, enterprise, academic and integration journeys.

Change-control method and schedule impact when Product changes the catalogue or assessment policy.

Stop/go gates: No full build award until the Brightspace bridge is secured, actual content has passed a SCORM proof, Product has prioritised launch courses, Finance has approved a cost envelope, and TCGI has named people for weekly decisions. No production release until independent security/accessibility findings, backup restore and migration reconciliation pass.

10. Paste-ready master prompt for Claude Code

Use this prompt in a new, TCGI-owned Git repository with this brief and sanitised sample SCORM packages available to the engineering team. A senior engineer should own the repository, review every change and retain deployment authority. Replace bracketed paths with actual repository paths. Do not paste production credentials or live learner data.

You are the lead implementation agent working with TCGI's senior engineer and outsourced delivery team. Read [PATH_TO_THIS_BRIEF] in full and inspect the repository before proposing changes. Our immediate product is an owned LMS-only MVP targeting a controlled Q3 2027 rollout while Brightspace remains available. The public WordPress/WooCommerce store, Stripe payment processing, Hivebrite membership/community, miniOrange identity provider, HubSpot historical records and Accredible certificates remain in place. Do not build or replace those systems.

Operating rules:
- Work in small, reviewable vertical slices. Do not claim the entire LMS is complete after a scaffold or mock-up.
- First inspect the repo and dependencies. If the repo is empty, propose a maintainable architecture and ADRs. Do not lock a framework, SCORM runtime, hosting service or paid dependency without an alternatives and cost/portability assessment approved by a human.
- Treat this brief as the requirement baseline. Make an assumption register and flag conflicts or missing business decisions. Never invent examination rules, prices, identity identifiers, consent policy, enterprise licence rights or migration guarantees.
- Keep payments and membership outside the MVP. Implement only a documented, signed, idempotent entitlement event contract from existing commerce, and a link/integration to Hivebrite where approved.
- Use the existing external miniOrange identity provider. Enforce tenant isolation and role permissions in every API and data access path. Never accept a client-supplied organisation ID as authority.
- Use representative, sanitised Rise SCORM 1.2 and 2004 packages for a compatibility proof. Do not implement a toy SCORM player and label it compliant. Evaluate a specialist runtime/service and document licence, EU hosting, integration, export and test implications.
- Model ContentItem, immutable ContentVersion and CoursePlacement separately; also separate identity, entitlement, enrolment, progress, result and credential.
- Persist integration events, support retry and reconciliation, and produce audit trails for academic and access changes. Protect against duplicate and out-of-order events.
- Use EU-hosted environments, secrets management, CI, migrations, monitoring, backup/restore and accessible responsive components. Tests should cover security boundaries, academic rules, event idempotency and end-to-end learner flows rather than simply asserting that implementation functions return expected hard-coded values.
- Do not use live credentials, production APIs, real personal data or deploy to production. Stop for human approval before external writes or irreversible actions.

Start with Phase A only. Produce the following files in docs/ (or use the repository's existing conventions):
1. Requirements traceability matrix for every P0/P1 in the brief, with owner, demonstration, test and unresolved decision.
2. Architecture decision records comparing at least two viable stack approaches and SCORM runtime options.
3. Data model and tenant/role threat model.
4. Event contracts for purchase, refund, access extension, enrolment, completion, assessment and credential status, including idempotency and failure handling.
5. A delivery backlog broken into demonstrable two-week vertical slices, with dependencies, estimates, test gates and a critical path to Q3 2027.
6. Migration spike plan testing real active Brightspace learner progress and SCORM suspend data, with a fallback if granular transfer is impossible.
7. A list of business decisions needed from Aayushi, Aishwarya, Andre, Boris and Finance, with the date each decision blocks delivery.

Show the plan and the top five technical risks. Wait for senior-engineer approval of the architecture and business decisions before implementing Phase B.

After approval, Phase B is the first production-quality vertical slice: miniOrange sandbox sign-in -> scoped learner identity -> entitlement fixture -> course enrolment -> launch a real sanitised Rise SCORM package -> save/restore progress -> display completion -> queue a HubSpot sandbox event -> show an admin audit record. Implement schema migrations, automated security/integration tests, a staging deployment and a concise demo script. Report exactly what works, what was simulated, what is unverified and the next slice. Continue subsequent slices only after review and acceptance.

Why Claude Code

Claude Code is my first choice for this particular brief because it works against a real codebase, can make coordinated changes across files, run commands/tests and maintain project instructions in the repository. It is an engineering accelerator for the outsourced team, not the contractor or the accountable architect. A prompt-to-app tool can be useful for interface exploration, but it is not the primary production workflow for SCORM compatibility, tenant security, migration and operational support.

11. Sources and interpretation

TCGI LMS Functional Specification, supplied July 2026 version: Brightspace costs, dates, users, migration rules, functional and non-functional requirements.

TCGI Vendor Shortlisting Criteria, supplied workbook: criterion inventory. The workbook is incompletely scored and cannot currently establish a vendor winner.

TCGI 2027 Plan Straw Man, September 2026: cash, team, product and platform constraints; custom LMS not funded in its draft position.

Anthropic Claude Code product documentation: https://code.claude.com/docs/en/overview and https://code.claude.com/docs/en/best-practices

LearnUpon migration documentation (relevant to build-versus-buy acceptance, not a custom-platform capability claim): https://support.learnupon.com/hc/en-us/articles/360014905198-Migration-guide-moving-your-enrollment-histories-to-LearnUpon

OWASP ASVS: https://owasp.org/projects/asvs

WCAG 2.1 recommendation: https://www.w3.org/TR/WCAG21/

Planning limitation: No current Brightspace extension, LearnUpon proposal, outsourced supplier quote, validated active-B2C count or real-package SCORM proof was supplied with this brief. The budget and schedule are hypotheses to test, not promises.
