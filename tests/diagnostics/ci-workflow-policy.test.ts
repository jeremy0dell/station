import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

function between(document: string, start: string, end?: string): string {
  const startIndex = document.indexOf(start);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = end === undefined ? document.length : document.indexOf(end, startIndex + 1);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return document.slice(startIndex, endIndex);
}

describe("hosted CI policy", () => {
  it("runs the full gate for ready pull requests and release calls but not main pushes", () => {
    const standardCi = read(".github/workflows/standard-ci.yml");
    const release = read(".github/workflows/release.yml");
    const development = read("docs/development.md");

    expect(standardCi).toContain("types: [opened, synchronize, reopened, ready_for_review]");

    const fullGate = between(standardCi, "  standard-ci:", "  main-smoke:");
    expect(fullGate).toContain("github.ref_type == 'tag'");
    expect(fullGate).toContain("github.event.pull_request.draft == false");
    expect(fullGate).toContain("run: pnpm test:pre-push");

    const mainSmoke = between(standardCi, "  main-smoke:");
    expect(mainSmoke).toContain("github.ref == 'refs/heads/main'");
    expect(mainSmoke).toContain("pnpm build");
    expect(mainSmoke).toContain("pnpm typecheck");
    expect(mainSmoke).toContain("pnpm lint");
    expect(mainSmoke).not.toContain("test:pre-push");
    expect(mainSmoke).not.toContain("setup-bun");

    const releaseStandardCi = between(release, "  standard-ci:", "  release-smoke:");
    expect(releaseStandardCi).toContain("uses: ./.github/workflows/standard-ci.yml");
    const nativeBuilds = between(release, "  build-native:", "  create-draft:");
    expect(nativeBuilds).toMatch(/needs:\s+- validate\s+- standard-ci\s+- release-smoke/);

    expect(development).toContain("Ready, non-draft pull requests run `pnpm test:pre-push`");
    expect(development).toContain("before any native release build starts");
    expect(development).toMatch(/Draft pull request activity allocates no\s+runner/);
    expect(development).toMatch(/Pushes to `main`\s+run only build, typecheck, and lint/);
  });

  it("scopes the local Turbo cache to the runner and dependency state", () => {
    const standardCi = read(".github/workflows/standard-ci.yml");
    const fullGate = between(standardCi, "  standard-ci:", "  main-smoke:");
    const mainSmoke = between(standardCi, "  main-smoke:");

    for (const job of [fullGate, mainSmoke]) {
      expect(job).toMatch(/uses: actions\/cache@[0-9a-f]{40}/);
      expect(job).toContain("path: .turbo");
      expect(job).toContain("runner.os");
      expect(job).toContain("runner.arch");
      expect(job).toContain("hashFiles('pnpm-lock.yaml', 'turbo.json')");
      expect(job).toContain("github.sha");
      expect(job).toContain("restore-keys:");
    }

    expect(fullGate).toContain("if: github.event_name == 'pull_request'");
    expect(standardCi).not.toMatch(/path:\s+.*station-build-id/);
  });
});
