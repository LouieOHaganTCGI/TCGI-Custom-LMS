import { expect, type Page } from "@playwright/test";
import { E2E_PORTS } from "../dev/stack-env.js";

export const APP = `http://localhost:${E2E_PORTS.app}`;
export const STUB = `http://127.0.0.1:${E2E_PORTS.stub}`;

/** Sign in through the real OIDC flow using the local test IdP's user picker. */
export async function signIn(page: Page, user: string) {
  await page.goto("/");
  await expect(page.getByText("Local test IdP (not miniOrange)")).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("LOCAL TEST IDENTITY PROVIDER. This is not miniOrange.")).toBeVisible();
  await page.getByLabel("Synthetic user").selectOption(user);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/learn");
}

/**
 * LMS sign-out is local: it revokes the LMS session, but the IdP's own SSO session survives (single logout
 * is DEC-06). To switch to a different test user, the IdP cookies are cleared too.
 */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("You have signed out.")).toBeVisible();
  await page.context().clearCookies();
}

export async function stubEvents(): Promise<{ id: string; type: string; deliveries: number; envelope: { aggregate: { id: string } } }[]> {
  return (await fetch(`${STUB}/events`)).json();
}

/** Wait until the HubSpot stub has received an event of `type` for aggregate `id` (the outbox worker polls). */
export async function waitForStubEvent(type: string, aggregateId: string, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = (await stubEvents()).find((e) => e.type === type && e.envelope.aggregate.id === aggregateId);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`HubSpot stub never received ${type} for ${aggregateId}`);
}
