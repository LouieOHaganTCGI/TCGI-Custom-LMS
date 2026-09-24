# Staging deployment runbook (prepared, not yet executed)

Status: **blocked on DEC-07** (hosting provider and TCGI-owned EU account) and **DEC-06** (miniOrange sandbox). Nothing has been provisioned. Each step marked ⚠ is an external write that needs explicit approval from Boris before it runs.

## Target (ADR-0003, provisional AWS eu-west-1 Dublin)

| Component | Staging choice | Notes |
|---|---|---|
| Web (app and content origins) | 1 container service running the image `node dist/src/server.js`, with 2 host names on one load balancer: `lms-staging.<tcgi-domain>` and `content.lms-staging.<tcgi-domain>` | The content origin **must** be a different host from the app (config refuses the same origin) |
| Worker | The same image, `node dist/src/cli.js worker` | Keep `RUN_WORKER=false` on web |
| Database | Managed PostgreSQL 16, Multi-AZ optional for staging, PITR on | Create `lms_owner` and `lms_app` (NOBYPASSRLS, not owner) per `scripts/pg-ci-init.sql` |
| Migrations | A one-off task: `node dist/src/cli.js migrate` with `MIGRATION_DATABASE_URL` (owner) | Runs before each deploy. Forward-only |
| Package storage | S3 bucket in eu-west-1, private, and versioned | ⚠ **The S3 `BlobStore` adapter isn't implemented yet.** It's needed before staging (small) |
| Secrets | Secrets Manager: `LAUNCH_TOKEN_SECRET`, `OUTBOUND_SIGNING_SECRET`, `OIDC_CLIENT_SECRET`, DB passwords | Never in the image or repo |
| IdP | miniOrange **sandbox** OIDC client with redirect `https://lms-staging.<tcgi-domain>/auth/callback` | DEC-06 |
| HubSpot | `HUBSPOT_MODE=webhook` to an approved sandbox receiver, or `disabled` | DEC-08 |
| Test data | `node dist/src/cli.js seed` (synthetic only), or `person:provision` for sandbox users | **No production or real personal data in staging** |

## Required environment

See `.env.example`. In staging: `NODE_ENV=production`, https URLs only, `OIDC_ALLOW_INSECURE_HTTP=false`. The config refuses to start otherwise.

## Steps

1. ⚠ Create the TCGI-owned AWS organisation and a `staging` account (DEC-07 / DEC-34), with no long-lived contractor keys. Set up GitHub OIDC federation for CI deploys.
2. Write the infrastructure as OpenTofu, reviewed in a PR. It isn't in the repo yet, and is deliberately left until the provider is approved.
3. ⚠ `tofu apply` for the VPC, RDS, S3, ECR, ECS services, load balancer and certificates, Secrets Manager and CloudWatch.
4. Build and push the image (CI). Run the migrate task, then deploy web and worker.
5. Smoke test: `/health` on both hosts, then run the demo script (`docs/phase-b/demo-script.md`) against staging with sandbox users.
6. Enable backups, and schedule the first **restore drill** (TS-OPS) into an isolated database, recording RPO and RTO.

## Building the image in a restricted network

```bash
docker build -t tcgi-lms:<sha> .
# Behind a TLS-intercepting proxy: pass its CA as a build-time secret (not stored in the image).
docker build --secret id=extra_ca,src=/path/to/proxy-ca.pem -t tcgi-lms:<sha> .
# If Docker Hub rate-limits: --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim
```

## Rollback

Redeploy the previous image tag. Migrations are forward-only. A schema problem is fixed with a corrective migration or a point-in-time restore. Never edit an applied migration.
