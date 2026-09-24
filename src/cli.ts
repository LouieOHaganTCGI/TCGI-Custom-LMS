import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { migrateToLatest } from "./db/migrate.js";
import { zipDirectory } from "./lib/zip-dir.js";
import { seed } from "./seed.js";
import { createServices } from "./services.js";
import type { CourseTier } from "./db/schema.js";

const USAGE = `Usage: tsx src/cli.ts <command> [options]
  migrate                                   Apply SQL migrations (MIGRATION_DATABASE_URL, owner role)
  seed                                      Load synthetic Phase B data (orgs, people, packages, courses, entitlement fixtures)
  worker                                    Run the outbox dispatcher loop
  content:import <zip-or-dir> --key <k>     Import a SCORM package as a new immutable content version
  course:create --slug s --title t --tier microlesson --versions <id,id>
  person:provision --issuer <iss> --subject <sub> --name <n> --email <e> --org <slug> [--admin]
                                            Pre-provision a person for an IdP test user (for example a miniOrange sandbox user)
  fixture:entitle --person <id> --course <slug> --org <slug> [--until <ISO date>]
                                            Phase B entitlement fixture (the same command the S4 event handler will use)`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help") return console.log(USAGE);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      key: { type: "string" }, slug: { type: "string" }, title: { type: "string" }, tier: { type: "string" }, versions: { type: "string" },
      issuer: { type: "string" }, subject: { type: "string" }, name: { type: "string" }, email: { type: "string" }, org: { type: "string" },
      admin: { type: "boolean" }, person: { type: "string" }, course: { type: "string" }, until: { type: "string" },
    },
  });
  const config = loadConfig();
  if (cmd === "migrate") {
    const url = config.MIGRATION_DATABASE_URL;
    if (!url) throw new Error("MIGRATION_DATABASE_URL (owner role) is required for migrate");
    console.log("applied:", await migrateToLatest(url));
    return;
  }
  const services = createServices(config);
  const system = { type: "system" as const, label: `cli ${cmd}` };
  try {
    switch (cmd) {
      case "seed":
        console.log(JSON.stringify(await seed(services, config.OIDC_ISSUER), null, 2));
        break;
      case "worker": {
        console.log("outbox worker started");
        let stop = false;
        process.on("SIGTERM", () => (stop = true));
        process.on("SIGINT", () => (stop = true));
        while (!stop) {
          const n = await services.dispatcher.runOnce(50).catch((e) => (console.error("dispatch error", e), 0));
          await services.entitlementEvents.processPending().catch((e) => console.error("entitlement processing error", e));
          if (n === 0) await new Promise((r) => setTimeout(r, config.WORKER_POLL_MS));
        }
        break;
      }
      case "content:import": {
        const src = positionals[0];
        if (!src || !values.key) throw new Error("content:import <zip-or-dir> --key <stable-key>");
        const stat = await fs.stat(src);
        const zip = stat.isDirectory() ? await zipDirectory(src) : await fs.readFile(src);
        console.log(JSON.stringify(await services.content.importPackage(zip, { stableKey: values.key }, system), null, 2));
        break;
      }
      case "course:create": {
        if (!values.slug || !values.title || !values.tier || !values.versions) throw new Error("course:create --slug --title --tier --versions");
        console.log(JSON.stringify(await services.content.createAndPublishCourse(
          { slug: values.slug, title: values.title, tier: values.tier as CourseTier, placements: values.versions.split(",").map((id) => ({ contentVersionId: id.trim() })) }, system)));
        break;
      }
      case "person:provision": {
        const { issuer, subject, name, email, org } = values;
        if (!issuer || !subject || !name || !org) throw new Error("person:provision --issuer --subject --name --org [--email] [--admin]");
        const id = await services.db.withSystem("provisioning", async (trx) => {
          const o = await trx.selectFrom("organisation").select("id").where("slug", "=", org).executeTakeFirstOrThrow();
          const p = await trx.insertInto("person").values({ display_name: name, primary_email: email ?? null, email_verified: false, updated_at: new Date() }).returning("id").executeTakeFirstOrThrow();
          await trx.insertInto("identity_link").values({ person_id: p.id, issuer, subject, linked_via: "provisioning" }).execute();
          await trx.insertInto("organisation_membership").values({ organisation_id: o.id, person_id: p.id, source: "cli provisioning" }).execute();
          if (values.admin) await trx.insertInto("role_grant").values({ person_id: p.id, role: "tcgi_admin", scope_type: "platform", organisation_id: null, reason: "cli provisioning" }).execute();
          const { audit } = await import("./modules/audit/audit.js");
          await audit(trx, { actor: system, action: "person.provisioned", entityType: "person", entityId: p.id, organisationId: o.id, after: { issuer, subject, admin: !!values.admin } });
          return p.id;
        });
        console.log(id);
        break;
      }
      case "fixture:entitle": {
        if (!values.person || !values.course || !values.org) throw new Error("fixture:entitle --person --course --org [--until]");
        const ids = await services.db.withSystem("entitlement-command", async (trx) => ({
          course: (await trx.selectFrom("course").select("id").where("slug", "=", values.course!).executeTakeFirstOrThrow()).id,
          org: (await trx.selectFrom("organisation").select("id").where("slug", "=", values.org!).executeTakeFirstOrThrow()).id,
        }));
        const now = new Date();
        console.log(JSON.stringify(await services.entitlements.grant({
          source: "phase-b-fixture", externalOrderId: `FIXTURE-${values.person}`, externalLineId: values.course, personId: values.person, organisationId: ids.org,
          courseId: ids.course, grantType: "manual", validFrom: now, validUntil: values.until ? new Date(values.until) : new Date(now.getTime() + 365 * 86400_000),
          reason: "Phase B entitlement fixture (cli)",
        }, system)));
        break;
      }
      default:
        console.error(`unknown command: ${cmd}\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    await services.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
