import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const classifier = fileURLToPath(
  new URL("../../scripts/ci/classify-standard-ci.mjs", import.meta.url),
);

type Classification = {
  docs_only: boolean;
  installer: boolean;
  binary: boolean;
  claim_stress: boolean;
  shell_matrix: boolean;
};

type ClassificationCase = {
  name: string;
  paths: readonly string[];
  expected: Classification;
};

describe("standard CI path classification", () => {
  it.each([
    {
      name: "documentation only",
      paths: ["README.md", "docs/development.md", "docs/releasing.md", "tests/README.md"],
      expected: {
        docs_only: true,
        installer: false,
        binary: false,
        claim_stress: false,
        shell_matrix: false,
      },
    },
    {
      name: "production source",
      paths: ["packages/protocol/src/index.ts"],
      expected: {
        docs_only: false,
        installer: false,
        binary: true,
        claim_stress: false,
        shell_matrix: false,
      },
    },
    {
      name: "Observer claim-sensitive source",
      paths: ["apps/observer/src/runtime/observerBootClaim.ts"],
      expected: {
        docs_only: false,
        installer: false,
        binary: true,
        claim_stress: true,
        shell_matrix: false,
      },
    },
    {
      name: "shell-sensitive setup source",
      paths: ["apps/cli/src/commands/setup/checks/worktrunk.ts"],
      expected: {
        docs_only: false,
        installer: false,
        binary: true,
        claim_stress: false,
        shell_matrix: true,
      },
    },
    {
      name: "guided PTY coverage",
      paths: ["tests/e2e/setup-guided-tty.test.ts", "tests/support/setup-guided.ts"],
      expected: {
        docs_only: false,
        installer: false,
        binary: false,
        claim_stress: false,
        shell_matrix: true,
      },
    },
    {
      name: "installer only",
      paths: ["scripts/install.sh", "scripts/test-runners/run-install-smoke.mjs"],
      expected: {
        docs_only: false,
        installer: true,
        binary: false,
        claim_stress: false,
        shell_matrix: false,
      },
    },
    {
      name: "composed update smoke runner",
      paths: ["scripts/test-runners/run-update-smoke.mjs"],
      expected: {
        docs_only: false,
        installer: false,
        binary: true,
        claim_stress: false,
        shell_matrix: false,
      },
    },
    {
      name: "tests only",
      paths: [
        "station/src/station/input/stationMouse.test.ts",
        "config/vitest/vitest.unit.config.ts",
      ],
      expected: {
        docs_only: false,
        installer: false,
        binary: false,
        claim_stress: false,
        shell_matrix: false,
      },
    },
    {
      name: "CI infrastructure",
      paths: [".github/workflows/standard-ci.yml"],
      expected: {
        docs_only: false,
        installer: true,
        binary: true,
        claim_stress: true,
        shell_matrix: true,
      },
    },
    {
      name: "packaged dependency state",
      paths: ["package.json", "pnpm-lock.yaml", "LICENSE"],
      expected: {
        docs_only: false,
        installer: true,
        binary: true,
        claim_stress: true,
        shell_matrix: false,
      },
    },
  ] as const)("classifies $name changes", ({ paths, expected }: ClassificationCase) => {
    expect(classify(paths)).toEqual(expected);
  });

  it("falls back to every specialized lane when Git reports no paths", () => {
    expect(classify([])).toEqual({
      docs_only: false,
      installer: true,
      binary: true,
      claim_stress: true,
      shell_matrix: true,
    });
  });
});

function classify(paths: readonly string[]): Classification {
  const input = paths.length === 0 ? Buffer.alloc(0) : Buffer.from(`${paths.join("\0")}\0`);
  const result = spawnSync(process.execPath, [classifier], {
    encoding: "utf8",
    input,
  });
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1) === "true"];
      }),
  ) as Classification;
}
