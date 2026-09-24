import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { sql } from "kysely";
import { audit, personActor } from "../modules/audit/audit.js";
import { asPrincipal, can, loadAuthzContext, NotFoundError, RuleViolation, type AuthzContext } from "../modules/authz/authz.js";
import { PackageValidationError } from "../modules/catalogue/scorm-package.js";
import { OidcError, safeReturnTo } from "../modules/identity/oidc.js";
import type { ActiveSession } from "../modules/identity/sessions.js";
import { safeEqual } from "../lib/crypto.js";
import type { Services } from "../services.js";
import type { CourseTier } from "../db/schema.js";
import { AUTH_REQUEST_COOKIE, cookieOptions, isUuid, safeReqLog, SESSION_COOKIE, sendHtml } from "./http-helpers.js";
import { enforceRoutePolicies, type RegisteredRoute, type RoutePolicy } from "./route-policy.js";
import { AdminAuditPage, AdminContentPage, AdminHome, AdminIntegrationsPage } from "./views/admin.js";
import { ErrorPage, render, type NavUser } from "./views/layout.js";
import { DashboardPage, DeniedPage, EnrolmentPage, MePage, SignInPage } from "./views/learner.js";

declare module "fastify" {
  interface FastifyRequest {
    session: ActiveSession | null;
    authz: AuthzContext | null;
  }
}

const STATIC_DIR = new URL("./static/", import.meta.url);
const TIERS: CourseTier[] = ["microlesson", "foundation", "professional_certificate", "advanced_certificate", "diploma"];

function navUser(req: FastifyRequest): NavUser | null {
  return req.authz && req.session ? { displayName: req.authz.displayName, isAdmin: req.authz.platform, csrfToken: req.session.csrfToken } : null;
}

