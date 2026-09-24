import { generateKeyPairSync, randomUUID } from "node:crypto";
import http from "node:http";
import Provider, { type Configuration } from "oidc-provider";

/**
 * LOCAL TEST IDENTITY PROVIDER. This is NOT miniOrange.
 *
 * A standards-compliant OpenID Provider (oidc-provider, MIT) for development and automated tests. It lets
 * the real OIDC relying-party code in src/modules/identity be exercised end to end, including signatures,
 * PKCE, state, nonce, issuer and audience checks. The miniOrange sandbox replaces it by configuration only,
 * once DEC-06 provides the tenant (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET).
 * Only synthetic users exist here, and there are no passwords: you choose a user from a list.
 */
export interface TestUser {
  sub: string;
  name: string;
  email: string;
  emailVerified?: boolean;
}

export interface TestIdp {
  issuer: string;
  server: http.Server;
  users: Map<string, TestUser>;
  setEmail(sub: string, email: string): void;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startTestIdp(opts: {
  port: number;
  host?: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  users: TestUser[];
}): Promise<TestIdp> {
  const host = opts.host ?? "127.0.0.1";
  const issuer = `http://${host}:${opts.port}`;
  const users = new Map(opts.users.map((u) => [u.sub, { ...u }]));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...privateKey.export({ format: "jwk" }), kid: randomUUID(), use: "sig", alg: "RS256" };

  const configuration: Configuration = {
    clients: [{
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uris: opts.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    }],
    jwks: { keys: [jwk as never] },
    cookies: { keys: [`test-idp-${randomUUID()}`] },
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false } },
    claims: { openid: ["sub"], email: ["email", "email_verified"], profile: ["name"] },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, id) => {
      const u = users.get(id);
      if (!u) return undefined;
      return { accountId: id, claims: async () => ({ sub: id, name: u.name, email: u.email, email_verified: u.emailVerified ?? true }) };
    },
    // First-party test client: grant the requested OIDC scopes without a consent screen.
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId ?? ctx.oidc.session!.grantIdFor(ctx.oidc.client!.clientId);
      if (grantId) return ctx.oidc.provider.Grant.find(grantId);
      const grant = new ctx.oidc.provider.Grant({ clientId: ctx.oidc.client!.clientId, accountId: ctx.oidc.session!.accountId! });
      grant.addOIDCScope("openid email profile");
      await grant.save();
      return grant;
    },
  };
  const provider = new Provider(issuer, configuration);
  const callback = provider.callback();

  const server = http.createServer(async (req, res) => {
    try {
      const m = req.url?.match(/^\/interaction\/([A-Za-z0-9_-]+)(\/login)?$/);
      if (!m) return callback(req, res);
      const details = await provider.interactionDetails(req, res);
      if (req.method === "GET" && !m[2]) {
        const options = [...users.values()].map((u) => `<option value="${esc(u.sub)}">${esc(u.name)} (${esc(u.sub)})</option>`).join("");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local test IdP</title></head>
<body style="font-family:system-ui;max-width:36rem;margin:2rem auto;padding:0 1rem">
<p role="note" style="background:#fff4d6;border:1px solid #8a4b00;padding:.75rem"><strong>LOCAL TEST IDENTITY PROVIDER. This is not miniOrange.</strong> Synthetic users only.</p>
<h1>Sign in (test)</h1>
<form method="post" action="/interaction/${esc(details.uid)}/login">
<label for="user">Synthetic user</label><br><select id="user" name="login">${options}</select><br><br>
<button type="submit">Continue</button></form></body></html>`);
      }
      if (req.method === "POST" && m[2]) {
        const body = await new Promise<string>((resolve) => {
          let d = "";
          req.on("data", (c) => (d += c));
          req.on("end", () => resolve(d));
        });
        const login = new URLSearchParams(body).get("login") ?? "";
        if (!users.has(login)) {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end("unknown test user");
        }
        return provider.interactionFinished(req, res, { login: { accountId: login } }, { mergeWithLastSubmission: false });
      }
      res.writeHead(405).end();
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`test idp error: ${(e as Error).message}`);
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  return {
    issuer,
    server,
    users,
    setEmail(sub, email) {
      const u = users.get(sub);
      if (u) u.email = email;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
