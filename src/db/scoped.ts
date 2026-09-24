import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./schema.js";

export type Trx = Transaction<Database>;

/** The database-level projection of an authorisation context (see modules/authz). */
export interface DbScope {
  personId: string | null;
  /** Organisations where the principal holds an org-management role. Server-derived, never client-supplied. */
  managedOrgIds: readonly string[];
  /** True only for TCGI platform roles and named system tasks. */
  platform: boolean;
  purpose: string;
}

/**
 * Named system tasks that may run with platform visibility. Adding one is a security-relevant change and
 * needs review.
 */
export type SystemPurpose =
  | "authn" // resolve IdP subject to person, create sessions
  | "session" // load and refresh sessions
  | "launch-exchange" // swap a one-time launch code for a launch token (content origin)
  | "outbox-dispatch"
  | "entitlement-command" // grants from trusted sources (fixture now, signed events in S4)
  | "content-import"
  | "provisioning"
  | "seed"
  | "maintenance";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function applyScope(trx: Trx, scope: DbScope): Promise<void> {
  if (scope.personId !== null && !UUID_RE.test(scope.personId)) throw new Error("invalid personId in scope");
  for (const id of scope.managedOrgIds) if (!UUID_RE.test(id)) throw new Error("invalid organisation id in scope");
  const orgs = `{${scope.managedOrgIds.join(",")}}`;
  // set_config(..., true) = transaction-local; the values vanish at COMMIT/ROLLBACK and never leak across pooled connections.
  await sql`select set_config('app.person_id', ${scope.personId ?? ""}, true),
                   set_config('app.managed_org_ids', ${orgs}, true),
                   set_config('app.platform', ${scope.platform ? "true" : "false"}, true),
                   set_config('app.purpose', ${scope.purpose}, true)`.execute(trx);
}

export class ScopedDb {
  constructor(private readonly db: Kysely<Database>) {}

  /** Run fn in a transaction scoped to a request principal. */
  withScope<T>(scope: DbScope, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await applyScope(trx, scope);
      return fn(trx);
    });
  }

  /** Run fn as a named system task with platform visibility. */
  withSystem<T>(purpose: SystemPurpose, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.withScope({ personId: null, managedOrgIds: [], platform: true, purpose: `system:${purpose}` }, fn);
  }

  /** Run fn as a specific person without platform visibility (for example a content-origin runtime call). */
  withPerson<T>(personId: string, purpose: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.withScope({ personId, managedOrgIds: [], platform: false, purpose }, fn);
  }

  destroy(): Promise<void> {
    return this.db.destroy();
  }
}
