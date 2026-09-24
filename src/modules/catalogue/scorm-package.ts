import { XMLParser } from "fast-xml-parser";
import yauzl from "yauzl";

/**
 * Validation and inspection of uploaded SCORM zip packages (CAT-01, threats T-19 and T-20).
 * Defences: entry count and size limits, compression-ratio (zip bomb) limit, path traversal and absolute
 * path rejection, symlink rejection, no XML entity expansion, and required manifest and launch file.
 */
export interface PackageLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_LIMITS: PackageLimits = {
  maxEntries: 10_000,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxEntryUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export interface PackageFile {
  path: string;
  data: Buffer;
}

export interface InspectedPackage {
  scormVersion: "1.2" | "2004";
  scormEdition: string | null;
  manifestIdentifier: string;
  title: string;
  launchHref: string;
  scoCount: number;
  files: PackageFile[];
  totalBytes: number;
}

export class PackageValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PackageValidationError";
  }
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export function normaliseEntryPath(raw: string): string {
  if (raw.includes("\\")) throw new PackageValidationError("unsafe_path", `backslash in entry path: ${raw}`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new PackageValidationError("unsafe_path", `absolute entry path: ${raw}`);
  if (raw.includes("\0")) throw new PackageValidationError("unsafe_path", "NUL in entry path");
  const segs = raw.split("/");
  if (segs.some((s) => s === "..")) throw new PackageValidationError("unsafe_path", `path traversal in entry: ${raw}`);
  return segs.filter((s) => s !== "" && s !== ".").join("/");
}

function readZip(buf: Buffer, limits: PackageLimits): Promise<PackageFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) => {
      if (err || !zip) return reject(new PackageValidationError("invalid_zip", `not a valid zip archive: ${err?.message ?? "unknown"}`));
      const files: PackageFile[] = [];
      let count = 0;
      let total = 0;
      let failed = false;
      const fail = (e: Error) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(e);
      };
      zip.on("error", (e: Error) => {
        if (e instanceof PackageValidationError) return fail(e);
        // yauzl's own file-name validation (absolute paths, "..", backslashes) is a path-safety rejection.
        if (/absolute path|invalid relative path|invalid characters/i.test(e.message)) return fail(new PackageValidationError("unsafe_path", e.message));
        fail(new PackageValidationError("invalid_zip", e.message));
      });
      zip.on("end", () => !failed && resolve(files));
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          count++;
          if (count > limits.maxEntries) throw new PackageValidationError("too_many_entries", `more than ${limits.maxEntries} entries`);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & S_IFMT) === S_IFLNK) throw new PackageValidationError("symlink", `symbolic link not allowed: ${entry.fileName}`);
          const p = normaliseEntryPath(entry.fileName);
          if (entry.fileName.endsWith("/")) return zip.readEntry(); // directory
          if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) throw new PackageValidationError("entry_too_large", `entry too large: ${p}`);
          const ratio = entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : 0;
          if (entry.uncompressedSize > 1024 * 1024 && ratio > limits.maxCompressionRatio) {
            throw new PackageValidationError("compression_ratio", `suspicious compression ratio (${Math.round(ratio)}:1) for ${p}`);
          }
          total += entry.uncompressedSize;
          if (total > limits.maxTotalUncompressedBytes) throw new PackageValidationError("package_too_large", "package exceeds the uncompressed size limit");
          zip.openReadStream(entry, (e2, stream) => {
            if (e2 || !stream) return fail(new PackageValidationError("invalid_zip", e2?.message ?? "cannot read entry"));
            const chunks: Buffer[] = [];
            let got = 0;
            stream.on("data", (c: Buffer) => {
              got += c.length;
              // Guards against lying size headers (yauzl validateEntrySizes also checks at end).
              if (got > entry.uncompressedSize) stream.destroy(new PackageValidationError("size_mismatch", `entry larger than declared: ${p}`));
              else chunks.push(c);
            });
            stream.on("error", (e3: Error) => fail(e3 instanceof PackageValidationError ? e3 : new PackageValidationError("invalid_zip", e3.message)));
            stream.on("end", () => {
              if (files.some((f) => f.path === p)) return fail(new PackageValidationError("duplicate_entry", `duplicate entry: ${p}`));
              files.push({ path: p, data: Buffer.concat(chunks) });
              zip.readEntry();
            });
          });
        } catch (e) {
          fail(e as Error);
        }
      });
      zip.readEntry();
    });
  });
}

