import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.js";

/** LRN-02 responsive layout on a phone-sized viewport (Chromium emulation; real iOS and Android devices still pending, R8). */
test("mobile: the dashboard and lesson player fit the viewport, and a lesson can be launched and saved @mobile", async ({ page }) => {
  await signIn(page, "learner-b2c-1");
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(await noHorizontalScroll()).toBe(true);
  await page.getByRole("button", { name: /Enrol in Synthetic pathway/ }).click();
  expect(await noHorizontalScroll()).toBe(true);
  await page.getByRole("button", { name: /Start lesson/ }).first().click();
  await page.waitForURL(/\/player$/);
  const lesson = page.frameLocator("#player-frame");
  await expect(lesson.getByText("Screen 1 of 3")).toBeVisible();
  await lesson.getByRole("button", { name: "Next screen" }).tap();
  await expect(lesson.getByText("Screen 2 of 3")).toBeVisible();
  await lesson.getByRole("button", { name: "Save and exit lesson" }).tap();
  await page.getByRole("button", { name: "Save and return to course" }).tap();
  await expect(page.locator(".lesson-list")).toContainText("In progress");
  const box = await page.getByRole("button", { name: /Resume lesson/ }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44); // touch target size
});
