import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { NotFoundError, RuleViolation } from "../modules/authz/authz.js";
import { lookupPackageFile, readPackageIndex, type PackageIndex } from "../modules/catalogue/content-service.js";
import { LAUNCH_TOKEN_TTL_SECONDS, verifyLaunchToken, type LaunchClaims } from "../modules/learning/launch-token.js";
import type { AttemptContext } from "../modules/learning/learning-service.js";
import type { Services } from "../services.js";
import { cookieOptions, isUuid, LAUNCH_COOKIE, safeReqLog } from "./http-helpers.js";
import { enforceRoutePolicies, type RegisteredRoute, type RoutePolicy } from "./route-policy.js";
import { renderPlayer } from "./views/player.js";

const require = createRequire(import.meta.url);
const STATIC_DIR = new URL("./static/", import.meta.url);

/** Explicit allow-list of static files. There is no directory serving. */
const STATIC_FILES: Record<string, { file: () => string; type: string }> = {
  "player.js": { file: () => new URL("player.js", STATIC_DIR).pathname, type: "text/javascript; charset=utf-8" },
  "player.css": { file: () => new URL("player.css", STATIC_DIR).pathname, type: "text/css; charset=utf-8" },
  // The UMD (classic script) builds, which define window.Scorm12API / window.Scorm2004API.
  "vendor/scorm12.min.js": { file: () => require.resolve("scorm-again/scorm12/min"), type: "text/javascript; charset=utf-8" },
  "vendor/scorm2004.min.js": { file: () => require.resolve("scorm-again/scorm2004/min"), type: "text/javascript; charset=utf-8" },
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".xml": "application/xml", ".xsd": "application/xml", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".vtt": "text/vtt",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject", ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The SCORM content origin (ADR-0002). It is a separate origin from the app, so untrusted package JavaScript
 * never shares a cookie jar or origin with learner/admin sessions (threat T-09). Authorisation is by an
 * attempt-scoped launch token cookie whose Path is /a/<attemptId>/. Each attempt therefore has its own
 * cookie, and parallel launches can't overwrite each other.
 */
export async function buildContentServer(services: Services, registry: RegisteredRoute[] = []): Promise<FastifyInstance> {
  const { config } = services;
  const app = Fastify({
    logger: config.LOG_LEVEL === "silent" ? false : { level: config.LOG_LEVEL, serializers: { req: safeReqLog } },
    genReqId: () => randomUUID(),
    bodyLimit: 256 * 1024,
    trustProxy: false,
  });
  enforceRoutePolicies(app, "content", registry);
  await app.register(cookie);
  app.addContentTypeParser(["application/json", "text/plain"], { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("invalid JSON"), { statusCode: 400 }), undefined);
    }
  });
  const indexCache = new Map<string, PackageIndex>();

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", "frame-ancestors 'self'");
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).type("text/plain").send("Not found");
    if (err instanceof RuleViolation) return reply.code(409).type("application/json").send({ result: false, errorCode: 101, error: err.code });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).type("text/plain").send("Bad request");
    req.log.error({ err }, "content origin error");
    return reply.code(500).type("text/plain").send("Server error");
  });

  const pub: RoutePolicy = { auth: "public", tenancy: "none" };
  const tok: RoutePolicy = { auth: "launch-token", tenancy: "attempt" };

  /** Verify the attempt-scoped token and re-check the attempt server-side. The path's attempt id must match the token's. */
  async function authorise(req: FastifyRequest, reply: FastifyReply): Promise<{ claims: LaunchClaims; attempt: AttemptContext } | null> {
    const { attemptId } = req.params as { attemptId: string };
    const claims = isUuid(attemptId) ? verifyLaunchToken(config.LAUNCH_TOKEN_SECRET, req.cookies[LAUNCH_COOKIE]) : null;
    if (!claims || claims.att !== attemptId) {
      await reply.code(401).type("text/plain").send("Your lesson session has expired. Please return to your course and launch the lesson again.");
      return null;
    }
    const attempt = await services.learning.attemptContext(claims);
    if (!attempt) {
      await reply.code(403).type("text/plain").send("This lesson is no longer available to you.");
      return null;
    }
    return { claims, attempt };
  }

  app.get("/health", { config: { policy: pub } }, async () => ({ status: "ok" }));

  app.get("/static/*", { config: { policy: pub } }, async (req, reply) => {
    const rel = (req.params as { "*": string })["*"];
    const entry = Object.prototype.hasOwnProperty.call(STATIC_FILES, rel) ? STATIC_FILES[rel] : undefined;
    if (!entry) return reply.code(404).type("text/plain").send("Not found");
    const body = await fs.readFile(entry.file());
    return reply.header("content-type", entry.type).header("cache-control", "public, max-age=300").send(body);
  });

  // One-time launch code → attempt-scoped token cookie → player. The code comes from the app origin.
  app.get("/launch", { config: { policy: pub } }, async (req, reply) => {
    const code = (req.query as Record<string, string | undefined>).code;
    const r = await services.learning.exchangeLaunchCode(code);
    if (!r) return reply.code(400).type("text/plain").send("This launch link has expired or was already used. Please launch the lesson again from your course.");
    reply.setCookie(LAUNCH_COOKIE, r.token, cookieOptions(config.CONTENT_BASE_URL, `/a/${r.attemptId}/`, LAUNCH_TOKEN_TTL_SECONDS));
    return reply.redirect(`/a/${r.attemptId}/player`, 303);
  });

  app.get("/a/:attemptId/player", { config: { policy: tok } }, async (req, reply) => {
    const auth = await authorise(req, reply);
    if (!auth) return reply;
    const a = auth.attempt;
    const html = renderPlayer({
      title: a.placementTitle,
      edition: a.scormVersion,
      base: `/a/${a.attemptId}`,
      launchPath: `/a/${a.attemptId}/pkg/${a.launchHref}`,
      exitUrl: new URL(`/learn/enrolments/${a.enrolmentId}`, config.APP_BASE_URL).href,
    });
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
      .send(html);
  });

  app.get("/a/:attemptId/runtime/state", { config: { policy: tok } }, async (req, reply) => {
    const auth = await authorise(req, reply);
    if (!auth) return reply;
    const cmi = await services.learning.resumeCmi(auth.claims);
    if (!cmi) return reply.code(403).send({ error: "attempt unavailable" });
    return reply.header("cache-control", "no-store").send({ edition: auth.attempt.scormVersion, cmi });
  });

  // SCORM commit from the run-time API. Normal commits are application/json. The terminate commit is sent
  // with navigator.sendBeacon, which some configurations send as text/plain, and dropping it would lose the
  // final state. Cross-site forgery is blocked because the launch cookie is SameSite=Lax and bound to this
  // attempt's path. The body must still be valid JSON.
  app.post("/a/:attemptId/runtime/commit", { config: { policy: tok } }, async (req, reply) => {
    const ct = String(req.headers["content-type"] ?? "");
    if (!ct.startsWith("application/json") && !ct.startsWith("text/plain")) return reply.code(415).send({ result: false, errorCode: 101 });
    const auth = await authorise(req, reply);
    if (!auth) return reply;
    const r = await services.learning.commit(auth.claims, req.body);
    return reply.header("cache-control", "no-store").send({ result: true, errorCode: 0, seq: r.seq });
  });

  app.get("/a/:attemptId/pkg/*", { config: { policy: tok } }, async (req, reply) => {
    const auth = await authorise(req, reply);
    if (!auth) return reply;
    const sha = auth.attempt.packageSha256;
    let index = indexCache.get(sha);
    if (!index) {
      const loaded = await readPackageIndex(services.store, sha);
      if (!loaded) throw new NotFoundError("package");
      index = loaded;
      indexCache.set(sha, index);
    }
    const rel = (req.params as { "*": string })["*"];
    const hit = lookupPackageFile(index, rel);
    if (!hit) return reply.code(404).type("text/plain").send("Not found");
    const blob = await services.store.open(hit.key);
    if (!blob) return reply.code(404).type("text/plain").send("Not found");
    const ext = path.extname(rel.split(/[?#]/)[0]!).toLowerCase();
    return reply
      .header("content-type", MIME[ext] ?? "application/octet-stream")
      .header("content-length", String(blob.size))
      .header("cache-control", "private, max-age=300")
      .header("cross-origin-resource-policy", "same-origin")
      .header("x-frame-options", "SAMEORIGIN")
      .send(blob.stream);
  });

  return app;
}
