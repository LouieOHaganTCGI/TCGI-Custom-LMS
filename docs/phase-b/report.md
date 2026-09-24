# Phase B report: first vertical slice

Date: 24 Sep 2026 · Branch: `claude/vigilant-einstein-ntfy9p` · Status: **ready for senior-engineer review. Not accepted yet.**

Target flow: miniOrange sandbox sign-in → scoped learner identity → entitlement fixture → course enrolment → launch a real sanitised Rise SCORM package → save/restore progress → display completion → queue a HubSpot sandbox event → show an admin audit record, **plus** schema migrations, automated security and integration tests, a staging deployment, and a demo script.

The honest summary: **the whole flow works end to end in a real browser against the production code paths.** Three external pieces are stand-ins: a local test IdP instead of the miniOrange sandbox, synthetic SCORM packages instead of real Rise exports, and a signed-webhook stub instead of the HubSpot sandbox. **The staging deployment hasn't been done**, because no EU hosting account exists (DEC-07). None of the three stand-ins is presented as the real system anywhere in the UI, code or docs.

## 1. What works (verified by automated tests on this branch)

| Step | Evidence |
|---|---|
| **OIDC sign-in**: Authorization Code + PKCE, state, nonce, ID-token signature, issuer, audience, and a userinfo subject match | `test/identity/oidc-login.test.ts` (9) against a real OpenID Provider over HTTP. Covers replayed callbacks, tampered state, missing browser binding, open-redirect attempts, and logout revoking the session |
| **Identity keyed on issuer + subject, never email** (ID-01) | An email change at the IdP updates the same person and is audited. An unlinked subject with a known email is **denied, not merged** |
| **Deactivation** (ID-04) | A deactivated person's live session stops at the next request, and sign-in is denied |
| **Scoped roles and tenancy** (ID-02, ADR-0004) | Capability map. Org context comes only from server-side RoleGrants. A client `organisation_id` is ignored (tested). Every route must declare a policy or **the server refuses to start**. The reviewed route inventory is a test |
| **Row-level security as a second barrier** | `test/db/rls.test.ts` (13) runs direct SQL as `lms_app` (not owner, NOBYPASSRLS): zero rows without context, learner-only rows for a learner, and Org A-only rows for an Org A context. Self-granted roles and entitlements are rejected |
| **Mutation-tested** | Removing RLS on one table fails 5 DB tests. Disabling the capability check fails 5 HTTP tests. Both were reverted |
| **Entitlement fixture through the real command** (INT-01 foundation) | Idempotent on (source, order, line). Conflicting terms are refused. A decision row and an audit entry are written each time. Membership of the licensing org is required |
| **Enrolment** | Needs an in-window entitlement (expired or future grants refused, and indistinguishable from a missing course). Pins the published revision. Copies the access end. Is idempotent, and **concurrent requests produce exactly one enrolment** |
| **Content import** (CAT-01, CAT-02) | Hardened validator (`test/catalogue`, 12): zip-slip, absolute or backslash paths, symlinks, zip bombs, lying size headers, XXE or DTD, missing manifest or launch file, multi-SCO (refused pending DEC-13). Content-addressed storage. An identical re-upload is deduplicated. A changed package becomes v2. **One version is placed in two courses with one stored copy** |
| **Immutability** | DB triggers block edits to approved content versions, published revisions and their placements, raw SCORM commits, entitlement decisions and audit entries, **even for the owner role** |
| **Launch on a separate content origin** (ADR-0002, T-09 and T-10) | One-time 60 s launch code → attempt-scoped HMAC token in an HttpOnly, SameSite=Lax cookie with `Path=/a/<attempt>/`. Tokens for another attempt or person, tampered, wrongly signed or expired tokens, and path traversal are all refused (`authz-matrix`, 33). **Sign-out revokes open lesson tokens** |
| **Hostile package** (T-09, browser) | `e2e/security.spec.ts`: a package that tries to read cookies, read the app, and POST to it can't see the session. Its cross-origin read is blocked, and its forged POST creates nothing (CSRF) |
| **Save and restore** (LRN-01) | Every commit is stored raw and append-only with a hash. Derived progress is updated. Relaunch returns `entry=resume` with location and suspend data. Real-browser resume for **both** SCORM 1.2 and 2004 via scorm-again (`e2e/phase-b.spec.ts`) |
| **Terminate commit** | Found and fixed during build: scorm-again sends the final commit via `sendBeacon`. It's now accepted, so the last state isn't lost |
| **Completion display** | The course page and dashboard show completion, pass or fail, and the score *labelled as reported by the lesson*. Completion is recorded **once** (repeat or regressing commits don't duplicate events or erase `first_completed_at`). Multi-lesson courses complete only when every required lesson is done |
| **Outbox → destination** (INT-03 first events) | `enrolment.created` and `course.completed` are written in the same transaction as the change, signed (HMAC), delivered, and **validated against `docs/contracts` JSON Schemas**. Retry with backoff, dead-letter on 4xx or after the maximum attempts, per-aggregate ordering, an audited admin replay, and idempotent receiver effect (`test/integration`, 6) |
| **Admin audit record** | `/admin/audit` with filters and a hash-chained, append-only trail (chain continuity tested). `/admin/integrations` shows deliveries, dead letters and replay |
| **Accessibility and responsiveness** | axe-core (WCAG 2.0/2.1 A and AA rules): no serious or critical violations on 8 pages. Skip link and keyboard test. Pixel 7 emulation journey with no horizontal scroll and 44 px touch targets |
| **Migrations** | 2 forward-only SQL migrations (Kysely migrator, locked and recorded), applied from the container image |
| **Build and container** | `npm run build` produces compiled JS that runs without dev tooling. A Docker image (non-root `node` user, production dependencies only, healthcheck) was built and run locally: migrations applied, and the web process was healthy with security headers |
| **CI** | `.github/workflows/ci.yml`: typecheck, lint, 106 tests on Postgres 16, contract validation, `npm audit --audit-level=high`, build, Playwright E2E, and an image build. *The workflow file is committed, but it hasn't run on GitHub yet (unverified until the first push)* |

Totals: **106 integration and unit tests, and 7 browser E2E tests, all passing** (E2E run twice with no flakes). Lint and typecheck are clean. `npm audit`: 0 vulnerabilities.

## 2. What is simulated

| Item | Stand-in | Why | Replacing it |
|---|---|---|---|
| **miniOrange sandbox** | A local OpenID Provider (`dev/test-idp.ts`, oidc-provider). Labelled "LOCAL TEST IDENTITY PROVIDER. This is not miniOrange" on its page and on the LMS sign-in page | No sandbox tenant or protocol details yet (**DEC-06**) | Config only if miniOrange offers OIDC: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, then `cli person:provision` for test users. If only SAML is offered, a SAML adapter is needed (about 1 slice) |
| **Real Rise packages** | Two **synthetic** SCORM packages (`fixtures/scorm/`) that drive the real run-time API | None supplied (**DEC-03**) | Drop sanitised exports into the admin upload. The R1–R13 matrix (ADR-0002) then runs on them |
| **HubSpot sandbox** | A signed-webhook receiver stub (`dev/hubspot-stub.ts`) with fault injection | No sandbox and no object mapping (**DEC-08**) | A HubSpot adapter implementing `DestinationAdapter` once the object model is decided. The outbox, retry and DLQ are already real |
| **Entitlement** | A fixture through the real command (`source = phase-b-fixture`) | By design: signed commerce events are slice S4 | S4 adds the verified inbound endpoint and derivation that call the same command |
| **Course publishing** | A one-step "create and publish revision 1" admin action | The draft, review and approve workflow is S6 (CAT-05) | S6 |

## 3. What is unverified or not done

- **Staging deployment: not done.** There is no approved EU hosting account (**DEC-07**), and creating one is an external write that needs your approval. What exists is a verified container image, CI, and a staging runbook (`docs/runbooks/staging.md`). The object-storage (S3) blob store isn't implemented. Staging needs it, and it's small.
- **Rise compatibility: unverified.** Nothing here proves real Rise packages work: not multi-SCO, sequencing, large `suspend_data`, media, or Rise's own resume prompt. That's the D2 matrix on real exports, and it's still the critical path.
- **Real mobile devices:** Chromium emulation only. iOS Safari and Android Chrome (R8, `pagehide` commits) are untested.
- **Screen-reader and manual WCAG pass:** only automated axe checks and a keyboard test. An independent audit is DEC-27.
- **CI on GitHub:** the workflow is committed but not yet observed running.
- **Load, backup and restore drill, monitoring and alerting:** not started (S12). The backup and PITR policy is in ADR-0003 only.
- **Independent security review:** none yet. What exists is self-review plus the automated suites.

## 4. Known limitations and follow-ups found during the build

1. **LMS sign-out doesn't end the IdP session.** Signing in again silently reuses the IdP's SSO session. Single logout depends on miniOrange capabilities (DEC-06).
2. **The OIDC userinfo fallback was needed.** Our test OP (per spec) puts `email` and `name` in userinfo, not the ID token. The RP now fetches userinfo with a subject check. We must confirm how miniOrange behaves.
3. **Launch tokens last 4 h.** A lesson session longer than that will fail to commit (the player shows a warning). Needs a sliding renewal, or a decision on maximum session length.
4. **Package upload is buffered in memory** (up to 500 MB). It should stream to object storage before production.
5. **Learner-context RLS allows a person to update their own enrolment row.** This is needed for completion. It should be narrowed to a SECURITY DEFINER function or column privileges.
6. **Provisional academic mappings flagged in code for Aishwarya:** SCORM 1.2 `failed` and `browsed` mapping, relaunch-after-completion behaviour (always resumes attempt 1), and the course completion rule "all required lessons" (DEC-16, DEC-19).
7. The HubSpot "matching key" isn't sent. Envelopes carry only the opaque person id (DEC-08).

## 5. Next slice (S4: signed entitlement events), subject to your acceptance of Phase B

- **Blocking inputs:** DEC-10 (who builds the WooCommerce producer, and staging store access) and DEC-11 (refund, cancellation and instalment rules).
- **Scope:**
  - A signed inbound endpoint per `docs/04` (HMAC with key rotation, a ±300 s window, a durable inbox, and 202/200/409/401/422 semantics).
  - Derived-state folding across `(effective_at, source_sequence)`, with property-based permutation and duplicate tests.
  - Purchase, refund, cancellation, extension and manual grant, and time-based expiry.
  - The admin event → decision → entitlement view.
- **In parallel, if you approve:** the S3 object-storage adapter plus staging provisioning, once DEC-07 is approved.
- **Before S4, ideally:** real Rise packages (DEC-03), so the runtime decision (DEC-13) stops being the critical-path risk.
