import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

interface WorkflowFile {
  readonly path: string;
  readonly document: string;
  readonly lines: readonly string[];
}

interface WorkflowStep {
  readonly line: number;
  readonly text: string;
}

function workflowFiles(): readonly WorkflowFile[] {
  return [".github/workflows", ".github/actions"].flatMap((directory) =>
    readdirSync(new URL(directory, root), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => {
        const path = `${directory}/${entry.parentPath.slice(
          fileURLToPath(new URL(directory, root)).length + 1,
        )}/${entry.name}`.replace("//", "/");
        const document = read(path);
        return { path, document, lines: document.split("\n") };
      }),
  );
}

function workflowSteps(file: WorkflowFile): readonly WorkflowStep[] {
  const stepStarts = file.lines.flatMap((line, index) =>
    /^\s*- (?:name|uses|run):/.test(line) ? [{ index, indent: line.search(/\S/) }] : [],
  );

  return stepStarts.map(({ index, indent }, stepIndex) => {
    const next = stepStarts
      .slice(stepIndex + 1)
      .find((candidate) => candidate.indent === indent && candidate.index > index);
    return {
      line: index + 1,
      text: file.lines.slice(index, next?.index ?? file.lines.length).join("\n"),
    };
  });
}

function workflowJobNames(document: string): readonly string[] {
  const lines = document.slice(document.indexOf("jobs:")).split("\n");
  return lines.flatMap((line) => {
    const name = line.match(/^ {2}([\w-]+):$/)?.[1];
    return name === undefined ? [] : [name];
  });
}

