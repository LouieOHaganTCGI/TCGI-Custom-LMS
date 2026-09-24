import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut, waitForStubEvent } from "./helpers.js";

/**
 * The Phase B vertical slice, end to end in a real browser:
 * sign-in (OIDC, local test IdP) → scoped identity → entitlement fixture → enrolment → launch a SCORM
 * package → save/restore progress → completion → event queued and delivered (HubSpot stub) → admin audit.
 *
 * The packages are the SYNTHETIC fixtures, not Rise exports (see fixtures/scorm/README.md).
 */
async function runLessonJourney(page: Page, courseTitle: string) {
  await page.getByRole("button", { name: `Enrol in ${courseTitle}` }).click();
  await page.waitForURL("**/learn/enrolments/**");
  const enrolmentId = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { level: 1, name: courseTitle })).toBeVisible();

  // First launch: ab-initio.
  await page.getByRole("button", { name: /Start lesson/ }).click();
  await page.waitForURL(/\/a\/[0-9a-f-]+\/player$/);
  expect(new URL(page.url()).port).toBe("3201"); // the separate content origin
  const lesson = page.frameLocator("#player-frame");
  await expect(lesson.getByText("Screen 1 of 3")).toBeVisible();
  await expect(lesson.locator("#resume-note")).toBeHidden();
  await lesson.getByRole("button", { name: "Next screen" }).click();
  await expect(lesson.getByText("Screen 2 of 3")).toBeVisible();
  await lesson.getByRole("button", { name: "Save and exit lesson" }).click();
  await expect(page.locator("#player-status")).toHaveText(/progress has been saved/);
  await page.getByRole("button", { name: "Save and return to course" }).click();
  await page.waitForURL(`**/learn/enrolments/${enrolmentId}`);
  await expect(page.locator(".lesson-list")).toContainText("In progress");

  // Relaunch: the saved state is restored and the content resumes at screen 2.
  await page.getByRole("button", { name: /Resume lesson/ }).click();
  await page.waitForURL(/\/player$/);
  await expect(lesson.getByText("Screen 2 of 3")).toBeVisible();
  await expect(lesson.locator("#resume-note")).toBeVisible();
  await lesson.getByRole("button", { name: /Complete lesson/ }).click();
  await expect(lesson.getByText("Lesson completed and passed (score 80).")).toBeVisible();
  await page.getByRole("button", { name: "Save and return to course" }).click();
  await page.waitForURL(`**/learn/enrolments/${enrolmentId}`);

  // Completion is displayed to the learner.
  await expect(page.getByText(/Course completed on/)).toBeVisible();
  await expect(page.locator(".lesson-list")).toContainText("Passed");
  await expect(page.locator(".lesson-list")).toContainText("Score reported by the lesson: 80");
  await page.getByRole("link", { name: "My learning" }).first().click();
  await expect(page.locator(".card", { hasText: courseTitle })).toContainText("1 of 1 lessons completed");
  return enrolmentId;
}

test.describe("Phase B vertical slice", () => {
  test("SCORM 1.2: an enterprise learner's full journey, with the event delivered and an admin audit record @phase-b", async ({ page }) => {
    await signIn(page, "learner-ent-a-1");
    await page.getByRole("link", { name: "My account" }).click();
    await expect(page.locator("main")).toContainText("Synthetic Enterprise A");
    await expect(page.locator("main")).toContainText("learner-ent-a-1"); // the IdP subject is the key
    await page.getByRole("link", { name: "My learning" }).click();

    const enrolmentId = await runLessonJourney(page, "Synthetic course: SCORM 1.2 lesson");
    const created = await waitForStubEvent("enrolment.created", enrolmentId);
    const completed = await waitForStubEvent("course.completed", enrolmentId);
    expect(created.deliveries).toBe(1);
    expect(completed.deliveries).toBe(1);
    await signOut(page);

    await signIn(page, "admin-1");
    await page.goto(`/admin/audit?entity_type=enrolment&entity_id=${enrolmentId}`);
    const rows = page.locator("tbody tr");
    await expect(rows.filter({ hasText: "enrolment.completed" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "enrolment.created" })).toHaveCount(1);
    await expect(rows.first()).toContainText("Brian Synthetic");
    await expect(rows.first()).toContainText("Synthetic Enterprise A");
    await page.goto("/admin/integrations");
    const delivered = page.locator(`tr[data-event-type="course.completed"][data-status="delivered"]`);
    await expect(delivered.filter({ hasText: enrolmentId.slice(0, 13) })).toHaveCount(1);
  });

  test("SCORM 2004: a B2C learner's full journey @phase-b", async ({ page }) => {
    await signIn(page, "learner-b2c-1");
    const enrolmentId = await runLessonJourney(page, "Synthetic course: SCORM 2004 lesson");
    await waitForStubEvent("course.completed", enrolmentId);
  });

  test("tenant isolation in the browser: a learner from another organisation gets a 404 on someone else's enrolment", async ({ page }) => {
    await signIn(page, "learner-b2c-1");
    await page.getByRole("link", { name: /Synthetic course: SCORM 2004 lesson/ }).click();
    const foreignUrl = page.url();
    await signOut(page);
    await signIn(page, "learner-ent-b-1");
    const res = await page.goto(foreignUrl);
    expect(res!.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});
