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
import { asPrincipal, can, loadAuthzContext, NotFoundError, RuleViolation, type AuthzContext, type Capability } from "../modules/authz/authz.js";
import { cpdYearOf } from "../modules/cpd/cpd-service.js";
import { PackageValidationError } from "../modules/catalogue/scorm-package.js";
import { OidcError, safeReturnTo } from "../modules/identity/oidc.js";
import type { ActiveSession } from "../modules/identity/sessions.js";
import { safeEqual } from "../lib/crypto.js";
import type { Services } from "../services.js";
import type { CourseTier } from "../db/schema.js";
import { AUTH_REQUEST_COOKIE, cookieOptions, isUuid, safeReqLog, SESSION_COOKIE, sendHtml } from "./http-helpers.js";
import { enforceRoutePolicies, type RegisteredRoute, type RoutePolicy } from "./route-policy.js";
import { AdminAuditPage, AdminContentPage, AdminInboundPage, AdminIntegrationsPage, AdminMappingsPage, AdminOrganisationPage, AdminOrganisationsPage, AdminOverviewPage } from "./views/admin.js";
import { CpdPage, TranscriptPage } from "./views/cpd.js";
import { ErrorPage, isFlashCode, render, type FlashCode, type NavUser } from "./views/layout.js";
import { DashboardPage, DeniedPage, EnrolmentPage, InvitePage, MePage, SignInPage } from "./views/learner.js";
import { ManagePickPage, TeamPage } from "./views/manager.js";

declare module "fastify" {
  interface FastifyRequest {
    session: ActiveSession | null;
    authz: AuthzContext | null;
  }
}

const STATIC_DIR = new URL("./static/", import.meta.url);
const TIERS: CourseTier[] = ["microlesson", "foundation", "professional_certificate", "advanced_certificate", "diploma"];

function navUser(req: FastifyRequest): NavUser | null {
  return req.authz && req.session
    ? { displayName: req.authz.displayName, isAdmin: req.authz.platform, isManager: req.authz.capabilities.has("org.manage"), csrfToken: req.session.csrfToken }
    : null;
}

