// Copy non-TypeScript runtime assets (SQL migrations, static web files) into dist/ after tsc.
import { cpSync } from "node:fs";
cpSync("src/db/migrations", "dist/src/db/migrations", { recursive: true });
cpSync("src/web/static", "dist/src/web/static", { recursive: true });
// Inbound events are validated at runtime against the published contract schemas (single source of truth).
cpSync("docs/contracts", "dist/docs/contracts", { recursive: true, filter: (src) => !src.includes("examples") && !src.endsWith(".ts") });
process.stdout.write("assets copied\n");
