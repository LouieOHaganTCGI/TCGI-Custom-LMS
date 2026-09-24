# ADR-0007 — Library sub-decisions for ADR-0001 (Phase B)

- Status: **Proposed** (made while implementing Phase B, as ADR-0001 required. Boris to confirm at Phase B review)
- Date: 2026-09-24

ADR-0001 left the HTTP framework, data access, UI rendering and queue as S1 sub-decisions, with **RLS compatibility, maintenance activity and licence** as the gates. The choices below are all open source. Production dependencies are 85 MIT, 4 BSD-3-Clause and 4 ISC packages (`license-checker --production`), with no copyleft. There is no paid dependency.

| Concern | Choice | Alternatives considered | Why |
|---|---|---|---|
| HTTP | **Fastify 5** (MIT) plus official plugins (cookie, helmet, multipart, rate-limit, formbody) | NestJS, Express | Explicit, low-magic, and fast. The `onRoute` hook lets us **refuse to boot** when a route lacks an authorisation policy (ADR-0004). NestJS's DI and decorators add abstraction a small team must maintain. Express 5 lacks built-in schema and hooks. |
| Data access | **Kysely** (MIT) query builder plus **plain SQL migrations** | Prisma, Drizzle, TypeORM | Every query runs in a transaction that first calls `set_config` for RLS. Kysely makes that trivial and keeps SQL reviewable. Prisma's connection model makes per-transaction RLS awkward. Migrations are SQL files a DBA can read. |
| Postgres driver | **pg** (MIT) | postgres.js | The most widely deployed, and Kysely's standard dialect. |
| OIDC RP | **openid-client 6** (MIT, OpenID-certified author) | passport strategies, hand-rolled | Handles discovery, PKCE, state, nonce, ID-token validation and userinfo subject checks. |
| UI rendering | **React 19 server-side to static HTML** (MIT), with no client bundle yet | SPA, templating engines | Auto-escaping (XSS-safe by default), a strict CSP (no inline script), and accessible markup. Client interactivity can be added later without a rewrite. |
| Zip parsing | **yauzl** (MIT) | adm-zip, unzipper | Streaming, validates entry sizes, and exposes headers for zip-bomb, symlink and path checks. |
| Manifest XML | **fast-xml-parser** (MIT) with entities off, and DTDs rejected up front | xml2js, libxmljs | No native build, and no entity expansion (no XXE). |
| Validation / config | **zod** (MIT) | — | Config is validated at boot. Production refuses insecure settings. |
| SCORM run-time API | **scorm-again 3** (MIT) | Rustici Engine / SCORM Cloud | **The first evaluated adapter only.** Selection is still DEC-13, pending real Rise evidence. |
| Queue / outbox | **Postgres table with `FOR UPDATE SKIP LOCKED`** (no library) | Graphile Worker, pg-boss | Per-aggregate ordering and dead-lettering are domain rules we need to own and test anyway. There's no extra dependency. |
| Tests | Vitest (MIT), Playwright (Apache-2.0), @axe-core/playwright (**MPL-2.0, dev-only**, not distributed), ajv (MIT), oidc-provider (MIT, dev-only, the local test IdP) | Jest, Cypress | Real Postgres, a real browser and a real OP. |

Pinned versions come from `package-lock.json`. `@playwright/test` is pinned **exactly** to the browser build available in the delivery environment. `npm audit` reported **0 vulnerabilities** on 24 Sep 2026. Vitest was moved to 5.x to avoid a moderate advisory in 3.x.
