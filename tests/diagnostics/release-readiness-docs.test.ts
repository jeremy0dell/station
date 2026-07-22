import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const removedPersistenceOption = ["--persist", "path"].join("-");

describe("release readiness docs", () => {
  it("separates release guidance from contributor and test references", async () => {
    const [
      readme,
      docsIndex,
      quickStart,
      install,
      limitations,
      systemDependencies,
      testsReadme,
      localRealConfig,
    ] = await Promise.all([
      read("README.md"),
      read("docs/index.md"),
      read("docs/quick-start.md"),
      read("docs/install.md"),
      read("docs/limitations.md"),
      read("docs/system-dependencies.md"),
      read("tests/README.md"),
      read("examples/local-real-config.toml"),
    ]);

    expect(readme).toContain("docs/index.md");
    expect(readme).toContain("docs/quick-start.md");
    expect(readme).toContain("docs/limitations.md");
    expect(docsIndex).toContain("## Start Here");
    expect(docsIndex).toContain("install.md#let-your-agent-install-and-validate-station");
    expect(docsIndex).toContain("## Use Station");
    expect(docsIndex).toContain("## Develop Station");
    expect(docsIndex).not.toContain("single-binary.md");
    expect(docsIndex).not.toContain("observer-singleton.md");
    expect(docsIndex).not.toContain("homebrew.md");
    expect(quickStart).toContain("Add your first project");
    expect(quickStart).toContain("Create Session");
    expect(install).toContain("Node.js 24.2+");
    expect(install).toContain("pnpm smoke:release");
    expect(install).toContain("examples/local-real-config.toml");
    expect(limitations).toContain("Agent Status Can Be Conservative");
    expect(limitations).not.toMatch(/TODO|Test Coverage Gaps|Remaining work/i);
    expect(systemDependencies).toContain("tmux");
    expect(systemDependencies).toContain("pnpm setup:system:check");
    expect(testsReadme).toContain("release-hardening-smoke");
    expect(localRealConfig).toContain('managed_root = "~/.worktrees"');
    expect(localRealConfig).toContain("include_external = false");
    expect(localRealConfig).not.toContain('profile = "default"');
  });

  it("provides an agent-led binary install and setup validation prompt", async () => {
    const documents = await Promise.all(["README.md", "docs/install.md"].map(read));

    for (const document of documents) {
      const normalized = document.replace(/\s+/g, " ").toLowerCase();
      expect(normalized).toContain("let your agent install and validate station");
      expect(document).toContain("gh auth status --hostname github.com");
      expect(document).toContain("gh repo view jeremy0dell/station");
      expect(document).toContain("docs/install.md");
      expect(document).toContain("stn setup plan --json");
      expect(document).toContain("stn setup check --json");
      expect(document).toContain("stn doctor");
      expect(document).toContain("summary.requiredOk: true");
      expect(normalized).toContain("do not clone the repository or build from source");
      expect(normalized).toContain("do not edit any shell startup file");
      expect(normalized).toContain("do not claim success");
    }
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
    const packageManifest = await readPackageManifest();
    expect(packageManifest.engines.node).toBe(">=24.2 <25");
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
    const packageJson = await readPackageManifest();

    expect(readme).toContain("authenticated GitHub release assets");
    expect(readme).toContain("does not require Node.js, pnpm, Bun");
    expect(install.replace(/\s+/g, " ")).toContain("latest stable tag");
    expect(install).toContain("tag=v0.7.1-rc.5");
    for (const [path, document] of [
      ["README.md", readme],
      ["docs/install.md", install],
    ] as const) {
      expect(document, path).not.toContain("ref=main");
      expect(document, path).not.toContain("gh auth token");
      expect(document, path).not.toContain("Authorization: Bearer");
      expect(document, path).not.toContain("curl");
      const recipes = shellBlocks(document).filter((block) =>
        block.includes("repos/jeremy0dell/station/contents/scripts/install.sh"),
      );
      expect(recipes, path).toHaveLength(1);
      for (const recipe of recipes) {
        expect(recipe, path).not.toContain("cd /path/to/your/git-project");
        expect(recipe, path).toContain("umask 077");
        expect(recipe, path).toContain("export GH_HOST=github.com");
        expect(recipe, path).toContain("releases/latest");
        expect(recipe.indexOf("export GH_HOST=github.com"), path).toBeLessThan(
          recipe.indexOf("gh api --method GET"),
        );
        expect(recipe, path).toContain('installer="$(mktemp)"');
        expect(recipe, path).toContain("trap 'rm -f \"$installer\"' EXIT");
        expect(recipe, path).toContain('test -s "$installer"');
        expect(recipe, path).toContain('sh -n "$installer"');
        expect(recipe, path).toContain('sh "$installer" --version "$tag"');

        const installerFetches = continuedShellCommands(recipe).filter((command) =>
          command.includes("contents/scripts/install.sh"),
        );
        expect(installerFetches, path).toHaveLength(1);
        const command = installerFetches[0] ?? "";
        expect(command, path).toContain("gh api --method GET");
        expect(command, path).toContain("Accept: application/vnd.github.raw+json");
        expect(command, path).toContain('-f ref="$tag"');
        expect(command, path).toContain(
          'repos/jeremy0dell/station/contents/scripts/install.sh > "$installer"',
        );
        expect(command, path).not.toMatch(/\|\s*(?:\/bin\/)?sh\b/);
      }
    }
    expect(install).toContain(
      'tag="$(GH_HOST=github.com gh api repos/jeremy0dell/station/releases/latest',
    );
    expect(install.replace(/\s+/g, " ")).toContain("installer code and artifacts");
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
    expect(development).toContain("accepted-release-candidate-0.7.1-rc.5");
    const acceptanceRecipes = shellBlocks(development).filter((block) =>
      block.includes('STATION_INSTALL_RELEASE_ID="$release_id"'),
    );
    expect(acceptanceRecipes).toHaveLength(1);
    const acceptanceRecipe = acceptanceRecipes[0] ?? "";
    expect(acceptanceRecipe).toContain("export GH_HOST=github.com");
    expect(acceptanceRecipe).toContain("release_run_id=123456789");
    expect(acceptanceRecipe).toContain("--json workflowName --jq '.workflowName'");
    expect(acceptanceRecipe).toContain("accepted-release-candidate-$version-attempt-$run_attempt");
    expect(acceptanceRecipe).toContain("manifest_field workflowRunId");
    expect(acceptanceRecipe).toContain("manifest_field workflowRunAttempt");
    expect(acceptanceRecipe).toContain('commit="$(manifest_field commit)"');
    expect(acceptanceRecipe).toContain('release_id="$(manifest_field releaseId)"');
    expect(acceptanceRecipe).toContain(
      'test "$(gh api "repos/jeremy0dell/station/commits/$tag" --jq \'.sha\')" = "$commit"',
    );
    expect(acceptanceRecipe).toContain('-f ref="$commit"');
    expect(acceptanceRecipe).not.toContain(
      'commit="$(gh api "repos/jeremy0dell/station/commits/$tag"',
    );
    expect(release).toContain('-f ref="$COMMIT"');
    expect(release).toContain("persist-credentials: false");
    const validateRelease = release.slice(
      release.indexOf("      - name: Validate release tag"),
      release.indexOf("\n  standard-ci:"),
    );
    expect(validateRelease).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(validateRelease).toContain("compare/$GITHUB_SHA...main");
    expect(validateRelease).toContain("ahead|identical");
    expect(validateRelease).not.toContain("git fetch --no-tags origin");
    const createDraftStart = release.indexOf("      - name: Create draft release");
    const createDraft = release.slice(
      createDraftStart,
      release.indexOf("      - uses: actions/upload-artifact@v4", createDraftStart),
    );
    expect(createDraft).toContain("for _ in {1..12}");
    expect(createDraft).toContain('gh release view "$TAG" --json databaseId,isDraft');
    expect(createDraft).toContain("'select(.isDraft == true) | .databaseId'");
    expect(createDraft).toContain('[[ "$release_id" =~ ^[0-9]+$ ]] && break');
    expect(createDraft).not.toContain("releases?per_page=100");
    expect(createDraft).toContain('--argjson releaseId "$release_id"');
    expect(release).toContain("accepted-release-candidate-");
    const installDraft = release.slice(
      release.indexOf("  install-draft:"),
      release.indexOf("  record-accepted-candidate:"),
    );
    const recordCandidate = release.slice(release.indexOf("  record-accepted-candidate:"));
    for (const job of [installDraft, recordCandidate]) {
      expect(job).toContain("contents: write");
      expect(job).not.toContain("contents: read");
    }
    expect(promote).toContain("workflow_dispatch");
    expect(promote).toContain("manual_acceptance");
    expect(promote).toContain("asset-ids.txt");
    expect(promote).toContain("actions/workflows/$workflow_id");
    expect(promote).toContain("compare/$commit...main");
    expect(promote).toContain('prerelease="$expected_prerelease"');
    expect(packageJson.version).toBe("0.7.1-rc.5");
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
      "prior published binary",
    ]) {
      expect(normalizedDevelopment).toContain(acceptance);
    }
  });

  it("documents the complete first-run handoff after the binary install", async () => {
    const [readme, install, quickStart] = await Promise.all(
      ["README.md", "docs/install.md", "docs/quick-start.md"].map(read),
    );

    expect(readme).not.toContain(removedPersistenceOption);
    expect(readme).toContain("docs/install.md");
    expect(readme).toContain("docs/quick-start.md");
    expect(readme).toContain("stn setup");
    expect(readme).toContain("stn doctor");
    expect(readme).toMatch(/PATH="\$HOME\/\.local\/bin\$\{PATH:\+":\$PATH"\}"/);
    expect(readme).toContain("hash -r");

    expect(install).not.toContain(removedPersistenceOption);
    expect(install).toMatch(/does not (?:read, create, or )?edit shell startup files/);
    expect(install).toContain("chosen shell configuration");
    expect(install).toContain("future shells");
    expect(install).toContain("Absolute fallback");
    expect(install).toContain("all three");
    expect(install).toContain("physically");
    expect(install).toContain("From any directory");
    expect(install).toContain("zero-project");
    expect(install).not.toContain("cd /path/to/your/git-project");
    expect(install).toMatch(/PATH="\$HOME\/\.local\/bin\$\{PATH:\+":\$PATH"\}"/);
    expect(install).toContain("hash -r");
    expect(install).toContain("stn setup");
    expect(install).toContain("stn doctor");
    expect(install).toContain("stn tui");
    expect(install).toContain("~/.config/station/config.toml");
    expect(install).toContain("PATH uses `:` to separate entries");
    expect(install).toMatch(
      /before GitHub requests[^.]*temporary-directory creation[^.]*destination mutation/,
    );

    expect(quickStart).not.toContain(removedPersistenceOption);
    expect(quickStart).toContain("Add your first project");
    expect(quickStart).toContain("Create Session");
    expect(quickStart).toContain("Create session");
    expect(quickStart).toContain("stn doctor");

    for (const path of ["docs/development.md", "docs/single-binary.md"]) {
      expect(await read(path), path).not.toContain(removedPersistenceOption);
    }
  });

  it("keeps the VirtualBuddy lane aligned with zero-project onboarding", async () => {
    const development = await read("docs/development.md");
    const start = development.indexOf("### VirtualBuddy clean-mac preparation");
    const end = development.indexOf("\nFor each target", start);
    const virtualBuddy = development.slice(start, end);
    const normalizedVirtualBuddy = virtualBuddy.replace(/\s+/g, " ");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(normalizedVirtualBuddy).toContain("zero-project config");
    expect(virtualBuddy).toContain("**Add your first project**");
    expect(virtualBuddy.indexOf("**Add your first project**")).toBeLessThan(
      virtualBuddy.indexOf("press `N`"),
    );
    expect(normalizedVirtualBuddy).toContain("one future-shell export");
    expect(normalizedVirtualBuddy).toContain("shell configuration you choose");
    expect(normalizedVirtualBuddy).toContain("`tmux prefix + Space`");
    expect(normalizedVirtualBuddy).toContain("cold open");
    expect(normalizedVirtualBuddy).toContain("warm reopen");
  });

  it("does not advertise removed Crush harness surfaces", async () => {
    const files = ["README.md", "AGENTS.md", ...(await markdownFiles("docs"))];

    for (const file of files) {
      const content = await read(file);
      expect(content, file).not.toMatch(/\bcrush\b|\.crush|STATION_CRUSH|station-crush/i);
    }
  });
});

interface PackageManifest {
  engines: { node: string };
  scripts: Record<string, string>;
  version: string;
}

async function read(path: string): Promise<string> {
  return fs.readFile(path, "utf8");
}

async function readPackageManifest(): Promise<PackageManifest> {
  try {
    return JSON.parse(await read("package.json")) as PackageManifest;
  } catch (cause) {
    throw new Error("package.json must contain valid JSON", { cause });
  }
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
  const entries = await fs.readdir(root, { withFileTypes: true });
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