function workflowJob(document: string, name: string): string {
  const lines = document.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `missing workflow job: ${name}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[\w-]+:/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function predecessorSelector(document: string): string {
  const selectors = [...document.matchAll(/node -e '\n([\s\S]*?)\n\s+' "\$[^"]+"/gu)]
    .map((match) => match[1] ?? "")
    .filter((script) => script.includes("No complete immutable published Station predecessor"));
  expect(selectors).toHaveLength(1);
  return selectors[0] ?? "";
}

function releaseFixture(
  tag: string,
  id: number,
  publishedAt: string,
): {
  id: number;
  tag_name: string;
  draft: boolean;
  immutable: boolean;
  published_at: string;
  assets: Array<{ id: number; name: string }>;
} {
  const version = tag.slice(1);
  const names = [
    "SHA256SUMS",
    "install.sh",
    ...["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map(
      (target) => `stn-v${version}-${target}.tar.gz`,
    ),
  ];
  return {
    id,
    tag_name: tag,
    draft: false,
    immutable: true,
    published_at: publishedAt,
    assets: names.map((name, index) => ({ id: id * 10 + index + 1, name })),
  };
}

function selectPredecessor(
  selector: string,
  releases: readonly ReturnType<typeof releaseFixture>[],
  excludedTag = "v9.9.9",
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["-e", selector, excludedTag], {
    encoding: "utf8",
    input: JSON.stringify([releases]),
  });
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

describe("workflow security policy", () => {
  it("pins every external action to a full commit SHA", () => {
    const externalAction = /^[^/\s]+\/[^@\s]+@([0-9a-f]{40})$/;

    for (const file of workflowFiles()) {
      file.lines.forEach((line, index) => {
        const reference = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1];
        if (
          reference === undefined ||
          reference.startsWith("./") ||
          reference.startsWith("docker://")
        ) {
          return;
        }
        expect.soft(reference, `${file.path}:${index + 1}: ${line.trim()}`).toMatch(externalAction);
      });
    }
  });

  it("disables credential persistence in every checkout step", () => {
    for (const file of workflowFiles()) {
      for (const step of workflowSteps(file)) {
        if (!/uses:\s*actions\/checkout@[0-9a-f]{40}/.test(step.text)) {
          continue;
        }
        expect
          .soft(step.text, `${file.path}:${step.line}: checkout must not persist credentials`)
          .toMatch(/\n\s+with:\s*(?:\n\s+[^\n]+)*\n\s+persist-credentials:\s*false(?:\s|$)/);
      }
    }
  });

  it("limits release and promotion permissions to the jobs that need them", () => {
    const promotion = read(".github/workflows/promote-release.yml");
    const promotionHeader = promotion.slice(0, promotion.indexOf("jobs:"));
    expect(promotionHeader).toMatch(/^permissions: \{\}$/m);
    expect(promotionHeader).not.toContain("contents: write");

    const promote = workflowJob(promotion, "promote");
    expect(promote).toMatch(/\n {4}permissions:\n {6}actions: read\n {6}contents: write\n/);
    expect(workflowJob(promotion, "verify-public-install")).toMatch(/\n {4}permissions: \{\}\n/);

    const release = read(".github/workflows/release.yml");
    const writeJobs = workflowJobNames(release).filter((job) =>
      workflowJob(release, job).includes("contents: write"),
    );
    expect(writeJobs).toEqual(["create-draft", "install-draft", "record-accepted-candidate"]);
  });

  it("scopes dedicated Claude authentication to the real-agent execution step", () => {
    const file = workflowFiles().find(
      (candidate) => candidate.path === ".github/workflows/nightly-agent-smoke.yaml",
    );
    expect(file).toBeDefined();
    if (file === undefined) {
      return;
    }

    expect(file.document).toContain("environment: nightly-agent-smoke");
    expect(file.document).toContain("npm view @anthropic-ai/claude-code@latest version");
    expect(file.document).toContain(
      'npm view "@anthropic-ai/claude-code@$claude_version" dist.integrity',
    );
    expect(file.document).toContain('npm install -g "@anthropic-ai/claude-code@$claude_version"');
    expect(file.document).toContain("Resolved latest version:");
    expect(file.document).toContain("Registry-reported integrity:");
    expect(file.document).toContain("Installed version:");

    const authentication = /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/;
    const authenticatedSteps = workflowSteps(file).filter((step) => authentication.test(step.text));
    expect(authenticatedSteps).toHaveLength(1);
    expect(file.document.match(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/g)).toHaveLength(
      authenticatedSteps[0]?.text.match(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/g)?.length ?? 0,
    );
    expect(authenticatedSteps[0]?.text).toContain("name: Real Claude launch + hook-capture smoke");
    expect(authenticatedSteps[0]?.text).toContain(
      `ANTHROPIC_API_KEY: ${actionsExpression("secrets.ANTHROPIC_API_KEY")}`,
    );
    expect(authenticatedSteps[0]?.text).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(authenticatedSteps[0]?.text).toContain('echo "::error::');
    expect(authenticatedSteps[0]?.text).toContain("exit 1");
    expect(authenticatedSteps[0]?.text).not.toContain("exit 0");

    for (const stepName of ["Install workspace", "Install tmux and the Claude Code CLI"]) {
      const step = workflowSteps(file).find((candidate) =>
        candidate.text.startsWith(`      - name: ${stepName}`),
      );
      expect(step, `missing nightly step: ${stepName}`).toBeDefined();
      expect(step?.text).not.toMatch(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
    }
  });
});

describe("hosted CI policy", () => {
  it("fans ready pull requests and release calls into independently reported validation lanes", () => {
    const standardCi = read(".github/workflows/standard-ci.yml");
    const release = read(".github/workflows/release.yml");

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

  it("uploads only bounded binary-smoke failure evidence without masking the lane", () => {
    const standardCi = read(".github/workflows/standard-ci.yml");
    const binary = workflowJob(standardCi, "binary_smoke");
    const aggregate = workflowJob(standardCi, "standard-ci");

    expect(binary).toContain("id: binary_smoke_run");
    expect(binary).toContain("timeout-minutes: 15");
    expect(binary).toContain(
      `STATION_BINARY_SMOKE_EVIDENCE_DIR: ${actionsExpression("runner.temp")}/station-binary-smoke-evidence`,
    );
    expect(binary).toContain(
      `if: ${actionsExpression("failure() && steps.binary_smoke_run.outcome == 'failure'")}`,
    );
    expect(binary).toContain(
      "uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    );
    expect(binary).toContain(
      `name: binary-smoke-evidence-${actionsExpression("github.run_id")}-${actionsExpression("github.run_attempt")}`,
    );
    expect(binary).toContain(
      `path: ${actionsExpression("runner.temp")}/station-binary-smoke-evidence`,
    );
    expect(binary).toContain("if-no-files-found: warn");
    expect(binary).toContain("retention-days: 3");
    expect(binary).toContain("continue-on-error: true");
    expect(binary.indexOf("id: binary_smoke_run")).toBeLessThan(
      binary.indexOf("uses: actions/upload-artifact@"),
    );
    expect(aggregate).toContain(`BINARY_SMOKE: ${actionsExpression("needs.binary_smoke.result")}`);
  });

  it("executes each inline immutable-predecessor selector against hostile release fixtures", () => {
    const selectors = [
      predecessorSelector(read(".github/workflows/release.yml")),
      predecessorSelector(read(".github/workflows/promote-release.yml")),
    ];
    const valid = releaseFixture("v1.2.3", 123, "2026-08-01T00:00:00Z");
    const newer = releaseFixture("v1.2.4", 124, "2026-08-02T00:00:00Z");
    const firstAsset = newer.assets[0];
    if (firstAsset === undefined) throw new Error("Release fixture omitted its first asset.");
    const invalid = [
      { ...newer, draft: true },
      { ...newer, immutable: false },
      { ...newer, assets: newer.assets.slice(0, -1) },
      { ...newer, assets: [...newer.assets.slice(0, -1), firstAsset] },
      { ...newer, published_at: "not-a-date" },
      { ...newer, tag_name: "v01.2.4" },
      { ...newer, id: 0 },
      { ...newer, assets: newer.assets.map((asset, index) => ({ ...asset, id: index })) },
      {
        ...newer,
        assets: newer.assets.map((asset, index) => ({
          ...asset,
          id: index < 2 ? 999 : asset.id,
        })),
      },
    ];

    for (const selector of selectors) {
      for (const malformed of invalid) {
        const result = selectPredecessor(selector, [malformed, valid]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(valid.tag_name);
      }

      const excluded = selectPredecessor(selector, [newer, valid], newer.tag_name);
      expect(excluded.status, excluded.stderr).toBe(0);
      expect(excluded.stdout).toBe(valid.tag_name);

      const sameDateLowerId = releaseFixture("v1.2.5", 125, "2026-08-03T00:00:00Z");
      const sameDateHigherId = releaseFixture("v1.2.6", 126, "2026-08-03T00:00:00Z");
      const selected = selectPredecessor(selector, [valid, sameDateLowerId, sameDateHigherId]);
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toBe(sameDateHigherId.tag_name);

      const noCandidate = selectPredecessor(selector, invalid);
      expect(noCandidate.status).not.toBe(0);
    }
  });

  it("separates the legacy transition from v4 Host convergence and reap planning", () => {
    const release = read(".github/workflows/release.yml");
    const promotion = read(".github/workflows/promote-release.yml");
    const updateSmoke = read("scripts/test-runners/run-update-smoke.mjs");
    const installDraft = workflowJob(release, "install-draft");
    const createDraft = workflowJob(release, "create-draft");
    const accepted = workflowJob(release, "record-accepted-candidate");
    const promote = workflowJob(promotion, "promote");
    const publicInstall = workflowJob(promotion, "verify-public-install");

    expect(release).toContain(
      `previous_tag: ${actionsExpression("steps.release.outputs.previous_tag")}`,
    );
    expect(release).toContain("previousTag: $previousTag");
    expect(release).toContain(".previousTag == $previousTag");
    expect(createDraft.indexOf("candidate/asset-ids.txt")).toBeLessThan(
      createDraft.indexOf("release-candidate-input-"),
    );
    expect(createDraft).toContain("targetBuildIdentity: $targetBuildIdentity");
    expect(installDraft).toContain("Fetch staged update assets and exact predecessor");
    expect(installDraft).toContain("actions/download-artifact@");
    expect(installDraft).toContain('awk -F= -v name="$name"');
    expect(installDraft).toContain('cmp candidate/SHA256SUMS "$release_dir/SHA256SUMS"');
    expect(installDraft).not.toContain("select(.name == $name)");
    expect(installDraft).toContain('--target-release-dir "$RUNNER_TEMP/update-release"');
    expect(installDraft).toContain('--target-build-identity "$target_build_identity"');
    expect(installDraft).toContain("Prove compatible transition from the exact predecessor");
    expect(installDraft).toContain("--incumbent-contract legacy-compatible");
    expect(installDraft).toContain("Prove v4 Host convergence against the staged target");
    expect(installDraft).toContain("Prove v4 pre-mutation reap-required against the staged target");
    expect(installDraft).toContain('--incumbent-binary "$RUNNER_TEMP/v4-update-incumbent"');
    expect(installDraft).toContain('pnpm build:binary -- --version "$v4_incumbent_version"');
    expect(installDraft.match(/pnpm smoke:update/g)).toHaveLength(3);
    const compatibleTransition = between(
      installDraft,
      "Prove compatible transition from the exact predecessor",
      "Prove v4 Host convergence against the staged target",
    );
    expect(compatibleTransition).toContain("--scenarios no-host");
    expect(compatibleTransition).not.toContain("--busy-host-outcome pre-mutation-reap-required");
    const hostConvergence = between(
      installDraft,
      "Prove v4 Host convergence against the staged target",
      "Prove v4 pre-mutation reap-required against the staged target",
    );
    expect(hostConvergence).toContain("--scenarios host-convergence");
    expect(hostConvergence).not.toContain("--incumbent-contract legacy-compatible");
    const reapRequired = between(
      installDraft,
      "Prove v4 pre-mutation reap-required against the staged target",
      "Verify lock refusal and same-version retry",
    );
    expect(reapRequired).toContain("--scenarios reap-required");
    expect(reapRequired).not.toContain("--incumbent-contract legacy-compatible");
    expect(accepted).toContain('test "$current_ids" = "$(cat candidate/asset-ids.txt)"');
    expect(accepted).not.toContain(": > candidate/asset-ids.txt");

    expect(promote).toContain('previous_tag="$(jq -er .previousTag candidate/manifest.json)"');
    expect(promote).toContain(".previousTag == $previousTag");
    expect(promote).toContain(".immutable");
    expect(promotion).toContain("group: station-release-publication");
    expect(promote).toContain('test "$freshest_previous" = "$previous_tag"');
    expect(promote.indexOf('test "$freshest_previous" = "$previous_tag"')).toBeLessThan(
      promote.indexOf("-F draft=false"),
    );
    expect(publicInstall).toContain("Install exact public predecessor");
    expect(publicInstall).toContain('--public-target-tag "$TAG"');
    expect(publicInstall).toContain('--target-build-identity "$TARGET_BUILD_IDENTITY"');
    expect(publicInstall).toContain("--scenarios no-host");
    expect(publicInstall).toContain("--incumbent-contract legacy-compatible");
    expect(updateSmoke).toContain("CompatibleUpdateCommandReportSchema.parse(rawReport)");
    expect(updateSmoke).toContain("function assertLegacyUpdateReport");
    expect(updateSmoke).toContain("post-apply latest discovery is forbidden");
    expect(updateSmoke).toContain("denyPostApplyLatest");
    expect(updateSmoke).toContain("function assertTargetCurrentReport");
    expect(updateSmoke).toContain('hostMode: "idle"');
    expect(updateSmoke).toContain('hostMode: "busy-bridge"');
    expect(updateSmoke).toContain('hostMode: "busy-nonbridge"');
    expect(updateSmoke).toContain("function assertHostConvergenceAudit");
    expect(updateSmoke).toContain("function assertFreshNoOpPlan");
    expect(updateSmoke).toContain(
      "--incumbent-contract legacy-compatible requires --scenarios no-host and full-handoff.",
    );
    expect(promotion).toContain(
      "Confirm macOS pre-mutation reap-required kept incumbent artifact, Observer, Host, and PTY inventory unchanged with no target UI/artifact crossover",
    );
    expect(promotion).not.toContain("partial crossover preserved old Host output");
  });

  it("keeps binary handoff stress manual, capped, and failure-artifact-only", () => {
    const stress = read(".github/workflows/binary-handoff-stress.yml");
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    expect(stress).toContain("workflow_dispatch:");
    expect(stress).not.toContain("schedule:");
    expect(stress).not.toContain("pull_request:");
    expect(stress).toContain("timeout-minutes: 20");
    expect(stress).toContain('if [ "$ROUNDS" -lt 1 ] || [ "$ROUNDS" -gt 100 ]');
    expect(stress).toContain("pnpm build:binary -- --version 0.0.0-local");
    expect(stress).toContain("--round-timeout-ms 30000");
    expect(stress).toContain(
      `STATION_BINARY_SMOKE_EVIDENCE_DIR: ${actionsExpression("runner.temp")}/station-binary-smoke-evidence`,
    );
    expect(stress).toContain(
      `if: ${actionsExpression("failure() && steps.binary_handoff_stress_run.outcome == 'failure'")}`,
    );
    expect(stress).toContain(
      "uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    );
    expect(stress).toContain("retention-days: 3");
    expect(stress).toContain("continue-on-error: true");
    expect(packageJson.scripts["stress:binary-handoff"]).toBe(
      "node scripts/test-runners/run-binary-smoke.mjs --mode handoff-stress",
    );
  });

  it("keeps exhaustive claim stress scheduled without extending every pull request", () => {
    const nightly = read(".github/workflows/nightly-observer-claim.yml");
    const testing = read("tests/README.md");

    expect(nightly).toContain('cron: "17 7 * * *"');
    expect(nightly).toContain("workflow_dispatch:");
    expect(nightly).toContain('bun: "true"');
    expect(nightly).toContain("pnpm test:observer-claim:cross-runtime");
    expect(nightly).not.toContain("test:observer-claim:cross-runtime:pr");
    expect(testing).toContain("nightly-observer-claim");
  });

  it("keeps pre-push local and fast while preserving explicit comprehensive commands", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const lefthook = read("lefthook.yml");
    const testing = read("tests/README.md");

    expect(packageJson.scripts["test:pre-push"]).toBe("pnpm lint");
    expect(packageJson.scripts["test:all"]).toContain("pnpm smoke:install");
    expect(packageJson.scripts["test:diagnostics:policy"]).toContain(
      "release-readiness-docs.test.ts",
    );
    expect(packageJson.scripts["test:e2e:setup:guided:all-shells"]).toContain(
      "STATION_SETUP_E2E_ALL_SHELLS=true",
    );
    expect(packageJson.scripts["test:ci:binary"]).toContain("pnpm smoke:binary");
    expect(packageJson.scripts["smoke:update"]).toBe(
      "node scripts/test-runners/run-update-smoke.mjs",
    );
    expect(packageJson.scripts["test:ci:binary"]).toContain(
      "pnpm smoke:update -- --incumbent-binary station/dist/bin/stn",
    );
    expect(packageJson.scripts["test:ci:binary"]).toContain("--scenarios v4-gate");
    expect(packageJson.scripts["test:ci:station"]).toContain("test:pty:bun");
    expect(lefthook).toContain("run: node scripts/run-without-git-locals.mjs pnpm test:pre-push");
    expect(testing).toContain("The pre-push hook is intentionally lint-only");
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
