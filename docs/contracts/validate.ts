/**
 * Validate example payloads against the event-contract schemas (JSON Schema 2020-12, ajv).
 * examples/valid/*.json must validate. examples/invalid/*.json must be rejected.
 * Usage: npm run contracts:validate
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
for (const f of (await fs.readdir(HERE)).filter((f) => f.endsWith(".schema.json"))) ajv.addSchema(JSON.parse(await fs.readFile(path.join(HERE, f), "utf8")));
const schemaFor = (type: string) =>
  ajv.getSchema(`https://tcgi.example/lms/contracts/${type.startsWith("entitlement.") ? "entitlement" : "learning-events"}.v1.schema.json`)!;

let failures = 0;
for (const [expectValid, folder] of [[true, "valid"], [false, "invalid"]] as const) {
  for (const f of (await fs.readdir(path.join(HERE, "examples", folder))).sort()) {
    const doc = JSON.parse(await fs.readFile(path.join(HERE, "examples", folder, f), "utf8")) as { type?: string };
    const validate = schemaFor(doc.type ?? "");
    const ok = validate(doc) === expectValid;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${folder}/${f}${!expectValid && ok ? " (rejected as expected)" : ""}`);
    if (!ok && expectValid) console.log("   ", JSON.stringify(validate.errors));
  }
}
console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
