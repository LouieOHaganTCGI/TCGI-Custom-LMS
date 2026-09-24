import { expect, test } from "@playwright/test";
import { commerceEvent, sendSigned } from "../dev/commerce-sim.js";
import { E2E_PORTS } from "../dev/stack-env.js";
import { APP, signIn, signOut } from "./helpers.js";

/**
 * S5 manager journey and S4 purchase/refund journey in a real browser.
 * The local test IdP, the commerce simulator and the HubSpot stub are stand-ins (not miniOrange, WooCommerce or HubSpot).
 */
test("manager invites a new starter, assigns a course, and sees their completion and CPD @enterprise", async ({ page }) => {
  await signIn(page, "manager-ent-a-1");
  await page.getByRole("link", { name: "Manage team" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Enterprise A" })).toBeVisible();
  await page.getByLabel("Full name").fill("Grace Newstarter");
  await page.getByLabel(/Work email/).fill("grace.work@example.test");
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = await page.getByLabel("Invitation link").inputValue();
  expect(link).toMatch(new RegExp(`^${APP}/invite/`));
  await signOut(page);

  // The new starter accepts with their own IdP identity.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "You're invited to learn with Synthetic Enterprise A" })).toBeVisible();
  await page.getByRole("button", { name: "Accept and sign in" }).click();
  await page.getByLabel("Synthetic user").selectOption("new-starter-1");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Welcome! Your account is now linked.")).toBeVisible();
  await signOut(page);

  // The manager assigns a course from the agreement.
  await signIn(page, "manager-ent-a-1");
  await page.goto("/manage");
  await page.getByRole("combobox", { name: "Learner", exact: true }).selectOption({ label: "Grace Newstarter" });
  await page.getByRole("combobox", { name: /^Course/ }).selectOption({ label: "Synthetic course: SCORM 1.2 lesson · Micro-lesson" });
  await page.getByRole("button", { name: "Assign course" }).click();
  await expect(page.getByText("Course assigned.")).toBeVisible();
  await expect(page.locator("tr", { hasText: "Grace Newstarter" })).toContainText("Seat active");
  await signOut(page);

  // The learner completes it.
  await signIn(page, "new-starter-1");
  await page.getByRole("button", { name: "Enrol in Synthetic course: SCORM 1.2 lesson" }).click();
  await page.getByRole("button", { name: /Start the first lesson/ }).click();
  await page.waitForURL(/\/player$/);
  const lesson = page.frameLocator("#player-frame");
  await lesson.getByRole("button", { name: /Complete lesson/ }).click();
  await expect(lesson.getByText("Lesson completed and passed (score 80).")).toBeVisible();
  await page.getByRole("button", { name: "Save and return to course" }).click();
  await expect(page.getByText(/Course completed on/)).toBeVisible();
  await page.getByRole("link", { name: "CPD" }).click();
  await expect(page.getByRole("cell", { name: /Synthetic course: SCORM 1.2 lesson/ })).toBeVisible();
  await signOut(page);

  // The manager sees the completion and CPD.
  await signIn(page, "manager-ent-a-1");
  await page.goto("/manage");
  const row = page.locator("tr", { hasText: "Grace Newstarter" });
  await expect(row).toContainText("Completed");
  await expect(row).toContainText("1 CPD units (synthetic)");
});

test("a signed purchase grants a course and a refund withdraws it, visible to the learner and admin @commerce", async ({ page }) => {
  const idpIssuer = `http://127.0.0.1:${E2E_PORTS.idp}`;
  const buy = commerceEvent({ action: "purchase", idpIssuer, learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "E2E-900" });
  expect((await sendSigned(APP, buy)).status).toBe(202);

  await signIn(page, "learner-ent-b-1");
  await page.getByRole("button", { name: "Enrol in Synthetic pathway: two reused lessons" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic pathway: two reused lessons" })).toBeVisible();
  await expect(page.getByText("TCGI Direct (B2C)").first()).toBeVisible(); // the B2C context, decided by the server

  const refund = commerceEvent({ action: "refund", idpIssuer, learnerSubject: "learner-ent-b-1", product: "SYN-PROD-PATHWAY-01", order: "E2E-900" });
  expect((await sendSigned(APP, refund)).status).toBe(202);
  await page.reload();
  await expect(page.getByText("Withdrawn").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Start lesson/ }).first()).toBeDisabled();
  await signOut(page);

  await signIn(page, "admin-1");
  await page.goto("/admin/entitlement-events");
  await expect(page.locator(`tr[data-event-type="entitlement.refunded"][data-status="processed"]`, { hasText: "E2E-900:1" })).toHaveCount(1);
  await expect(page.locator(`tr[data-event-type="entitlement.purchase_completed"]`, { hasText: "E2E-900:1" })).toContainText("Revoked");
});
