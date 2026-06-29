import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release readiness docs", () => {
  it("documents install, known issues, system dependencies, and deterministic versus real gates", async () => {
    const [readme, install, knownIssues, systemDependencies, testsReadme, localRealConfig] =
      await Promise.all([
        read("README.md"),
        read("docs/install.md"),
        read("docs/known-issues.md"),
        read("docs/system-dependencies.md"),
        read("tests/README.md"),
        read("examples/local-real-config.toml"),
      ]);

    expect(readme).toContain("pnpm smoke:release");
    expect(readme).toContain("docs/install.md");
    expect(install).toContain("Node.js 24.x");
    expect(install).toContain("pnpm smoke:release");
    expect(install).toContain("examples/local-real-config.toml");
    expect(knownIssues).toContain("Real E2E remains opt-in");
    expect(systemDependencies).toContain("tmux");
    expect(systemDependencies).toContain("pnpm setup:system:check");
    expect(testsReadme).toContain("release-hardening-smoke");
    expect(localRealConfig).toContain('managed_root = "~/.worktrees"');
    expect(localRealConfig).toContain("include_external = false");
    expect(localRealConfig).not.toContain('profile = "default"');
  });

  it("does not advertise removed Crush harness surfaces", async () => {
    const files = ["README.md", "AGENTS.md", ...(await markdownFiles("docs"))];

    for (const file of files) {
      const content = await read(file);
      expect(content, file).not.toMatch(/\bcrush\b|\.crush|STATION_CRUSH|station-crush/i);
    }
  });
});

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function markdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}
