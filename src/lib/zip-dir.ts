import { promises as fs } from "node:fs";
import path from "node:path";
import { buildZip, type ZipEntryInput } from "./zip-writer.js";

/** Zip a directory (recursively), with paths relative to it. */
export async function zipDirectory(dir: string): Promise<Buffer> {
  const entries: ZipEntryInput[] = [];
  async function walk(rel: string) {
    for (const d of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(r);
      else if (d.isFile()) entries.push({ name: r, data: await fs.readFile(path.join(dir, r)) });
    }
  }
  await walk("");
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return buildZip(entries);
}
