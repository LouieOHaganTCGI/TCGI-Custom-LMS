# Slice report: UX foundation, S4 purchase/refund events, S5 enterprise, CPD

Date: 24 Sep 2026 · Branch: `claude/vigilant-einstein-ntfy9p` · Status: **ready for review. Not accepted yet.**

This batch took the accepted Phase B slice and added four slices, each with its own tests. Business rules nobody has decided are **not invented**. Where a feature needs one, it uses the safe default from `docs/00` and `docs/07`, and the code labels it `PROVISIONAL` with the decision ID.

## 1. What was built

### UX foundation and learner experience (LRN-02, NFR-05)
- A design system (`src/web/static/app.css`): colour tokens checked for AA contrast, a responsive grid, cards, stat tiles, badges, progress bars, lesson steps, forms, tables, empty states, flash messages, print styles, and 44 px touch targets on touch screens.
- The dashboard has a "Continue learning" hero with progress, at-a-glance stats (in progress, completed, available, and CPD this year), course cards with tier, organisation and access-window warnings (ending within 30 days, or ended), and an "Available to you" section.
- The course page has a progress hero with a single primary action ("Resume where you left off"), numbered lesson steps with status icons, and an access panel with a clear "access ended" message.
- The admin area has a side navigation and an **operations overview** with live counts: active learners, active enrolments, completions and expiring access, plus held events and dead letters flagged as needing attention (OPS-01, first cut).
- Flash messages use whitelisted codes, so a URL can't inject text into them.

### S4: signed purchase, refund and extension events (INT-01, INT-02)
- `POST /integrations/v1/events/:source` implements the docs/04 contract exactly:
  - An HMAC signature over the raw body, with a ±300 s window.
  - Per-source keys from config, with **two keys for rotation**.
  - A check that the envelope source matches the path.
  - Schema validation against the **published JSON Schemas** (the same files as the docs).
  - A durable inbox, then 202. A duplicate returns 200, a changed payload returns 409 (audited), a bad signature returns 401, and invalid content returns 422.
- **The derivation** (`fold.ts`) recomputes each order line's entitlement from *all* of its events, in effective-time order. It's tested over 200 random arrival orders and with duplicates, including refund-before-purchase.
- **Held, not guessed**, each with a reason visible in admin:
  - partial refunds and suspension or instalment default (DEC-11)
  - quantity greater than 1
  - a grant with no access end (no duration is invented)
  - an extension that would shorten access or comes after a revoke
  - a grant after a revoke on the same line
  - an unknown product mapping
  - an unmatched learner (the claim flow is DEC-10)
- Effects:
  - A purchase creates a **B2C-context** entitlement, with the organisation chosen by the server.
  - A refund **withdraws** active enrolments but **keeps all progress** (R-7).
  - An extension moves the enrolment's access end.
  - Every change writes a decision record and an audit entry, and emits `enrolment.status_changed` through the outbox.
- Admin pages list purchase and refund events (filter by held) with their resulting access and a "reprocess line" action, and manage **commerce product mappings**.
- `dev/commerce-sim.ts` is a **local commerce simulator** (not WooCommerce) that sends correctly signed events.

### S5: enterprise organisations, agreements, seats and managers (ENT-01, ENT-02, ENT-03, ID-03)
- **TCGI admin:**
  - Create organisations.
  - Record agreements: reference, seat limit, access window and allowed courses, **all entered from the contract**, with nothing defaulted (DEC-12).
  - Invite people, grant the manager role, and release seats with a reason.
- **Manager portal** (`/manage`):
  - Seats in use against the limit, team progress per course, and CPD per member.
  - Invitations with a copyable one-time link. Email delivery awaits DEC-25.
  - Assign a course from the agreement, which allocates a seat.
  - CSV export of team progress (audited, with formula-injection protection).
