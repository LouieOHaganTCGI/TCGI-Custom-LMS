/** Environment for the local dev and E2E stacks. Local-only secrets, never used anywhere real. */
const LOCAL_SECRET = "local-dev-only-secret-not-for-any-real-environment";
/** HMAC key the local commerce simulator signs with (local only). */
export const SIM_COMMERCE_SECRET = `${LOCAL_SECRET}-commerce-sim`;

export interface StackPorts {
  app: number;
  content: number;
  idp: number;
  stub: number;
}

export function stackEnv(db: string, ports: StackPorts, pg = "127.0.0.1:54329"): Record<string, string> {
  return {
    NODE_ENV: "development",
    ENV_LABEL: db === "lms_e2e" ? "e2e" : "local",
    APP_PORT: String(ports.app),
    CONTENT_PORT: String(ports.content),
    APP_BASE_URL: `http://localhost:${ports.app}`,
    CONTENT_BASE_URL: `http://localhost:${ports.content}`,
    DATABASE_URL: `postgres://lms_app:lms_app_local@${pg}/${db}`,
    MIGRATION_DATABASE_URL: `postgres://lms_owner:lms_owner_local@${pg}/${db}`,
    LAUNCH_TOKEN_SECRET: `${LOCAL_SECRET}-launch`,
    OUTBOUND_SIGNING_SECRET: `${LOCAL_SECRET}-outbound`,
    OIDC_ISSUER: `http://127.0.0.1:${ports.idp}`,
    OIDC_CLIENT_ID: "tcgi-lms-local",
    OIDC_CLIENT_SECRET: `${LOCAL_SECRET}-oidc`,
    OIDC_PROVIDER_LABEL: "Local test IdP (not miniOrange)",
    OIDC_ALLOW_INSECURE_HTTP: "true",
    HUBSPOT_MODE: "webhook",
    HUBSPOT_WEBHOOK_URL: `http://127.0.0.1:${ports.stub}/events`,
    BLOB_DIR: `var/blobs-${db}`,
    RUN_WORKER: "true",
    WORKER_POLL_MS: "300",
    LOG_LEVEL: "warn",
    INBOUND_SOURCES: JSON.stringify({ "woocommerce:tcgi-store-sim": { keys: { "sim-1": SIM_COMMERCE_SECRET } } }),
  };
}

export const DEV_PORTS: StackPorts = { app: 3000, content: 3001, idp: 4400, stub: 4500 };
export const E2E_PORTS: StackPorts = { app: 3200, content: 3201, idp: 4600, stub: 4700 };
