# Architecture decision records

Format: a lightweight record per decision (context, options, criteria, assessment, proposed decision, consequences, and what would change it). Every ADR here is at **Proposed** status. None becomes *Accepted* until the senior engineer (Boris) signs off. ADRs with licence or hosting cost also need Finance sign-off (see [07-business-decisions.md](../07-business-decisions.md)).

| ADR | Title | Status | Approval needed from | Decision ID |
|---|---|---|---|---|
| [0001](0001-application-stack.md) | Application stack and architecture style | Proposed | Boris | DEC-05 |
| [0002](0002-scorm-runtime.md) | SCORM runtime and launch architecture | Proposed. **Evidence pending D2 PoC** | Boris + Finance | DEC-13 |
| [0003](0003-hosting-eu.md) | EU hosting and infrastructure | Proposed | Boris + Finance | DEC-07 |
| [0004](0004-tenant-isolation-authorization.md) | Tenant isolation and scoped authorisation | Proposed | Boris | DEC-05 |
| [0005](0005-identity-federation.md) | Identity federation with miniOrange | Proposed. Needs IdP facts | Boris | DEC-06 |
| [0006](0006-integration-events.md) | Integration events: inbox, outbox and entitlement derivation | Proposed | Boris | DEC-05, DEC-10 |

Evaluation criteria used throughout, from the brief and operating rules: fit to P0 requirements, **supportability and contractor handover** (brief §6), security, EU data residency, **portability and exit** (OPS-04, brief §9 rights), recurring cost profile, delivery risk to Q3 2027, and testability.
