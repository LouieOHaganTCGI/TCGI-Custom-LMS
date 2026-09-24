import type { ScopedDb, Trx } from "../../db/scoped.js";
import type { CourseTier } from "../../db/schema.js";
import { sha256Hex } from "../../lib/crypto.js";
import { audit, type Actor } from "../audit/audit.js";
import { RuleViolation } from "../authz/authz.js";
import type { BlobStore } from "./blob-store.js";
import { inspectPackage, normaliseEntryPath, type PackageLimits, DEFAULT_LIMITS } from "./scorm-package.js";

/**
 * Package files are content-addressed: each file lives at content/<package sha>/<sha of path>, and
 * content/<package sha>/index.json maps each normalised in-package path to its key. Serving looks up the
 * requested path in the index, so no request path ever becomes a filesystem path.
 */
export interface PackageIndex {
  packageSha256: string;
  files: Record<string, { key: string; bytes: number }>;
}

export const indexKey = (pkgSha: string) => `content/${pkgSha}/index.json`;

export async function readPackageIndex(store: BlobStore, pkgSha: string): Promise<PackageIndex | null> {
  const f = await store.open(indexKey(pkgSha));
  if (!f) return null;
  const chunks: Buffer[] = [];
  for await (const c of f.stream) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as PackageIndex;
}

