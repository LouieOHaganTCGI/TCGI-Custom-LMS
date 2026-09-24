import type { FastifyReply } from "fastify";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export function sendHtml(reply: FastifyReply, html: string, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(html);
}

export function cookieOptions(baseUrl: string, path = "/", maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    secure: baseUrl.startsWith("https://"),
    sameSite: "lax" as const,
    path,
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

export const SESSION_COOKIE = "lms_sid";
export const AUTH_REQUEST_COOKIE = "lms_auth";
export const LAUNCH_COOKIE = "lms_lt";

/**
 * Request log serializer: method, path and request id only. Query strings (OIDC codes, launch codes) and
 * headers (cookies) are never logged (threat T-14, docs/adr/0003 "no PII or secrets in logs").
 */
export function safeReqLog(req: { method?: string; url?: string; id?: string }) {
  return { method: req.method, path: (req.url ?? "").split("?")[0], id: req.id };
}
