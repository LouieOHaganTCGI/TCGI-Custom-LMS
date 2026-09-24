// Copy non-TypeScript runtime assets (SQL migrations, static web files) into dist/ after tsc.
import { cpSync } from "node:fs";
cpSync("src/db/migrations", "dist/src/db/migrations", { recursive: true });
cpSync("src/web/static", "dist/src/web/static", { recursive: true });
process.stdout.write("assets copied\n");
