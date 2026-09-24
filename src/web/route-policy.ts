import type { FastifyInstance, RouteOptions } from "fastify";
import type { Capability } from "../modules/authz/authz.js";

/**
 * Every route must declare how it is authorised (ADR-0004, TS-SEC route inventory). The server refuses to
 * start if a route has no policy, so an unprotected route can't ship by accident.
 *
 * - `public`: no principal needed (sign-in pages, static assets, health).
 * - `session` + capability: an application-origin route that needs a signed-in person with the capability.
 * - `launch-token`: a content-origin route authorised by an attempt-scoped launch token.
 * - `signed-event`: a machine-to-machine route authorised by an HMAC signature per source (docs/04). Browsers
 *   and sessions are never accepted there.
 *
 * `tenancy` documents where the data scope comes from. It's checked by the security tests.
 */
export type RoutePolicy =
  | { auth: "public"; tenancy: "none"; csrf?: false }
  | { auth: "session"; capability: Capability; tenancy: "self" | "platform" | "org"; csrf?: boolean }
  | { auth: "launch-token"; tenancy: "attempt" }
  | { auth: "signed-event"; tenancy: "system" };

declare module "fastify" {
  interface FastifyContextConfig {
    policy?: RoutePolicy;
  }
}

export interface RegisteredRoute {
  origin: "app" | "content";
  method: string;
  url: string;
  policy: RoutePolicy;
}

export function enforceRoutePolicies(app: FastifyInstance, origin: "app" | "content", registry: RegisteredRoute[]): void {
  app.addHook("onRoute", (route: RouteOptions) => {
    const policy = (route.config as { policy?: RoutePolicy } | undefined)?.policy;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.every((m) => m === "HEAD")) return; // automatic HEAD routes mirror their GET
    if (!policy) throw new Error(`Route ${methods.join(",")} ${route.url} has no authorisation policy (config.policy)`);
    if (origin === "content" && policy.auth === "session") throw new Error(`Content-origin route ${route.url} must not use app sessions`);
    if (origin === "app" && policy.auth === "launch-token") throw new Error(`Launch tokens are only valid on the content origin (${route.url})`);
    if (origin === "content" && policy.auth === "signed-event") throw new Error(`Signed-event routes belong on the app origin (${route.url})`);
    for (const m of methods) if (m !== "HEAD") registry.push({ origin, method: m, url: route.url, policy });
  });
}
