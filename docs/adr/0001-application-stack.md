# ADR-0001 — Application stack and architecture style

- Status: **Proposed** (awaiting Boris, DEC-05)
- Date: 2026-09-24

## Context

This is a greenfield repo. The brief (§6) offers a *candidate* shape for estimating (TypeScript web app and API, PostgreSQL, managed object storage and CDN, a managed queue, EU hosting, IaC, CI/CD) and states plainly that this is **not** permission to pick libraries without a supportability review. The team is outsourced and small (about 4 FTE), with handover to TCGI in view. The product mixes transactional work (entitlements, enrolments, results) with admin workflows and one browser-heavy area (the SCORM player).

Forces:

- Security boundaries have to be enforced in one place and be testable (ADR-0004).
- Handover: TCGI must be able to hire or replace the contractor. That favours mainstream, boring technology.
- The SCORM runtime API is JavaScript in the browser whatever we choose (ADR-0002).
- Assessment and gradebook features (LRN-04) are costly to build from scratch.

## Options

### Option A — TypeScript modular monolith (the brief's candidate shape)

- **Runtime:** Node.js LTS. One deployable, with an API and background-worker process type from the same codebase.
- **API:** An HTTP framework with explicit module boundaries, for example NestJS, or Fastify with our own module layout. The choice is made in S1 via a short spike and recorded as a sub-decision.
- **UI:** React, rendered server-side or as an SPA, with an accessible component base (for example React Aria, or Radix plus our own styles). Tested with axe-core.
- **Data:** PostgreSQL 16+, row-level security (RLS) as a second layer of tenant defence, and SQL-first migrations that can be reviewed (for example Kysely or Drizzle with plain SQL migration files, *or* Prisma). The sub-decision is recorded in S1 with RLS compatibility as the deciding test.
- **Jobs and outbox:** A Postgres-backed queue (for example Graphile Worker or pg-boss), so the outbox write and the business write share one transaction. No extra broker at MVP scale.
- **Contracts:** OpenAPI and JSON Schema generated from, or checked against, shared TypeScript types.

### Option B — Python/Django modular monolith

- Django plus Django REST Framework, PostgreSQL with RLS, Celery or a Postgres-backed queue, and React only for the learner player and dashboard, with Django templates plus HTMX for admin screens.
- Strengths: mature migrations, auth and admin scaffolding, and fast admin CRUD.
- Weaknesses: two languages (Python server, TypeScript player). Django admin needs strict hardening to be tenant-safe, because it bypasses our policy layer if used carelessly.

### Option C — Customise an open-source LMS (Moodle with a multi-tenant layer such as IOMAD, or Moodle Workplace)

- Strengths: mature quiz engine (randomised question banks, attempts, gradebook), SCORM player, and reports. Fastest route to LRN-04 feature coverage.
- Weaknesses: multi-tenant isolation depends on a plugin or distribution rather than a core design. Customisations pile up upgrade debt. SCORM 2004 support in Moodle is documented as incomplete (verify against the current version). PHP and plugin skills are a different hiring pool. The entitlement and event contracts become plugins. It is weaker as the foundation of the brief's long-term "unified platform" intent.
- **Note:** this option is essentially "buy/adopt" in disguise and belongs in the same build-vs-buy comparison as LearnUpon and Brightspace. It is included here so the architecture choice isn't made in isolation.

### Rejected early: microservices

At about 4 engineers and this scope, separately deployed services add distributed-transaction and ops cost with no isolation benefit that RLS plus module boundaries don't already give. Integration adapters (the WooCommerce adapter, the HubSpot and Accredible publishers) are modules inside the monolith's worker, and could be split out later.

## Assessment

| Criterion | A: TS monolith | B: Django monolith | C: Moodle + tenancy layer |
|---|---|---|---|
| P0 fit (entitlements, events, tenancy) | Strong. Built to the contract | Strong | Medium. Needs plugins, and tenancy is bolted on |
| P0 fit (assessments LRN-04) | Build (S8–S9). Scope depends on DEC-15 | Build | **Strong** (native quiz) |
| SCORM | Via ADR-0002 runtime, shared language | Via ADR-0002. Player in TS anyway | Native 1.2. 2004 partial |
| Tenant isolation assurance | High (single policy layer plus RLS) | High (same pattern) | Medium. Depends on the plugin's correctness |
| Supportability and handover | Large hiring pool. Framework churn is a risk, mitigated by boring choices | Large pool. Stable framework | Niche PHP/Moodle skills. Upgrade burden |
| Portability and exit | Full ownership. Standard Postgres | Full ownership | Open source, but a Moodle-shaped data model |
| Delivery risk to Q3 2027 | Medium | Medium | Medium-low for features, **high for tenancy and security assurance** |
| Recurring licence cost | None (OSS) | None (OSS) | None for Moodle/IOMAD. Workplace is commercial via partners |

## Proposed decision

**Option A**, a TypeScript modular monolith on PostgreSQL, with these guard rails:

1. Module boundaries follow the domain split the brief requires: `identity`, `organisations`, `catalogue` (ContentItem, ContentVersion, Course, Placement), `entitlements`, `enrolment`, `learning` (attempt, progress), `assessment`, `credentials`, `integration` (inbox, outbox, adapters), `audit` and `reporting`. A module may read another module's data only through its public interface. This is enforced with a lint rule (dependency-cruiser or eslint-boundaries).
2. All data access goes through a tenant-scoped repository layer that sets the RLS session context (ADR-0004). Raw DB access outside it fails CI.
3. Library sub-decisions (HTTP framework, query builder or ORM, UI component base, queue) are made in S1 in a short recorded ADR each, with RLS compatibility, maintenance activity and licence as the gates.
4. Before the build contract, **Option C gets priced alongside** as part of the build-vs-buy decision. If DEC-15 concludes that TCGI needs a full Moodle-class quiz engine for diplomas, revisit this ADR.

## Consequences

- One language across the API, worker and SCORM player, and shared types for event contracts.
- We build assessment features ourselves. Their scope must be pinned by DEC-15 and DEC-16 before S8.
- The contractor must follow the module-boundary and repository rules, which are enforced in CI rather than by convention.

## What would change this decision

- The supplier's strongest available team is Python → Option B (the same design carries over).
- DEC-15 requires Moodle-class assessment breadth by the pilot → re-price Option C.
- Build-vs-buy concludes LearnUpon or Brightspace → this ADR becomes moot.
