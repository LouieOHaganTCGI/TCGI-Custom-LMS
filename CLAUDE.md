# TCGI LMS: project instructions

- Requirement baseline: `TCGI_LMS_MVP_Build_Brief_2027.md`. Planning pack: `docs/` (start at `docs/README.md`).
- Current phase: Phase B was **accepted** (24 Sep 2026). The UX foundation, S4 (signed commerce events), S5 (enterprise and managers) and CPD are **built and awaiting review** (`docs/slices/report-ux-s4-s5-cpd.md`). Don't start S6 or later until they're accepted. Anything that depends on an open DEC-xx is labelled PROVISIONAL in code.
- Run `npm run check` and `npm run test:e2e` before pushing. Local DB: `npm run db:local`. Dev stack: `npm run dev`.
- `dev/` holds a local test IdP and a HubSpot stub. They must never be presented or deployed as miniOrange or HubSpot.
- Out of scope: payments, checkout, membership, community, IdP replacement, certificate issuance, and the public website. The LMS consumes signed entitlement events (`docs/04-event-contracts.md`) and never becomes the payment system.
- Never invent exam rules, prices, identity identifiers, consent policy, licence rights or migration guarantees. Add an open item to `docs/00-assumption-register.md` or `docs/07-business-decisions.md` instead.
- Tenant scope always comes from server-side RoleGrants, never from client-supplied organisation IDs. Every new route declares its capability and tenancy rule.
- No live credentials, production APIs, real personal data or production deploys. Stop for human approval before any external write.
- Keep contract examples valid: `npm run contracts:validate`.
