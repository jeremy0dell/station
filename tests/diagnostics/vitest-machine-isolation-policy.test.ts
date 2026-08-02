import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { UserConfig } from "vitest/config";

const repositoryRoot = new URL("../../", import.meta.url);
const configDirectory = new URL("config/vitest/", repositoryRoot);
const fixtureConfig = new URL(
  "tests/diagnostics/fixtures/vitest-machine-isolation/vitest.config.ts",
  repositoryRoot,
);
const machineSetupSuffix = "/config/vitest/test-machine-sandbox.setup.ts";

// This inventory stays independent from config composition so a new config cannot satisfy its own policy.
const machineIsolatedConfigs = [
  "vitest.agent-scripted.config.ts",
  "vitest.contracts.config.ts",
  "vitest.diagnostics.config.ts",
  "vitest.integration.config.ts",
  "vitest.unit.config.ts",
] as const;

const laneOwnedConfigs = [
  {
    file: "vitest.e2e.config.ts",
    rationale:
      "Observer E2E owns explicit config, state, socket, repository, and process fixtures.",
  },
  {
    file: "vitest.setup-e2e.config.ts",
    rationale:
      "Setup E2E constructs complete homes, PATHs, provider shims, and hostile environments.",
  },
] as const;

const realMachineConfigs = [
  {
    file: "vitest.claude-real.config.ts",
    rationale: "The lane exercises the installed Claude provider and its real machine state.",
  },
  {
    file: "vitest.codex-real.config.ts",
    rationale: "The lane exercises the installed Codex provider and its real machine state.",
  },
  {
    file: "vitest.cursor-real.config.ts",
    rationale: "The lane exercises the installed Cursor provider and its real machine state.",
  },
  {
    file: "vitest.opencode-real.config.ts",
    rationale: "The lane exercises the installed OpenCode provider and its real machine state.",
  },
  {
    file: "vitest.pi-real.config.ts",
    rationale: "The lane exercises the installed Pi provider and its real machine state.",
  },
  {
    file: "vitest.real-e2e.config.ts",
    rationale: "The lane deliberately exercises real providers and external machine integrations.",
  },
  {
    file: "vitest.tmux-popup-real.config.ts",
    rationale: "The lane drives a real tmux server and production popup process boundaries.",
  },
  {
    file: "vitest.worktrunk-real.config.ts",
    rationale: "The lane exercises the installed Worktrunk provider and real Git worktrees.",
  },
] as const;

const exceptionConfigs = [...laneOwnedConfigs, ...realMachineConfigs];
const centralConfigs = [...machineIsolatedConfigs, ...exceptionConfigs.map(({ file }) => file)];

describe("Vitest machine-isolation policy", () => {
  it("classifies every executable central config exactly once", () => {
    const executableConfigs = readdirSync(configDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^vitest\..+\.config\.ts$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    expect(new Set(centralConfigs).size).toBe(centralConfigs.length);
    expect([...centralConfigs].sort()).toEqual(executableConfigs);
  });

  it.each(machineIsolatedConfigs)("keeps %s on automatic machine isolation", async (file) => {
    assertMachineIsolated(await loadConfig(new URL(file, configDirectory)));
  });

  it.each(exceptionConfigs)("keeps $file outside automatic machine isolation", async (entry) => {
    expect(entry.rationale.trim().length).toBeGreaterThan(0);
    expect(setupFilesFor(await loadConfig(new URL(entry.file, configDirectory)))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/test-machine-sandbox\.setup\.ts$/u)]),
    );
  });

  it("keeps the process-level regression fixture machine isolated", async () => {
    assertMachineIsolated(await loadConfig(fixtureConfig));
  });

  it("keeps central configs reachable from package scripts and documented", () => {
    const packageDocument = readFileSync(new URL("package.json", repositoryRoot), "utf8");
    const developmentDocument = readFileSync(
      new URL("docs/development.md", repositoryRoot),
      "utf8",
    );

    for (const file of centralConfigs) {
      expect(packageDocument, `${file} is not referenced by a package script`).toContain(
        `config/vitest/${file}`,
      );
      expect(developmentDocument, `${file} is missing from the test isolation matrix`).toContain(
        `\`${file}\``,
      );
    }
  });
});

async function loadConfig(url: URL): Promise<UserConfig> {
  const configModule = (await import(url.href)) as { default: UserConfig };
  return configModule.default;
}

function setupFilesFor(config: UserConfig): readonly string[] {
  const setupFiles = config.test?.setupFiles;
  if (setupFiles === undefined) return [];
  return typeof setupFiles === "string" ? [setupFiles] : setupFiles;
}

function assertMachineIsolated(config: UserConfig): void {
  expect(config.test?.isolate).toBe(true);
  expect(config.test?.unstubEnvs).toBe(true);
  expect(config.test?.sequence?.hooks).toBe("stack");
  expect(config.test?.sequence?.setupFiles).toBe("list");
  expect(setupFilesFor(config)).toEqual(
    expect.arrayContaining([expect.stringMatching(new RegExp(`${machineSetupSuffix}$`, "u"))]),
  );
}
