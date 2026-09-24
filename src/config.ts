import { z } from "zod";

/**
 * Runtime configuration. All secrets come from the environment (in deployed
 * environments: the secrets manager, ADR-0003). Nothing secret is committed.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Short environment label used in outbound event `source` (e.g. "staging"). */
    ENV_LABEL: z.string().regex(/^[a-z0-9-]+$/).default("local"),
    HOST: z.string().default("127.0.0.1"),
    APP_PORT: z.coerce.number().int().default(3000),
    CONTENT_PORT: z.coerce.number().int().default(3001),
    /** Public URL of the learner/admin application origin. */
    APP_BASE_URL: z.string().url(),
    /** Public URL of the separate SCORM content origin (ADR-0002). Must differ from APP_BASE_URL. */
    CONTENT_BASE_URL: z.string().url(),

    DATABASE_URL: z.string().min(1),
    /** Owner role connection, used only by migrations. */
    MIGRATION_DATABASE_URL: z.string().min(1).optional(),

    LAUNCH_TOKEN_SECRET: z.string().min(32),
    OUTBOUND_SIGNING_SECRET: z.string().min(32),
    OUTBOUND_SIGNING_KEY_ID: z.string().default("lms-outbound-1"),

    // Identity (ADR-0005). miniOrange sandbox values go here once DEC-06 provides them.
    OIDC_ISSUER: z.string().url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    /** Human label shown on the sign-in page so a test IdP is never mistaken for miniOrange. */
    OIDC_PROVIDER_LABEL: z.string().default("miniOrange"),
    /** Only for a local test IdP over http. Refused in production. */
    OIDC_ALLOW_INSECURE_HTTP: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    /** DEC-06 open: default is OFF, so only pre-provisioned or invited people can sign in. */
    AUTH_ALLOW_SELF_REGISTRATION: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    /** Provisional session policy pending DEC-06. */
    SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),

    BLOB_DIR: z.string().default("var/blobs"),
    MAX_PACKAGE_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),

    // Outbound HubSpot destination. The real HubSpot object mapping is DEC-08, so the only
    // implemented mode is "webhook", which POSTs the signed contract envelope to a URL
    // (a local stub or an approved sandbox receiver).
    HUBSPOT_MODE: z.enum(["disabled", "webhook"]).default("disabled"),
    HUBSPOT_WEBHOOK_URL: z.string().url().optional(),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(2000),
    /** Run the outbox dispatcher inside the web process (dev/single-node). Production runs `cli worker` separately. */
    RUN_WORKER: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    /**
     * Inbound signed-event sources and their HMAC keys (docs/04 §1), as JSON:
     * {"woocommerce:tcgi-store-staging": {"keys": {"k1": "<secret ≥ 32 chars>"}}}. Two keys allow rotation.
     */
    INBOUND_SOURCES: z.string().default("{}").transform((v, ctx) => {
      try {
        const parsed = z.record(z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/), z.object({ keys: z.record(z.string().min(1), z.string().min(32)) })).parse(JSON.parse(v));
        return parsed;
      } catch (e) {
        ctx.addIssue({ code: "custom", message: `INBOUND_SOURCES must be valid JSON: ${(e as Error).message.slice(0, 200)}` });
        return z.NEVER;
      }
    }),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((c, ctx) => {
    if (new URL(c.APP_BASE_URL).origin === new URL(c.CONTENT_BASE_URL).origin) {
      ctx.addIssue({ code: "custom", message: "CONTENT_BASE_URL must be a different origin from APP_BASE_URL (ADR-0002)" });
    }
    if (c.NODE_ENV === "production") {
      if (c.OIDC_ALLOW_INSECURE_HTTP) ctx.addIssue({ code: "custom", message: "OIDC_ALLOW_INSECURE_HTTP is not allowed in production" });
      for (const k of ["APP_BASE_URL", "CONTENT_BASE_URL", "OIDC_ISSUER"] as const) {
        if (!c[k].startsWith("https://")) ctx.addIssue({ code: "custom", message: `${k} must be https in production` });
      }
    }
    if (c.HUBSPOT_MODE === "webhook" && !c.HUBSPOT_WEBHOOK_URL) {
      ctx.addIssue({ code: "custom", message: "HUBSPOT_WEBHOOK_URL is required when HUBSPOT_MODE=webhook" });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}