export function lookupPackageFile(index: PackageIndex, requestPath: string): { key: string; bytes: number } | null {
  let p: string;
  try {
    p = normaliseEntryPath(decodeURIComponent(requestPath));
  } catch {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(index.files, p) ? index.files[p]! : null;
}

export interface ImportResult {
  contentItemId: string;
  contentVersionId: string;
  versionNo: number;
  packageSha256: string;
  scormVersion: "1.2" | "2004";
  deduplicated: boolean;
}

export class ContentService {
  constructor(
    private readonly db: ScopedDb,
    private readonly store: BlobStore,
    private readonly limits: PackageLimits = DEFAULT_LIMITS,
  ) {}

  /**
   * Import a SCORM zip as a new immutable ContentVersion of a ContentItem (CAT-01, CAT-02). Re-uploading
   * an identical package returns the existing version and never creates a second copy.
   */
  async importPackage(zip: Buffer, item: { stableKey: string; title?: string }, actor: Actor, requestId: string | null = null): Promise<ImportResult> {
    const pkgSha = sha256Hex(zip);
    const existing = await this.db.withSystem("content-import", (trx) =>
      trx.selectFrom("content_version").select(["id", "content_item_id", "version_no", "scorm_version"]).where("package_sha256", "=", pkgSha).executeTakeFirst(),
    );
    if (existing) {
      return { contentItemId: existing.content_item_id, contentVersionId: existing.id, versionNo: existing.version_no, packageSha256: pkgSha, scormVersion: existing.scorm_version, deduplicated: true };
    }

    const pkg = await inspectPackage(zip, this.limits);
    // Store files first. They are content-addressed and harmless if the DB transaction later fails.
    const index: PackageIndex = { packageSha256: pkgSha, files: {} };
    for (const f of pkg.files) {
      const key = `content/${pkgSha}/${sha256Hex(f.path)}`;
      await this.store.put(key, f.data);
      index.files[f.path] = { key, bytes: f.data.length };
    }
    await this.store.put(indexKey(pkgSha), Buffer.from(JSON.stringify(index)));

    return this.db.withSystem("content-import", async (trx) => {
      let ci = await trx.selectFrom("content_item").select("id").where("stable_key", "=", item.stableKey).executeTakeFirst();
      if (!ci) {
        ci = await trx
          .insertInto("content_item")
          .values({ stable_key: item.stableKey, title: item.title ?? pkg.title, created_by: actor.type === "person" ? actor.personId : null })
          .returning("id")
          .executeTakeFirstOrThrow();
      }
      const max = await trx.selectFrom("content_version").select((eb) => eb.fn.max("version_no").as("m")).where("content_item_id", "=", ci.id).executeTakeFirst();
      const versionNo = (max?.m ?? 0) + 1;
      const cv = await trx
        .insertInto("content_version")
        .values({
          content_item_id: ci.id,
          version_no: versionNo,
          package_sha256: pkgSha,
          scorm_version: pkg.scormVersion,
          scorm_edition: pkg.scormEdition,
          manifest_identifier: pkg.manifestIdentifier,
          title: pkg.title,
          launch_href: pkg.launchHref,
          file_count: pkg.files.length,
          total_bytes: pkg.totalBytes,
          created_by: actor.type === "person" ? actor.personId : null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, {
        actor,
        action: "content.version_imported",
        entityType: "content_version",
        entityId: cv.id,
        after: { stable_key: item.stableKey, version_no: versionNo, package_sha256: pkgSha, scorm_version: pkg.scormVersion, launch_href: pkg.launchHref, files: pkg.files.length },
        requestId,
      });
      return { contentItemId: ci.id, contentVersionId: cv.id, versionNo, packageSha256: pkgSha, scormVersion: pkg.scormVersion, deduplicated: false };
    });
  }

  /**
   * Phase B shortcut: create a course whose first revision places the given content versions, and publish
   * it in one audited step. The full draft/review/approve workflow is slice S6 (CAT-05).
   * Completion rule: all required placements complete. This is provisional pending DEC-19.
   */
  async createAndPublishCourse(
    input: { slug: string; title: string; tier: CourseTier; placements: { contentVersionId: string; title?: string }[] },
    actor: Actor,
    requestId: string | null = null,
  ): Promise<{ courseId: string; revisionId: string }> {
    if (input.placements.length === 0) throw new RuleViolation("a course needs at least one placement", "no_placements");
    return this.db.withSystem("content-import", async (trx) => {
      const exists = await trx.selectFrom("course").select("id").where("slug", "=", input.slug).executeTakeFirst();
      if (exists) throw new RuleViolation(`course slug already exists: ${input.slug}`, "slug_taken");
      const course = await trx.insertInto("course").values({ slug: input.slug, title: input.title, tier: input.tier }).returning("id").executeTakeFirstOrThrow();
      const rev = await trx
        .insertInto("course_revision")
        .values({ course_id: course.id, revision_no: 1, completion_rule_ref: COMPLETION_RULE_ALL_REQUIRED })
        .returning("id")
        .executeTakeFirstOrThrow();
      let position = 1;
      for (const p of input.placements) {
        const cv = await trx.selectFrom("content_version").select(["id", "content_item_id", "title", "status"]).where("id", "=", p.contentVersionId).executeTakeFirst();
        if (!cv || cv.status !== "approved") throw new RuleViolation("content version not found or not approved", "bad_content_version");
        await trx
          .insertInto("course_placement")
          .values({ course_revision_id: rev.id, content_item_id: cv.content_item_id, content_version_id: cv.id, position: position++, title: p.title ?? cv.title })
          .execute();
      }
      await publishRevision(trx, rev.id, actor, requestId);
      await audit(trx, { actor, action: "course.created", entityType: "course", entityId: course.id, after: { slug: input.slug, tier: input.tier, placements: input.placements.length }, requestId });
      return { courseId: course.id, revisionId: rev.id };
    });
  }
}

export const COMPLETION_RULE_ALL_REQUIRED = "all-required-placements-completed/v0-provisional";

async function publishRevision(trx: Trx, revisionId: string, actor: Actor, requestId: string | null): Promise<void> {
  const now = new Date();
  await trx
    .updateTable("course_revision")
    .set({ state: "published", published_at: now, published_by: actor.type === "person" ? actor.personId : null })
    .where("id", "=", revisionId)
    .where("state", "=", "draft")
    .execute();
  await audit(trx, { actor, action: "course.revision_published", entityType: "course_revision", entityId: revisionId, after: { state: "published" }, requestId });
}
