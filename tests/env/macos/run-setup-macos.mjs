#!/usr/bin/env node
// Tier 3 runner (see docs/setup-testing.md): clone a Tart macOS image per profile,
// run `stn setup check --json` over SSH on a real Mac, and assert the same outcome
// contract as tiers 1/2. Full fidelity for real brew / Command Line Tools states.
//
// Usage: node tests/env/macos/run-setup-macos.mjs <profile> [<profile>...]
//
// Requires: an Apple-Silicon Mac with Tart installed (https://tart.run), the
// "station-happy" image built (tests/env/macos/station-happy.pkr.hcl), and a
// vanilla image pulled for deprivation states. Respects Apple's 2-VM/host limit
// by running profiles strictly sequentially.
//
// Prerequisites NOT yet automated (image work, needs a Mac + packer): the
// station-happy image must bake the checkout at /Users/admin/station, the built
// CLI (apps/cli/dist/main.js), and a harness CLI; and the `ready` profile needs a
// valid /Users/admin/station.toml written (mirror setupProfiles.ts readyConfigToml)
// before `setup check` can reach exit 0. The no-brew / no-xcode-clt profiles run on
// the vanilla cirruslabs image, which also lacks node and the checkout, so
// `node .../main.js setup check` exits 127 there until that image is likewise
// provisioned. Until then this runner is wired but not end-to-end green — do not
// read a passing run as full coverage.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Each profile maps to a base image + the expected `setup check` outcome. The
// expectations mirror packages/testing/src/setupProfiles.ts (the canonical
// contract); the in-process tier-1 test is the source of truth.
export const profiles = {
  ready: {
    image: "station-happy",
    setup: "full", // run bootstrap + write config, expect requiredOk
    exitCode: 0,
  },
  "all-tools-present": { image: "station-happy", setup: "check", exitCode: 1, requiredOk: false },
  "no-brew": {
    image: "ghcr.io/cirruslabs/macos-sequoia-vanilla:latest",
    setup: "check",
    exitCode: 1,
    requiredOk: false,
    checks: { worktrunk: "missing", tmux: "missing", bun: "missing", diffnav: "missing" },
  },
  "no-xcode-clt": {
    image: "ghcr.io/cirruslabs/macos-sequoia-vanilla:latest",
    setup: "check",
    exitCode: 1,
    requiredOk: false,
    checks: { "command-line-tools": "missing" },
  },
};

// Guarded so importing this module (e.g. the contract-consistency unit test) does
// not boot any VMs; only a direct `node run-setup-macos.mjs` invocation runs.
// Portable across Node versions (vs. import.meta.main, which needs Node 24.2+).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  if (requested.length === 0) {
    console.error(
      `Usage: run-setup-macos.mjs <profile>... (known: ${Object.keys(profiles).join(", ")})`,
    );
    process.exit(2);
  }

  let failures = 0;
  // Sequential by design: Apple permits at most 2 macOS VMs per host.
  for (const name of requested) {
    const profile = profiles[name];
    if (profile === undefined) {
      console.error(`Unknown profile: ${name}`);
      failures += 1;
      continue;
    }
    const clone = `stn-setup-${name}`;
    // `tart run` runs the guest in the foreground until it stops, so it must be an
    // async child (not spawnSync, which would block here forever); retain the handle
    // to kill it in finally.
    let vm;
    try {
      console.log(`\n==> ${name}: cloning ${profile.image}`);
      tart(["clone", profile.image, clone]);
      vm = spawn("tart", ["run", "--no-graphics", clone], { stdio: "ignore", detached: true });
      vm.unref();
      const ip = waitForIp(clone);
      const json = ssh(ip, setupCommand(profile));
      const problems = assertOutcome(profile, json);
      if (problems.length > 0) {
        console.error(`✗ ${name}: ${problems.join("; ")}`);
        failures += 1;
      } else {
        console.log(`✓ ${name}`);
      }
    } catch (error) {
      console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
      failures += 1;
    } finally {
      vm?.kill();
      spawnSync("tart", ["stop", clone], { stdio: "ignore" });
      spawnSync("tart", ["delete", clone], { stdio: "ignore" });
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} profile(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${requested.length} macOS profile(s) passed.`);
}

function setupCommand(profile) {
  // `full` runs the real bootstrap (brew bundle + build + link) before checking;
  // `check` runs only the read-only check against the image as-is.
  const checkout = "/Users/admin/station";
  const check = `node ${checkout}/apps/cli/dist/main.js --config /Users/admin/station.toml setup check --json`;
  return profile.setup === "full"
    ? `cd ${checkout} && ./scripts/setup/bootstrap.sh >/dev/null 2>&1; ${check}`
    : check;
}

function assertOutcome(profile, result) {
  const problems = [];
  if (result.status !== profile.exitCode) {
    problems.push(`exit ${result.status}, expected ${profile.exitCode}`);
  }
  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    return [...problems, "stdout was not JSON"];
  }
  if (profile.requiredOk !== undefined && plan.summary?.requiredOk !== profile.requiredOk) {
    problems.push(`requiredOk ${plan.summary?.requiredOk}, expected ${profile.requiredOk}`);
  }
  const byId = new Map((plan.checks ?? []).map((c) => [c.id, c.status]));
  for (const [id, status] of Object.entries(profile.checks ?? {})) {
    if (byId.get(id) !== status)
      problems.push(`check ${id} was ${byId.get(id)}, expected ${status}`);
  }
  return problems;
}

// Blocking tart commands only (clone). The long-running `tart run` uses async
// spawn at the call site so it does not deadlock the sequential profile loop.
function tart(args) {
  const result = spawnSync("tart", args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`tart ${args.join(" ")} failed`);
  }
  return result;
}

function waitForIp(clone) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("tart", ["ip", clone], { encoding: "utf8" });
    const ip = (result.stdout ?? "").trim();
    if (result.status === 0 && ip.length > 0) return ip;
    spawnSync("sleep", ["2"]);
  }
  throw new Error(`timed out waiting for ${clone} IP`);
}

function ssh(ip, command) {
  const result = spawnSync(
    "sshpass",
    [
      "-p",
      "admin",
      "ssh",
      "-o",
      "StrictHostKeyChecking=no",
      // Ephemeral Tart VMs reuse IPs with fresh host keys; a stale known_hosts entry
      // makes OpenSSH disable password auth, so sshpass fails and stdout is empty
      // (then JSON.parse throws and masks the real outcome). Don't touch known_hosts.
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      `admin@${ip}`,
      command,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return { status: result.status, stdout: result.stdout ?? "" };
}