type XmlNode = Record<string, unknown>;
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "#text" in (v as XmlNode)) return String((v as XmlNode)["#text"]).trim();
  return null;
};
/** Attribute lookup that ignores namespace prefix (adlcp:scormtype vs adlcp:scormType). */
function attr(node: XmlNode, localName: string): string | null {
  for (const [k, v] of Object.entries(node)) {
    if (!k.startsWith("@_")) continue;
    const name = k.slice(2).split(":").pop()!;
    if (name.toLowerCase() === localName.toLowerCase()) return String(v);
  }
  return null;
}
function child(node: XmlNode, localName: string): unknown {
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@_")) continue;
    if (k.split(":").pop() === localName) return v;
  }
  return undefined;
}

export function parseManifest(xml: string): Omit<InspectedPackage, "files" | "totalBytes"> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new PackageValidationError("manifest_dtd", "manifest DTD/entity declarations are not allowed");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: false, allowBooleanAttributes: true });
  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (e) {
    throw new PackageValidationError("manifest_invalid", `imsmanifest.xml is not well-formed: ${(e as Error).message}`);
  }
  const manifest = child(doc, "manifest") as XmlNode | undefined;
  if (!manifest) throw new PackageValidationError("manifest_invalid", "missing <manifest> root");
  const manifestIdentifier = attr(manifest, "identifier");
  if (!manifestIdentifier) throw new PackageValidationError("manifest_invalid", "manifest has no identifier");

  const metadata = child(manifest, "metadata") as XmlNode | undefined;
  const schemaVersion = metadata ? text(child(metadata, "schemaversion")) : null;
  let scormVersion: "1.2" | "2004";
  let scormEdition: string | null = null;
  if (schemaVersion === "1.2") scormVersion = "1.2";
  else if (schemaVersion && (/^2004/.test(schemaVersion) || schemaVersion === "CAM 1.3")) {
    scormVersion = "2004";
    scormEdition = schemaVersion;
  } else {
    throw new PackageValidationError("unsupported_version", `unsupported or missing SCORM schemaversion: ${schemaVersion ?? "none"}`);
  }

  const orgsNode = child(manifest, "organizations") as XmlNode | undefined;
  const orgs = asArray(orgsNode ? (child(orgsNode, "organization") as XmlNode | XmlNode[]) : undefined);
  const defaultId = orgsNode ? attr(orgsNode, "default") : null;
  const org = orgs.find((o) => attr(o, "identifier") === defaultId) ?? orgs[0];
  if (!org) throw new PackageValidationError("manifest_invalid", "manifest has no organization");
  const title = text(child(org, "title")) ?? manifestIdentifier;

  const resourcesNode = child(manifest, "resources") as XmlNode | undefined;
  const resources = asArray(resourcesNode ? (child(resourcesNode, "resource") as XmlNode | XmlNode[]) : undefined);
  const byId = new Map(resources.map((r) => [attr(r, "identifier") ?? "", r]));

  const launchable: { href: string }[] = [];
  const walk = (items: XmlNode[]) => {
    for (const it of items) {
      const ref = attr(it, "identifierref");
      if (ref) {
        const res = byId.get(ref);
        if (!res) throw new PackageValidationError("manifest_invalid", `item references missing resource ${ref}`);
        const type = (attr(res, "scormtype") ?? "").toLowerCase();
        const href = attr(res, "href");
        if (type === "sco" && href) launchable.push({ href: href + (attr(it, "parameters") ?? "") });
      }
      walk(asArray(child(it, "item") as XmlNode | XmlNode[]));
    }
  };
  walk(asArray(child(org, "item") as XmlNode | XmlNode[]));
  if (launchable.length === 0) throw new PackageValidationError("no_sco", "no launchable SCO found in the default organization");
  // ADR-0002: multi-SCO packages need sequencing support, which is part of the open runtime decision (DEC-13).
  if (launchable.length > 1) {
    throw new PackageValidationError("multi_sco_unsupported", `package has ${launchable.length} SCOs; multi-SCO support awaits the runtime decision (DEC-13)`);
  }
  return { scormVersion, scormEdition, manifestIdentifier, title, launchHref: launchable[0]!.href, scoCount: launchable.length };
}

export async function inspectPackage(zip: Buffer, limits: PackageLimits = DEFAULT_LIMITS): Promise<InspectedPackage> {
  const files = await readZip(zip, limits);
  const manifestFile = files.find((f) => f.path === "imsmanifest.xml");
  if (!manifestFile) throw new PackageValidationError("no_manifest", "imsmanifest.xml must be at the package root");
  const info = parseManifest(manifestFile.data.toString("utf8"));
  const launchPath = normaliseEntryPath(decodeURIComponent(info.launchHref.split(/[?#]/)[0]!));
  if (!files.some((f) => f.path === launchPath)) throw new PackageValidationError("launch_missing", `launch file not found in package: ${launchPath}`);
  return { ...info, files, totalBytes: files.reduce((n, f) => n + f.data.length, 0) };
}
