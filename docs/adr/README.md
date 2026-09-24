# Architecture decision records

Format: a lightweight record per decision (context, options, criteria, assessment, proposed decision, consequences, and what would change it). ADRs 0001 and 0003–0006 were **accepted by Boris on 24 Sep 2026**. For ADR-0002 the evaluation method is accepted, and the runtime selection is pending evidence. ADRs with licence or hosting cost also need Finance sign-off (see [07-business-decisions.md](../07-business-decisions.md)).

| ADR | Title | Status | Approval needed from | Decision ID |
|---|---|---|---|---|
| [0001](0001-application-stack.md) | Application stack and architecture style | **Accepted** 24 Sep 2026 | Boris | DEC-05 |
| [0002](0002-scorm-runtime.md) | SCORM runtime and launch architecture | Method accepted. **Selection pending evidence** | Boris + Finance | DEC-13 |
| [0003](0003-hosting-eu.md) | EU hosting and infrastructure | **Accepted** (cost still with Finance) | Boris + Finance | DEC-07 |
| [0004](0004-tenant-isolation-authorization.md) | Tenant isolation and scoped authorisation | **Accepted** 24 Sep 2026 | Boris | DEC-05 |
| [0005](0005-identity-federation.md) | Identity federation with miniOrange | **Accepted** (IdP facts pending) | Boris | DEC-06 |
| [0006](0006-integration-events.md) | Integration events: inbox, outbox and entitlement derivation | **Accepted** | Boris | DEC-05, DEC-10 |
| [0007](0007-library-choices.md) | Library sub-decisions (Fastify, Kysely, SQL migrations, React SSR, and others) | Proposed (confirm at Phase B review) | Boris | — |

Evaluation criteria used throughout, from the brief and operating rules: fit to P0 requirements, **supportability and contractor handover** (brief §6), security, EU data residency, **portability and exit** (OPS-04, brief §9 rights), recurring cost profile, delivery risk to Q3 2027, and testability.
