# ADR-0003 — EU hosting and infrastructure

- Status: **Accepted** by Boris (Head of Tech), 24 Sep 2026. Items that also need Finance or other owners stay open in 07 (for example DEC-07 hosting cost, DEC-06 IdP facts)
- Date: 2026-09-24

## Context

EU hosting is mandatory, with Ireland preferred (§6). We need isolated dev, staging and prod environments, IaC, automated deploys and rollback, backups with tested restore, secrets management, central logs, uptime checks and incident escalation. The objective is 99.9% monthly availability (DEC-21). The team is small, so managed services are strongly preferred over self-operated ones. TCGI must own the accounts (brief §9 rights).

## Options

| Criterion | 1. AWS eu-west-1 (Dublin) | 2. Azure North Europe (Ireland) | 3. EU-headquartered provider (for example OVHcloud or Scaleway, FR region) |
|---|---|---|---|
| Ireland region | Yes | Yes | No (France or other EU) |
| Managed Postgres, multi-AZ, PITR | RDS or Aurora PostgreSQL | Azure Database for PostgreSQL Flexible Server | Managed Postgres available. Check HA and PITR tiers |
| Containers | ECS Fargate (or App Runner) | Container Apps or App Service | Managed Kubernetes or serverless containers |
| Object storage and CDN | S3 + CloudFront | Blob Storage + Front Door | S3-compatible storage. Check CDN options |
| Secrets | Secrets Manager or SSM | Key Vault | Provider secret manager or external (for example Vault) |
| Logs and monitoring | CloudWatch, plus optional OSS or SaaS | Azure Monitor | Provider tooling plus OSS |
| IaC | OpenTofu or Terraform (mature) | OpenTofu or Terraform, Bicep | OpenTofu or Terraform (check provider maturity) |
| Hiring pool and contractor familiarity | Largest | Large | Smaller |
| Sovereignty and US CLOUD Act exposure | US-owned | US-owned | EU-owned |
| Cost | Needs a calculator estimate. **Not stated here** | Needs an estimate | Often lower list price. Needs an estimate |

## Proposed decision

**Option 1: AWS eu-west-1**, provisionally, because of Ireland residency, managed multi-AZ Postgres with point-in-time recovery, and the largest contractor familiarity. It is subject to:

1. Finance pricing dev, staging and prod with the provider's calculator (DEC-07). No figures are assumed here.
2. The data-protection lead confirming that a US-owned provider in an EU region is acceptable for TCGI's policy. If not, choose Option 3.
3. Portability rules, so a move stays feasible:
   - Containers only (no provider-specific function runtimes in the core).
   - PostgreSQL features only (no Aurora-only features).
   - S3-compatible object APIs.
   - OpenTofu for all infrastructure.
   - The queue lives in Postgres (ADR-0001), not a proprietary broker.
4. Account structure (ownership terms: DEC-34): a TCGI-owned organisation with separate `dev`, `staging` and `prod` accounts. The contractor gets role-based access, with no long-lived keys. CI deploys via OIDC federation. Prod access is break-glass only and audited.
5. The CDN serves only **non-personal** SCORM static assets (A-11). Personal data is never cached at the edge.
6. **Nothing is provisioned** until DEC-07 is approved. The first external write (account creation) needs explicit human approval.

## Baseline operational design (any option)

- **Backups:** managed PITR, plus daily logical backups copied to a second EU region or account (immutable, with retention per DEC-30). **A quarterly restore drill** (TS-OPS) and one before the pilot.
- **Environments:** prod data never copied to staging. Staging uses synthetic or pseudonymised fixtures.
- **Observability:** structured JSON logs with request and trace IDs and **no PII in logs** (log only person IDs). Uptime checks from outside the region. Alerting routed per DEC-21.
- **Security:** WAF on the app origin. TLS 1.2+ everywhere. Encryption at rest with provider-managed keys (upgrade to customer-managed keys if policy requires). Dependency and container scanning in CI.
