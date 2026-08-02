import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySetupPlan } from "../../src/commands/setup/apply.js";
import { homebrewInstallAction } from "../../src/commands/setup/flows/guided.js";
import { missingHarnessInstallActions } from "../../src/commands/setup/harnessInstall.js";
import type { SetupAction, SetupHarnessFact, SetupPlan } from "../../src/commands/setup/model.js";

describe("guided agent installers", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("uses official Homebrew packages for every supported macOS agent except Cursor", () => {
    const actions = missingHarnessInstallActions(missingHarnesses(), {
      brewAvailable: true,
      homeDir: "/tmp/home",
      macos: true,
    });

    const commands = commandsByHarness(actions);
    expect(commands).toMatchObject({
      codex: ["brew", "install", "--cask", "homebrew/cask/codex"],
      opencode: ["brew", "install", "homebrew/core/opencode"],
      pi: ["brew", "install", "homebrew/core/pi-coding-agent"],
      claude: ["brew", "install", "--cask", "homebrew/cask/claude-code"],
    });
    expect(commands.cursor?.join(" ")).toContain("https://cursor.com/install");
  });

  it("executes every fallback unattended without touching the user's shell files", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-agent-install-"));
    tempRoots.push(root);
    const binDir = join(root, "bin");
    const fixtureDir = join(root, "installers");
    const resultDir = join(root, "results");
    const homeDir = join(root, "home");
    await Promise.all([
      mkdir(binDir, { recursive: true }),
      mkdir(fixtureDir, { recursive: true }),
      mkdir(resultDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    const zshrc = join(homeDir, ".zshrc");
    await writeFile(zshrc, "# user sentinel\n", "utf8");
    await installFakeExecutables(binDir, fixtureDir);

    const actions = [
      homebrewInstallAction(),
      ...missingHarnessInstallActions(missingHarnesses(), {
        brewAvailable: false,
        homeDir,
        macos: false,
      }).map((action) => ({ ...action, selected: true })),
    ];
    const result = await applySetupPlan(testPlan(actions), {
      env: {
        HOME: homeDir,
        CODEX_HOME: join(homeDir, ".codex"),
        PATH: `${binDir}:/usr/bin:/bin`,
        FAKE_INSTALLER_DIR: fixtureDir,
        FAKE_RESULTS: resultDir,
      },
    });

    expect(result.failedAction).toBeUndefined();
    await expect(readFile(join(resultDir, "homebrew"), "utf8")).resolves.toBe("ran\n");
    await expect(readFile(join(resultDir, "codex"), "utf8")).resolves.toContain(
      `CODEX_HOME=${homeDir}/.codex`,
    );
    await expect(readFile(join(resultDir, "codex"), "utf8")).resolves.toContain(
      `CODEX_INSTALL_DIR=${homeDir}/.local/bin`,
    );
    await expect(readFile(join(resultDir, "codex-started"), "utf8")).rejects.toThrow();
    await expect(readFile(join(resultDir, "cursor"), "utf8")).resolves.toBe("ran\n");
    await expect(readFile(join(resultDir, "opencode"), "utf8")).resolves.toBe("--no-modify-path\n");
    await expect(readlink(join(homeDir, ".local", "bin", "opencode"))).resolves.toBe(
      join(homeDir, ".opencode", "bin", "opencode"),
    );
    const npmCalls = await readFile(join(resultDir, "npm"), "utf8");
    expect(npmCalls).toContain(
      `install --global --prefix ${homeDir}/.local --ignore-scripts --no-fund --no-audit @earendil-works/pi-coding-agent`,
    );
    expect(npmCalls).toContain(
      `install --global --prefix ${homeDir}/.local --no-fund --no-audit @anthropic-ai/claude-code`,
    );
    expect(npmCalls).not.toContain(
      `--ignore-scripts --no-fund --no-audit @anthropic-ai/claude-code`,
    );
    await expect(readFile(zshrc, "utf8")).resolves.toBe("# user sentinel\n");
    await expect(readFile(join(homeDir, ".profile"), "utf8")).rejects.toThrow();
  });
});

function missingHarnesses(): SetupHarnessFact[] {
  return [
    { id: "codex", label: "Codex", status: "missing", command: "codex" },
    { id: "cursor", label: "Cursor Agent", status: "missing", command: "agent" },
    { id: "opencode", label: "OpenCode", status: "missing", command: "opencode" },
    { id: "pi", label: "Pi", status: "missing", command: "pi" },
    { id: "claude", label: "Claude Code", status: "missing", command: "claude" },
  ];
}

function commandsByHarness(
  actions: readonly SetupAction[],
): Record<string, readonly string[] | undefined> {
  return Object.fromEntries(actions.map((action) => [action.data?.harness, action.command]));
}

function testPlan(actions: readonly SetupAction[]): SetupPlan {
  return {
    generatedAt: "2026-07-26T12:00:00.000Z",
    mode: "apply",
    checks: [],
    actions: [...actions],
    summary: {
      launchReady: false,
      workflowReady: false,
      requiredOk: false,
      requiredMissing: 1,
      warnings: 0,
      selectedActions: actions.length,
      selectionSource: "unresolved",
      configPath: "/tmp/config.toml",
    },
    nextSteps: [],
  };
}

async function installFakeExecutables(binDir: string, fixtureDir: string): Promise<void> {
  const curl = join(binDir, "curl");
  const npm = join(binDir, "npm");
  await writeFile(
    curl,
    `#!/bin/sh
set -eu
url=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *Homebrew*) source="$FAKE_INSTALLER_DIR/homebrew.sh" ;;
  *chatgpt*) source="$FAKE_INSTALLER_DIR/codex.sh" ;;
  *cursor*) source="$FAKE_INSTALLER_DIR/cursor.sh" ;;
  *opencode*) source="$FAKE_INSTALLER_DIR/opencode.sh" ;;
  *) exit 64 ;;
esac
cp "$source" "$output"
`,
    "utf8",
  );
  await writeFile(
    npm,
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_RESULTS/npm"
`,
    "utf8",
  );
  await Promise.all([chmod(curl, 0o755), chmod(npm, 0o755)]);

  await writeFile(
    join(fixtureDir, "homebrew.sh"),
    `#!/bin/bash
set -eu
printf 'ran\n' > "$FAKE_RESULTS/homebrew"
`,
    "utf8",
  );
  await writeFile(
    join(fixtureDir, "codex.sh"),
    `#!/bin/sh
set -eu
if [ "\${CODEX_NON_INTERACTIVE:-}" != "1" ]; then
  printf 'ran\n' > "$FAKE_RESULTS/codex-started"
  exit 65
fi
printf 'HOME=%s\nCODEX_HOME=%s\nCODEX_INSTALL_DIR=%s\n' "$HOME" "$CODEX_HOME" "$CODEX_INSTALL_DIR" > "$FAKE_RESULTS/codex"
printf 'installer shell write\n' > "$HOME/.profile"
`,
    "utf8",
  );
  await writeFile(
    join(fixtureDir, "cursor.sh"),
    `#!/bin/bash
set -eu
printf 'ran\n' > "$FAKE_RESULTS/cursor"
`,
    "utf8",
  );
  await writeFile(
    join(fixtureDir, "opencode.sh"),
    `#!/bin/bash
set -eu
printf '%s\n' "$*" > "$FAKE_RESULTS/opencode"
mkdir -p "$HOME/.opencode/bin"
printf '#!/bin/sh\n' > "$HOME/.opencode/bin/opencode"
chmod +x "$HOME/.opencode/bin/opencode"
`,
    "utf8",
  );
}
