import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContentAddressedBlobStore } from "../src/blob-store.js";

const gunzipAsync = promisify(gunzip);
const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ContentAddressedBlobStore", () => {
  it("compresses and deduplicates identical HTML by hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ao3-blobs-"));
    directories.push(directory);
    const store = new ContentAddressedBlobStore(directory);
    const first = await store.putHtml("<html><body>preserved</body></html>");
    const second = await store.putHtml("<html><body>preserved</body></html>");

    expect(second).toEqual(first);
    expect(first.bodyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const compressed = await readFile(join(directory, first.storageKey));
    expect((await gunzipAsync(compressed)).toString("utf8")).toBe("<html><body>preserved</body></html>");
  });
});
