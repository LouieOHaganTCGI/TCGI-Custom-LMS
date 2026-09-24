import type { Config } from "./config.js";
import { createDb } from "./db/pool.js";
import { ScopedDb } from "./db/scoped.js";
import { AdminQueries } from "./modules/admin/admin-queries.js";
import { LocalBlobStore, type BlobStore } from "./modules/catalogue/blob-store.js";
import { ContentService } from "./modules/catalogue/content-service.js";
import { EnrolmentService } from "./modules/enrolment/enrolment-service.js";
import { EntitlementCommands } from "./modules/entitlements/entitlement-commands.js";
import { IdentityService } from "./modules/identity/identity-service.js";
import { OidcRelyingParty } from "./modules/identity/oidc.js";
import { SessionStore } from "./modules/identity/sessions.js";
import { OutboxDispatcher, SignedWebhookDestination, type DestinationAdapter } from "./modules/integration/dispatcher.js";
import { LearningService } from "./modules/learning/learning-service.js";

export interface Services {
  config: Config;
  db: ScopedDb;
  store: BlobStore;
  sessions: SessionStore;
  identity: IdentityService;
  oidc: OidcRelyingParty;
  content: ContentService;
  entitlements: EntitlementCommands;
  enrolment: EnrolmentService;
  learning: LearningService;
  dispatcher: OutboxDispatcher;
  admin: AdminQueries;
  close(): Promise<void>;
}

export function createServices(config: Config, overrides: { adapters?: Map<string, DestinationAdapter> } = {}): Services {
  const db = new ScopedDb(createDb(config.DATABASE_URL));
  const store = new LocalBlobStore(config.BLOB_DIR);
  const eventSource = `tcgi-lms:${config.ENV_LABEL}`;
  const adapters =
    overrides.adapters ??
    new Map<string, DestinationAdapter>(
      config.HUBSPOT_MODE === "webhook" && config.HUBSPOT_WEBHOOK_URL
        ? [["hubspot", new SignedWebhookDestination("hubspot", config.HUBSPOT_WEBHOOK_URL, config.OUTBOUND_SIGNING_SECRET, config.OUTBOUND_SIGNING_KEY_ID)]]
        : [],
    );
  return {
    config,
    db,
    store,
    sessions: new SessionStore(db, { idleMinutes: config.SESSION_IDLE_MINUTES, absoluteHours: config.SESSION_ABSOLUTE_HOURS }),
    identity: new IdentityService(db, { allowSelfRegistration: config.AUTH_ALLOW_SELF_REGISTRATION }),
    oidc: new OidcRelyingParty(db, {
      issuer: config.OIDC_ISSUER,
      clientId: config.OIDC_CLIENT_ID,
      clientSecret: config.OIDC_CLIENT_SECRET,
      redirectUri: new URL("/auth/callback", config.APP_BASE_URL).href,
      allowInsecureHttp: config.OIDC_ALLOW_INSECURE_HTTP,
    }),
    content: new ContentService(db, store),
    entitlements: new EntitlementCommands(db),
    enrolment: new EnrolmentService(db, eventSource),
    learning: new LearningService(db, { launchTokenSecret: config.LAUNCH_TOKEN_SECRET, contentBaseUrl: config.CONTENT_BASE_URL, eventSource }),
    dispatcher: new OutboxDispatcher(db, adapters, config.OUTBOX_MAX_ATTEMPTS),
    admin: new AdminQueries(db),
    close: () => db.destroy(),
  };
}
