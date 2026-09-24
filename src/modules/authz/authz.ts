import type { DbScope, ScopedDb, Trx } from "../../db/scoped.js";
import type { Role } from "../../db/schema.js";

/**
 * Scoped capabilities (ADR-0004). The role -> capability map is code, and changing it is a security review item.
 * `learning.self` is held by every active person: it only ever reaches the person's own records.
 */
export const CAPABILITIES = [
  "learning.self",
  "audit.read",
  "integration.read",
  "integration.replay",
  "content.import",
  "course.publish",
  "org.admin",
  "entitlement.admin",
  "enrolment.read.org",
  "org.manage",
  "report.export.org",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const PLATFORM_ROLE_CAPS: Record<Extract<Role, "tcgi_admin">, Capability[]> = {
  tcgi_admin: ["audit.read", "integration.read", "integration.replay", "content.import", "course.publish", "org.admin", "entitlement.admin"],
};
const ORG_ROLE_CAPS: Record<Extract<Role, "enterprise_manager">, Capability[]> = {
  enterprise_manager: ["enrolment.read.org", "org.manage", "report.export.org"],
};

export interface AuthzContext {
  personId: string;
  displayName: string;
  capabilities: ReadonlySet<Capability>;
  /** Organisations where this person manages records. Derived from RoleGrants on the server. */
  managedOrgIds: readonly string[];
  platform: boolean;
  grants: ReadonlyArray<{ role: Role; scopeType: "platform" | "organisation"; organisationId: string | null }>;
}

export function toDbScope(ctx: AuthzContext, purpose: string): DbScope {
  return { personId: ctx.personId, managedOrgIds: ctx.managedOrgIds, platform: ctx.platform, purpose };
}

/** Build the authorisation context from the database. The client never supplies any part of it. */
export async function loadAuthzContext(trx: Trx, personId: string, now = new Date()): Promise<AuthzContext | null> {
  const person = await trx
    .selectFrom("person")
    .select(["id", "display_name", "status"])
    .where("id", "=", personId)
    .executeTakeFirst();
  if (!person || person.status !== "active") return null;

  const grants = await trx
    .selectFrom("role_grant")
    .select(["role", "scope_type", "organisation_id"])
    .where("person_id", "=", personId)
    .where("valid_from", "<=", now)
    .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", now)]))
    .execute();

  const caps = new Set<Capability>(["learning.self"]);
  const managed = new Set<string>();
  let platform = false;
  for (const g of grants) {
    if (g.scope_type === "platform" && g.role === "tcgi_admin") {
      platform = true;
      PLATFORM_ROLE_CAPS.tcgi_admin.forEach((c) => caps.add(c));
    } else if (g.scope_type === "organisation" && g.role === "enterprise_manager" && g.organisation_id) {
      managed.add(g.organisation_id);
      ORG_ROLE_CAPS.enterprise_manager.forEach((c) => caps.add(c));
    }
  }
  return {
    personId: person.id,
    displayName: person.display_name,
    capabilities: caps,
    managedOrgIds: [...managed].sort(),
    platform,
    grants: grants.map((g) => ({ role: g.role, scopeType: g.scope_type, organisationId: g.organisation_id })),
  };
}

export function can(ctx: AuthzContext | null, capability: Capability): boolean {
  return !!ctx && ctx.capabilities.has(capability);
}

/** Run a unit of work as this principal with RLS applied. */
export function asPrincipal<T>(db: ScopedDb, ctx: AuthzContext, purpose: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.withScope(toDbScope(ctx, purpose), fn);
}

/** Thrown by services when a resource is not visible to the principal. Always rendered as 404 (no enumeration). */
export class NotFoundError extends Error {
  constructor(what = "resource") {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** Thrown when an action violates a business rule (for example no active entitlement). Rendered as 409 or 422. */
export class RuleViolation extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RuleViolation";
  }
}
