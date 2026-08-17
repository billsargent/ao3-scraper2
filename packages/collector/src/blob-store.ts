import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export interface StoredBlob {
  bodyHash: `sha256:${string}`;
  storageKey: string;
  byteLength: number;
  compressedByteLength: number;
}

export class ContentAddressedBlobStore {
  constructor(private readonly rootDirectory: string) {}

  async putHtml(body: string): Promise<StoredBlob> {
    const digest = createHash("sha256").update(body).digest("hex");
    const bodyHash = `sha256:${digest}` as const;
    const storageKey = join("sha256", digest.slice(0, 2), digest.slice(2, 4), `${digest}.html.gz`);
    const target = join(this.rootDirectory, storageKey);
    const compressed = await gzipAsync(Buffer.from(body, "utf8"), { level: 9 });
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, compressed, { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    return { bodyHash, storageKey, byteLength: Buffer.byteLength(body, "utf8"), compressedByteLength: compressed.byteLength };
  }
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
