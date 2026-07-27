import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const aggregatePolicy = fileURLToPath(
  new URL("../../scripts/ci/require-standard-ci-results.sh", import.meta.url),
);

function read(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

function actionsExpression(value: string): string {
  return `\${{ ${value} }}`;
}

function between(document: string, start: string, end?: string): string {
  const startIndex = document.indexOf(start);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = end === undefined ? document.length : document.indexOf(end, startIndex + 1);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return document.slice(startIndex, endIndex);
}

const successfulCiEnvironment = {
  DOCS_ONLY: "false",
  INSTALLER_SELECTED: "true",
  BINARY_SELECTED: "true",
  CLAIM_STRESS_SELECTED: "false",
  SHELL_MATRIX_SELECTED: "false",
  CLASSIFY: "success",
  STATIC: "success",
  FAST_TESTS: "success",
  INTEGRATION_TESTS: "success",
  SETUP_E2E: "success",
  OBSERVER_E2E: "success",
  INSTALLER_SMOKE: "success",
  SQLITE_CROSS_RUNTIME: "success",
  STATION_TESTS: "success",
  BINARY_SMOKE: "success",
} as const;

const documentationCiEnvironment = {
  ...successfulCiEnvironment,
  DOCS_ONLY: "true",
  INSTALLER_SELECTED: "false",
  BINARY_SELECTED: "false",
  CLAIM_STRESS_SELECTED: "false",
  SHELL_MATRIX_SELECTED: "false",
  FAST_TESTS: "skipped",
  INTEGRATION_TESTS: "skipped",
  SETUP_E2E: "skipped",
  OBSERVER_E2E: "skipped",
  INSTALLER_SMOKE: "skipped",
  SQLITE_CROSS_RUNTIME: "skipped",
  STATION_TESTS: "skipped",
  BINARY_SMOKE: "skipped",
} as const;

function runAggregatePolicy(environment: Readonly<Record<string, string>>) {
  return spawnSync("/bin/sh", [aggregatePolicy], {
    encoding: "utf8",
    env: { ...environment },
  });
}

describe("hosted CI policy", () => {
  it("fans ready pull requests and release calls into independently reported validation lanes", () => {
    const standardCi = read(".github/workflows/standard-ci.yml");
    const release = read(".github/workflows/release.yml");
    const development = read("docs/development.md");

    expect(standardCi).toContain("types: [opened, synchronize, reopened, ready_for_review]");
    expect(standardCi).toContain("github.ref_type == 'tag'");
    expect(standardCi).toContain("github.event.pull_request.draft == false");

    for (const job of [
      "fast_tests",
      "integration_tests",
      "setup_e2e",
      "observer_e2e",
      "installer_smoke",
      "sqlite_cross_runtime",
      "station_tests",
      "binary_smoke",
    ]) {
      expect(standardCi).toContain(`  ${job}:`);
    }
    expect(standardCi).toContain(`name: setup-e2e (${actionsExpression("matrix.lane")})`);
    expect(standardCi).toContain("needs: [classify, static]");
    expect(standardCi).toContain("needs.classify.outputs.docs_only != 'true'");
    expect(standardCi).toContain("needs.classify.outputs.installer == 'true'");
    expect(standardCi).toContain("needs.classify.outputs.binary == 'true'");
    expect(standardCi).toContain("needs.classify.outputs.claim_stress");
    expect(standardCi).toContain("needs.classify.outputs.shell_matrix");
    expect(standardCi).toContain("STATION_SETUP_E2E_ALL_SHELLS");
    expect(standardCi).toContain("pnpm test:sqlite:bun:pr");
    expect(standardCi).toContain("pnpm test:sqlite:bun");
    expect(standardCi).not.toContain("pnpm test:pre-push");

    const aggregate = between(standardCi, "  standard-ci:", "  main-smoke:");
    expect(aggregate).toContain("name: standard-ci");
    expect(aggregate).toContain("always()");
    expect(aggregate).toContain("sh scripts/ci/require-standard-ci-results.sh");
    expect(aggregate).toContain("- binary_smoke");

    const releaseStandardCi = between(release, "  standard-ci:", "  release-smoke:");
    expect(releaseStandardCi).toContain("uses: ./.github/workflows/standard-ci.yml");
    const nativeBuilds = between(release, "  build-native:", "  create-draft:");
    expect(nativeBuilds).toMatch(/needs:\s+- validate\s+- standard-ci\s+- release-smoke/);

    expect(development).toContain("Ready, non-draft pull requests fan out");
    expect(development).toContain("before any native release build starts");
    expect(development).toMatch(/Draft pull request activity\s+allocates no runner/);
    expect(development).toMatch(/Pushes to `main`\s+run only build, typecheck, and lint/);
  });

  it("fails closed when a required or selected lane is unexpectedly skipped", () => {
    for (const testCase of [
      {
        name: "all selected",
        environment: successfulCiEnvironment,
      },
      {
        name: "specialized lanes not selected",
        environment: {
          ...successfulCiEnvironment,
          INSTALLER_SELECTED: "false",
          BINARY_SELECTED: "false",
          INSTALLER_SMOKE: "skipped",
          BINARY_SMOKE: "skipped",
        },
      },
      {
        name: "documentation only",
        environment: documentationCiEnvironment,
      },
    ]) {
      const result = runAggregatePolicy(testCase.environment);
      expect(result.status, `${testCase.name}: ${result.stderr}`).toBe(0);
    }

    for (const testCase of [
      {
        name: "required lane skipped",
        environment: { ...successfulCiEnvironment, FAST_TESTS: "skipped" },
      },
      {
        name: "selected lane skipped",
        environment: { ...successfulCiEnvironment, INSTALLER_SMOKE: "skipped" },
      },
      {
        name: "unselected lane unexpectedly ran",
        environment: { ...successfulCiEnvironment, BINARY_SELECTED: "false" },
      },
      {
        name: "contradictory documentation selectors",
        environment: { ...documentationCiEnvironment, SHELL_MATRIX_SELECTED: "true" },
      },
    ]) {
      const result = runAggregatePolicy(testCase.environment);
      expect(result.status, testCase.name).toBe(1);
      expect(result.stderr, testCase.name).toContain("must end with");
    }
  });

  it("keeps exhaustive claim stress scheduled without extending every pull request", () => {
    const nightly = read(".github/workflows/nightly-observer-claim.yml");
    const development = read("docs/development.md");

    expect(nightly).toContain('cron: "17 7 * * *"');
    expect(nightly).toContain("workflow_dispatch:");
    expect(nightly).toContain('bun: "true"');
    expect(nightly).toContain("pnpm test:observer-claim:cross-runtime");
    expect(nightly).not.toContain("test:observer-claim:cross-runtime:pr");
    expect(development).toContain("nightly-observer-claim");
  });

  it("keeps pre-push local and fast while preserving explicit comprehensive commands", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const lefthook = read("lefthook.yml");
    const development = read("docs/development.md");

    expect(packageJson.scripts["test:pre-push"]).toBe("pnpm lint");
    expect(packageJson.scripts["test:all"]).toContain("pnpm smoke:install");
    expect(packageJson.scripts["test:diagnostics:policy"]).toContain(
      "release-readiness-docs.test.ts",
    );
    expect(packageJson.scripts["test:e2e:setup:guided:all-shells"]).toContain(
      "STATION_SETUP_E2E_ALL_SHELLS=true",
    );
    expect(packageJson.scripts["test:ci:binary"]).toContain("pnpm smoke:binary");
    expect(packageJson.scripts["test:ci:station"]).toContain("test:pty:bun");
    expect(lefthook).toContain("run: node scripts/run-without-git-locals.mjs pnpm test:pre-push");
    expect(development).toContain("The pre-push hook is intentionally lint-only");
  });

  it("scopes the shared Turbo cache to pull requests, runners, and dependency state", () => {
    const standardCi = read(".github/workflows/standard-ci.yml");
    const setupAction = read(".github/actions/setup-ci/action.yml");
    const mainSmoke = between(standardCi, "  main-smoke:");

    const setupNodePin = setupAction.match(/uses: (actions\/setup-node@[0-9a-f]{40})/)?.[1];
    expect(setupNodePin).toBeDefined();
    expect(mainSmoke).toContain(`uses: ${setupNodePin}`);
    expect(setupAction).toMatch(/uses: actions\/cache@[0-9a-f]{40}/);
    expect(setupAction).toContain("if: inputs.restore-turbo-cache == 'true'");
    expect(setupAction).toContain("path: .turbo");
    expect(setupAction).toContain("runner.os");
    expect(setupAction).toContain("runner.arch");
    expect(setupAction).toContain("hashFiles('pnpm-lock.yaml', 'turbo.json')");
    expect(setupAction).toContain("github.sha");
    expect(setupAction).toContain("restore-keys:");
    expect(standardCi).toContain(
      `restore-turbo-cache: ${actionsExpression("github.event_name == 'pull_request'")}`,
    );

    expect(mainSmoke).toContain("github.ref == 'refs/heads/main'");
    expect(mainSmoke).toContain("pnpm build");
    expect(mainSmoke).toContain("pnpm typecheck");
    expect(mainSmoke).toContain("pnpm lint");
    expect(mainSmoke).not.toContain("test:pre-push");
    expect(mainSmoke).not.toContain("setup-bun");
    expect(mainSmoke).toMatch(/uses: actions\/cache@[0-9a-f]{40}/);
    expect(standardCi).not.toMatch(/path:\s+.*station-build-id/);
  });
});
