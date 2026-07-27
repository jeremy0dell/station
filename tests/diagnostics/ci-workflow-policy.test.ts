import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

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
    expect(standardCi).toContain("pnpm test:sqlite:bun:pr");
    expect(standardCi).toContain("pnpm test:sqlite:bun");
    expect(standardCi).not.toContain("pnpm test:pre-push");

    const aggregate = between(standardCi, "  standard-ci:", "  main-smoke:");
    expect(aggregate).toContain("name: standard-ci");
    expect(aggregate).toContain("always()");
    expect(aggregate).toContain("success|skipped");
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
    expect(packageJson.scripts["test:ci:binary"]).toContain("pnpm smoke:binary");
    expect(packageJson.scripts["test:ci:station"]).toContain("test:pty:bun");
    expect(lefthook).toContain("run: node scripts/run-without-git-locals.mjs pnpm test:pre-push");
    expect(development).toContain("The pre-push hook is intentionally lint-only");
  });

  it("scopes the shared Turbo cache to pull requests, runners, and dependency state", () => {
    const standardCi = read(".github/workflows/standard-ci.yml");
    const setupAction = read(".github/actions/setup-ci/action.yml");
    const mainSmoke = between(standardCi, "  main-smoke:");

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
