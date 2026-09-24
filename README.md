# TCGI LMS (owned LMS MVP)

The TCGI-owned learning platform MVP, targeting a controlled Q3 2027 rollout while Brightspace stays available.
The requirement baseline is [`TCGI_LMS_MVP_Build_Brief_2027.md`](TCGI_LMS_MVP_Build_Brief_2027.md). Planning and architecture are in
[`docs/`](docs/README.md).

**Status:** Phase A and Phase B are accepted. **UX foundation, S4 (signed purchase and refund events), S5 (enterprise manager portal, seats, invitations) and CPD are built and awaiting review.**
See [`docs/slices/report-ux-s4-s5-cpd.md`](docs/slices/report-ux-s4-s5-cpd.md) for what works, what is provisional and what is still missing.

Out of scope, by design: checkout and payments (WooCommerce and Stripe), membership and community (Hivebrite), the identity provider
(miniOrange), historical records (HubSpot), and certificate issuance (Accredible).

## Run locally

Requirements: Node 22 and PostgreSQL 16 binaries (`/usr/lib/postgresql/16/bin`, or set `PGBIN`).

```bash
npm ci
npm run db:local     # throwaway cluster in .pgdata with lms_owner / lms_app roles (databases lms_dev, lms_test, lms_e2e)
npm run dev          # migrate + synthetic seed; app http://localhost:3000, content origin :3001,
                     # LOCAL test IdP :4400 (not miniOrange), HubSpot STUB :4500 (not HubSpot)
```

Everything local is synthetic: fictional people (`*@example.test`), synthetic SCORM packages, and local-only secrets.

## Checks

```bash
npm run check        # typecheck + lint + 156 unit/integration tests (real Postgres) + contract schemas
npm run test:e2e     # Playwright: learner, manager and commerce journeys, isolation, hostile package, axe on 16 pages, mobile
npx tsx dev/commerce-sim.ts purchase --learner learner-ent-b-1 --product SYN-PROD-PATHWAY-01 --order SIM-1   # local commerce simulator
npm run build        # compiled JS in dist/ (docker build . for the image)
```

## Layout

| Path | What |
|---|---|
| `src/db/migrations/` | Forward-only SQL migrations, RLS policies, immutability triggers |
| `src/db/scoped.ts` | The only way to run queries: every transaction carries an RLS scope (ADR-0004) |
| `src/modules/` | identity, authz, audit, catalogue, entitlements, enrolment, learning, integration, admin |
| `src/web/` | App origin (`app-server.tsx`) and SCORM content origin (`content-server.ts`), each route with a declared policy |
| `test/`, `e2e/` | Security, integration and end-to-end suites |
| `dev/` | Local test IdP, HubSpot stub, dev stack. **Never deployed** |
| `docs/` | Phase A pack, ADRs, event contracts, Phase B demo script and report, runbooks |
