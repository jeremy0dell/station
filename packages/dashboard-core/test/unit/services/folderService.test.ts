import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFolderService } from "../../../src/services/folderService.js";

describe("node folder service", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
  });

  it("returns current visible directories after creation, rename, and deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-folder-service-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "alpha"));
    const service = createNodeFolderService();

    await expect(directoryNames(service, root)).resolves.toEqual(["alpha"]);

    await mkdir(join(root, "beta"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "not-a-directory"), "ignored");
    await expect(directoryNames(service, root)).resolves.toEqual(["alpha", "beta"]);

    await rename(join(root, "beta"), join(root, "gamma"));
    await rm(join(root, "alpha"), { recursive: true });
    await expect(directoryNames(service, root)).resolves.toEqual(["gamma"]);
  });
});

async function directoryNames(
  service: ReturnType<typeof createNodeFolderService>,
  path: string,
): Promise<string[]> {
  return (await service.readDirectory(path)).entries.map((entry) => entry.name);
}
