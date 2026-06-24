#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const options = parseArgs(process.argv.slice(2));
const timeoutMs = Number(process.env.STATION_RELEASE_SMOKE_TIMEOUT_MS ?? 120_000);
const tempRoot = mkdtempSync(join(tmpdir(), "station-release-smoke-"));
const stateDir = join(tempRoot, "state");
const configPath = join(tempRoot, "config.toml");
let observerStopped = false;

try {
  if (!options.skipBuild) {
    spawnChecked("pnpm", ["build"], { label: "build" });
  } else {
    assertBuiltCli();
  }

  mkdirSync(stateDir, { recursive: true });
  const fakeWt = writeFakeWorktrunk(tempRoot);
  writeSmokeConfig({ fakeWt });

  const doctor = runStationJson(["--config", configPath, "doctor"], "doctor");
  assert(doctor.debugBundle?.available === true, "doctor did not report debug bundle availability");

  runStationJson(["--config", configPath, "reconcile", "--reason", "release-smoke"], "reconcile");
  const snapshot = runStationJson(["--config", configPath, "snapshot", "--json"], "snapshot");
  assert(snapshot.counts?.projects === 1, "snapshot did not include the smoke project");

  const debugBundle = runStationJson(["--config", configPath, "debug", "bundle"], "debug bundle");
  assertPathExists(debugBundle.bundlePath, "debug bundle path was not created");

  if (!options.skipScripted) {
    spawnChecked("pnpm", ["test:agent:scripted"], { label: "scripted agent smoke" });
  }

  const summary = {
    status: "release smoke passed",
    configPath,
    stateDir,
    rows: snapshot.rows?.length ?? 0,
    debugBundle: debugBundle.bundlePath,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  stopObserver();
  if (!options.keepTemp) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`release smoke temp kept at ${tempRoot}\n`);
  }
}

function parseArgs(args) {
  const parsed = {
    keepTemp: false,
    skipBuild: false,
    skipScripted: false,
  };
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--keep-temp") {
      parsed.keepTemp = true;
    } else if (arg === "--skip-build") {
      parsed.skipBuild = true;
    } else if (arg === "--skip-scripted") {
      parsed.skipScripted = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Usage: pnpm smoke:release [-- --skip-build --skip-scripted --keep-temp]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown release smoke option: ${arg}`);
    }
  }
  return parsed;
}

function assertBuiltCli() {
  const entry = join(repoRoot, "apps", "cli", "dist", "main.js");
  assert(existsSync(entry), "built CLI is missing; run pnpm build or omit --skip-build");
}

function writeSmokeConfig(input) {
  const projectRoot = join(tempRoot, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    configPath,
    [
      "schema_version = 1",
      "",
      "[observer]",
      "auto_start = true",
      `socket_path = ${JSON.stringify(join(tempRoot, "run", "observer.sock"))}`,
      `state_dir = ${JSON.stringify(stateDir)}`,
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "noop-terminal"',
      'harness = "noop-harness"',
      'layout = "agent-shell"',
      "",
      "[worktree.worktrunk]",
      `command = ${JSON.stringify(input.fakeWt)}`,
      "use_lifecycle_hooks = false",
      'hook_mode = "disabled"',
      "",
      "[[projects]]",
      'id = "release-smoke"',
      'label = "Release Smoke"',
      `root = ${JSON.stringify(projectRoot)}`,
      'default_branch = "main"',
      "",
      "[projects.defaults]",
      'harness = "noop-harness"',
      'terminal = "noop-terminal"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      "",
    ].join("\n"),
  );
}

function writeFakeWorktrunk(root) {
  const binDir = join(root, "bin");
  const fakeStateDir = join(root, "fake-worktrunk-state");
  const binPath = join(binDir, "fake-wt.mjs");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fakeStateDir, { recursive: true });
  writeFileSync(binPath, fakeWorktrunkSource(fakeStateDir), { mode: 0o700 });
  chmodSync(binPath, 0o700);
  return binPath;
}

function fakeWorktrunkSource(fakeStateDir) {
  return `#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
const projectId = basename(cwd).replace(/[^a-zA-Z0-9._:-]+/g, "_") || "project";
const stateFile = join(${JSON.stringify(fakeStateDir)}, projectId + ".json");

if (args.includes("--version")) {
  console.log("fake-wt 0.0.0");
  process.exit(0);
}

function current() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return { branch: "main", path: cwd };
  }
}

function write(record) {
  mkdirSync(${JSON.stringify(fakeStateDir)}, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(record));
}

function emit(record = current()) {
  console.log(JSON.stringify([{ path: record.path, branch: record.branch, dirty: false }]));
}

if (args.includes("list")) {
  emit();
  process.exit(0);
}

if (args.includes("switch")) {
  const createIndex = args.indexOf("--create");
  const branch = createIndex >= 0 && args[createIndex + 1] ? args[createIndex + 1] : "release-smoke";
  const path = join(${JSON.stringify(fakeStateDir)}, projectId + "-" + branch.replace(/[^a-zA-Z0-9._:-]+/g, "_"));
  mkdirSync(path, { recursive: true });
  const record = { branch, path };
  write(record);
  emit(record);
  process.exit(0);
}

if (args.includes("remove")) {
  rmSync(stateFile, { force: true });
  console.log("{}");
  process.exit(0);
}

console.log("{}");
`;
}

function runStationJson(args, label) {
  const result = spawnChecked(join(repoRoot, "bin", "stn"), args, { label });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stopObserver() {
  if (observerStopped || !existsSync(configPath)) {
    return;
  }
  observerStopped = true;
  spawnSync(join(repoRoot, "bin", "stn"), ["--config", configPath, "observer", "stop"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function spawnChecked(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${options.label} failed with status ${result.status ?? "unknown"}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPathExists(path, message) {
  assert(typeof path === "string" && path.length > 0, message);
  assert(existsSync(path), message);
}
