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
    const [readme, install, development, singleBinary, homebrew, release, promote] =
      await Promise.all(
        [
          "README.md",
          "docs/install.md",
          "docs/development.md",
          "docs/single-binary.md",
          "docs/homebrew.md",
          ".github/workflows/release.yml",
          ".github/workflows/promote-release.yml",
        ].map(read),
      );
    const packageJson = JSON.parse(await read("package.json"));

    expect(readme).toContain("authenticated private binary");
    expect(readme).toContain("without Node.js, pnpm, Bun");
    expect(install.replace(/\s+/g, " ")).toContain("latest stable tag");
    expect(install).toContain("tag=v0.7.0");
    for (const [path, document] of [
      ["README.md", readme],
      ["docs/install.md", install],
    ] as const) {
      expect(document, path).not.toContain("ref=main");
      const expectedRecipeCount = path === "README.md" ? 1 : 2;
      const contentsFetches = continuedShellCommands(document).filter((command) =>
        command.includes("contents/scripts/install.sh"),
      );
      expect(contentsFetches, path).toHaveLength(expectedRecipeCount);
      for (const command of contentsFetches) {
        expect(command, path).toMatch(/^curl\s/);
      }
      const recipes = shellBlocks(document).filter((block) =>
        block.includes(
          "https://api.github.com/repos/jeremy0dell/station/contents/scripts/install.sh?ref=$tag",
        ),
      );
      expect(recipes, path).toHaveLength(expectedRecipeCount);
      for (const recipe of recipes) {
        expect(recipe, path).toContain("umask 077");
        expect(recipe, path).toContain('token="$(gh auth token --hostname github.com)"');
        expect(recipe, path).toContain('headers="$(mktemp)"');
        expect(recipe, path).toContain('installer="$(mktemp)"');
        expect(recipe, path).toContain('trap \'rm -f "$headers" "$installer"\' EXIT');
        expect(recipe, path).toContain("Authorization: Bearer %s");
        expect(recipe, path).toContain("Accept: application/vnd.github.raw+json");
        expect(recipe, path).toContain("unset token");
        expect(recipe, path).toContain('test -s "$installer"');
        expect(recipe, path).toContain('sh -n "$installer"');
        expect(recipe, path).toContain('sh "$installer" --version "$tag"');

        const installerFetches = continuedShellCommands(recipe).filter((command) =>
          command.includes("contents/scripts/install.sh?ref=$tag"),
        );
        expect(installerFetches, path).toHaveLength(1);
        const command = installerFetches[0] ?? "";
        expect(command, path).toContain("--disable");
        expect(command, path).toContain("--proto '=https'");
        expect(command, path).toContain("--tlsv1.2");
        expect(command, path).toContain("--fail");
        expect(command, path).toContain("--silent");
        expect(command, path).toContain("--show-error");
        expect(command, path).toContain("--max-redirs 0");
        expect(command, path).toContain('--header "@$headers"');
        expect(command, path).toContain('--output "$installer"');
        expect(command, path).toContain(
          "https://api.github.com/repos/jeremy0dell/station/contents/scripts/install.sh?ref=$tag",
        );
        expect(command, path).toMatch(/^curl\s/);
        expect(command, path).not.toMatch(/\b(?:Authorization|Bearer|token)\b/i);
        expect(command, path).not.toMatch(/(?:^|\s)(?:-L|--location)(?:\s|$)/);
        expect(command, path).not.toMatch(/\|\s*(?:\/bin\/)?sh\b/);
      }
    }
    expect(readme.replace(/\s+/g, " ")).toContain("installer code and artifacts");
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
    expect(development).toContain("accepted-release-candidate-0.7.0");
    expect(release).toContain('-f ref="$COMMIT"');
    expect(release).toContain("persist-credentials: false");
    expect(release).toContain("accepted-release-candidate-");
    const installDraft = release.slice(
      release.indexOf("  install-draft:"),
      release.indexOf("  record-accepted-candidate:"),
    );
    const recordCandidate = release.slice(release.indexOf("  record-accepted-candidate:"));
    for (const job of [installDraft, recordCandidate]) {
      expect(job).toContain("contents: read");
      expect(job).not.toContain("contents: write");
    }
    expect(promote).toContain("workflow_dispatch");
    expect(promote).toContain("manual_acceptance");
    expect(promote).toContain("asset-ids.txt");
    expect(promote).toContain("actions/workflows/$workflow_id");
    expect(promote).toContain("compare/$commit...main");
    expect(promote).toContain('prerelease="$expected_prerelease"');
    expect(packageJson.version).toBe("0.7.0");
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
      const normalized = document.replace(/\s+/g, " ");
      expect(document, path).toContain("<install-dir>/.station-install.lock");
      expect(document, path).toContain("<install-dir>/.station-install.lock/owner-*");
      expect(document, path).toContain("<data-home>/station/.station-install.lock");
      expect(document, path).toContain("<data-home>/station/.station-install.lock/owner-*");
      expect(normalized, path).toContain("requested tag or `latest`");
      expect(document, path).toContain("token");
      expect(document, path).toMatch(/10(?:-second| seconds)/);
      expect(document, path).toMatch(/existing\s+Station\s+installation\s+was\s+unchanged/);
      expect(document, path).toContain("sole runtime commit point");
      expect(document, path).toMatch(/129, 130, (?:and|or) 143/);
      expect(document, path).toContain("4096");
      expect(document, path).toContain("124");
      expect(document, path).toContain("125");
      expect(document, path).toContain("SIGKILL");
      expect(document, path).toMatch(/power\s+loss/i);
      expect(normalized, path).toMatch(/no post-power-loss durability guarantee/);
      expect(document, path).toContain("fsync");
      expect(document, path).toContain("manually");
      expect(document, path).toContain("alive");
    }

    const development = await read("docs/development.md");
    const normalizedDevelopment = development.replace(/\s+/g, " ");
    for (const acceptance of [
      "terminal A",
      "terminal B",
      "accepted-release-candidate",
      "command-not-found",
      "Ctrl-C",
      "Ctrl-Z",
      "stn-tmux-popup",
      "stn-ingress",
      "HOST_UPGRADE_BLOCKED",
      "same Observer socket",
      "second binary release",
    ]) {
      expect(normalizedDevelopment).toContain(acceptance);
    }
  });

  it("documents the complete first-run handoff after the binary install", async () => {
    const documents = await Promise.all(
      ["README.md", "docs/install.md"].map(async (path) => [path, await read(path)] as const),
    );

    for (const [path, document] of documents) {
      expect(document, path).toContain("only installs the Station binaries");
      expect(document, path).toContain("cd /path/to/your/git-project");
      expect(document, path).toMatch(/PATH="\$HOME\/\.local\/bin\$\{PATH:\+":\$PATH"\}"/);
      expect(document, path).toContain("hash -r");
      expect(document, path).toContain("stn setup");
      expect(document, path).toContain("stn doctor");
      expect(document, path).toMatch(/\nstn\n/);
      expect(document, path).toContain("~/.config/station/config.toml");
      expect(document, path).toContain("shell startup file");
      expect(document, path).toContain("cold-boot welcome screen");
      expect(document, path).toContain("Create Session");
      expect(document, path).toContain("start the agent session");
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

function continuedShellCommands(document: string): string[] {
  return document
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[A-Z_]+=[^ ]+\s+)*(?:curl|gh)\s/.test(line));
}

function shellBlocks(document: string): string[] {
  return [...document.matchAll(/```(?:sh|bash)\r?\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
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
