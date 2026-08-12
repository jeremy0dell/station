import * as fs from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const removedPersistenceOption = ["--persist", "path"].join("-");

describe("release readiness docs", () => {
  it("documents the native TUI update-notice lifecycle", async () => {
    const [architecture, install, development, tui] = await Promise.all(
      ["docs/architecture.md", "docs/install.md", "docs/development.md", "docs/tui.md"].map(read),
    );
    const notice = "Station <version> is available — run `stn update`";

    expect(install).toContain(notice);
    expect(tui).toContain(notice);
    for (const document of [architecture, install, tui]) {
      expect(document).toContain("one process-local");
      expect(document).toContain("no persistent cache");
      expect(document).toContain("version-changing");
    }
    expect(development).toContain("apps/cli/test/integration/tui-command.test.ts");
    expect(development).toContain("tests/diagnostics/release-readiness-docs.test.ts");
    expect(development).toContain("older published native binary");
  });

  it("separates release guidance from contributor and test references", async () => {
    const [
      readme,
      docsReadme,
      quickStart,
      install,
      limitations,
      systemDependencies,
      testsReadme,
      localRealConfig,
    ] = await Promise.all([
      read("README.md"),
      read("docs/README.md"),
      read("docs/quick-start.md"),
      read("docs/install.md"),
      read("docs/limitations.md"),
      read("docs/system-dependencies.md"),
      read("tests/README.md"),
      read("examples/local-real-config.toml"),
    ]);

    expect(readme).toContain("docs/README.md");
    expect(readme).toContain("docs/quick-start.md");
    expect(readme).toContain("docs/limitations.md");
    expect(docsReadme).toContain("## Start Here");
    expect(docsReadme).toContain("install.md#let-your-agent-install-and-validate-station");
    expect(docsReadme).toContain("## Use Station");
    expect(docsReadme).toContain("## Develop Station");
    expect(docsReadme).not.toContain("single-binary.md");
    expect(docsReadme).not.toContain("observer-singleton.md");
    expect(docsReadme).not.toContain("homebrew.md");
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
    const [readme, install, development] = await Promise.all(
      ["README.md", "docs/install.md", "docs/development.md"].map(read),
    );

    for (const document of [readme, install]) {
      const prompt = agentInstallPrompt(document);
      const normalizedPrompt = prompt.replace(/\s+/g, " ").toLowerCase();
      expect(document.replace(/\s+/g, " ").toLowerCase()).toContain(
        "let your agent install and validate station",
      );
      expect(prompt).toContain(
        "https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.5.1/install.sh",
      );
      expect(prompt).toContain("v0.0.0-pre-alpha.5.1");
      expect(prompt).toContain("stn setup check --json");
      expect(prompt).toContain("stn doctor");
      expect(prompt).toContain("summary.requiredOk: true");
      expect(normalizedPrompt).toContain("do not clone the repository or build from source");
      expect(normalizedPrompt).toContain("do not edit any shell startup file");
      expect(normalizedPrompt).not.toContain("github token");
      expect(normalizedPrompt).not.toContain("gh auth");
      expect(normalizedPrompt).not.toContain("latest");
      expect(normalizedPrompt).not.toContain("homebrew");
      expect(normalizedPrompt).not.toContain("ref=main");
      expect(normalizedPrompt).not.toContain("/main/");
      expect(normalizedPrompt).toContain("absolute installed `stn` path");
      expect(normalizedPrompt).toContain(
        "only as evidence about the current agent execution context",
      );
      expect(normalizedPrompt).toContain("unfinished manual step");
      expect(normalizedPrompt).toContain("verify all three launchers in a new shell");
      expect(normalizedPrompt).toContain("do not claim success");
    }
    expect(agentInstallPrompt(readme)).toBe(agentInstallPrompt(install));

    const normalizedDevelopment = virtualBuddyCleanMacSection(development)
      .replace(/\s+/g, " ")
      .toLowerCase();
    expect(normalizedDevelopment).toContain("sandbox-only auth failure");
    expect(normalizedDevelopment).toContain("scoped host/keychain access");
    expect(normalizedDevelopment).toContain("absolute installed `stn` path");
    expect(normalizedDevelopment).toContain("future-shell path as unverified");
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

  it("documents and enforces the public exact-tag binary release contract", async () => {
    const [
      readme,
      install,
      docsReadme,
      limitations,
      development,
      singleBinary,
      homebrew,
      release,
      promote,
      installer,
      installSmoke,
      installerBinaryUpdate,
    ] = await Promise.all(
      [
        "README.md",
        "docs/install.md",
        "docs/README.md",
        "docs/limitations.md",
        "docs/development.md",
        "docs/single-binary.md",
        "docs/homebrew.md",
        ".github/workflows/release.yml",
        ".github/workflows/promote-release.yml",
        "scripts/install.sh",
        "scripts/test-runners/run-install-smoke.mjs",
        "apps/cli/src/update/installerBinaryUpdate.ts",
      ].map(read),
    );
    const packageJson = await readPackageManifest();
    const exactVersion = "v0.0.0-pre-alpha.5.1";
    const exactInstallerUrl =
      "https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.5.1/install.sh";

    for (const [path, document] of [
      ["README.md", readme],
      ["docs/install.md", install],
      ["docs/README.md", docsReadme],
      ["docs/limitations.md", limitations],
    ] as const) {
      const normalized = document.replace(/\s+/g, " ");
      expect(normalized, path).toMatch(/experimental pre-alpha/i);
      expect(document, path).toContain(exactVersion);
      expect(document, path).toContain("GitHub Issues");
      expect(document, path).toContain("stn setup");
      expect(document, path).toContain("stn setup check --json");
      expect(document, path).toContain("stn doctor");
      expect(document, path).toMatch(/macOS 13(?:\.0)?(?:\+| or newer)/);
      expect(document, path).toContain("glibc 2.39");
      expect(document, path).not.toContain("/releases/latest");
      expect(document, path).not.toContain("ref=main");
      expect(document, path).not.toMatch(/gh auth (?:login|status)/);
      expect(document, path).not.toMatch(/^\s*brew install[^\n]*station/im);
    }

    expect(readme).toContain(exactInstallerUrl);
    for (const [path, document] of [
      ["README.md", readme],
      ["docs/install.md", install],
      ["docs/README.md", docsReadme],
    ] as const) {
      expect(document, path).toContain("curl --disable -fsSL");
    }
    expect(readme.indexOf(exactInstallerUrl)).toBeLessThan(readme.indexOf("## Why Station"));
    expect(readme.indexOf("stn setup")).toBeLessThan(readme.indexOf("## Why Station"));
    expect(readme).toContain("[installation guide](docs/install.md)");
    expect(install).toContain(exactInstallerUrl);
    expect(install).toContain("does not require a GitHub account");
    expect(install).toContain("Setup never starts an agent");
    expect(install.replace(/\s+/g, " ")).toContain(
      "Each accepted agent is attempted independently",
    );
    expect(install).toContain("streams the child installer's terminal output");
    expect(install.replace(/\s+/g, " ")).toContain(
      "The old `v0.7.1-rc.*` releases were internal previews",
    );
    expect(singleBinary).toContain("release **draft**");
    expect(singleBinary).toContain("six assets");
    expect(singleBinary).toContain("workflow cannot enforce the precondition itself");
    expect(singleBinary).toContain("station-installer-binary-v1");
    expect(singleBinary).toContain("`stn update` composes it with");
    expect(singleBinary).toContain("Manager-owned channels");
    expect(install).toContain("Automatic-update ownership");
    expect(install).toContain("stn update --dry-run --json");
    expect(install).toContain("stn update --drive-package-manager");
    expect(install).toContain("defaults to preserving");
    expect(install).toContain("--no-handoff");
    expect(install).toContain("existing installations continue to work but are not enrolled");
    expect(development).toMatch(/workflow never\s+publishes\s+the draft automatically/);
    expect(development).toContain("accepted-release-candidate-0.0.0-pre-alpha.5.1");
    expect(development).toContain("v0.7.1-rc.8");
    expect(homebrew).toContain("Homebrew installation is not currently supported");
    expect(homebrew).toContain("This distribution policy is separate from first-run dependencies");
    expect(homebrew).not.toMatch(/^\s*brew install[^\n]*station/im);

    expect(installer).toContain('embedded_version=""');
    expect(installer).toContain("releases/download/$tag");
    expect(installer).toContain("run_curl");
    expect(installer).toContain('curl --disable "$@"');
    expect(installer).toContain("--expected-installation");
    expect(installer).toContain("station-installer-binary-v1");
    expect(installer).toContain("STATION_INSTALL_RELEASE_ID");
    expect(installer).not.toContain("releases/latest");
    expect(installer).not.toContain("contents/scripts/install.sh");
    expect(installSmoke).toContain('readFileSync(join(repoRoot, "package.json")');
    expect(installSmoke).toContain("releaseVersion");
    expect(installSmoke).toContain("const releaseTag = ");
    expect(installSmoke).not.toContain('const releaseTag = "v0.0.0-pre-alpha.');
    expect(installSmoke).toContain("makePublicBin()");
    expect(installSmoke).toContain("assertStrictPublicFlow");
    expect(installSmoke).toContain("strict stamped public flow without gh");
    expect(installSmoke).toContain("STATION_INSTALL_RELEASE_ID");
    expect(installSmoke).toContain("scenarioReceiptAndExpectedInstallation");
    expect(installerBinaryUpdate).toContain('const channel = "installer-binary" as const');
    expect(installerBinaryUpdate).toContain("--expected-installation");

    expect(release).toContain("Stamp release installer");
    expect(release).toContain(['embedded_version=\\"$', 'TAG\\"'].join(""));
    expect(release).toContain(['for asset in "$', '{expected[@]}" install.sh'].join(""));
    expect(release).toContain("install.sh");
    expect(release).toContain("SHA256SUMS");
    expect(release).toContain("accepted-release-candidate-");
    expect(release).not.toContain("render-installer");
    const createDraft = release.slice(
      release.indexOf("      - name: Create draft release"),
      release.indexOf("\n  install-draft:"),
    );
    for (const asset of [
      "stn-v$VERSION-darwin-arm64.tar.gz",
      "stn-v$VERSION-darwin-x64.tar.gz",
      "stn-v$VERSION-linux-arm64.tar.gz",
      "stn-v$VERSION-linux-x64.tar.gz",
      "install.sh",
      "SHA256SUMS",
    ]) {
      expect(createDraft).toContain(asset);
    }
    const installDraft = release.slice(
      release.indexOf("  install-draft:"),
      release.indexOf("  record-accepted-candidate:"),
    );
    expect(installDraft).toContain("releases/assets/$installer_asset_id");
    expect(installDraft).toContain('grep -Fx "embedded_version=\\"$TAG\\""');
    expect(installDraft).toContain("STATION_INSTALL_RELEASE_ID");
    expect(installDraft).not.toContain('--version "$TAG"');
    expect(installDraft).toContain("0.7.1-rc.8");
    expect(installDraft).toContain(".station-install-receipt");
    expect(installDraft).toContain("station-installer-binary-v1");
    const recordCandidate = release.slice(release.indexOf("  record-accepted-candidate:"));
    expect(recordCandidate).toContain("asset-ids.txt");
    expect(recordCandidate).toContain("releaseId");

    expect(promote).toContain("verify-public-install:");
    expect(promote).toContain("Download exact-tag public installer");
    expect(promote).toContain("Install without GitHub credentials or gh");
    expect(promote).toContain("releases/download/$TAG/install.sh");
    expect(promote).toContain("curl --disable --fail --silent --show-error --location");
    expect(promote).toContain('test ! -e "$public_path/gh"');
    expect(promote).toContain("env -u GH_TOKEN -u GITHUB_TOKEN");
    expect(promote).toContain("install.sh");
    expect(promote).toContain(".station-install-receipt");
    expect(promote).toContain("station-installer-binary-v1");
    for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      expect(release).toContain(target);
      expect(promote).toContain(target);
      expect(singleBinary).toContain(target);
    }

    expect(packageJson.version).toBe("0.0.0-pre-alpha.5.1");
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
      expect(normalized, path).toContain("requested tag");
      expect(normalized, path).not.toContain("requested tag or `latest`");
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
      "internal preview",
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
    expect(install).toMatch(/does not (?:read, create, or )?edit shell\s+startup files/);
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
      /before network requests[^.]*temporary-directory creation[^.]*destination mutation/,
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
    const virtualBuddy = virtualBuddyCleanMacSection(development);
    const normalizedVirtualBuddy = virtualBuddy.replace(/\s+/g, " ");

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

  it("keeps assistant-only operating guidance out of documentation", async () => {
    const forbiddenGuidance = [
      /## No-Action Mode/i,
      /If the user says "no action"/i,
      /unless explicitly asked/i,
      /## Agent Guidance Maintenance/i,
      /## The agent-driven loop/i,
      /`AGENTS\.md`/,
      /when the task (?:permits|calls for)/i,
    ];

    for (const file of await markdownFiles("docs")) {
      const content = await read(file);
      for (const pattern of forbiddenGuidance) {
        expect(content, `${file}: ${pattern}`).not.toMatch(pattern);
      }
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

function agentInstallPrompt(document: string): string {
  const heading = document.search(/let your agent install and validate station/i);
  if (heading < 0) throw new Error("agent install prompt heading is missing");
  const match = document.slice(heading).match(/```text\r?\n([\s\S]*?)```/);
  if (match?.[1] === undefined) throw new Error("agent install prompt is missing");
  return match[1];
}

function virtualBuddyCleanMacSection(document: string): string {
  const start = document.indexOf("### VirtualBuddy clean-mac preparation");
  const end = document.indexOf("\nFor each target", start);
  if (start < 0 || end <= start) throw new Error("VirtualBuddy clean-mac section is missing");
  return document.slice(start, end);
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