- **Invitation acceptance** links by one-time token plus IdP identity, **never by email**. If the invitee already has an account (for example a B2C learner invited by their employer), the placeholder **merges into that account**, moving membership, seat and seat entitlements. There are no duplicate identities.
- **Isolation:**
  - Every manager operation checks the organisation against the manager's server-side grants (another organisation's ID gives 404).
  - A narrow `SECURITY DEFINER` function is the only way a manager can create people.
  - RLS allows managers to write only *seat* entitlements for *their* organisation.
  - Managers never see an employee's personal B2C learning (T-03).
- **Seat limit** enforced with a row lock. With 5 concurrent assignments for the remaining seats, exactly the limit is allocated.
- **Seat release** is TCGI-only (the DEC-32 default). It revokes the seat's entitlements and withdraws active enrolments, and history is kept.

### CPD (LRN-05, LRN-06 CPD part)
- TCGI sets a CPD value and unit per course (both or neither; audited). **Awards snapshot the value**, so later edits never rewrite history.
- CPD is awarded **once per completion**, unique on the source. Replays and relaunches don't duplicate it. It's included in the `course.completed` event.
- The learner CPD page shows totals per unit by **calendar year** and in total, never adding different units together. There's a year filter, a **CSV transcript** (audited), and a **printable transcript** ("Print or save as PDF").

## 2. Evidence

| Suite | Count | What it proves |
|---|---|---|
| Unit and integration (Vitest, real Postgres 16) | **156 tests, 13 files** | All the above, plus Phase B. New: fold properties (13), inbound HTTP contract (14), enterprise and manager isolation (13), invitations via real OIDC (3 more, 12 in total), CPD (7) |
| Browser E2E (Playwright) | **9 journeys, passing twice in a row** | The manager invite → accept → assign → learner completes → manager sees CPD journey. Signed purchase → enrol → refund → withdrawn. Phase B journeys. Hostile package. Mobile. axe on **16 pages** |
| Mutation checks | (Phase B) | RLS removal and capability-check removal both fail tests |
| Lint, typecheck, contracts, audit | clean | `npm audit`: 0 vulnerabilities. All production dependencies are permissive licences |

Two genuine defects found and fixed by the new tests and axe:
- Breadcrumb links relied on colour alone (WCAG 1.4.1). They're now underlined.
- Small buttons were under 44 px on phones. They now meet the touch-target rule.

## 3. Provisional behaviour (needs a decision)

| Behaviour | Default used | Decision |
|---|---|---|
| Refund and extension rules R-1 to R-7. Partial refunds, instalment default and suspension held | Proposed rules from docs/04 | **DEC-11** (Finance) |
| Purchases with no IdP subject held as "unmatched learner" | No email-based claiming | **DEC-10**, DEC-06 |
| Invitation links expire after 14 days. Links are copied by the manager (no email sent) | — | DEC-12, **DEC-25** |
| Seat release and reassignment by TCGI only. Release withdraws enrolments | — | **DEC-32** |
| CPD awarded on course completion. Values and units are set per course by TCGI | Seed values are labelled "(synthetic)" | **DEC-22** |
| Agreement terms | Entered from contracts. Seed agreements are synthetic | **DEC-12** |

## 4. Still not done (unchanged from Phase B, plus new items)

- No staging deployment (DEC-07). Real miniOrange (DEC-06), Rise packages (DEC-03) and HubSpot (DEC-08) are still stand-ins.
- Assessments (LRN-04) haven't been started, because DEC-15 and DEC-16 are open. **No exam rules are coded.**
- Not yet built: draft, review and approve publishing (S6), learning paths with prerequisites (S7), cohorts, messaging (LRN-07), search (CAT-06), non-SCORM resources (CAT-07), Accredible (INT-05), full HubSpot mapping, and the Hivebrite link.
- Entitlement expiry is enforced at use (access checks), but there's no batch job that marks entitlements "expired".
- A PDF transcript is produced through the browser's print dialog, not generated server-side.
