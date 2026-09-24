import type { ScopedDb, Trx } from "../../db/scoped.js";
import { audit } from "../audit/audit.js";

export interface VerifiedClaims {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export type LoginResolution =
  | { outcome: "signed_in"; personId: string; identityLinkId: string }
  | { outcome: "denied"; reason: "no_linked_account" | "person_inactive" };

/**
 * Resolve a verified IdP login to an LMS person (ID-01).
 * - The key is (issuer, subject). **Email is never used to find or merge accounts.**
 * - Email and name are mutable attributes, refreshed from the IdP on each login and audited on change.
 * - Unknown subjects are denied unless self-registration is enabled (DEC-06, default off). Migrated or invited
 *   people are pre-provisioned with an IdentityLink, and the invitation flow comes in S5.
 */
export class IdentityService {
  constructor(
    private readonly db: ScopedDb,
    private readonly opts: { allowSelfRegistration: boolean },
  ) {}

  async resolveLogin(c: VerifiedClaims, requestId: string | null, now = new Date()): Promise<LoginResolution> {
    return this.db.withSystem("authn", async (trx) => {
      const link = await trx
        .selectFrom("identity_link")
        .innerJoin("person", "person.id", "identity_link.person_id")
        .select(["identity_link.id as link_id", "person.id as person_id", "person.status", "person.primary_email",
          "person.email_verified", "person.display_name"])
        .where("identity_link.issuer", "=", c.issuer)
        .where("identity_link.subject", "=", c.subject)
        .executeTakeFirst();

      if (!link) {
        if (!this.opts.allowSelfRegistration) {
          await audit(trx, {
            actor: { type: "system", label: "authn" },
            action: "auth.login_denied",
            entityType: "identity_subject",
            entityId: `${c.issuer}#${c.subject}`,
            reason: "no_linked_account",
            requestId,
          });
          return { outcome: "denied", reason: "no_linked_account" };
        }
        return this.selfRegister(trx, c, requestId, now);
      }

      if (link.status !== "active") {
        await audit(trx, {
          actor: { type: "system", label: "authn" },
          action: "auth.login_denied",
          entityType: "person",
          entityId: link.person_id,
          reason: "person_inactive",
          requestId,
        });
        return { outcome: "denied", reason: "person_inactive" };
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (c.email !== null && c.email !== link.primary_email) changes.primary_email = { from: link.primary_email, to: c.email };
      if (c.emailVerified !== link.email_verified) changes.email_verified = { from: link.email_verified, to: c.emailVerified };
      if (c.name && c.name !== link.display_name) changes.display_name = { from: link.display_name, to: c.name };
      if (Object.keys(changes).length > 0) {
        await trx
          .updateTable("person")
          .set({
            ...(changes.primary_email ? { primary_email: c.email } : {}),
            ...(changes.email_verified ? { email_verified: c.emailVerified } : {}),
            ...(changes.display_name ? { display_name: c.name as string } : {}),
            updated_at: now,
          })
          .where("id", "=", link.person_id)
          .execute();
        await audit(trx, {
          actor: { type: "system", label: "authn (attributes from IdP)" },
          action: "person.attributes_updated_from_idp",
          entityType: "person",
          entityId: link.person_id,
          before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
          after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])),
          requestId,
        });
      }
      await trx.updateTable("identity_link").set({ last_login_at: now }).where("id", "=", link.link_id).execute();
      await audit(trx, {
        actor: { type: "person", personId: link.person_id, label: c.name ?? link.display_name },
        action: "auth.login",
        entityType: "person",
        entityId: link.person_id,
        after: { issuer: c.issuer },
        requestId,
      });
      return { outcome: "signed_in", personId: link.person_id, identityLinkId: link.link_id };
    });
  }

  private async selfRegister(trx: Trx, c: VerifiedClaims, requestId: string | null, now: Date): Promise<LoginResolution> {
    const direct = await trx.selectFrom("organisation").select("id").where("kind", "=", "tcgi_direct").executeTakeFirstOrThrow();
    const person = await trx
      .insertInto("person")
      .values({ display_name: c.name ?? "Learner", primary_email: c.email, email_verified: c.emailVerified, updated_at: now })
      .returning("id")
      .executeTakeFirstOrThrow();
    const link = await trx
      .insertInto("identity_link")
      .values({ person_id: person.id, issuer: c.issuer, subject: c.subject, linked_via: "self_registration", last_login_at: now })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx.insertInto("organisation_membership").values({ organisation_id: direct.id, person_id: person.id, source: "self_registration" }).execute();
    await audit(trx, {
      actor: { type: "system", label: "authn" },
      action: "person.self_registered",
      entityType: "person",
      entityId: person.id,
      organisationId: direct.id,
      after: { issuer: c.issuer },
      requestId,
    });
    return { outcome: "signed_in", personId: person.id, identityLinkId: link.id };
  }
}
