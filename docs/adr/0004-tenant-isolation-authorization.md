# ADR-0004 — Tenant isolation and scoped authorisation

- Status: **Proposed** (Boris, DEC-05)
- Date: 2026-09-24

## Context

Organisation A users must never enumerate Organisation B's users, courses, entitlements or reports by changing a URL or parameter (§4). Permissions must be scoped capabilities, not an `is_admin` flag. Tenant and role checks apply to APIs, DB queries and downloads (ID-02). Operating rule: **never accept a client-supplied organisation ID as authority.** One person can hold B2C enrolments *and* enterprise enrolments (A-06), and their employer must not see their personal B2C learning.

## Options

1. **Database per tenant.** The strongest isolation, but the operational cost for five or more tenants plus B2C is high, cross-tenant TCGI reporting becomes hard, and one person spanning several tenants is awkward. Rejected for the MVP.
2. **Schema per tenant.** Similar drawbacks, with migrations fanned out across schemas. Rejected.
3. **Shared schema, `organisation_id` on every tenant-owned row, application policy layer only.** Simple, but a single missed `WHERE` leaks data.
4. **Shared schema plus application policy layer plus PostgreSQL row-level security (defence in depth).** **Proposed.**

## Proposed decision (Option 4)

### Tenancy model

- Every enrolment, seat, agreement, cohort, report and export has an **`organisation_id` licensing context**. B2C learning uses a dedicated TCGI Direct organisation, so the column is never null and RLS stays simple.
- `Person` and `IdentityLink` are **global** (one person, many contexts). Person data is visible to an org only through an active `OrganisationMembership`, and only the fields the org's role permits.
- Content (`ContentItem` and `ContentVersion`) is TCGI-owned and global. Its *visibility* to an org comes from agreement catalogue rules (ENT-01, ID-05).

### Authorisation model

- `RoleGrant(person, role, scope_type, scope_id, valid_from, valid_to, granted_by, reason)`, where `scope_type ∈ {platform, organisation, course, cohort}`.
- Roles map to **capabilities**, for example:
  - `enrolment.read`, `enrolment.assign`
  - `seat.allocate`
  - `result.correct`, `result.approve_correction`
  - `report.export`
  - `content.publish`
  - `support.view_access_history`
  - `integration.replay`

  The role→capability map is code, and is reviewed as a security change.
- Initial roles, subject to DEC-33:

  | Role | Scope |
  |---|---|
  | `learner` | self |
  | `enterprise_manager` | organisation |
  | `tcgi_admin` | platform |
  | `tcgi_product_editor` | platform, catalogue only |
  | `tcgi_academic_approver` | platform, academic corrections |
  | `tcgi_support` | platform, restricted fields, with every read of learner detail audited |
  | `integration_service` | a machine principal per source system |

### Enforcement path (every request)

1. **Authenticate:** a session from the IdP login (ADR-0005), or a machine principal from a signed request or client credentials.
2. **Build `AuthzContext` server-side:** `person_id` and the active RoleGrants loaded from the DB. The client may *select* an organisation context (for a manager of several orgs), but the server only accepts a selection that matches a grant, and otherwise answers **404**. It never trusts the value itself.
3. **Policy check** in the use-case layer: `can(ctx, capability, resource)`. A resource is loaded *through* the scoped repository, so a foreign ID resolves as "not found" rather than "forbidden", which prevents enumeration.
4. **DB layer:** each transaction runs `SET LOCAL app.person_id`, `app.org_ids` (the array of permitted orgs) and `app.platform_caps`. RLS policies on tenant-owned tables check those. The application connects as a **non-owner role without `BYPASSRLS`**. Migrations run as a separate owner role.
5. **Files and downloads:** exports and transcripts are generated into per-request object keys and served through short-lived signed URLs, created only after the policy check. SCORM content uses a launch token scoped to a single attempt (ADR-0002).
6. **Audit:** every write, every export, and every support read of learner detail creates an `AuditEntry`.

### Test obligations (TS-SEC)

- A **route inventory test**: each registered route must declare its capability and tenancy rule. An undeclared route fails CI.
- A matrix test: two seeded orgs with look-alike data. Every role × every route × foreign resource IDs, expecting 404 or 403 and no data in the body.
- An RLS test with **direct SQL** as the app role with a foreign org context, which must return zero rows. Proves defence in depth independently of app code.
- Concurrency: a seat-limit race (two invites for the last seat) creates exactly one allocation (`SELECT … FOR UPDATE` or a constraint).

## Consequences

- There's a small per-transaction overhead for `SET LOCAL`, and every query path must be inside a scoped transaction (enforced by the repository layer).
- Cross-tenant TCGI reports run under a platform capability that RLS policies recognise explicitly, never by switching RLS off.
