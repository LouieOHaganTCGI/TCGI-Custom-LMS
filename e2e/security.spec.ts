import { expect, test } from "@playwright/test";
import pg from "pg";
import { buildZip } from "../src/lib/zip-writer.js";
import { APP, signIn } from "./helpers.js";

/**
 * Threat T-09: a hostile SCORM package (untrusted JavaScript) must not be able to read or act on the learner's
 * application session. The package runs on the separate content origin. It tries to read cookies, read
 * the app, and make a state-changing request without a CSRF token.
 */
const OWNER = "postgres://lms_owner:lms_owner_local@127.0.0.1:54329/lms_e2e";

function hostilePackage(targetCourseId: string): Buffer {
  const manifest = `<?xml version="1.0"?><manifest identifier="hostile" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
<metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
<organizations default="o"><organization identifier="o"><title>Hostile test package</title><item identifier="i" identifierref="r"><title>Hostile</title></item></organization></organizations>
<resources><resource identifier="r" type="webcontent" adlcp:scormtype="sco" href="index.html"/></resources></manifest>`;
  const js = `(async function () {
  var out = [];
  out.push("COOKIE:" + (document.cookie.indexOf("lms_sid") >= 0 ? "LEAKED" : "none"));
  try { var r = await fetch("${APP}/learn", { credentials: "include" }); var t = await r.text(); out.push("APP-READ:LEAKED " + t.length); }
  catch (e) { out.push("APP-READ:blocked"); }
  try { await fetch("${APP}/learn/courses/${targetCourseId}/enrol", { method: "POST", mode: "no-cors", credentials: "include",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "organisation_id=x" }); out.push("APP-POST:sent"); }
  catch (e) { out.push("APP-POST:blocked"); }
  try { out.push("TOP-ORIGIN:" + window.top.location.origin); } catch (e) { out.push("TOP-ORIGIN:blocked"); }
  document.getElementById("out").textContent = out.join("|");
})();`;
  return buildZip([
    { name: "imsmanifest.xml", data: Buffer.from(manifest) },
    { name: "index.html", data: Buffer.from(`<!doctype html><html lang="en"><head><title>hostile</title></head><body><p id="out">running</p><script src="evil.js"></script></body></html>`) },
    { name: "evil.js", data: Buffer.from(js) },
  ]);
}

async function owner<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

test("a hostile SCORM package can't read or use the app session (T-09) @security", async ({ page }) => {
  const [target] = await owner<{ id: string }>("select id from course where slug='synthetic-pathway-two-lessons'");
  await signIn(page, "admin-1");
  // Upload through the admin UI: validation accepts it (it's a structurally valid package).
  await page.goto("/admin/content");
  await page.getByLabel(/Content key/).fill("hostile-test-package");
  await page.getByLabel("SCORM zip package").setInputFiles({ name: "hostile.zip", mimeType: "application/zip", buffer: hostilePackage(target!.id) });
  await page.getByRole("button", { name: "Upload and validate" }).click();
  await expect(page.getByRole("status")).toContainText("Imported SCORM 1.2 package");
  const versionId = /Content version ID: ([0-9a-f-]{36})/.exec((await page.getByRole("status").textContent())!)![1]!;
  await page.getByLabel("Course slug").fill("hostile-course");
  await page.getByLabel("Title").fill("Hostile course");
  await page.getByLabel(/Content version IDs/).fill(versionId);
  await page.getByRole("button", { name: "Create and publish" }).click();
  await expect(page.getByRole("status")).toContainText("Course created and published");

  // Entitle the admin through the fixture command path (SQL here stands in for the CLI fixture).
  const [ids] = await owner<{ person_id: string; org: string; course: string }>(
    "select p.id as person_id, o.id as org, c.id as course from person p, organisation o, course c where p.display_name like 'Dana%' and o.slug='tcgi-direct' and c.slug='hostile-course'");
  await owner(`insert into entitlement (organisation_id, person_id, course_id, grant_type, source, external_order_id, external_line_id, status, valid_from, valid_until)
    values ($1,$2,$3,'manual','e2e-fixture','E2E','hostile','active', now() - interval '1 day', now() + interval '30 days')`, [ids!.org, ids!.person_id, ids!.course]);
  const before = await owner("select id from enrolment where course_id=$1", [target!.id]);

  await page.goto("/learn");
  await page.getByRole("button", { name: "Enrol in Hostile course" }).click();
  await page.getByRole("button", { name: /Start lesson/ }).click();
  await page.waitForURL(/\/player$/);
  const result = page.frameLocator("#player-frame").locator("#out");
  await expect(result).not.toHaveText("running", { timeout: 10_000 });
  const text = (await result.textContent())!;
  expect(text).toContain("COOKIE:none");
  expect(text).toContain("APP-READ:blocked");
  expect(text).toContain("TOP-ORIGIN:http://localhost:3201"); // top is the player on the content origin, not the app
  // The no-cors POST can be sent, but without the CSRF token it is refused: no enrolment is created.
  const after = await owner("select id from enrolment where course_id=$1", [target!.id]);
  expect(after.length).toBe(before.length);
});
