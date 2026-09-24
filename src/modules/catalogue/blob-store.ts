import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

/**
 * Package file storage. The local filesystem is for development and tests. The deployed implementation is
 * object storage (S3-compatible, EU region, ADR-0003) and **isn't built yet**. It will implement the same
 * interface.
 */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  exists(key: string): Promise<boolean>;
  open(key: string): Promise<{ stream: Readable; size: number } | null>;
}

const SAFE_KEY = /^[A-Za-z0-9._\-/]+$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error(`unsafe blob key: ${JSON.stringify(key)}`);
  }
}

export class LocalBlobStore implements BlobStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("blob key escapes root");
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data, { flag: "w" });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async open(key: string): Promise<{ stream: Readable; size: number } | null> {
    let full: string;
    try {
      full = this.resolve(key);
    } catch {
      return null;
    }
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) return null;
      return { stream: createReadStream(full), size: st.size };
    } catch {
      return null;
    }
  }
}