/** A whitelisted flash code from ?flash=… (never free text). */
function flashOf(req: FastifyRequest): FlashCode | null {
  const f = (req.query as Record<string, unknown> | undefined)?.flash;
  return isFlashCode(f) ? f : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** Multi-value form fields (checkboxes) arrive as a string or an array. */
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

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
    if (policy.auth === "signed-event") return; // verified in the handler against the raw body (docs/04 §1)
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
  const plat = (capability: Capability, csrf?: false): RoutePolicy => ({
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

  app.get("/assets/app.js", { config: { policy: pub } }, async (_req, reply) => {
    const js = await fs.readFile(new URL("app.js", STATIC_DIR));
    return reply.header("content-type", "text/javascript; charset=utf-8").header("cache-control", "public, max-age=300").send(js);
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
    const { redirectUrl, requestCookie } = await services.oidc.begin(safeReturnTo(q.return_to), new Date(), q.invite ?? null);
    reply.setCookie(AUTH_REQUEST_COOKIE, requestCookie, cookieOptions(config.APP_BASE_URL, "/auth", 600));
    return reply.redirect(redirectUrl, 302);
  });

  app.get("/auth/callback", { config: { policy: pub, ...authLimit } }, async (req, reply) => {
    const callbackUrl = new URL(req.url, config.APP_BASE_URL);
    reply.clearCookie(AUTH_REQUEST_COOKIE, { path: "/auth" });
    const { claims, returnTo, inviteTokenHash } = await services.oidc.complete(req.cookies[AUTH_REQUEST_COOKIE], callbackUrl);
    const result = await services.identity.resolveLogin(claims, req.id, new Date(), inviteTokenHash);
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
    const [enrolments, eligible, cpd] = await Promise.all([services.enrolment.listMine(ctx), services.enrolment.listEligible(ctx), services.cpd.thisYear(ctx)]);
    return sendHtml(reply, render(<DashboardPage user={navUser(req)!} enrolments={enrolments} eligible={eligible} now={new Date()} cpdThisYear={cpd} flash={flashOf(req)} />));
  });

  app.post("/learn/courses/:courseId/enrol", { config: { policy: self } }, async (req, reply) => {
    const { courseId } = req.params as { courseId: string };
    if (!isUuid(courseId)) throw new NotFoundError("course");
    // Deliberately reads nothing else from the body: the organisation comes from the entitlement (ADR-0004).
    const { enrolmentId } = await services.enrolment.enrol(req.authz!, courseId, req.id);
    return reply.redirect(`/learn/enrolments/${enrolmentId}?flash=enrolled`, 303);
  });

  app.get("/learn/enrolments/:enrolmentId", { config: { policy: self } }, async (req, reply) => {
    const { enrolmentId } = req.params as { enrolmentId: string };
    if (!isUuid(enrolmentId)) throw new NotFoundError("enrolment");
    const view = await services.learning.getEnrolment(req.authz!, enrolmentId);
    return sendHtml(reply, render(<EnrolmentPage user={navUser(req)!} view={view} now={new Date()} flash={flashOf(req)} />));
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
  app.get("/admin", { config: { policy: plat("audit.read") } }, async (req, reply) =>
    sendHtml(reply, render(<AdminOverviewPage user={navUser(req)!} stats={await services.admin.overview(req.authz!)} flash={flashOf(req)} />)));

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
    return sendHtml(reply, render(<AdminContentPage user={navUser(req)!} versions={versions} courses={courses} message={extra.message} error={extra.error} flash={flashOf(req)} />), status);
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

  app.post("/admin/courses/:courseId/cpd", { config: { policy: plat("course.publish") } }, async (req, reply) => {
    const { courseId } = req.params as { courseId: string };
    if (!isUuid(courseId)) throw new NotFoundError("course");
    const b = req.body as Record<string, unknown>;
    const rawValue = str(b.cpd_value).trim();
    const rawUnit = str(b.cpd_unit).trim();
    const value = rawValue === "" ? null : Number(rawValue.replace(",", "."));
    try {
      await services.cpd.setCourseCpd(req.authz!, courseId, value, rawUnit === "" ? null : rawUnit, req.id);
    } catch (e) {
      if (e instanceof RuleViolation) return contentPage(req, reply, { error: e.message }, 400);
      throw e;
    }
    return reply.redirect("/admin/content?flash=course-updated", 303);
  });

  // ---------------------------------------------------------------- CPD (learner)
  app.get("/cpd", { config: { policy: self } }, async (req, reply) => {
    const year = /^\d{4}$/.test(str((req.query as Record<string, unknown>).year)) ? str((req.query as Record<string, unknown>).year) : undefined;
    const summary = await services.cpd.summary(req.authz!, year);
    return sendHtml(reply, render(<CpdPage user={navUser(req)!} summary={summary} year={year} currentYear={cpdYearOf(new Date())} />));
  });

  app.get("/cpd/transcript", { config: { policy: self } }, async (req, reply) => {
    const year = /^\d{4}$/.test(str((req.query as Record<string, unknown>).year)) ? str((req.query as Record<string, unknown>).year) : undefined;
    const summary = await services.cpd.summary(req.authz!, year);
    return sendHtml(reply, render(<TranscriptPage user={navUser(req)!} name={req.authz!.displayName} summary={summary} year={year} generatedAt={new Date()} />));
  });

  app.get("/cpd/transcript.csv", { config: { policy: self } }, async (req, reply) => {
    const year = /^\d{4}$/.test(str((req.query as Record<string, unknown>).year)) ? str((req.query as Record<string, unknown>).year) : undefined;
    const csv = await services.cpd.transcriptCsv(req.authz!, req.id, year);
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="cpd-transcript${year ? `-${year}` : ""}.csv"`).header("cache-control", "no-store").send(csv);
  });

  // ---------------------------------------------------------------- invitations (public landing, ID-03)
  app.get("/invite/:token", { config: { policy: pub } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const preview = await services.identity.invitationPreview(token);
    return sendHtml(reply, render(<InvitePage orgName={preview?.orgName ?? null} token={token} providerLabel={config.OIDC_PROVIDER_LABEL} />), preview ? 200 : 404);
  });

  // ---------------------------------------------------------------- enterprise manager (org-scoped)
  const mgr = (capability: Capability): RoutePolicy => ({ auth: "session", capability, tenancy: "org" });
  const orgParam = (req: FastifyRequest) => {
    const { orgId } = req.params as { orgId: string };
    if (!isUuid(orgId)) throw new NotFoundError("organisation");
    return orgId; // a selector only: EnterpriseService checks it against the manager's server-side grants (ADR-0004)
  };
  const teamPage = async (req: FastifyRequest, reply: FastifyReply, orgId: string, extra: { inviteLink?: string; error?: string } = {}, status = 200) => {
    const view = await services.enterprise.teamView(req.authz!, orgId);
    return sendHtml(reply, render(<TeamPage user={navUser(req)!} view={view} now={new Date()} flash={flashOf(req)} inviteLink={extra.inviteLink} error={extra.error} />), status);
  };

  app.get("/manage", { config: { policy: mgr("org.manage") } }, async (req, reply) => {
    const orgs = await services.enterprise.managedOrganisations(req.authz!);
    if (orgs.length === 1) return reply.redirect(`/manage/orgs/${orgs[0]!.id}`, 303);
    return sendHtml(reply, render(<ManagePickPage user={navUser(req)!} orgs={orgs} />));
  });

  app.get("/manage/orgs/:orgId", { config: { policy: mgr("org.manage") } }, async (req, reply) => teamPage(req, reply, orgParam(req)));

  app.post("/manage/orgs/:orgId/invitations", { config: { policy: mgr("org.manage") } }, async (req, reply) => {
    const orgId = orgParam(req);
    const b = req.body as Record<string, unknown>;
    try {
      const r = await services.enterprise.invite(req.authz!, orgId, { name: str(b.name), email: str(b.email) }, req.id);
      return teamPage(req, reply, orgId, { inviteLink: r.link }, 201);
    } catch (e) {
      if (e instanceof RuleViolation) return teamPage(req, reply, orgId, { error: e.message }, 400);
      throw e;
    }
  });

  app.post("/manage/orgs/:orgId/assignments", { config: { policy: mgr("org.manage") } }, async (req, reply) => {
    const orgId = orgParam(req);
    const b = req.body as Record<string, unknown>;
    const personId = str(b.person_id);
    const courseId = str(b.course_id);
    if (!isUuid(personId) || !isUuid(courseId)) return teamPage(req, reply, orgId, { error: "Choose a learner and a course." }, 400);
    try {
      await services.enterprise.assignCourse(req.authz!, orgId, personId, courseId, req.id);
    } catch (e) {
      if (e instanceof RuleViolation) return teamPage(req, reply, orgId, { error: e.message }, 409);
      throw e;
    }
    return reply.redirect(`/manage/orgs/${orgId}?flash=seat-assigned`, 303);
  });

  app.get("/manage/orgs/:orgId/export.csv", { config: { policy: mgr("report.export.org") } }, async (req, reply) => {
    const orgId = orgParam(req);
    const csv = await services.enterprise.exportCsv(req.authz!, orgId, req.id);
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="team-progress.csv"').header("cache-control", "no-store").send(csv);
  });

  // ---------------------------------------------------------------- TCGI admin: organisations and seats
  const orgsPage = async (req: FastifyRequest, reply: FastifyReply, error?: string, status = 200) =>
    sendHtml(reply, render(<AdminOrganisationsPage user={navUser(req)!} orgs={await services.enterprise.listOrganisations(req.authz!)} flash={flashOf(req)} error={error} />), status);
  const orgDetailPage = async (req: FastifyRequest, reply: FastifyReply, orgId: string, extra: { error?: string; inviteLink?: string } = {}, status = 200) =>
    sendHtml(reply, render(<AdminOrganisationPage user={navUser(req)!} d={await services.enterprise.organisationDetail(req.authz!, orgId)} flash={flashOf(req)} error={extra.error} inviteLink={extra.inviteLink} />), status);
  const ruleOr = async <T,>(fn: () => Promise<T>, onRule: (msg: string) => Promise<unknown>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RuleViolation) {
        await onRule(e.message);
        return undefined;
      }
      throw e;
    }
  };

  app.get("/admin/organisations", { config: { policy: plat("org.admin") } }, async (req, reply) => orgsPage(req, reply));

  app.post("/admin/organisations", { config: { policy: plat("org.admin") } }, async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    const id = await ruleOr(() => services.enterprise.createOrganisation(req.authz!, { slug: str(b.slug).trim(), name: str(b.name) }, req.id), (m) => orgsPage(req, reply, m, 400));
    if (id === undefined) return reply;
    return reply.redirect(`/admin/organisations/${id}?flash=org-created`, 303);
  });

  app.get("/admin/organisations/:orgId", { config: { policy: plat("org.admin") } }, async (req, reply) => orgDetailPage(req, reply, orgParam(req)));

  app.post("/admin/organisations/:orgId/agreements", { config: { policy: plat("org.admin") } }, async (req, reply) => {
    const orgId = orgParam(req);
    const b = req.body as Record<string, unknown>;
    const start = new Date(`${str(b.access_start)}T00:00:00Z`);
    const end = new Date(`${str(b.access_end)}T23:59:59Z`);
    const courseIds = list(b.course_ids).filter(isUuid);
    const ok = await ruleOr(() => services.enterprise.createAgreement(req.authz!, orgId, {
      reference: str(b.reference), seatLimit: Number(str(b.seat_limit)), accessStart: start, accessEnd: end, courseIds,
    }, req.id), (m) => orgDetailPage(req, reply, orgId, { error: m }, 400));
    if (ok === undefined) return reply;
    return reply.redirect(`/admin/organisations/${orgId}?flash=agreement-created`, 303);
  });

  app.post("/admin/organisations/:orgId/managers", { config: { policy: plat("org.admin") } }, async (req, reply) => {
    const orgId = orgParam(req);
    const personId = str((req.body as Record<string, unknown>).person_id);
    if (!isUuid(personId)) return orgDetailPage(req, reply, orgId, { error: "Choose a member." }, 400);
    const ok = await ruleOr(async () => (await services.enterprise.grantManager(req.authz!, orgId, personId, req.id), true), (m) => orgDetailPage(req, reply, orgId, { error: m }, 400));
    if (ok === undefined) return reply;
    return reply.redirect(`/admin/organisations/${orgId}?flash=manager-granted`, 303);
  });

  app.post("/admin/organisations/:orgId/invitations", { config: { policy: plat("org.admin") } }, async (req, reply) => {
    const orgId = orgParam(req);
    const b = req.body as Record<string, unknown>;
    const r = await ruleOr(() => services.enterprise.invite(req.authz!, orgId, { name: str(b.name), email: str(b.email) }, req.id), (m) => orgDetailPage(req, reply, orgId, { error: m }, 400));
    if (r === undefined) return reply;
    return orgDetailPage(req, reply, orgId, { inviteLink: r.link }, 201);
  });

  app.post("/admin/seats/:seatId/release", { config: { policy: plat("org.admin") } }, async (req, reply) => {
    const { seatId } = req.params as { seatId: string };
    if (!isUuid(seatId)) throw new NotFoundError("seat");
    const orgId = await services.enterprise.releaseSeat(req.authz!, seatId, str((req.body as Record<string, unknown>).reason), req.id);
    return reply.redirect(`/admin/organisations/${orgId}?flash=seat-released`, 303);
  });

  // ---------------------------------------------------------------- TCGI admin: commerce events and mappings (S4)
  app.get("/admin/entitlement-events", { config: { policy: plat("entitlement.admin") } }, async (req, reply) => {
    const st = str((req.query as Record<string, unknown>).status);
    const status = st === "held" || st === "processed" || st === "received" ? st : undefined;
    const rows = await services.admin.inboundEvents(req.authz!, status);
    return sendHtml(reply, render(<AdminInboundPage user={navUser(req)!} rows={rows} status={status} flash={flashOf(req)} />));
  });

  app.post("/admin/entitlement-events/:id/reprocess", { config: { policy: plat("entitlement.admin") } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new NotFoundError("event");
    const ev = await services.admin.inboundEvent(req.authz!, id);
    await services.entitlementEvents.processAggregate(ev.source, ev.aggregate_id, personActor(req.authz!.personId, req.authz!.displayName), req.id);
    return reply.redirect("/admin/entitlement-events?flash=event-reprocessed", 303);
  });

  const mappingsPage = async (req: FastifyRequest, reply: FastifyReply, error?: string, status = 200) => {
    const m = await services.admin.mappings(req.authz!);
    return sendHtml(reply, render(<AdminMappingsPage user={navUser(req)!} mappings={m.mappings} courses={m.courses} flash={flashOf(req)} error={error} />), status);
  };
  app.get("/admin/mappings", { config: { policy: plat("entitlement.admin") } }, async (req, reply) => mappingsPage(req, reply));
  app.post("/admin/mappings", { config: { policy: plat("entitlement.admin") } }, async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    if (!isUuid(str(b.course_id))) return mappingsPage(req, reply, "Choose a course.", 400);
    const ok = await ruleOr(async () => (await services.admin.createMapping(req.authz!, { source: str(b.source).trim(), externalProductId: str(b.external_product_id), courseId: str(b.course_id) }, req.id), true),
      (m) => mappingsPage(req, reply, m, 400));
    if (ok === undefined) return reply;
    return reply.redirect("/admin/mappings?flash=mapping-created", 303);
  });

  // ---------------------------------------------------------------- inbound signed events (INT-01, machine-to-machine)
  await app.register(async (scope) => {
    // Raw body for HMAC verification. JSON is parsed only after the signature checks out.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
    scope.post("/integrations/v1/events/:source", { config: { policy: { auth: "signed-event", tenancy: "system" }, rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { source } = req.params as { source: string };
      const raw = typeof req.body === "string" ? req.body : "";
      const r = await services.entitlementEvents.ingest(source, {
        signature: typeof req.headers["tcgi-signature"] === "string" ? req.headers["tcgi-signature"] : undefined,
        keyId: typeof req.headers["tcgi-key-id"] === "string" ? req.headers["tcgi-key-id"] : undefined,
      }, raw);
      return reply.code(r.status).header("cache-control", "no-store").send(r.body);
    });
  });

  return app;
}
