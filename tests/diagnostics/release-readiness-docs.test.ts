import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const removedPersistenceOption = ["--persist", "path"].join("-");

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
      expect(document, path).not.toContain(removedPersistenceOption);
      expect(document, path).toMatch(/does not (?:read, create, or )?edit shell startup files/);
      expect(document, path).toContain("chosen shell configuration");
      expect(document, path).toContain("future shells");
      expect(document, path).toContain("Absolute fallback");
      expect(document, path).toContain("all three");
      expect(document, path).toContain("physically");
      expect(document, path).toContain("From any directory");
      expect(document, path).toContain("zero-project");
      expect(document, path).toContain("Add your first project");
      expect(document, path).not.toContain("cd /path/to/your/git-project");
      expect(document, path).toMatch(/PATH="\$HOME\/\.local\/bin\$\{PATH:\+":\$PATH"\}"/);
      expect(document, path).toContain("hash -r");
      expect(document, path).toContain("stn setup");
      expect(document, path).toContain("stn doctor");
      expect(document, path).toContain("stn tui");
      expect(document, path).toContain("~/.config/station/config.toml");
      expect(document, path).toContain("empty dashboard");
      expect(document, path).toContain("Create Session");
      expect(document, path).toContain("start the agent session");
    }

    const install = await read("docs/install.md");
    expect(install).toContain("PATH uses `:` to separate entries");
    expect(install).toMatch(
      /before GitHub requests[^.]*temporary-directory creation[^.]*destination mutation/,
    );

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
