#!/usr/bin/env node
// Tier 2 runner: build a per-profile Linux image and assert `stn setup check
// --json` against the same outcome contract as the in-process tier-1 harness
// (apps/cli/test/integration/setup-profiles.test.ts). See docs/setup-testing.md.
//
// Usage: node scripts/test-runners/run-setup-container.mjs [profile...]
//        (no args = all Linux-coverable profiles)
//
// Requires Docker. brew/CLT profiles are macOS-only (tier 3 / Tart), not here.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = join(repoRoot, "tests", "env", "docker", "Dockerfile");

// Mirrors the Linux-coverable subset of packages/testing/src/setupProfiles.ts.
// Each `setup check` exits 1 until a config is written, so the distinguishing
// signal is requiredOk + which checks are missing.
const expectations = {
  "happy-linux": {
    exitCode: 1,
    requiredOk: false,
    checks: {
      worktrunk: "ok",
      tmux: "ok",
      bun: "ok",
      diffnav: "ok",
      "git-delta": "ok",
      harness: "ok",
      config: "missing",
    },
  },
  "no-git": { exitCode: 1, requiredOk: false, checks: { "git-project": "missing" } },
  "no-tmux": { exitCode: 1, requiredOk: false, checks: { tmux: "missing" } },
  "no-worktrunk": { exitCode: 1, requiredOk: false, checks: { worktrunk: "missing" } },
  "no-bun": { exitCode: 1, requiredOk: false, checks: { bun: "missing" } },
  "no-diffnav": {
    exitCode: 1,
    requiredOk: false,
    checks: { diffnav: "missing", "git-delta": "missing" },
  },
  "no-harness": { exitCode: 1, requiredOk: false, checks: { harness: "missing" } },
};

const requested = process.argv.slice(2);
const profiles = requested.length > 0 ? requested : Object.keys(expectations);

let failures = 0;
for (const profile of profiles) {
  const expect = expectations[profile];
  if (expect === undefined) {
    console.error(`Unknown profile: ${profile} (known: ${Object.keys(expectations).join(", ")})`);
    failures += 1;
    continue;
  }
  const tag = `stn-setup-${profile}`;
  console.log(`\n==> building ${profile}`);
  const build = run("docker", [
    "build",
    "-f",
    dockerfile,
    "--target",
    profile,
    "-t",
    tag,
    repoRoot,
  ]);
  if (build.status !== 0) {
    console.error(`build failed for ${profile}`);
    failures += 1;
    continue;
  }
  console.log(`==> running ${profile}`);
  const result = run("docker", ["run", "--rm", tag], { capture: true });
  const mismatch = assertProfile(expect, result);
  if (mismatch.length > 0) {
    console.error(`✗ ${profile}: ${mismatch.join("; ")}`);
    failures += 1;
  } else {
    console.log(`✓ ${profile}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} profile(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${profiles.length} container profile(s) passed.`);

function assertProfile(expect, result) {
  const problems = [];
  if (result.status !== expect.exitCode) {
    problems.push(`exit ${result.status}, expected ${expect.exitCode}`);
  }
  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    problems.push("stdout was not JSON");
    return problems;
  }
  if (plan.summary?.requiredOk !== expect.requiredOk) {
    problems.push(`requiredOk ${plan.summary?.requiredOk}, expected ${expect.requiredOk}`);
  }
  const byId = new Map((plan.checks ?? []).map((check) => [check.id, check.status]));
  for (const [id, status] of Object.entries(expect.checks)) {
    if (byId.get(id) !== status) {
      problems.push(`check ${id} was ${byId.get(id)}, expected ${status}`);
    }
  }
  return problems;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}
