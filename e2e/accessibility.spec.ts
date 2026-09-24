import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers.js";

/**
 * TS-A11Y automated gate (WCAG 2.1 A/AA rules in axe-core) for LMS platform pages. Automated checks find only
 * part of WCAG issues. Manual keyboard and screen-reader passes and the independent audit (DEC-27) are
 * still required. Uploaded Rise content is tested separately (spec §5.2).
 */
async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n").slice(1, 2).join("")}`).join(" | ")}`)).toEqual([]);
}

test("platform pages have no serious or critical axe violations @a11y", async ({ page }) => {
  await page.goto("/");
  await audit(page, "sign-in");
  await signIn(page, "learner-ent-b-1");
  await audit(page, "dashboard");
  await page.getByRole("button", { name: /Enrol in/ }).first().click();
  await audit(page, "enrolment");
  await page.getByRole("link", { name: "My account" }).click();
  await audit(page, "my account");
  for (const url of ["/cpd", "/cpd/transcript"]) {
    await page.goto(url);
    await audit(page, url);
  }
  await page.goto("/invite/not-a-valid-token");
  await audit(page, "invite (invalid)");
  await page.goto("/learn"); // the public invite page has no signed-in navigation
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.context().clearCookies();
  await signIn(page, "manager-ent-a-1");
  await page.goto("/manage");
  await audit(page, "manager team");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.context().clearCookies();
  await signIn(page, "admin-1");
  for (const url of ["/admin", "/admin/audit", "/admin/integrations", "/admin/content", "/admin/organisations", "/admin/entitlement-events", "/admin/mappings"]) {
    await page.goto(url);
    await audit(page, url);
  }
  await page.goto("/admin/organisations");
  await page.getByRole("link", { name: "Synthetic Enterprise A" }).click();
  await audit(page, "organisation detail");
});

test("keyboard: the skip link moves focus to main content, and actions are reachable by Tab", async ({ page }) => {
  await signIn(page, "learner-ent-a-1");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  let found = false;
  for (let i = 0; i < 15 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await page.evaluate(() => document.activeElement?.textContent?.includes("Enrol in") ?? false);
  }
  expect(found).toBe(true);
});
