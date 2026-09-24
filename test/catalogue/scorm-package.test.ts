import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipDirectory } from "../../src/lib/zip-dir.js";
import { buildZip } from "../../src/lib/zip-writer.js";
import { inspectPackage, PackageValidationError, parseManifest } from "../../src/modules/catalogue/scorm-package.js";
import { FIXTURE_DIR } from "../../src/seed.js";
import { createHarness, ownerQuery, type Harness } from "../support/harness.js";

const manifest12 = (resources: string, items = '<item identifier="i1" identifierref="r1"><title>t</title></item>') => `<?xml version="1.0"?>
<manifest identifier="m1" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
<metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
<organizations default="o1"><organization identifier="o1"><title>Lesson</title>${items}</organization></organizations>
<resources>${resources}</resources></manifest>`;
const oneSco = '<resource identifier="r1" type="webcontent" adlcp:scormtype="sco" href="index.html"/>';
const ok = (extra: { name: string; data: Buffer; unixMode?: number; declaredSize?: number }[] = []) =>
  buildZip([{ name: "imsmanifest.xml", data: Buffer.from(manifest12(oneSco)) }, { name: "index.html", data: Buffer.from("<html></html>") }, ...extra]);

async function rejects(zip: Buffer, code: string) {
  const err = await inspectPackage(zip).catch((e) => e);
  expect(err, `expected rejection ${code}`).toBeInstanceOf(PackageValidationError);
  expect((err as PackageValidationError).code).toBe(code);
}

describe("SCORM package validation (CAT-01, T-19, T-20)", () => {
  it("accepts the synthetic SCORM 1.2 and 2004 fixtures and detects version and launch file", async () => {
    const p12 = await inspectPackage(await zipDirectory(path.join(FIXTURE_DIR, "synthetic-scorm12")));
    expect(p12).toMatchObject({ scormVersion: "1.2", launchHref: "index.html", scoCount: 1, manifestIdentifier: "tcgi-synthetic-scorm12" });
    const p04 = await inspectPackage(await zipDirectory(path.join(FIXTURE_DIR, "synthetic-scorm2004")));
    expect(p04).toMatchObject({ scormVersion: "2004", scormEdition: "2004 4th Edition", launchHref: "index.html" });
  });

  it("rejects path traversal, absolute paths and backslash paths (zip-slip)", async () => {
    await rejects(ok([{ name: "../../evil.js", data: Buffer.from("x") }]), "unsafe_path");
    await rejects(ok([{ name: "/etc/cron.d/evil", data: Buffer.from("x") }]), "unsafe_path");
    await rejects(ok([{ name: "a\\..\\..\\evil", data: Buffer.from("x") }]), "unsafe_path");
    await rejects(ok([{ name: "C:/windows/evil", data: Buffer.from("x") }]), "unsafe_path");
  });

  it("rejects symbolic links", async () => {
    await rejects(ok([{ name: "link", data: Buffer.from("/etc/passwd"), unixMode: 0o120777 }]), "symlink");
  });

  it("rejects zip bombs (extreme compression ratio)", async () => {
    await rejects(ok([{ name: "bomb.bin", data: Buffer.alloc(20 * 1024 * 1024, 0) }]), "compression_ratio");
  });

  it("rejects entries larger than declared", async () => {
    const err = await inspectPackage(ok([{ name: "liar.txt", data: Buffer.alloc(5000, 65), declaredSize: 10 }])).catch((e) => e);
    expect(err).toBeInstanceOf(PackageValidationError);
  });

  it("rejects non-zip input, a missing manifest, and a missing launch file", async () => {
    await rejects(Buffer.from("definitely not a zip"), "invalid_zip");
    await rejects(buildZip([{ name: "index.html", data: Buffer.from("x") }]), "no_manifest");
    await rejects(buildZip([{ name: "imsmanifest.xml", data: Buffer.from(manifest12(oneSco)) }]), "launch_missing");
  });

  it("refuses manifest DTDs and entities (no XXE or billion-laughs)", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x SYSTEM "file:///etc/passwd">]><manifest identifier="m">&x;</manifest>`;
    expect(() => parseManifest(xxe)).toThrow(/DTD/);
  });

  it("rejects unsupported versions and packages with no SCO", () => {
    expect(() => parseManifest(manifest12(oneSco).replace("<schemaversion>1.2</schemaversion>", "<schemaversion>0.9</schemaversion>"))).toThrow(/unsupported/);
    expect(() => parseManifest(manifest12('<resource identifier="r1" type="webcontent" adlcp:scormtype="asset" href="index.html"/>'))).toThrow(/no launchable SCO/);
  });

  it("rejects multi-SCO packages until the runtime decision covers sequencing (DEC-13)", () => {
    const res = oneSco + '<resource identifier="r2" type="webcontent" adlcp:scormtype="sco" href="two.html"/>';
    const items = '<item identifier="i1" identifierref="r1"><title>a</title></item><item identifier="i2" identifierref="r2"><title>b</title></item>';
    expect(() => parseManifest(manifest12(res, items))).toThrow(/multi-SCO/);
  });
});

describe("content import: ContentItem / immutable ContentVersion (CAT-02)", () => {
  let h: Harness;
  beforeAll(async () => (h = await createHarness()));
  afterAll(async () => h.close());
  const actor = { type: "system" as const, label: "test" };

  it("re-uploading an identical package reuses the existing version (no duplicate copy)", async () => {
    const zip = await zipDirectory(path.join(FIXTURE_DIR, "synthetic-scorm12"));
    const r = await h.services.content.importPackage(zip, { stableKey: "synthetic-lesson-scorm12" }, actor);
    expect(r.deduplicated).toBe(true);
    expect(r.contentVersionId).toBe(h.data.contentVersions.scorm12);
    const [n] = await ownerQuery<{ n: string }>("select count(*) as n from content_version");
    expect(n!.n).toBe("2");
  });

  it("a changed package becomes version 2 of the same item. Version 1 and its placements are untouched", async () => {
    const dir = path.join(FIXTURE_DIR, "synthetic-scorm12");
    const files = await fs.readdir(dir);
    const entries = await Promise.all(files.map(async (f) => ({ name: f, data: await fs.readFile(path.join(dir, f)) })));
    entries.push({ name: "changelog.txt", data: Buffer.from("v2") });
    const r = await h.services.content.importPackage(buildZip(entries), { stableKey: "synthetic-lesson-scorm12" }, actor);
    expect(r).toMatchObject({ deduplicated: false, versionNo: 2 });
    const rows = await ownerQuery<{ content_version_id: string }>("select distinct content_version_id from course_placement");
    expect(rows.map((x) => x.content_version_id)).not.toContain(r.contentVersionId);
    const [audit] = await ownerQuery<{ n: string }>("select count(*) as n from audit_entry where action='content.version_imported' and entity_id=$1", [r.contentVersionId]);
    expect(audit!.n).toBe("1");
  });

  it("one content version is placed in two courses with a single stored package (reuse without re-upload)", async () => {
    const rows = await ownerQuery<{ n: string }>("select count(distinct course_revision_id) as n from course_placement where content_version_id=$1", [h.data.contentVersions.scorm12]);
    expect(rows[0]!.n).toBe("2");
  });
});
