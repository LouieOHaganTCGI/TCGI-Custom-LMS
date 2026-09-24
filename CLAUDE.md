# TCGI LMS: project instructions

- Requirement baseline: `TCGI_LMS_MVP_Build_Brief_2027.md`. Planning pack: `docs/` (start at `docs/README.md`).
- Current phase: **Phase A done, awaiting approval.** Don't implement Phase B until the ADRs in `docs/adr/` are marked Accepted by the senior engineer.
- Out of scope: payments, checkout, membership, community, IdP replacement, certificate issuance, and the public website. The LMS consumes signed entitlement events (`docs/04-event-contracts.md`) and never becomes the payment system.
- Never invent exam rules, prices, identity identifiers, consent policy, licence rights or migration guarantees. Add an open item to `docs/00-assumption-register.md` or `docs/07-business-decisions.md` instead.
- Tenant scope always comes from server-side RoleGrants, never from client-supplied organisation IDs. Every new route declares its capability and tenancy rule.
- No live credentials, production APIs, real personal data or production deploys. Stop for human approval before any external write.
- Keep contract examples valid: `python3 docs/contracts/validate.py`.