export async function buildAppServer(services: Services, registry: RegisteredRoute[] = []): Promise<FastifyInstance> {
  const { config } = services;
  const app = Fastify({
    logger: config.LOG_LEVEL === "silent" ? false : { level: config.LOG_LEVEL, serializers: { req: safeReqLog } },
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  enforceRoutePolicies(app, "app", registry);
  app.decorateRequest("session", null);
  app.decorateRequest("authz", null);

  const idpOrigin = new URL(config.OIDC_ISSUER).origin;
  const contentOrigin = new URL(config.CONTENT_BASE_URL).origin;
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "frame-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "base-uri": ["'none'"],
        // Forms submit to self and then redirect to the IdP (sign-in) or the content origin (launch).
        "form-action": ["'self'", idpOrigin, contentOrigin],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: config.MAX_PACKAGE_BYTES, files: 1, fields: 5, fieldSize: 1024 } });
  await app.register(rateLimit, { global: false });

  // Resolve the session and authorisation context from server-side state only.
  app.addHook("onRequest", async (req) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return;
    const s = await services.sessions.resolve(sid);
    if (!s) return;
    const ctx = await services.db.withPerson(s.personId, "authz.load", (trx) => loadAuthzContext(trx, s.personId));
    if (!ctx) return;
    req.session = s;
    req.authz = ctx;
  });

  // Enforce each route's declared policy: authentication, capability, and CSRF for state-changing requests.
  app.addHook("preHandler", async (req, reply) => {
    const policy = req.routeOptions.config.policy as RoutePolicy | undefined;
    if (!policy) return; // only the not-found handler has no policy: onRoute rejects any real route without one
    if (policy.auth === "public") return;
    if (policy.auth !== "session") return reply.code(404).send();
    if (!req.authz || !req.session) {
      if (req.method === "GET") return reply.redirect(`/?return_to=${encodeURIComponent(safeReturnTo(req.url))}`, 303);
      return reply.code(401).send({ error: "authentication required" });
    }
    // Missing capability → 404, not 403, so the existence of admin or foreign resources isn't revealed.
    if (!can(req.authz, policy.capability)) return sendHtml(reply, render(<ErrorPage status={404} title="Page not found" message="The page you asked for does not exist." user={navUser(req)} />), 404);
    if (req.method !== "GET" && req.method !== "HEAD" && policy.csrf !== false) {
      const token = (req.body as Record<string, unknown> | undefined)?._csrf;
      if (typeof token !== "string" || !safeEqual(token, req.session.csrfToken)) {
        return sendHtml(reply, render(<ErrorPage status={403} title="Form expired" message="Please go back, reload the page and try again." user={navUser(req)} />), 403);
      }
    }
  });

  app.setErrorHandler(async (err, req, reply) => {
    const user = navUser(req);
    if (err instanceof NotFoundError) return sendHtml(reply, render(<ErrorPage status={404} title="Page not found" message="The page you asked for does not exist." user={user} />), 404);
    if (err instanceof RuleViolation) return sendHtml(reply, render(<ErrorPage status={409} title="That can't be done" message={err.message} user={user} />), 409);
    if (err instanceof OidcError) {
      req.log.warn({ code: err.code, cause: String(err.causeError ?? "") }, "oidc login failed");
      return sendHtml(reply, render(<ErrorPage status={400} title="Sign-in failed" message="We couldn't complete sign-in. Please try again." user={null} />), 400);
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return sendHtml(reply, render(<ErrorPage status={status} title="Request not accepted" message="The request was not valid." user={user} />), status);
    req.log.error({ err }, "unhandled error");
    return sendHtml(reply, render(<ErrorPage status={500} title="Something went wrong" message="An unexpected error occurred. It has been logged." user={user} />), 500);
  });
  app.setNotFoundHandler(async (req, reply) =>
    sendHtml(reply, render(<ErrorPage status={404} title="Page not found" message="The page you asked for does not exist." user={navUser(req)} />), 404),
  );

  const pub: RoutePolicy = { auth: "public", tenancy: "none" };
  const self: RoutePolicy = { auth: "session", capability: "learning.self", tenancy: "self" };
  const plat = (capability: "audit.read" | "integration.read" | "integration.replay" | "content.import" | "course.publish", csrf?: false): RoutePolicy => ({
    auth: "session", capability, tenancy: "platform", ...(csrf === false ? { csrf } : {}),
  });

  // ---------------------------------------------------------------- public
  app.get("/health", { config: { policy: pub } }, async () => {
    await services.db.withSystem("maintenance", (trx) => sql`select 1`.execute(trx));
    return { status: "ok" };
  });

  app.get("/assets/app.css", { config: { policy: pub } }, async (_req, reply) => {
    const css = await fs.readFile(new URL("app.css", STATIC_DIR));
    return reply.header("content-type", "text/css; charset=utf-8").header("cache-control", "public, max-age=300").send(css);
  });

  app.get("/", { config: { policy: pub } }, async (req, reply) => {
    if (req.authz) return reply.redirect("/learn", 303);
    const q = req.query as Record<string, string | undefined>;
    const notice = q.signed_out ? "You have signed out." : undefined;
    return sendHtml(reply, render(<SignInPage providerLabel={config.OIDC_PROVIDER_LABEL} returnTo={safeReturnTo(q.return_to)} notice={notice} />));
  });

  const authLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };
  app.get("/auth/login", { config: { policy: pub, ...authLimit } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const { redirectUrl, requestCookie } = await services.oidc.begin(safeReturnTo(q.return_to));
    reply.setCookie(AUTH_REQUEST_COOKIE, requestCookie, cookieOptions(config.APP_BASE_URL, "/auth", 600));
    return reply.redirect(redirectUrl, 302);
  });

  app.get("/auth/callback", { config: { policy: pub, ...authLimit } }, async (req, reply) => {
    const callbackUrl = new URL(req.url, config.APP_BASE_URL);
    reply.clearCookie(AUTH_REQUEST_COOKIE, { path: "/auth" });
    const { claims, returnTo } = await services.oidc.complete(req.cookies[AUTH_REQUEST_COOKIE], callbackUrl);
    const result = await services.identity.resolveLogin(claims, req.id);
    if (result.outcome === "denied") return sendHtml(reply, render(<DeniedPage reason={result.reason} />), 403);
    // A fresh session id on every login (no session fixation). Any previous session is revoked.
    const old = req.cookies[SESSION_COOKIE];
    if (old) await services.sessions.revoke(old);
    const { cookieValue } = await services.sessions.create(result.personId, result.identityLinkId);
    reply.setCookie(SESSION_COOKIE, cookieValue, cookieOptions(config.APP_BASE_URL, "/"));
    return reply.redirect(returnTo, 303);
  });

  app.post("/auth/logout", { config: { policy: self } }, async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE]!;
    await services.sessions.revoke(sid);
    await services.sessions.revokeLaunchTokens(req.authz!.personId);
    await services.db.withPerson(req.authz!.personId, "auth.logout", (trx) =>
      audit(trx, { actor: personActor(req.authz!.personId, req.authz!.displayName), action: "auth.logout", entityType: "person", entityId: req.authz!.personId, requestId: req.id }),
    );
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.redirect("/?signed_out=1", 303);
  });

  // ---------------------------------------------------------------- learner
  app.get("/learn", { config: { policy: self } }, async (req, reply) => {
    const ctx = req.authz!;
    const [enrolments, eligible] = await Promise.all([services.enrolment.listMine(ctx), services.enrolment.listEligible(ctx)]);
    return sendHtml(reply, render(<DashboardPage user={navUser(req)!} enrolments={enrolments} eligible={eligible} now={new Date()} />));
  });

  app.post("/learn/courses/:courseId/enrol", { config: { policy: self } }, async (req, reply) => {
    const { courseId } = req.params as { courseId: string };
    if (!isUuid(courseId)) throw new NotFoundError("course");
    // Deliberately reads nothing else from the body: the organisation comes from the entitlement (ADR-0004).
    const { enrolmentId } = await services.enrolment.enrol(req.authz!, courseId, req.id);
    return reply.redirect(`/learn/enrolments/${enrolmentId}`, 303);
  });

  app.get("/learn/enrolments/:enrolmentId", { config: { policy: self } }, async (req, reply) => {
    const { enrolmentId } = req.params as { enrolmentId: string };
    if (!isUuid(enrolmentId)) throw new NotFoundError("enrolment");
    const view = await services.learning.getEnrolment(req.authz!, enrolmentId);
    return sendHtml(reply, render(<EnrolmentPage user={navUser(req)!} view={view} />));
  });

  app.post("/learn/enrolments/:enrolmentId/placements/:placementId/launch", { config: { policy: self } }, async (req, reply) => {
    const { enrolmentId, placementId } = req.params as { enrolmentId: string; placementId: string };
    if (!isUuid(enrolmentId) || !isUuid(placementId)) throw new NotFoundError("placement");
    const { launchUrl } = await services.learning.launch(req.authz!, enrolmentId, placementId, req.id);
    return reply.redirect(launchUrl, 303);
  });

  app.get("/me", { config: { policy: self } }, async (req, reply) => {
    const ctx = req.authz!;
    const data = await asPrincipal(services.db, ctx, "identity.me", async (trx) => ({
      person: await trx.selectFrom("person").select(["id", "display_name", "primary_email", "email_verified", "status"]).where("id", "=", ctx.personId).executeTakeFirstOrThrow(),
      links: await trx.selectFrom("identity_link").select(["issuer", "subject", "linked_via", "last_login_at"]).where("person_id", "=", ctx.personId).execute(),
      memberships: await trx.selectFrom("organisation_membership as m").innerJoin("organisation as o", "o.id", "m.organisation_id")
        .select(["o.name", "o.kind", "m.status"]).where("m.person_id", "=", ctx.personId).execute(),
      grants: await trx.selectFrom("role_grant as g").leftJoin("organisation as o", "o.id", "g.organisation_id")
        .select(["g.role", "g.scope_type", "o.name as org_name"]).where("g.person_id", "=", ctx.personId).execute(),
    }));
    return sendHtml(reply, render(<MePage user={navUser(req)!} {...data} />));
  });

  // ---------------------------------------------------------------- TCGI admin (platform)
  app.get("/admin", { config: { policy: plat("audit.read") } }, async (req, reply) => sendHtml(reply, render(<AdminHome user={navUser(req)!} />)));

  app.get("/admin/audit", { config: { policy: plat("audit.read") } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter = { action: q.action || undefined, entityType: q.entity_type || undefined, entityId: q.entity_id || undefined, beforeId: q.before || undefined };
    const rows = await services.admin.audit(req.authz!, filter);
    return sendHtml(reply, render(<AdminAuditPage user={navUser(req)!} rows={rows} filter={filter} />));
  });

  app.get("/admin/integrations", { config: { policy: plat("integration.read") } }, async (req, reply) => {
    const rows = await services.admin.outbox(req.authz!);
    const note =
      config.HUBSPOT_MODE === "webhook"
        ? `The HubSpot destination is a signed webhook receiver at ${new URL(config.HUBSPOT_WEBHOOK_URL!).origin}. The HubSpot CRM object mapping is not implemented yet (DEC-08).`
        : "The HubSpot destination is disabled in this environment. Events queue here and are not delivered.";
    return sendHtml(reply, render(<AdminIntegrationsPage user={navUser(req)!} rows={rows} destinationNote={note} />));
  });

  app.post("/admin/integrations/:id/replay", { config: { policy: plat("integration.replay") } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new NotFoundError("outbox message");
    await services.dispatcher.replay(id, personActor(req.authz!.personId, req.authz!.displayName), req.id);
    return reply.redirect("/admin/integrations", 303);
  });

  const contentPage = async (req: FastifyRequest, reply: FastifyReply, extra: { message?: string; error?: string }, status = 200) => {
    const [versions, courses] = await Promise.all([services.admin.contentVersions(req.authz!), services.admin.courses(req.authz!)]);
    return sendHtml(reply, render(<AdminContentPage user={navUser(req)!} versions={versions} courses={courses} message={extra.message} error={extra.error} />), status);
  };

  app.get("/admin/content", { config: { policy: plat("content.import") } }, async (req, reply) => contentPage(req, reply, {}));

  // Multipart: CSRF is checked manually from the first form field, before the file is read.
  app.post("/admin/content/upload", { config: { policy: plat("content.import", false) } }, async (req, reply) => {
    if (!req.isMultipart()) return contentPage(req, reply, { error: "Expected a multipart form upload." }, 400);
    let csrfOk = false;
    let stableKey: string | undefined;
    let zip: Buffer | undefined;
    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "_csrf") csrfOk = typeof part.value === "string" && safeEqual(part.value, req.session!.csrfToken);
        else if (part.fieldname === "stable_key" && typeof part.value === "string") stableKey = part.value.trim();
      } else if (part.fieldname === "package") {
        if (!csrfOk) return sendHtml(reply, render(<ErrorPage status={403} title="Form expired" message="Please reload the page and try again." user={navUser(req)} />), 403);
        zip = await part.toBuffer();
      }
    }
    if (!csrfOk) return sendHtml(reply, render(<ErrorPage status={403} title="Form expired" message="Please reload the page and try again." user={navUser(req)} />), 403);
    if (!stableKey || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(stableKey)) return contentPage(req, reply, { error: "Enter a valid content key." }, 400);
    if (!zip) return contentPage(req, reply, { error: "Choose a SCORM zip file." }, 400);
    try {
      const r = await services.content.importPackage(zip, { stableKey }, personActor(req.authz!.personId, req.authz!.displayName), req.id);
      return contentPage(req, reply, {
        message: r.deduplicated
          ? `This exact package already exists as version ${r.versionNo} (${r.contentVersionId}). No copy was created.`
          : `Imported SCORM ${r.scormVersion} package as ${stableKey} version ${r.versionNo}. Content version ID: ${r.contentVersionId}`,
      });
    } catch (e) {
      if (e instanceof PackageValidationError) return contentPage(req, reply, { error: `Package rejected (${e.code}): ${e.message}` }, 422);
      throw e;
    }
  });

  app.post("/admin/courses", { config: { policy: plat("course.publish") } }, async (req, reply) => {
    const b = req.body as Record<string, string | undefined>;
    const tier = b.tier as CourseTier;
    const ids = (b.content_version_ids ?? "").split(/\s+/).filter(Boolean);
    if (!b.slug || !/^[a-z0-9-]{2,96}$/.test(b.slug) || !b.title || !TIERS.includes(tier) || ids.length === 0 || !ids.every(isUuid)) {
      return contentPage(req, reply, { error: "Check the course fields: slug, title, tier and at least one content version ID." }, 400);
    }
    try {
      const r = await services.content.createAndPublishCourse(
        { slug: b.slug, title: b.title.slice(0, 200), tier, placements: ids.map((id) => ({ contentVersionId: id })) },
        personActor(req.authz!.personId, req.authz!.displayName),
        req.id,
      );
      return contentPage(req, reply, { message: `Course created and published: ${r.courseId}` });
    } catch (e) {
      if (e instanceof RuleViolation) return contentPage(req, reply, { error: e.message }, 409);
      throw e;
    }
  });

  return app;
}
