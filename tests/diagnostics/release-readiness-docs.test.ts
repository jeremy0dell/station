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
    expect(install).toContain("Node.js 24.2+");
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

  it("keeps the Node.js 24.2+ development requirement consistent", async () => {
    const documents = await Promise.all(
      [
        "README.md",
        "docs/development.md",
        "docs/install.md",
        "docs/system-dependencies.md",
        "docs/local-development.md",
        "docs/homebrew.md",
      ].map(read),
    );

    for (const document of documents) {
      expect(document).toContain("Node.js 24.2+");
    }
    expect(JSON.parse(await read("package.json")).engines.node).toBe(">=24.2 <25");
  });

  it("documents the authenticated private binary release contract", async () => {
    const [readme, install, development, singleBinary, homebrew] = await Promise.all(
      [
        "README.md",
        "docs/install.md",
        "docs/development.md",
        "docs/single-binary.md",
        "docs/homebrew.md",
      ].map(read),
    );
    const packageJson = JSON.parse(await read("package.json"));

    expect(readme).toContain("authenticated private binary");
    expect(readme).toContain("without Node.js, pnpm, Bun");
    expect(install).toContain("latest stable release");
    expect(install).toContain("--version v0.1.1-rc.1");
    expect(install).toContain("SHA256SUMS");
    expect(install).toContain("stn-tmux-popup");
    for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      expect(singleBinary).toContain(target);
    }
    expect(singleBinary).toContain("**Status: implemented.**");
    expect(singleBinary).toContain("release **draft**");
    expect(singleBinary).toContain("GitHub immutable");
    expect(singleBinary).toContain("workflow cannot enforce the precondition itself");
    expect(singleBinary).toContain("without `+` build metadata");
    expect(development).toMatch(/workflow never\s+publishes\s+the draft automatically/);
    expect(development).toContain("HOST_UPGRADE_BLOCKED");
    expect(homebrew).toContain("`workflow_dispatch` only");
    expect(homebrew).toContain("`COMMITTER_TOKEN` remains intentionally unconfigured");
    expect(packageJson.scripts["smoke:install"]).toBe(
      "node scripts/test-runners/run-install-smoke.mjs",
    );
    expect(packageJson.scripts["test:all"]).toContain("pnpm smoke:install");
  });

  it("keeps installer continuity and interrupted-upgrade recovery documented", async () => {
    const documents = await Promise.all(
      ["docs/install.md", "docs/development.md", "docs/single-binary.md"].map(
        async (path) => [path, await read(path)] as const,
      ),
    );

    for (const [path, document] of documents) {
      expect(document, path).toContain("<install-dir>/.station-install.lock");
      expect(document, path).toContain("<install-dir>/.station-install.lock/owner");
      expect(document, path).toContain("requested tag or `latest`");
      expect(document, path).toMatch(/10(?:-second| seconds)/);
      expect(document, path).toMatch(/existing\s+Station\s+installation\s+was\s+unchanged/);
      expect(document, path).toContain("sole runtime commit point");
      expect(document, path).toMatch(/129, 130, (?:and|or) 143/);
      expect(document, path).toContain("SIGKILL");
      expect(document, path).toMatch(/power\s+loss/);
      expect(document, path).toContain("manually");
      expect(document, path).toContain("alive");
    }

    const development = await read("docs/development.md");
    const normalizedDevelopment = development.replace(/\s+/g, " ");
    for (const acceptance of [
      "terminal A",
      "terminal B",
      "RC → stable → RC",
      "command-not-found",
      "Ctrl-C",
      "Ctrl-Z",
      "stn-tmux-popup",
      "stn-ingress",
      "HOST_UPGRADE_BLOCKED",
      "same Observer socket",
      "explicit rollback check",
    ]) {
      expect(normalizedDevelopment).toContain(acceptance);
    }
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
