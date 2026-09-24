import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The signature header for signed events (docs/04-event-contracts.md §1):
 * `t=<unix>,v1=<hex(HMAC-SHA256(secret, t + "." + body))>`
 */
export function signEventBody(secret: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSeconds},v1=${hmacHex(secret, `${nowSeconds}.${body}`)}`;
}

export function verifyEventSignature(
  secret: string,
  header: string | undefined,
  body: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  return safeEqual(parts.v1, hmacHex(secret, `${t}.${body}`));
}
