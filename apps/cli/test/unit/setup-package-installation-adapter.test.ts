import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SetupHarnessInstallOperation,
  SetupPackageInstallOperation,
  SetupToolInstallOperation,
  SupportedHarnessId,
} from "@station/setup-core";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupFacts } from "../../src/commands/setup/adapters/inspectionTypes.js";
import { createSetupOperationAdapter } from "../../src/commands/setup/adapters/operations.js";
import { resolveSetupHarnessInstallation } from "../../src/commands/setup/harnessInstallation.js";

describe("setup package installation adapter", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("uses canonical installers for setup tools and supported macOS agents", async () => {
    const commands = new Map<SupportedHarnessId, readonly string[]>();
    const toolCommands: string[] = [];
    let activeHarness: SupportedHarnessId | undefined;
    const execute = createSetupOperationAdapter({
      facts: packageFacts({ brewAvailable: true, macos: true }),
      deps: {
        runner: async (input) => {
          if (activeHarness !== undefined) {
            commands.set(activeHarness, [input.command, ...(input.args ?? [])]);
          } else {
            toolCommands.push([input.command, ...(input.args ?? [])].join(" "));
          }
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    const tools: SetupToolInstallOperation["tool"][] = ["worktrunk", "tmux", "bun", "diff-viewer"];
    for (const tool of tools) {
      await execute({
        id: `install:${tool}`,
        kind: "install-tool",
        tier: "required",
        selected: true,
        tool,
      });
    }
    for (const harnessId of harnessInstallOrder) {
      activeHarness = harnessId;
      await execute(harnessInstallOperation(harnessId));
    }

    expect(toolCommands).toEqual([
      "brew install worktrunk",
      "brew install tmux",
      "brew install bun",
      "brew install hunk",
    ]);
    expect(Object.fromEntries(commands)).toMatchObject({
      codex: ["brew", "install", "--cask", "homebrew/cask/codex"],
      opencode: ["brew", "install", "homebrew/core/opencode"],
      pi: ["brew", "install", "homebrew/core/pi-coding-agent"],
      claude: ["brew", "install", "--cask", "homebrew/cask/claude-code"],
    });
    expect(commands.get("cursor")?.join(" ")).toContain("https://cursor.com/install");
  });

  it("pairs each installer decision with its presentation message", () => {
    expect(
      harnessInstallOrder.map((harnessId) => {
        const installation = resolveSetupHarnessInstallation({
          harnessId,
          brewAvailable: true,
          homeDir: "/tmp/home",
          macos: true,
        });
        return [harnessId, installation.message.id];
      }),
    ).toEqual([
      ["codex", "installer.codex-brew"],
      ["cursor", "installer.cursor-script"],
      ["opencode", "installer.opencode-brew"],
      ["pi", "installer.pi-brew"],
      ["claude", "installer.claude-brew"],
    ]);
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
    await installFakeExecutables({ binDir, fixtureDir });

    const execute = createSetupOperationAdapter({
      facts: packageFacts({ brewAvailable: false, homeDir, macos: false }),
      deps: {
        env: {
          HOME: homeDir,
          CODEX_HOME: join(homeDir, ".codex"),
          PATH: `${binDir}:/usr/bin:/bin`,
          FAKE_INSTALLER_DIR: fixtureDir,
          FAKE_RESULTS: resultDir,
        },
      },
    });
    const operations: SetupPackageInstallOperation[] = [
      {
        id: "install:homebrew",
        kind: "install-homebrew",
        tier: "required",
        selected: true,
      },
      ...harnessInstallOrder.map(harnessInstallOperation),
    ];
    const outcomes = [];
    for (const operation of operations) outcomes.push(await execute(operation));

    expect(outcomes.every((outcome) => outcome.status === "completed")).toBe(true);
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

const harnessInstallOrder = ["codex", "cursor", "opencode", "pi", "claude"] as const;

function harnessInstallOperation(harnessId: SupportedHarnessId): SetupHarnessInstallOperation {
  return {
    id: `install-harness:${harnessId}`,
    kind: "install-harness",
    tier: "required",
    selected: true,
    harnessId,
  };
}

function packageFacts(input: {
  readonly brewAvailable: boolean;
  readonly homeDir?: string;
  readonly macos: boolean;
}): SetupFacts {
  return {
    homeDir: input.homeDir ?? "/tmp/home",
    brew: { status: input.brewAvailable ? "ok" : "missing", command: "brew" },
    xcode: { status: "ok", applicable: input.macos },
  } as SetupFacts;
}

async function installFakeExecutables(input: {
  readonly binDir: string;
  readonly fixtureDir: string;
}): Promise<void> {
  const { binDir, fixtureDir } = input;
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
