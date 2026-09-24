import * as client from "openid-client";
import type { ScopedDb } from "../../db/scoped.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import type { VerifiedClaims } from "./identity-service.js";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowInsecureHttp: boolean;
}

/**
 * OIDC relying party (ADR-0005): Authorization Code + PKCE (S256) with state and nonce, all validated by
 * openid-client (issuer, audience, signature, expiry, nonce). Login requests are stored server-side,
 * are single-use, and expire after 10 minutes.
 *
 * Works with any standards-compliant OP. Pointing it at the miniOrange sandbox is configuration only
 * (DEC-06). If TCGI's miniOrange tenant only offers SAML, a SAML adapter implementing the same
 * VerifiedClaims contract is needed.
 */
export class OidcRelyingParty {
  private configPromise: Promise<client.Configuration> | null = null;

  constructor(
    private readonly db: ScopedDb,
    private readonly s: OidcSettings,
  ) {}

  private config(): Promise<client.Configuration> {
    if (!this.configPromise) {
      this.configPromise = client
        .discovery(new URL(this.s.issuer), this.s.clientId, this.s.clientSecret, undefined, {
          execute: this.s.allowInsecureHttp ? [client.allowInsecureRequests] : [],
        })
        .catch((err) => {
          this.configPromise = null; // allow retry after the IdP recovers
          throw err;
        });
    }
    return this.configPromise;
  }

  /** Start a login. Returns the IdP redirect URL and the opaque cookie value that binds the browser to this request. */
  async begin(returnTo: string, now = new Date()): Promise<{ redirectUrl: string; requestCookie: string }> {
    const config = await this.config();
    const requestCookie = randomToken(32);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    await this.db.withSystem("authn", (trx) =>
      trx
        .insertInto("auth_request")
        .values({ id: sha256Hex(requestCookie), state, nonce, code_verifier: codeVerifier, return_to: returnTo, expires_at: new Date(now.getTime() + 10 * 60_000) })
        .execute(),
    );
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.s.redirectUri,
      scope: "openid email profile",
      response_type: "code",
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    });
    return { redirectUrl: url.href, requestCookie };
  }

  /**
   * Complete a login. The stored request is consumed (deleted) before the code exchange, so a replayed
   * callback always fails.
   */
  async complete(requestCookie: string | undefined, callbackUrl: URL, now = new Date()): Promise<{ claims: VerifiedClaims; returnTo: string }> {
    if (!requestCookie) throw new OidcError("missing_login_request");
    const req = await this.db.withSystem("authn", (trx) =>
      trx.deleteFrom("auth_request").where("id", "=", sha256Hex(requestCookie)).returningAll().executeTakeFirst(),
    );
    if (!req) throw new OidcError("unknown_or_used_login_request");
    if (req.expires_at <= now) throw new OidcError("login_request_expired");

    const config = await this.config();
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: req.code_verifier,
        expectedState: req.state,
        expectedNonce: req.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw new OidcError("token_validation_failed", err);
    }
    const idc = tokens.claims();
    if (!idc || typeof idc.sub !== "string" || idc.sub.length === 0) throw new OidcError("missing_subject");
    // Many OPs put scope claims (email, name) only in userinfo, not in the ID token. Fetch userinfo when
    // they are missing. openid-client checks that the userinfo `sub` equals the ID token subject.
    let attrs: Record<string, unknown> = idc;
    if (typeof idc.email !== "string" || typeof idc.name !== "string") {
      try {
        attrs = { ...(await client.fetchUserInfo(config, tokens.access_token, idc.sub)), ...idc };
      } catch (err) {
        throw new OidcError("userinfo_failed", err);
      }
    }
    return {
      claims: {
        issuer: idc.iss,
        subject: idc.sub,
        email: typeof attrs.email === "string" ? attrs.email : null,
        emailVerified: attrs.email_verified === true,
        name: typeof attrs.name === "string" ? attrs.name : null,
      },
      returnTo: req.return_to,
    };
  }
}

export class OidcError extends Error {
  constructor(
    readonly code: string,
    readonly causeError?: unknown,
  ) {
    super(`OIDC login failed: ${code}`);
    this.name = "OidcError";
  }
}

/** Only allow same-application relative return paths (no open redirect). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.length > 512) return "/learn";
  return value;
}
