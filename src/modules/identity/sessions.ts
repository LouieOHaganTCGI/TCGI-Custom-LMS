import type { ScopedDb } from "../../db/scoped.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

export interface ActiveSession {
  personId: string;
  csrfToken: string;
  identityLinkId: string;
}

/**
 * Server-side sessions (ADR-0005). The cookie carries a random 256-bit id. Only its SHA-256 is stored,
 * so a database read never yields a usable cookie.
 */
export class SessionStore {
  constructor(
    private readonly db: ScopedDb,
    private readonly policy: SessionPolicy,
  ) {}

  async create(personId: string, identityLinkId: string, now = new Date()): Promise<{ cookieValue: string; csrfToken: string }> {
    const cookieValue = randomToken(32);
    const csrfToken = randomToken(24);
    await this.db.withSystem("session", (trx) =>
      trx
        .insertInto("web_session")
        .values({
          id_hash: sha256Hex(cookieValue),
          person_id: personId,
          identity_link_id: identityLinkId,
          csrf_token: csrfToken,
          last_seen_at: now,
          idle_expires_at: new Date(now.getTime() + this.policy.idleMinutes * 60_000),
          absolute_expires_at: new Date(now.getTime() + this.policy.absoluteHours * 3_600_000),
        })
        .execute(),
    );
    return { cookieValue, csrfToken };
  }

  /** Resolve and slide the idle expiry. Returns null for unknown, revoked or expired sessions. */
  async resolve(cookieValue: string | undefined, now = new Date()): Promise<ActiveSession | null> {
    if (!cookieValue || cookieValue.length > 128) return null;
    const idHash = sha256Hex(cookieValue);
    return this.db.withSystem("session", async (trx) => {
      const s = await trx
        .selectFrom("web_session")
        .innerJoin("person", "person.id", "web_session.person_id")
        .select(["web_session.person_id", "web_session.csrf_token", "web_session.identity_link_id", "web_session.idle_expires_at",
          "web_session.absolute_expires_at", "web_session.revoked_at", "person.status"])
        .where("web_session.id_hash", "=", idHash)
        .executeTakeFirst();
      if (!s || s.revoked_at || s.status !== "active" || s.idle_expires_at <= now || s.absolute_expires_at <= now) return null;
      await trx
        .updateTable("web_session")
        .set({ last_seen_at: now, idle_expires_at: new Date(now.getTime() + this.policy.idleMinutes * 60_000) })
        .where("id_hash", "=", idHash)
        .execute();
      return { personId: s.person_id, csrfToken: s.csrf_token, identityLinkId: s.identity_link_id };
    });
  }

  async revoke(cookieValue: string, now = new Date()): Promise<void> {
    await this.db.withSystem("session", (trx) =>
      trx.updateTable("web_session").set({ revoked_at: now }).where("id_hash", "=", sha256Hex(cookieValue)).execute(),
    );
  }

  /**
   * Revoke every content-origin launch token issued to this person before now. This is used on sign-out, so a
   * lesson left open on a shared device can't keep writing progress.
   */
  async revokeLaunchTokens(personId: string, now = new Date()): Promise<void> {
    await this.db.withSystem("session", (trx) => trx.updateTable("person").set({ launch_tokens_valid_after: now }).where("id", "=", personId).execute());
  }

  /** Revoke all sessions for a person (deactivation, ID-04). */
  async revokeAllFor(personId: string, now = new Date()): Promise<void> {
    await this.db.withSystem("session", (trx) =>
      trx.updateTable("web_session").set({ revoked_at: now }).where("person_id", "=", personId).where("revoked_at", "is", null).execute(),
    );
    await this.revokeLaunchTokens(personId, now);
  }
}
