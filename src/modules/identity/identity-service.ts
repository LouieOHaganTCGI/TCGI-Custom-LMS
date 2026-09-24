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
  | { outcome: "signed_in"; personId: string; identityLinkId: string; invitationAccepted?: boolean }
  | { outcome: "denied"; reason: "no_linked_account" | "person_inactive" | "invite_invalid" };

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

  async resolveLogin(c: VerifiedClaims, requestId: string | null, now = new Date(), inviteTokenHash: string | null = null): Promise<LoginResolution> {
    return this.db.withSystem("authn", async (trx) => {
      if (inviteTokenHash) {
        const r = await this.acceptInvitation(trx, c, inviteTokenHash, requestId, now);
        if (r) return r;
      }
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

  /** Public invitation page: the organisation name, if the token is valid. */
  async invitationPreview(token: string, now = new Date()): Promise<{ orgName: string } | null> {
    if (!token || token.length > 128) return null;
    const { sha256Hex } = await import("../../lib/crypto.js");
    return this.db.withSystem("authn", async (trx) => {
      const r = await trx.selectFrom("invitation as i").innerJoin("organisation as o", "o.id", "i.organisation_id").select(["o.name"])
        .where("i.token_hash", "=", sha256Hex(token)).where("i.accepted_at", "is", null).where("i.revoked_at", "is", null).where("i.expires_at", ">", now).executeTakeFirst();
      return r ? { orgName: r.name } : null;
    });
  }

  /**
   * ID-03 invitation acceptance. Proof is possession of the one-time invite token plus an authenticated IdP
   * identity. Email is never used.
   * - The subject is unknown: link it to the invited (placeholder) person.
   * - The subject is already linked to another person (for example an existing B2C learner): merge the
   *   placeholder into that person, so there are no duplicate identities. The merge moves membership, seats
   *   and seat entitlements. The placeholder never signed in, so it has no learning records.
   * Returns null when the invitation is invalid but the subject has an account (normal sign-in continues).
   */
  private async acceptInvitation(trx: Trx, c: VerifiedClaims, tokenHash: string, requestId: string | null, now: Date): Promise<LoginResolution | null> {
    const inv = await trx.selectFrom("invitation").select(["id", "organisation_id", "person_id", "expires_at"]).where("token_hash", "=", tokenHash)
      .where("accepted_at", "is", null).where("revoked_at", "is", null).forUpdate().executeTakeFirst();
    const link = await trx.selectFrom("identity_link").innerJoin("person", "person.id", "identity_link.person_id")
      .select(["identity_link.id as link_id", "person.id as person_id", "person.status", "person.display_name"])
      .where("identity_link.issuer", "=", c.issuer).where("identity_link.subject", "=", c.subject).executeTakeFirst();
    if (!inv || inv.expires_at <= now) {
      if (link) return null;
      await audit(trx, { actor: { type: "system", label: "authn" }, action: "auth.login_denied", entityType: "identity_subject", entityId: `${c.issuer}#${c.subject}`, reason: "invite_invalid", requestId });
      return { outcome: "denied", reason: "invite_invalid" };
    }
    if (link && link.status !== "active") return { outcome: "denied", reason: "person_inactive" };

    let personId: string;
    let linkId: string;
    if (!link) {
      personId = inv.person_id;
      linkId = (await trx.insertInto("identity_link").values({ person_id: personId, issuer: c.issuer, subject: c.subject, linked_via: "invitation", last_login_at: now }).returning("id").executeTakeFirstOrThrow()).id;
      await trx.updateTable("person").set({ ...(c.name ? { display_name: c.name } : {}), ...(c.email ? { primary_email: c.email } : {}), email_verified: c.emailVerified, updated_at: now }).where("id", "=", personId).execute();
      await trx.updateTable("organisation_membership").set({ status: "active" }).where("organisation_id", "=", inv.organisation_id).where("person_id", "=", personId).execute();
    } else {
      personId = link.person_id;
      linkId = link.link_id;
      if (personId !== inv.person_id) await mergePlaceholder(trx, inv.person_id, personId, inv.organisation_id, now);
      else await trx.updateTable("organisation_membership").set({ status: "active" }).where("organisation_id", "=", inv.organisation_id).where("person_id", "=", personId).execute();
      await trx.updateTable("identity_link").set({ last_login_at: now }).where("id", "=", linkId).execute();
    }
    await trx.updateTable("invitation").set({ accepted_at: now }).where("id", "=", inv.id).execute();
    await audit(trx, { actor: { type: "person", personId, label: c.name ?? link?.display_name ?? "learner" }, action: "invitation.accepted", entityType: "person", entityId: personId,
      organisationId: inv.organisation_id, after: { invitation_id: inv.id, merged_placeholder: link && personId !== inv.person_id ? inv.person_id : null, issuer: c.issuer }, requestId });
    await audit(trx, { actor: { type: "person", personId, label: c.name ?? link?.display_name ?? "learner" }, action: "auth.login", entityType: "person", entityId: personId, after: { issuer: c.issuer, via: "invitation" }, requestId });
    return { outcome: "signed_in", personId, identityLinkId: linkId, invitationAccepted: true };
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

/** Move an unused invited placeholder's organisation membership, seats and seat entitlements onto an existing person. */
async function mergePlaceholder(trx: Trx, placeholderId: string, targetId: string, orgId: string, now: Date): Promise<void> {
  const target = await trx.selectFrom("organisation_membership").select(["id", "status"]).where("organisation_id", "=", orgId).where("person_id", "=", targetId).executeTakeFirst();
  if (target) {
    await trx.updateTable("organisation_membership").set({ status: "active" }).where("id", "=", target.id).execute();
    await trx.updateTable("organisation_membership").set({ status: "ended", ended_at: now }).where("organisation_id", "=", orgId).where("person_id", "=", placeholderId).execute();
  } else {
    await trx.updateTable("organisation_membership").set({ person_id: targetId, status: "active" }).where("organisation_id", "=", orgId).where("person_id", "=", placeholderId).execute();
  }
  const seats = await trx.selectFrom("seat_allocation").select(["id", "agreement_id"]).where("person_id", "=", placeholderId).where("state", "=", "allocated").execute();
  for (const s of seats) {
    const has = await trx.selectFrom("seat_allocation").select("id").where("agreement_id", "=", s.agreement_id).where("person_id", "=", targetId).where("state", "=", "allocated").executeTakeFirst();
    if (has) await trx.updateTable("seat_allocation").set({ state: "released", released_at: now, release_reason: "merged into existing account" }).where("id", "=", s.id).execute();
    else await trx.updateTable("seat_allocation").set({ person_id: targetId }).where("id", "=", s.id).execute();
  }
  const ents = await trx.selectFrom("entitlement").selectAll().where("person_id", "=", placeholderId).where("grant_type", "=", "seat").where("status", "=", "active").execute();
  for (const e of ents) {
    const courseLine = `${targetId}:${e.course_id}`;
    const dup = await trx.selectFrom("entitlement").select("id").where("source", "=", e.source).where("external_order_id", "=", e.external_order_id).where("external_line_id", "=", courseLine).executeTakeFirst();
    if (!dup) {
      await trx.updateTable("entitlement").set({ person_id: targetId, external_line_id: courseLine, updated_at: now }).where("id", "=", e.id).execute();
    } else {
      await trx.updateTable("entitlement").set({ status: "revoked", updated_at: now }).where("id", "=", e.id).execute();
    }
    await trx.insertInto("entitlement_decision").values({ organisation_id: e.organisation_id, entitlement_id: e.id, input_ref: JSON.stringify({ merged_from: placeholderId, into: targetId }),
      rule_version: "invitation-merge/v0", before: JSON.stringify({ person_id: placeholderId }), after: JSON.stringify(dup ? { status: "revoked", duplicate_of: dup.id } : { person_id: targetId }) }).execute();
  }
  await trx.updateTable("person").set({ status: "deactivated", updated_at: now }).where("id", "=", placeholderId).execute();
}
