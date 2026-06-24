import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoots = ["apps", "packages", "integrations"] as const;
const generatedExtensions = [".js", ".js.map", ".d.ts", ".d.ts.map"];

describe("source tree build artifacts", () => {
  it("keeps generated compiler artifacts out of source directories", async () => {
    const root = new URL("../../../../", import.meta.url);
    const artifacts: string[] = [];

    for (const sourceRoot of sourceRoots) {
      await collectArtifacts(join(root.pathname, sourceRoot), artifacts);
    }

    expect(artifacts).toEqual([]);
  });
});

async function collectArtifacts(directory: string, artifacts: string[]): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      await collectArtifacts(path, artifacts);
      continue;
    }

    if (
      path.includes("/src/") &&
      generatedExtensions.some((extension) => path.endsWith(extension))
    ) {
      artifacts.push(path);
    }
  }
}
