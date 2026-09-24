import { loadConfig, type Config } from "../../src/config.js";

const PG = process.env.TEST_PG ?? "127.0.0.1:54329";
const DB = process.env.TEST_DB ?? "lms_test";
export const OWNER_URL = process.env.TEST_OWNER_URL ?? `postgres://lms_owner:lms_owner_local@${PG}/${DB}`;
export const APP_URL = process.env.TEST_APP_URL ?? `postgres://lms_app:lms_app_local@${PG}/${DB}`;
const SECRET = "test-only-secret-value-not-used-anywhere-else";
export const TEST_COMMERCE_SECRET = `${SECRET}-commerce`;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    ENV_LABEL: "test",
    APP_BASE_URL: "http://localhost:3100",
    CONTENT_BASE_URL: "http://localhost:3101",
    DATABASE_URL: APP_URL,
    MIGRATION_DATABASE_URL: OWNER_URL,
    LAUNCH_TOKEN_SECRET: `${SECRET}-launch`,
    OUTBOUND_SIGNING_SECRET: `${SECRET}-outbound`,
    OIDC_ISSUER: "http://127.0.0.1:4499",
    OIDC_CLIENT_ID: "tcgi-lms-test",
    OIDC_CLIENT_SECRET: `${SECRET}-oidc`,
    OIDC_ALLOW_INSECURE_HTTP: "true",
    OIDC_PROVIDER_LABEL: "Local test IdP (not miniOrange)",
    BLOB_DIR: "var/blobs-test",
    LOG_LEVEL: "silent",
    INBOUND_SOURCES: JSON.stringify({ "woocommerce:tcgi-store-sim": { keys: { "k1": TEST_COMMERCE_SECRET, "k2": `${TEST_COMMERCE_SECRET}-rotated` } } }),
    ...overrides,
  });
}
