import { hmacHex, safeEqual } from "../../lib/crypto.js";

/**
 * Attempt-scoped launch token (ADR-0002, threats T-09 and T-10). It authorises reading and writing the CMI
 * state of exactly one attempt, and serving that attempt's package files, on the content origin only. It's
 * never valid on the application origin. The server still re-checks the attempt, person and enrolment
 * window on every use.
 */
export interface LaunchClaims {
  att: string; // attempt id
  per: string; // person id
  exp: number; // unix seconds
  iat: number; // unix seconds, compared with person.launch_tokens_valid_after (revocation on sign-out)
}

const VERSION = "lt1";

export function issueLaunchToken(secret: string, claims: LaunchClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${VERSION}.${body}.${hmacHex(secret, `${VERSION}.${body}`)}`;
}

export function verifyLaunchToken(secret: string, token: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): LaunchClaims | null {
  if (!token || token.length > 1024) return null;
  const [v, body, mac] = token.split(".");
  if (v !== VERSION || !body || !mac) return null;
  if (!safeEqual(mac, hmacHex(secret, `${v}.${body}`))) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const c = claims as Partial<LaunchClaims>;
  if (typeof c.att !== "string" || typeof c.per !== "string" || typeof c.exp !== "number" || typeof c.iat !== "number") return null;
  if (c.exp <= nowSeconds) return null;
  return { att: c.att, per: c.per, exp: c.exp, iat: c.iat };
}

export const LAUNCH_TOKEN_TTL_SECONDS = 4 * 3600;
export const LAUNCH_CODE_TTL_SECONDS = 60;
